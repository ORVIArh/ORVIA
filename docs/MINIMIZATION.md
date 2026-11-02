# Periodic energy minimization

`PeriodicMinimizer` implements resumable steepest descent and Armijo backtracking using the complete periodic force pass. Every coordinate, force, energy, trial, convergence check and acceptance decision is computed and stored on chain. Transaction callers provide only an experiment ID and a work limit; they cannot submit trial coordinates, gradients or energies.

This is an alternative coordinator for the declared fixed-orthorhombic cutoff Hamiltonian: harmonic bonds and angles, periodic torsions, switched Lennard–Jones interactions, conducting reaction-field electrostatics, explicit exclusions and direct uncut exceptions. It does not implement Ewald/PME, a barostat, equilibrium sampling, or a prepared medicinal simulation. Convergence means that the registered numerical force criterion is met for this Hamiltonian, not that a global minimum or useful drug candidate has been found.

## Deployment and registration

Deploy `PeriodicMinimizer(owner, modules)` with these eleven pinned modules in tuple order:

`registry, dataset, math, bond, angle, torsion, lj, coulomb, elementary, geometry, nonbonded`.

Then deploy `WorkingStatePage(minimizer)` and call `bindWorkingPage(page)` once as owner. The protocol manifest must contain every dependency, the minimizer and its page. The minimizer verifies module bytecode, numerical-math identity, the angular elementary-math dependencies, direct nonbonded kernel dependencies, and page writer identity. Every advance rechecks dependency code and the frozen dataset commitment.

Owner registration is `registerExperiment(protocolId, datasetId, settings)`, where settings are:

| Field | Constraint |
|---|---|
| `initialStep` | Positive finite binary128 scalar |
| `forceTolerance` | Finite, at least `2^-1000` |
| `armijo` | Finite and strictly between zero and one |
| `maxIterations` | 1–4096 accepted iterations |
| `maxTrials` | 1–64 rejected trials per line search |

The force-tolerance floor is conservative protection against squared-force underflow masquerading as a satisfied extremely small tolerance. Intermediate overflow is rejected by the numerical kernels. Initial geometry must be valid and evaluable; unsupported initial numerical ranges revert rather than producing a successful result.

Development caps are 2–1024 atoms, at least one and at most 16,384 bonds, at most 4,096 angles, 4,096 torsions and 4,096 exceptions. Pair enumeration is exhaustive and bounded one record at a time, not a neighbor-list optimization. These caps are validation limits, not evidence of practical protein-scale throughput.

The namespace includes the chain ID, coordinator address and experiment ID. The immutable run commitment binds that namespace, settings, protocol manifest, frozen dataset, module code hashes and working-page identity. Runs do not share mutable state.

## Algorithm and work accounting

For the complete force vector `F = -∇U`, the proposal is `x_trial = x_current + αF_current`. The force RMS is defined over atoms as:

`RMS = sqrt(sum_i |F_i|² / N)`.

All three Cartesian components of every atom contribute. The maximum atom-force norm is also accumulated and exposed. Initial convergence is checked only after every interaction and force assessment has completed. A trial likewise needs a complete force pass and assessment before acceptance.

A valid trial is accepted only if both `U_trial < U_current` and the binary128 Armijo condition hold:

`U_trial <= U_current - c α sum_i |F_i|²`.

The explicit strict energy decrease prevents a numerically unchanged trial from being accepted when the computed Armijo decrement rounds away. After acceptance, the current buffer changes atomically; convergence is checked against the registered RMS tolerance. A further iteration restarts from the registered initial step. Rejection leaves the accepted buffer untouched and halves the step.

Any account may call `advanceExperiment(id, workLimit)` with 1–8 work units. A unit is one atom load/proposal/force assessment, one topology validation/interaction calculation, or one acceptance decision. Optional empty interaction stages are skipped. An interaction may entail multiple fixed numerical operations, and dataset/page lookup costs still depend on the bounded registered layout. There are no unbounded atom or pair loops in a single work unit.

| Status | Value | Meaning |
|---|---:|---|
| Loading | 1 | Copy frozen initial coordinates, validate particle parameters |
| ValidatingBonds through ValidatingExceptions | 2–5 | Validate topology and build namespaced exception index |
| InitialBonds through InitialPairs | 6–9 | Complete accepted-state energy and forces |
| AssessInitial | 10 | Accumulate complete initial gradient norms |
| Propose | 11 | Write trial coordinates and clear trial force storage |
| TrialBonds through TrialPairs | 12–15 | Complete trial energy and forces |
| AssessTrial | 16 | Accumulate complete trial gradient norms |
| Decide | 17 | Accept or reject one trial |
| Converged | 18 | Complete accepted gradient meets RMS tolerance |
| Failed | 19 | Explicit stopping limit; does not claim convergence |

`Failure` values are `None=0`, `LineSearchLimit=1`, `IterationLimit=2`, and `StepUnderflow=3`. The second `advanceExperiment` return value is `converged`: it is true only for Converged, never for Failed. Both terminal states seal the working namespace. A failed run retains the last accepted coordinates and complete forces. Input velocities are validated but unused; minimization is not dynamics or thermalization.

## Invalid trials and rollback

A self-call isolates each trial proposal, interaction and force assessment. An exact known numerical-domain error—zero separation, singular geometry, nonfinite arithmetic, unavailable periodic image, invalid geometry, division by zero or negative square root—marks the trial invalid and sends it to rejection. No invalid trial is accepted. Partial trial storage is inactive and is overwritten on the next proposal; the accepted buffer does not change.

An empty revert, out-of-gas, panic or unknown error reverts the whole transaction, including any work completed earlier in that transaction. It does not cause backtracking. This distinction prevents caller-selected gas limits from choosing the numerical trajectory. The self-call endpoints reject direct external calls. Trial Armijo arithmetic uses the same distinction.

## Validation and limitations

`reference/generate_minimizer_reference.py` uses exact rational arithmetic and independent energy finite differences for a three-atom, two-bond harmonic chain. Starting at x coordinates `[0,2,4]`, with unit force constants and rest lengths, its initial energy is 1 and forces are `[+1,0,-1]`. With initial step 4 and Armijo coefficient 1/4:

1. Step 4 gives `[4,2,0]`, energy 1, and is rejected for insufficient decrease.
2. Step 2 gives coincident atoms and is rejected as invalid geometry.
3. Step 1 gives `[1,2,3]`, energy 0 and a complete zero gradient, and converges.

The EVM regression checks this exact path, accepted-state preservation through both rejected trials, differing transaction partitions, already stationary input, explicit iteration/line-search failures, independent configuration/run commitments, authorization, and gas-failure rollback. A further four-atom fixture exercises bonds, angles, torsions, periodic normal pairs, exclusions and direct exceptions: 26 energy/force values before and after one accepted trial are compared against independent 100-digit energy differentiation. The Python harmonic fixture has six independent reference checks. Execution reports record fixture-specific advancement gas only; they exclude deployment, upload and registration costs.

The coordinator runtime exceeds Ethereum's 24 KiB EIP-170 limit. Local integration tests therefore explicitly permit larger bytecode and assert the documented 96 KiB Robinhood target bound. They are not a Robinhood fork or a production deployment, and they do not establish current mainnet availability or suitability. The deployment lane must validate the chain's actual active rules before launch. External audit, prepared-system validation and realistic scale measurements remain separate release requirements.
