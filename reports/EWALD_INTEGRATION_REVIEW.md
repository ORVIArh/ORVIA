# Ewald integration readiness review

Review scope: independent source and test inspection of the current `EwaldDynamicsCoordinator` / `EwaldForceEvaluator` integration. This is not an external security audit, molecular validation, target-chain deployment test, or mainnet approval. The reviewer did not modify the Ewald-owned sources and did not rerun the long EVM integration suite while its owner was already running it.

**Finding:** no concrete force-routing, snapshot-mutation, buffer-publication or stage-transition correctness defect was found in the source snapshot below. Production readiness remains blocked by deployment-limit evidence, final-source execution evidence, realistic workload/scientific validation and integration coverage. The findings distinguish observed defects from unfulfilled readiness evidence; no speculative exploit is asserted.

## Findings and constraints

| ID | Severity / type | Finding and required resolution |
|---|---|---|
| ER-01 | High — deployment constraint | The current coordinator artifact is 30,938 runtime bytes, exceeding the 24,576-byte limit enforced by standard EIP-170 environments. `test/ewald-dynamics.test.mjs` explicitly enables `allowUnlimitedContractSize` and only asserts an assumed 96 KiB target limit. This test cannot prove Robinhood deployment support. Reproduce the exact final compiler artifact and verify the actual target chain's runtime and transaction limits, or split the coordinator. The evaluator artifact is 21,793 bytes. Sizes were independently read from `build/artifacts.json`; its source provenance must still be secured by the final build manifest. |
| ER-02 | High — workload and scientific constraint | Every force evaluation is all-pairs plus explicit reciprocal modes. Small work batches bound individual transactions but do not establish affordable or timely completion, useful electrostatic accuracy, or adequacy for the intended solvated protein. Validate a scientifically justified alpha/cutoff/mode configuration, compare to an established implementation, then measure its complete on-chain workload. The tiny finite-sum fixture is not a substitute. |
| ER-03 | Medium — execution evidence pending | At review time, the owner's isolated dynamics test was still running and `reports/ewald_dynamics_validation.json` did not exist. The owner reported additional numerical guards compiled after that isolated run started. Existing standalone evaluator evidence therefore does not certify the final integrated source. Complete the authoritative all-source compile and integration suite, record source/compiler/artifact identities, and resolve every failure before relying on it. |
| ER-04 | Medium — integration coverage gap | The inspected dynamics fixture exercises ordinary pairs, direct kind-2 exceptions, empty angle/torsion streams, partition changes, partial merge/kick visibility, changed evaluator code, and bad-mass rollback. During review, its owner added interleaved parked snapshots and independent keeper completion to the final test source; these assertions were inspected but had not run in the older isolated process. A kind-1 exclusion and nonempty angle/torsion stages still lack integrated fixture coverage. These branches appear consistent by inspection but need focused execution coverage. This is a test gap, not a demonstrated defect. |
| ER-05 | Low — standalone consumer contract | `forceAt` and `energies` check completion but do not rerun dependency, snapshot or dataset checks on read. The reviewed coordinator performs its own protocol/module/dataset checks before a merge, so no integrated bypass was found. Future standalone consumers should not assume these getters are equivalent to a full provenance assertion; expose/use an explicit assertion if that stronger acceptance guarantee is required. |

A calculation that encounters invalid geometry or unsupported arithmetic reverts its current transaction and remains at the earlier successful checkpoint. There is no explicit failed/aborted terminal state or recovery by changing the frozen model. That preserves correctness but may strand a run permanently; operational tooling must report the revert and avoid presenting an incomplete run as a result.

## Snapshot and identity review

The coordinator is deployed first. Its owner binds a working page once, then binds an evaluator owned by the coordinator. Shared registry, dataset, math, elementary and geometry identities are checked. The coordinator creates the evaluator output page and asks the evaluator factory to create the snapshot page with the coordinator as writer. The factory allowlist and canonical `WorkingStatePage` implementation prevent an arbitrary input contract from satisfying snapshot freezing merely by returning a fabricated `isSealed` flag.

Each force pass copies exactly one atom's coordinates per work unit. The initial pass copies the initial active buffer; subsequent passes copy the fully drifted inactive buffer. No stage writes those coordinates while their snapshot is being copied. The final copy seals the namespace before registration. The evaluator validates the source coverage and frozen namespace, stores page/writer code hashes, and rechecks the source on every advancement. The canonical page cannot subsequently rewrite or unseal the namespace.

The snapshot namespace is domain separated by chain, coordinator address, run state namespace, completed-step count and the initial-pass flag. Initial and first-next snapshots therefore differ despite both having completedSteps=0. Later steps and other experiment IDs also remain distinct. Each evaluator registration receives a monotonic evaluator run ID, captured in the coordinator run; exception lookups are scoped to that ID. Coordinator exception lookups are scoped to its unique state namespace.

Core configuration hashes bind ordered module addresses and runtime hashes. The coordinator's final configuration additionally binds its working page, evaluator identity and configuration, snapshot page and output page. Its run commitment binds chain/address, experiment ID, protocol manifest, dataset ID/commitment, final configuration, dt, step count, alpha, mode extent and state namespace. The protocol manifest itself binds protocol ID. The evaluator commitment independently binds its run identity, manifest, frozen dataset, output configuration and complete source registration/page/writer identity. Immutable source data are addressed on-chain; the commitment is not a claim that a pointer by itself validates an arbitrary mutable data source.

`PeriodicDataset.assertDataset` checks its frozen page records and transitive dynamics dataset. Both advancing paths invoke the registered-module checks; the coordinator also verifies its stored dataset commitment. Registration may accept numerical data that only fail when their bounded validation stage executes; failure still rolls back the entire failing transaction.

## Force routing and accumulator review

`_calculatePair` passes literal zero as charge product for both ordinary and kind-2 exception calls to `SwitchedNonbondedKernel`. Ordinary reaction-field contribution returns zero strength. Direct exception Coulomb receives zero charge product. Consequently this path contributes switched ordinary LJ or unswitched direct-exception LJ only. Kind-1 exclusions skip the entire short-range pair. No additional direct or reaction-field electrostatics were found in the coordinator.

The evaluator visits each unordered pair once. Exception lookup suppresses its screened real-space term, and the exception stage adds the declared correction once. Reciprocal factors still use original particle charges. The self and neutralizing-background terms are separately accumulated. Within each reciprocal mode, all particles contribute C/S before the mode energy and any mode forces are used. The canonical mode enumeration represents one member of each ± pair; no second reciprocal loop was found in the coordinator.

The evaluator output starts in a fresh zero-filled namespace, exposes force/energy getters only after completion, and seals the output in the final Background stage. Partial raw-page reads remain possible and are intentionally not accepted output. The coordinator merges the total Ewald energy only when its merge cursor is zero, then adds one complete atom force per work unit. A failing first merge atom reverts that energy addition as well. On resumption after successful work, a nonzero cursor prevents adding the energy again.

`initialized` becomes true only after every initial electrostatic force has merged. Before then `stateAt` reverts and runInfo's zero energy is a placeholder. Thereafter all drift/force/snapshot/evaluation/merge/kick operations target the inactive buffer; public committed-state reads continue to return the previous complete state. Drift clears the inactive energy once and every inactive atom's force. The final atom's kick flips the active buffer and increments completedSteps atomically. Final completion seals the working namespace. No partial new timestep is published through the committed-state API.

## Stage and gas review

The reviewed coordinator transitions are:

```text
Loading -> validation streams -> initial bonded/LJ streams
 -> InitialSnapshot -> InitialRegister -> InitialEwald -> InitialMerge
 -> Drift -> next bonded/LJ streams -> NextSnapshot -> NextRegister
 -> NextEwald -> NextMerge -> Kick -> Drift or Completed
```

Optional zero-count angle/torsion/exception streams are skipped by a finite sequence of enum increments. Required atom, bond and pair counts ensure that skipping reaches a nonempty stage; no empty-stage infinite loop was found. The Ewald statuses use their own evaluator cursor and do not increment the coordinator's ordinary stage cursor. When a public caller has already completed that evaluator, `_advanceEwald` recognizes completion and moves to Merge without attempting an illegal extra evaluator advancement.

The outer work limit is eight. Each Ewald outer unit advances at most one evaluator unit; register, final-mode energy, and final-stage sealing can cost more than an ordinary cell. Protocol checks include bounded registry scans, and dataset checks include bounded page scans. There is no `gasleft()`-dependent scientific branch. Fixed order is preserved across transaction partitions, but eight units are not a promise that every supported input fits every target transaction gas limit.

For N atoms, E exceptions and K canonical modes, evaluator work is:

```text
N + N*(N-1)/2 + 2*E + K*(1+2*N) + 1
K = ((2*M+1)^3-1)/2
```

At the development maxima N=1,024, E=4,096, M=32, this is 137,312 modes and 281,885,281 evaluator work units per force pass: at least 35,235,661 maximum-eight-unit advancement transactions before coordinator overhead. This is a deterministic operation-count illustration, not a gas or fee quote or a recommendation to run at those limits. T integration steps require T+1 force passes. Every pass retains a separate coordinate snapshot and complete electrostatic output, totaling `(T+1)*(6*N+6)` words of capacity in addition to the active/inactive state page.

## Evidence reviewed

The existing `reports/ewald_validation.json` reports 63 comparisons against the independent high-precision finite-sum reference, maximum absolute error about 1.42e-33, with 1e-27 absolute plus 1e-26 relative tolerance (a separate tail tolerance is declared). This is observed component evidence; it is not proof of the final integrated artifact or converged electrostatic physics.

The integration reference differentiates scalar Ewald + nonzero bond + nonzero LJ energies and applies high-precision velocity Verlet. It includes a two-step ordinary trajectory and a one-step direct-exception trajectory. Inspection confirms the independent oracle includes the interactions whose accidental Coulomb duplication would perturb those trajectories. The test reconstructs core configuration and run commitments independently and compares state checkpoints with an explicit tolerance. The current test also exposes its local contract-size relaxation instead of silently presenting it as a chain deployment test. In response to review, the final test source additionally parks a distinct experiment at its sealed snapshot, permissionlessly completes the other experiment's evaluator, verifies coordinator recognition without prematurely exposing its initial state, and checks that the parked metadata and snapshot words remain unchanged. This closes those source-coverage omissions pending successful execution of the final suite.

Remaining model/integration constraints include orthorhombic fixed-box NVE only in this coordinator, no PME/neighbor-list acceleration, no constraint/thermostat/barostat integration here, no alchemical free-energy acceptance path here, finite supported numerical domains, no established cross-engine molecular benchmark, and no scientific validation for the target cardiac-myosin system. A registered protocol or successful synthetic test does not establish those missing properties.

## Exact reviewed file identities

Hashes below are SHA-256 of source/artifact file bytes, not EVM Keccak runtime hashes. They identify this review snapshot; changes require at least a targeted review update. The main contract hashes were rechecked at the end of inspection.

| File | SHA-256 |
|---|---|
| `contracts/core/EwaldDynamicsCoordinator.sol` | `48f9b079bffc46ab69245f858022ea4b7f7b0f9f507478e57b8b2a1d61dab1d4` |
| `contracts/core/EwaldForceEvaluator.sol` | `f2b8a2a42820cb1915cf484ef4d39bc60f4194a1e562cc2f1d99e61c92e3c025` |
| `contracts/core/WorkingStatePage.sol` | `47441435615ea985ab4b4db97d10efc39da8c945823d38e651c7f454e3c2137a` |
| `contracts/core/ExperimentRegistry.sol` | `39c3e8382b3fae049c16da81b1ea586e36deaa5ecbbda466b8377e240f78f047` |
| `contracts/core/PeriodicDataset.sol` | `1d01a1a4525f637b70781a8264f80e83e8c6686f0d33068b25446ff208fddb6e` |
| `contracts/kernels/SwitchedNonbondedKernel.sol` | `4755fd13b34f2d60b1ea545b79f9a74403e3cd424d6392d357d0a8e2b8d48ac3` |
| `test/ewald-dynamics.test.mjs` | `79700a6daab6ba8ca1d32fce7238ac78d14367d2c8b46b12e2f8cdaf72fa07f0` |
| `test/ewald.test.mjs` | `a7bd9527ff88eae360e68cf4ded6e8baa04cffb6874d5db04539bad8d90ad4d9` |
| `docs/EWALD.md` | `2106427ada304a9c3f35aceb888acb7b0822154e340a6ba08a76d3266769f7d2` |
| `reference/generate_ewald_dynamics_reference.py` | `5dda348dd9453422dda8a23226647431bc227835f7ad97e2a28be06b8844f369` |
| `reference/ewald_dynamics_reference.json` | `4e636df52942d14dafd70a953757f8298829c0c57329f691810f9a58539dc4c9` |
| `reports/ewald_validation.json` | `376a7e5d93a1003a40bba8580c9af1096b358c5b0e4968846c003706afb81d15` |

## Final execution evidence

The subsequent complete source-pinned suite passed all 205 Node/EVM tests, including the current Ewald dynamics cases with keeper advancement and an interleaved parked snapshot. `reports/ewald_dynamics_validation.json` records successful ordinary and direct-exception trajectories; the largest recorded absolute scalar error is 1.56e-33 within its declared fixture tolerances. The scientific truncation, target-chain, scaling and remaining model-coverage limitations above still apply.
