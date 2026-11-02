# ORVIA architecture and deployment accounting

**Superseded deployment allocation:** the active target is now the [256-contract design](ARCHITECTURE_256.md), with every storage bank counted and no fixed dollar cap. This document retains the earlier 64-slot role plan and component history. Its old deployment counts and capacity observations are not the current allocation.

The target is fully on-chain scientific execution from registered inputs on Robinhood Chain mainnet, chain 4663. Direct permissionless bounded calls trigger progress. A contract cannot wake itself up: a user or transaction submitter must call the advancement entry point and pay gas. Submission does not authorize supplying off-chain forces, trajectories or scientific results. Pool/swap-triggered submission is deferred.

The draft design retains 64 production instances, above the requested minimum of 50. The count is a design constraint, not evidence of massive data, scientific accuracy or parallel chain throughput. The actual prepared model and final algorithms may require revising partitions while retaining the requested minimum. Empty or redundant contracts must not be used as evidence of computational scale.

| Category | Planned instances | Meaning |
|---|---:|---|
| Control | 4 | Registry, input catalog, simulation orchestration and work scheduling |
| Compute | 24 | Numerical, force, integration, constraint, sampling and ensemble roles |
| Input storage | 16 | Sealed typed molecular, parameter, protocol and provenance partitions |
| Working storage | 16 | State buffers, forces, lists, electrostatics, constraint and analysis workspaces |
| Analysis | 4 | Sample collection, MBAR, diagnostics and final uncertainty |
| **Total** | **64** | **Planned addresses, not completed or deployed contracts** |

The manifest distinguishes deployment dependencies from later immutable configuration bindings, preventing the coordinator/page writer relationship from becoming a constructor cycle. Each intended slot has one instance, explicit roles, dependencies and evidence fields. The design validator rejects duplicate slots, cycles, unsupported implementation claims and inflated experimental counts.

## Current component architecture

There are 44 deployable experimental product types. Some implement multiple provisional roles; others are alternative paths. Their exact source/count evidence is in `data/contract_manifest.json` and `reports/compiled_sizes.json`.

| Execution path | Connected features | Main omitted production integration |
|---|---|---|
| `DynamicsCoordinator` | Finite listed interactions and Verlet | Periodic full model |
| `PeriodicDynamicsCoordinator` | Fixed box, exhaustive pairs, switched LJ/RF and Verlet | Scale/ensemble/alchemy |
| `NeighborDynamicsCoordinator` | Same Hamiltonian with cached list traversal | Quadratic rebuild and complete production protocol |
| `LangevinDynamicsCoordinator` | Neighbor path plus counter-based BAOAB | Constraints, Ewald and alchemy |
| `ConstrainedDynamicsCoordinator` | Neighbor NVE plus SHAKE/RATTLE | Thermostat, Ewald and alchemy |
| `EwaldDynamicsCoordinator` | LJ/bonded Verlet plus complete frozen-snapshot direct Ewald | Constraints, thermostat, neighbor acceleration and alchemy |
| `PeriodicMinimizer` | Force/RMS assessment and bounded Armijo trials | Handoff into one complete selected production protocol |

The original harmonic-only engines remain regression fixtures. The analysis contracts form a separate tested graph rooted in immutable-writer sample collection. No current production simulation writer supplies the final complete alchemical reduced-potential matrix. Time-series diagnostics do not automatically select decorrelated MBAR input. Softcore and Monte Carlo acceptance primitives do not themselves implement state proposals or a sampler.

Direct Ewald does not implement the draft PME mesh/transform roles K13–K17. Their planned status is intentionally retained rather than falsely mapping explicit Fourier sums to mesh/FFT implementations. The final release architecture must reconcile its selected scientific algorithm, scale and justified address inventory. The generic `WorkingStatePage` type is not evidence that all sixteen production working-state roles are finished.

## Identity and execution barriers

Input page factories, canonical schemas, ordered hashes, immutable writers and one-time bindings establish the development inputs and module identities. Existing runs cannot silently substitute a new module or protocol. Register, upload, validate and freeze operations precede permissionless calculation. Bounded advances perform deterministic on-chain operations; transaction size and sender must not change summation order or random-stream addressing.

Dynamics paths keep current and staged buffers separate. A failed transaction rolls back its own cross-contract writes while preserving earlier valid checkpoints. A timestep becomes visible only after its final completion barrier. Constraint nonconvergence and analysis failure are explicit outcomes, not scientific success. Ewald forces consume sealed factory-issued snapshots; its output is unavailable until the entire force pass completes. Terminal namespaces seal against further mutation.

Current development limits include 1,024 atoms and 4,096 steps in the dynamics paths and 65,536 words per working namespace. The actual solvated target is not accommodated or costed by these limits. More pages require bounded indexes and validated complete coverage, not unbounded scans. Neighbor rebuild still screens all unordered pairs; direct reciprocal sums require calibrated cutoffs and scale measurements. Random draws are keyed by registered experiment/stream, seed, replica, step and counter rather than timestamp, sender, swaps or block randomness.

## Release evidence

| Gate | Required evidence |
|---|---|
| Architecture | Justified instance count, supported concrete roles, acyclic deploy graph and immutable configuration |
| Code | Exact compiler input, source hashes, constructor arguments, measured runtime/initcode and target limits |
| Scientific inputs | Complete accepted model, compatible parameters, hybrid map, nonempty sealed pages and provenance |
| Full integration | One approved pipeline connecting all chosen Hamiltonian, ensemble, sampling and analysis stages |
| Numerical/scientific validation | Independent full-model references, declared error budget, stability, sampling/overlap/correlation and complete repeats |
| Scale and cost | Maximum-sized bounded work, full-run operation counts, actual target estimates and explicit feasible gas/time/fee budget |
| Security/execution | Cross-run isolation, adversarial inputs, rollback/retry, all barriers, permission/code identity and independent review |
| Deployment | Live target verification, target fork, exact public deployer/nonce plan, source-verification rehearsal and current quotes |

`python3 scripts/validate_manifest.py --self-test` checks the design. `python3 scripts/validate_manifest.py --require-ready` and `node scripts/deploy.mjs --readiness` must reject this release candidate. No number of individually passing component tests substitutes for these missing end-to-end requirements.

Four experimental runtimes exceed Ethereum's 24 KiB ceiling. Local tests relax this restriction explicitly and compare against Robinhood's documented 96 KB planning value (treated as KiB). The documented 192 KB initcode limit includes constructor data in deployment checks. Exact live limits and fork execution remain unverified; local relaxed Ganache results are not that evidence.

Robinhood sources: [connection](https://docs.robinhood.com/chain/connecting/), [chain differences](https://docs.robinhood.com/chain/differences-from-ethereum/), [fees](https://docs.robinhood.com/chain/gas-and-fees/), [deployment](https://docs.robinhood.com/chain/deploy-smart-contracts/). Read-only RPC now succeeds through the documented Pinax provider, while the official public endpoint probe remains unsuccessful. The local state-fork kernel smoke uses Shanghai rules and does not establish Robinhood Nitro execution, a full molecular calculation or production deployment.
