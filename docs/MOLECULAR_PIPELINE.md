# Connected hybrid molecular pipeline

This branch connects registered endpoint inputs, a complete declared finite Hamiltonian, unconstrained BAOAB dynamics, immutable molecular snapshots, cross-state energies, chronology, deterministic sample selection and MBAR. **Implementation and small-fixture validation are not ORVIA-001 scientific acceptance or mainnet readiness.** Full prepared-system coverage, a justified physical protocol, ensemble/error validation, computational feasibility and release review remain separate requirements.

## Endpoint data and Hamiltonian

`AlchemicalTopologyCatalog` binds sealed `PartitionedInputCatalog` streams, explicit model/dummy policies, box, nonbonded parameters and the ordered lambda schedule. Incremental validation checks every atom and interaction record. It requires aligned hybrid atom/interaction indices, identical positive masses and initial velocities, exact declared exception ordering, finite numerical values and supported parameter domains. It does not certify that a parameter family or molecular state is scientifically appropriate.

Streams contain binary128 words and integer indices:

| Stream | Words per record | Fields |
|---|---:|---|
| Positions | 3 | x, y, z |
| Particles | 4 | mass, vx, vy, vz |
| Nonbonded | 3 | sigma, epsilon, charge |
| Bonds | 4 | a, b, k, r0 |
| Angles | 5 | a, b, c, k, theta0 |
| Periodic torsions | 7 | a, b, c, d, periodicity, k, phase |
| Exceptions | 6 | a, b, kind, sigma, epsilon, desired charge product |

Units are nm, ps, Da, kJ/mol and radians. Harmonic bond/angle energies include the factor 1/2. Periodic impropers can use the torsion form only when their actual source ordering and sign convention have been independently verified. Unsupported CMAP, Urey–Bradley or harmonic-improper terms must not be silently dropped by an importer.

`AlchemicalHamiltonianEvaluator` reads one frozen source snapshot and computes forces and component energies through bounded stages:

1. Validate atom positions, interpolate charges and compute Ewald self terms.
2. Evaluate all harmonic bonds, angles and periodic torsions under both endpoint parameter sets and linearly combine their energies/forces. Zero coefficients are skipped; at lambda 0/1 only the selected endpoint is evaluated.
3. Evaluate explicit LJ/electrostatic exceptions, then the remaining unordered pairs.
4. Compute the full declared finite reciprocal mode cube, self/background/exception corrections and total energy.
5. Seal output forces and energies before any result getter accepts them.

For normal LJ pairs, endpoint mixing uses arithmetic sigma and geometric epsilon. Identical endpoint pair parameters use ordinary LJ. Changed pair parameters use the existing two-endpoint soft-core model with `rhoA=r^6+alpha*sigmaA^6*lambda^2` and `rhoB=r^6+alpha*sigmaB^6*(1-lambda)^2`, followed by the registered quintic radial switch. Direct exception LJ is uncut. Charges interpolate as `q(lambda)=(1-lambda)*qA+lambda*qB`; desired exception charge products interpolate independently between their explicitly registered endpoint values. The reciprocal and correction terms use those same interpolated charges. This is an explicitly defined intermediate Hamiltonian, not a claim that it duplicates every package's default alchemical convention.

Electrostatics is finite tin-foil Ewald: screened real pairs, explicit reciprocal modes, self energy, uniform neutralizing-background energy and pair-exception corrections. It is not PME or automatically converged electrostatics. Ewald cutoff/mode refinement and charged-cell treatment require physical validation. The fixed-box switched LJ model has no silently added dispersion-tail correction. Both must match the independent reference settings.

Mathematically zero LJ/charge interactions are skipped so inactive zero-strength atoms do not acquire artificial separation constraints. True active singularities still fail. A disappearing atom also needs a scientifically declared confined dummy network or correct phase-space correction. Zeroing its nonbonded/bonded terms is not, by itself, a valid RBFE endpoint.

## Real simulation and checkpoint lineage

`MolecularSimulationPipeline` is the immutable writer for a `ShardedWorkingState` router. It binds one Hamiltonian evaluator, collector, chronological analyzer and MBAR estimator. Constructors and every advancement check actual dependency identities through the registered protocol. No EOA-facing method accepts forces, energies or sample matrices.

Each window reads its initial position/velocity data from the sealed topology. The same complete Hamiltonian supplies both the sampled-state force and every cross-state sample energy. BAOAB uses the registered mass, dt, friction, kT, seed, stream and lambda-specific replica number. A mutable namespace uses `9*N+1` words. Immutable COW snapshots preserve complete committed position/velocity/force/energy states; a partial drift or force import cannot replace `stateAt`'s committed view.

The stochastic counter is the absolute uint64 timestep. `continueWindow(parent)` accepts only the current window at a complete-state barrier. It records the parent commitment/checkpoint, marks the old run handed off, copies the exact immutable source state through bounded work and continues with the same absolute counter. Callers cannot supply replacement coordinates, velocities, a new seed or a reset step. The old parent remains readable. Large overall durations are not truncated to the historical 4,096-step coordinator cap; they still need a measured feasible scientific schedule.

This pipeline currently uses an unconstrained fixed-volume ensemble. It does not silently compose SHAKE/RATTLE, a barostat or a minimizer. A chosen molecular model must justify this path and timestep, or the required composition must be implemented and validated before release. Input coordinates that require minimization are not claimed minimized by loading them.

## Molecular samples and analysis

After each retained complete timestep, the writer freezes the exact source snapshot and computes every registered lambda energy on that same configuration. The record retains the snapshot commitment, run lineage, absolute timestep, state and actual evaluation commitments, plus the exact computed energy words. The sampled-state force evaluation reads the frozen post-drift position snapshot; the final committed snapshot adds only the force and final velocity fields, preserving every position word. Other state energies read that final snapshot. Both snapshots remain readable, so this position-preserving transition can be replayed rather than inferred from equal labels. Sampling/force work is paused while cross-state evaluation is incomplete. Failure rolls back the current transaction; previously committed states and registered incomplete evaluation/run history remain available. An EVM revert is not silently converted into a completed sample.

Window interleaving cannot choose the MBAR matrix's floating-point summation order. Raw samples are materialized only in canonical state-major/chronological order after all preregistered windows finish. The collector never receives off-chain energies. Exact original energies remain retained; selection does not reconstruct them from rounded reduced potentials.

The chronological observable is the sampled-state potential energy. After its complete analysis, invalid/constant/short/truncated estimates block selection. The preregistered rule selects every `ceil(g)`th retained sample in each state and requires the registered ESS threshold before creating a selected matrix. MBAR then consumes this selected immutable series. This finite-sample rule is not proof that every slow molecular observable has equilibrated or become independent; the scientific protocol must justify additional observables, adequate correlation windows and repeat-level uncertainty. MBAR convergence and weight ESS remain separate from temporal correlation and biological validity.

Inherited analysis limits remain explicit: at most 16 lambda states and 4,096 raw samples per series, with the existing centered reduced-potential domain. A real campaign must demonstrate scientifically adequate coverage within these domains or extend the algorithms with validation. The engine must never shorten sampling, clip energies or discard inconvenient frames merely to pass those guards.

## Verification

`reference/hybrid_hamiltonian.py` independently differentiates a 90-digit scalar Hamiltonian. Its reciprocal reference sums the full mode cube, unlike the contract's half-space traversal. `test/molecular-pipeline.test.mjs` exercises complete endpoint/intermediate force categories, actual stochastic continuation, immutable parent state, varied transaction partitions and window interleaving, canonical on-chain matrices, and rejection of inadequate chronology. Generated evidence identifies its own exact fixture and validation status. No small fixture is a prepared cardiac-myosin experiment, converged ensemble, sufficient uncertainty estimate or mainnet fee quote.

The corrected initial targeted run passed **4/4 Node tests**, without skips or failures. At lambda 0, 0.5 and 1, all 10 energy values and 12 force components matched the independent reference with maximum absolute errors below `2.24e-33` (registered test criterion `1e-25` absolute plus `1e-24` relative). Its two-atom, two-state continuation fixture retained eight samples over five absolute timesteps and reproduced the same state/matrix words across continuation and scheduling changes.

Those tests intentionally reject inadequate chronological evidence. They do **not yet** demonstrate a complete accepted chronology/selection/MBAR molecular campaign, a long-time equilibrium distribution, minimization or a full prepared myosin workload. The first rejected implementation exposed a real bond-force memory-alias bug; the corrected helper and independent full-force rerun resolve that numerical failure. This is why trajectory reproducibility by itself is insufficient physical validation.

The combined targeted scenarios used 580 advancement transactions and 973,864,652 local EVM gas, excluding deployment and input preparation. This is an aggregate over three charged static Hamiltonian checks and two stochastic campaign schedules, not one timestep, a protein estimate, target throughput or a mainnet monetary quote. Subsequent performance changes must preserve the validated mathematical path and be measured separately.
