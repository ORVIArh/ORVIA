# Constrained NVE execution

`ConstrainedDynamicsCoordinator` integrates the registered periodic cutoff Hamiltonian with velocity Verlet, onchain SHAKE position constraints, and onchain RATTLE velocity constraints. Constraint inputs, both iterative solves, force accumulation, and the acceptance of a complete timestep are executed by contracts. Transaction callers supply an experiment ID and bounded work count; no caller-supplied trajectory result is accepted.

This coordinator selects constrained NVE dynamics. `LangevinDynamicsCoordinator` remains a separate integrator. Combining its BAOAB splitting with these projection stages would require a separately derived and validated constrained thermostat; this implementation does not claim that capability.

## Deployment and immutable inputs

Deploy `ConstraintCatalog(owner, periodicDataset, math)` and `ConstrainedDynamicsCoordinator(owner, modules, catalog)`. The coordinator's twelve modules have the same tuple order as `NeighborDynamicsCoordinator`:

`registry, dataset, math, integrator, bond, angle, torsion, lj, coulomb, elementary, geometry, nonbonded`.

Here `integrator` is `VelocityVerletKernel`. Deploy the coordinator's `WorkingStatePage`, `NeighborList(writer=coordinator, math, geometry, page)`, `DistanceConstraintKernel(math)`, and `ConstraintSolver(writer=coordinator, math, kernel)`. Only then call owner-only `bindWorkingPage(page, neighbors, solver)` once. Solver construction requires an already-deployed writer. The coordinator checks the solver's writer and math; the solver pins the kernel, math and writer code and verifies its kernel's numerical dependency. The protocol manifest must include every module, the catalog, solver, constraint kernel, coordinator, working page and neighbor list.

The catalog creates a set with `createSet(setId, datasetId, constraintCount)`, appends at most eight `(a,b,distance)` records per transaction with `append`, and freezes exact coverage with `seal`. Records require `a < b`, positive finite target length, and strictly increasing `a*N+b`; duplicated or reversed pairs are rejected. Sets contain 1–16,384 constraints and 2–1,024 atoms, also bounded by the number of distinct pairs. Catalog IDs cannot be reused. Only the catalog owner can author inputs; sealed sets cannot be changed.

Each set binds the periodic dataset ID and frozen dataset commitment, atom/constraint counts, chain, catalog address, dataset/math bytecode hashes and ordered records. A run can only use a sealed set bound to its exact dataset. Authoring a target is scientific input, not evidence that the target or force field is physically appropriate.

Register with `registerExperiment(protocolId, datasetId, parameters)`, with fields in this order:

| Field | Meaning |
|---|---|
| `dt` | Positive finite timestep in the dataset's consistent units |
| `steps` | 1–4,096 committed timesteps |
| `skin` | Positive finite neighbor-list skin |
| `constraintSetId` | Sealed catalog set |
| `positionTolerance` | Positive finite maximum relative squared-distance residual |
| `velocityTolerance` | Positive finite maximum `abs(r·v_relative / |r|²)`, in inverse-time units |
| `maxIterations` | 1–4,096 complete correction/checking passes per solver problem |

The two tolerances have different units and are not interchangeable. Registration accepts explicit user-chosen positive finite tolerances; choosing an overly loose tolerance weakens the numerical result. The validated fixture uses `1e-20` for both in its declared units.

## Coordinate convention and initial preparation

The input must already satisfy all position constraints within `positionTolerance` and all velocity constraints within `velocityTolerance`. The coordinator validates both before the first force evaluation. It does not silently project an unconstrained input into a different initial state.

Finite binary128 inputs alone do not establish a uniform accuracy guarantee. In particular, very large absolute coordinates combined with small displacements can lose precision when reconstructing velocity from position differences. Prepared-system validation must choose coordinate, timestep and mass scales supported by its own error budget; this fixture does not establish such a bound for arbitrary inputs.

Coordinates are consistently unwrapped within each constrained molecule. For every constrained pair, every component of the raw displacement `x_b - x_a` must lie strictly between minus and plus half the corresponding box length. This ensures the constraint displacement equals the unique nearest image used by the periodic force model. The coordinator checks this condition at initialization, before solver sealing for the trial positions, and on the converged projected positions before copying them. Exact half-box ties, wrapped molecules and trial constraints crossing these supported images revert. Whole-molecule translation is permitted when relative displacements remain supported. This deliberately restricted convention does not repair images or track bond winding numbers.

## Timestep order and work accounting

1. Read the complete current force and execute the unconstrained Verlet half kick and drift into the inactive buffer.
2. Create a SHAKE problem. Upload current positions as fixed anchors, trial positions as mutable solver coordinates, dataset masses, and catalog target lengths, one record per work unit. Seal the complete input.
3. Execute bounded solver corrections/checks until convergence. Validate projected constraint images. Copy projected positions to the inactive buffer and reconstruct each half-step velocity as `(x_projected - x_old)/dt`.
4. Prepare/reuse the neighbor list for the complete projected geometry, then accumulate every bond, angle, torsion and candidate pair force and the matching energy.
5. Execute the final unconstrained half kick. Create a RATTLE problem with the projected positions as fixed anchors, post-kick velocities as solver coordinates, the same masses/pairs, and canonical zero constraint-distance fields.
6. Solve to the registered velocity tolerance. Copy every projected velocity into the inactive buffer. Only after the last copy, atomically flip the active buffer and increment the committed step.

`advanceExperiment(id, workLimit)` is permissionless with 1–8 work units. Each atom upload, constraint upload, image check, solution copy, integration update or interaction is one unit. Problem creation is one unit. Solver correction/check records and neighbor-list preparation use their own bounded work accounting. There are no unbounded per-step atom or constraint loops in an advance call.

Any account may call the solver's own `advance(problemId, workLimit)`. The coordinator accepts this progress after checking the exact solver source commitment, frozen input commitment, mode, atom/constraint counts, complete upload counts, tolerance, iteration limit and terminal status. No external account can create or upload the coordinator's problems. Problems derive identity from the run namespace, committed step number and mode; input source commitments bind the complete immutable run configuration.

| Status | Value | Meaning |
|---|---:|---|
| Loading | 1 | Load frozen initial positions and velocities |
| ValidatingBonds through ValidatingExceptions | 2–5 | Validate force topology |
| ValidatingConstraints | 6 | Validate initial lengths, tangent velocities and images |
| PreparingInitial | 7 | Prepare initial neighbor list |
| InitialBonds through InitialPairs | 8–11 | Complete initial force and energy |
| Drift | 12 | Unconstrained trial half kick/drift |
| CreatePosition through UploadPositionConstraints | 13–15 | Create and upload SHAKE problem |
| SolvePosition | 16 | Execute/check SHAKE convergence |
| CheckPositionImages / ApplyPosition | 17 / 18 | Validate and copy projected geometry/half velocities |
| PreparingNext | 19 | Prepare neighbor list at projected geometry |
| NextBonds through NextPairs | 20–23 | Complete projected force and energy |
| Kick | 24 | Final unconstrained half kick |
| CreateVelocity through UploadVelocityConstraints | 25–27 | Create and upload RATTLE problem |
| SolveVelocity / ApplyVelocity | 28 / 29 | Solve and copy projected velocities |
| Completed / Failed | 30 / 31 | Terminal successful run or solver nonconvergence |

## Failure and visibility

`stateAt` and `runInfo` expose the active committed buffer. Its coordinates and velocities never change during either iterative projection or partial force accumulation. As in the other coordinators, initial loading and initial force construction are preparation stages; an initial complete dynamical checkpoint is available at `Drift`.

If either solver exhausts its iteration limit, the coordinator records `Failed`, seals the working namespace and leaves the last committed state and complete current forces intact. Solver partial coordinates remain inspectable but `solutionAt` rejects them. A failed run cannot continue or change its numerical parameters. Arithmetic errors, unsupported geometry and out-of-gas revert the transaction, including earlier work in that transaction; previous successful work remains. Gas limits cannot approve an incomplete solve or timestep.

## Independent validation and scope

`reference/constrained_trajectory.py` uses 100-digit mpmath, energy differentiation for forces, a simultaneous nonlinear multiplier root solve for positions, and a dense mass-weighted linear projection for velocities. These differ from the contract's sequential pair corrections. The three-atom fixture has masses `[16,1,1]`, two unit O-H constraints, nonzero constrained bond springs and an unconstrained angle potential. Its tangent initial velocities combine translation and rotation. Two timesteps at `dt=1/32` are checked at three complete checkpoints: 84 position, velocity, force and energy scalars, both residuals, momentum, ballistic center of mass and total energy drift. The ideal high-precision fixture energy drift is approximately `1.31e-9`; the test does not assert exact NVE energy conservation at finite timestep.

The contract suite also checks exact final bytes across transaction partitions, direct public solver advancement, iteration failure, gas rollback, initial and trial image rejection, independent catalog/configuration/run/source commitments, and authoring/solver permissions. Reports record local advancement gas, including explicitly advanced solver transactions, and exclude deployment, dataset upload and registration.

The coordinator exceeds Ethereum's 24 KiB EIP-170 runtime limit. Its dedicated local Ganache fixture explicitly allows larger code and asserts runtime below the documented 96 KiB Robinhood planning bound. This is not a Robinhood fork or deployment result. Prepared-system validation, realistic scale/gas measurements, equilibrium sampling evidence, external audit and current chain deployment checks remain separate release gates.
