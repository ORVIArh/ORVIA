# ORVIA v0.6.0-dev status

**Active target: [ORVIA-256](docs/ARCHITECTURE_256.md), fully on-chain production from large registered molecular models.** The user removed the dollar cap and selected up to 256 actual contracts. The current design budgets 32 core contracts, 96 input banks, 64 pipeline-state banks and 64 Hamiltonian-output banks. Eight core integrations remain required; the connected prototype is not a finished 256-contract release. The single-result-anchor route is not selected.

**Current integration is in progress; the complete current-source check has not passed.** [validation_summary.json](reports/validation_summary.json) is deliberately marked `development_in_progress` and `passed: false` after the connected engine and softcore-v2 changes. A previous source-bound component checkpoint cannot validate changed or newly added inputs.

The historical v0.5.1 check passed **212 Node/EVM tests, 63 Python references and all nine groups**, with integrity checks for 159 inputs, two compiler outputs, 36 reports and nine logs. That dated result and the recovered v0.5.0 baseline remain in the research log; neither is a pass for this development snapshot.

**Not ready for mainnet.** The connected development pipeline now supplies a finite hybrid Hamiltonian, unconstrained sampling, computed cross-state energies, sample selection and MBAR. Sharded input/state and absolute-counter continuation extend the historical capacity guards. These are implementations and small-fixture results, not a complete accepted cardiac-myosin campaign. The older 64-slot manifest is retained as historical design evidence; the active 256-address inventory includes every router and factory-created bank. None has been deployed to Robinhood.

## Implemented development capabilities

This inventory combines historical components with current development candidates. See [the connected pipeline](docs/MOLECULAR_PIPELINE.md) and [sharded state](docs/SHARDED_STATE.md) for exact implementation boundaries.

| Lane | Implemented behavior | Evidence and limits |
|---|---|---|
| Neighbors | Deterministic bounded rebuild/reuse, neighbor NVE and selectable pinned inline pair arithmetic | Bitwise trajectory comparison; targeted inline integration suite passes 11 tests; rebuild remains quadratic |
| Stochastic dynamics | Bounded scalar functions, counter random stream and BAOAB integration | High-precision references, seeded trajectories and zero-friction comparison |
| Constraints | Sealed constraint data, bounded SHAKE/RATTLE and constrained NVE | Independent simultaneous multiplier/projection oracle; explicit failure and atomic commit |
| Ewald | Screened real forces, direct reciprocal sums, corrections and snapshot-based NVE | Independently differentiated energies/trajectories; production truncation calibration missing |
| Minimization | Complete forces, gradient RMS and Armijo trials | Independent reference and rollback tests; no off-chain minimization outputs accepted |
| Alchemical math | Finite endpoint-mixed Hamiltonian, unconstrained BAOAB sampling and softcore/MC primitives | Independent small-fixture energies, derivatives and continuation checks; full prepared-system/protocol acceptance missing |
| Analysis | Computed cross-state energies, canonical chronology, correlation-based selection, MBAR and paired-repeat primitives | Connected development sampler; full-system equilibration, overlap and repeat uncertainty remain unvalidated |
| Scaling | Authenticated input streams, sharded COW state, immutable snapshots and absolute-counter continuation | Capacity/cross-page tests and local gas; no complete prepared-system gas/time acceptance |
| Preparation | Reproducible ligand map and selected coordinate candidates; alternative cofactor model audit | Full model preparation remains blocked; source checks reproducible offline |
| Deployment and cost | Local deployment rehearsal, runtime/source verification, unsigned quote tools, strict release gate and inline pair integration | Local state-fork kernel smoke only; no Robinhood execution-client rehearsal or complete production fee quote; feasibility gap remains |

[validation_summary.json](reports/validation_summary.json) is the authority for the final full-suite result, with detailed logs and numerical/gas reports beside it. Parallel engineering review does not substitute for an independent security audit. Local acceptance is not evidence of sufficient physical sampling or a medicinal claim.

## Work that still blocks a release

1. Freeze a scientifically justified complete protein/ligand/solvent model with compatible parameters, special-state treatment and a hybrid topology. The 24-atom map alone is insufficient.
2. Complete the chosen protocol around the connected finite Hamiltonian/unconstrained sampler, including justified minimization/equilibration and any required constraints or volume/replica proposals. The current fixed-volume unconstrained path does not silently supply those capabilities.
3. Validate the implemented state/input partitioning and retained continuation at the complete prepared-model workload. Demonstrate a scientifically sufficient schedule within an explicit measured gas/time/fee budget.
4. Validate the complete Hamiltonian and ensemble against independent references, then demonstrate equilibration, overlap, temporal correlation control and repeat uncertainty on the actual declared experiment.
5. Complete independent security review and a reproducible target-chain deployment/fork/source-verification rehearsal. Bind the final public operator address, nonce sequence and fresh live quotes to the reviewed production plan.

[PRODUCTION_GAPS.md](docs/PRODUCTION_GAPS.md) gives concrete acceptance criteria. [MAINNET_READINESS.md](docs/MAINNET_READINESS.md) describes which evidence is code-local, scientific, network-dependent or operator-dependent. Read-only mainnet RPC now succeeds through the documented Pinax provider; the official public endpoint probe still fails. Two numerical kernels also pass a block-pinned local state-fork smoke check. That check uses local Ethereum Shanghai rules, so full Robinhood execution-client and prepared-model acceptance remain missing. Public production deployment configuration is also unresolved.

## 2 November 2026 continuation

The source was recovered into a persistent local Git checkout. Neighbor NVE now explicitly admits the pinned inline pair runtime, with unchanged state/commitment barriers and new complete-fixture equivalence, interruption and rejection checks. See [compute costs](docs/COMPUTE_COST.md) for measured scope. The alternative public-model audit now detects the topology/PDB atom mismatch and verifies cofactor charge conventions. Its separately named ADP/phosphate protocol remains an unapproved proposal; the original vanadate-containing ORVIA-001 model remains selected and blocked. [Release notes](docs/RELEASE_v0_5_1.md), [roadmap](ROADMAP.md) and [research log](RESEARCH_LOG.md) track the changes and remaining work.

The targeted neighbor suite passed **11/11 tests**, with zero failures or skips. The identical four-atom, three-step NVE fixture used **66,727,850 gas** through the original pair kernel and **65,446,162 gas** through the pinned inline kernel, a **1.92% advancement saving**. This excludes deployment, inputs and registration. The larger 51–53% figure concerns pair-only microbenchmarks; neither result establishes full-system feasibility. Current complete-suite acceptance remains separately governed by `validation_summary.json`.

A separate [actual target-node read-only probe](docs/TARGET_NODE_EXECUTION.md) passed runtime and exact numerical-return checks for two kernels, with zero broadcasts. This extends the network evidence beyond the local state fork; full molecular/transaction execution acceptance remains unfinished. The supplementary harness and report are distributed separately from the offline source-bound suite.
