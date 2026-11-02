# ORVIA v0.6.0-dev status

**Active target: [ORVIA-256](docs/ARCHITECTURE_256.md), fully on-chain production from large registered molecular models.** The user removed the dollar cap and selected up to 256 actual contracts. The current design budgets 32 core contracts, 96 input banks, 64 pipeline-state banks and 64 Hamiltonian-output banks. The complete 256-address inventory now has a passing local integration fixture. The raw C4 component is exercised separately and still requires physical alchemical integration; this is not a production release. The single-result-anchor route is not selected.

**Mainnet only.** No public testnet deployment is planned. Local EVM checks, mainnet-pinned local forks and read-only chain-4663 simulations remain part of validation. Public deployment stays blocked until the complete 256-contract release and scientific evidence pass.

The [256-address release planner](docs/RELEASE_256_PLAN.md) now produces an unsigned infrastructure candidate for the public operator. It binds exact constructors, dependencies, fixed-bank identities and configuration calls while retaining unresolved production protocol/input fields and all acceptance blockers. It neither accesses the encrypted wallet nor broadcasts transactions.

**Current integration is in progress; the complete current-source check has not passed.** [validation_summary.json](reports/validation_summary.json) is deliberately marked `development_in_progress` and `passed: false` after the connected engine and softcore-v2 changes. A previous source-bound component checkpoint cannot validate changed or newly added inputs.

The historical v0.5.1 check passed **212 Node/EVM tests, 63 Python references and all nine groups**, with integrity checks for 159 inputs, two compiler outputs, 36 reports and nine logs. That dated result and the recovered v0.5.0 baseline remain in the research log; neither is a pass for this development snapshot.

**Not ready for mainnet.** The connected development pipeline now supplies a finite hybrid Hamiltonian, bounded spatial indexing, constrained or unconstrained sampling, computed cross-state energies, sample selection and MBAR. Sharded input/state and absolute-counter continuation extend the historical capacity guards. These are implementations and small-fixture results, not a complete accepted cardiac-myosin campaign. The older 64-slot manifest is retained as historical design evidence; the active 256-address inventory includes every router and factory-created bank. None has been deployed to Robinhood.

## Implemented development capabilities

This inventory combines historical components with current development candidates. See [the connected pipeline](docs/MOLECULAR_PIPELINE.md) and [sharded state](docs/SHARDED_STATE.md) for exact implementation boundaries.

| Lane | Implemented behavior | Evidence and limits |
|---|---|---|
| Neighbors | Deterministic bounded rebuild/reuse, neighbor NVE and selectable pinned inline pair arithmetic | Historical inline/NVE tests plus the new ordered periodic-cell path; guarded finite-domain completeness and exact Hamiltonian parity checks |
| Stochastic dynamics | Bounded scalar functions, counter random stream and BAOAB integration | High-precision references, seeded trajectories and zero-friction comparison |
| Constraints | Sealed constraint data, bounded SHAKE/RATTLE and constrained NVE | Independent simultaneous multiplier/projection oracle; explicit failure and atomic commit |
| Ewald | Screened real forces, direct reciprocal sums, corrections and snapshot-based NVE | Independently differentiated energies/trajectories; production truncation calibration missing |
| Minimization | Complete forces, gradient RMS and Armijo trials | Independent reference and rollback tests; no off-chain minimization outputs accepted |
| Alchemical math | Finite endpoint-mixed Hamiltonian, unconstrained BAOAB sampling and softcore/MC primitives | Independent small-fixture energies, derivatives and continuation checks; full prepared-system/protocol acceptance missing |
| Analysis | Computed cross-state energies, canonical chronology, correlation-based selection, MBAR and paired-repeat primitives | Connected development sampler; full-system equilibration, overlap and repeat uncertainty remain unvalidated |
| Scaling | Authenticated input streams, sharded COW state, immutable snapshots and absolute-counter continuation | Capacity/cross-page tests and local gas; no complete prepared-system gas/time acceptance |
| Preparation | Reproducible ligand map and selected coordinate candidates; alternative cofactor model audit | Full hybrid streams are assembled and independently checked; parameter/protocol and C4 transformation acceptance remain blocked |
| Deployment and cost | Local deployment rehearsal, runtime/source verification, unsigned quote tools, strict release gate and inline pair integration | Local state-fork kernel smoke only; no Robinhood execution-client rehearsal or complete production fee quote; feasibility gap remains |

[validation_summary.json](reports/validation_summary.json) is the authority for the final full-suite result, with detailed logs and numerical/gas reports beside it. Parallel engineering review does not substitute for an independent security audit. Local acceptance is not evidence of sufficient physical sampling or a medicinal claim.

## Work that still blocks a release

1. Freeze a scientifically justified complete protein/ligand/solvent model with compatible parameters, special-state treatment and a hybrid topology. The 24-atom map alone is insufficient.
2. Complete the chosen protocol around the connected finite Hamiltonian/unconstrained sampler, including justified minimization/equilibration, full-model constraints, C4 activity/coupling and any required volume/replica proposals. Constrained fixed-volume integration is now connected and tested on small fixtures; full-model parameter and ensemble acceptance remain required.
3. Validate the implemented state/input partitioning and retained continuation at the complete prepared-model workload. Demonstrate a scientifically sufficient schedule within an explicit measured gas/time/fee budget.
4. Validate the complete Hamiltonian and ensemble against independent references, then demonstrate equilibration, overlap, temporal correlation control and repeat uncertainty on the actual declared experiment.
5. Complete independent security review and a reproducible target-chain deployment/fork/source-verification rehearsal. Bind the final public operator address, nonce sequence and fresh live quotes to the reviewed production plan.

[PRODUCTION_GAPS.md](docs/PRODUCTION_GAPS.md) gives concrete acceptance criteria. [MAINNET_READINESS.md](docs/MAINNET_READINESS.md) describes which evidence is code-local, scientific, network-dependent or operator-dependent. The operator-supplied Alchemy RPC now passes read-only mainnet chain, block and gas-price checks; the private endpoint path is omitted from reports. Two numerical kernels also pass a block-pinned local state-fork smoke check. That check uses local Ethereum Shanghai rules, so full Robinhood execution-client and prepared-model acceptance remain missing. Public production deployment configuration is also unresolved.

## 2 November 2026 continuation

The source was recovered into a persistent local Git checkout. Neighbor NVE now explicitly admits the pinned inline pair runtime, with unchanged state/commitment barriers and new complete-fixture equivalence, interruption and rejection checks. See [compute costs](docs/COMPUTE_COST.md) for measured scope. The alternative public-model audit now detects the topology/PDB atom mismatch and verifies cofactor charge conventions. Its separately named ADP/phosphate protocol remains an unapproved proposal; the original vanadate-containing ORVIA-001 model remains selected and blocked. [Release notes](docs/RELEASE_v0_5_1.md), [roadmap](ROADMAP.md) and [research log](RESEARCH_LOG.md) track the changes and remaining work.

The targeted neighbor suite passed **11/11 tests**, with zero failures or skips. The identical four-atom, three-step NVE fixture used **66,727,850 gas** through the original pair kernel and **65,446,162 gas** through the pinned inline kernel, a **1.92% advancement saving**. This excludes deployment, inputs and registration. The larger 51–53% figure concerns pair-only microbenchmarks; neither result establishes full-system feasibility. Current complete-suite acceptance remains separately governed by `validation_summary.json`.

A separate [actual target-node read-only probe](docs/TARGET_NODE_EXECUTION.md) passed runtime and exact numerical-return checks for two kernels, with zero broadcasts. This extends the network evidence beyond the local state fork; full molecular/transaction execution acceptance remains unfinished. The supplementary harness and report are distributed separately from the offline source-bound suite.

## Latest 256-address checkpoint

All **256 actual contracts** were deployed locally: 32 core components and 224 storage banks. The [complete fixture](docs/COMPLETE_256_PROTOTYPE.md) passed authenticated constrained sampling through spatial force evaluation and one two-state analysis through accepted MBAR diagnostics. All three factory nonces remained unchanged during the runs. Three paired repeats were preregistered; this fixture did not complete the other five campaigns or their final repeat uncertainty. Raw C4 was evaluated independently and is not yet part of the alchemical Hamiltonian.

Local core and bank deployment used **183,998,164 gas**, excluding configuration, model upload and campaign execution. Both large coordinator creation calls returned exact runtime bytes through the [Robinhood provider](docs/TARGET_256_CREATION_PROBE.md). These were read-only simulations, not mainnet deployments or fee guarantees. The complete current-source full suite and scientific production gates remain open.

The [dated infrastructure and input cost evidence](evidence/256-costs/README.md) now covers all 91 infrastructure transactions with individual conditional mainnet estimates: **186,177,439 gas**. The existing 24 input streams require **85,243 upload transactions** with the current 128-word batches. A separately calibrated projection prices infrastructure plus those uploads at **$8,937–$8,965** using the recorded 2 November gas and ETH/USD prices. This excludes unresolved input additions, model initialization and all campaign execution; it is not a complete production budget. Lossless storage compression is being audited separately and is not implemented by the quoted contracts.

The [completed lossless storage audit](evidence/256-input-compression/README.md) reconstructs every one of the **10,903,836 original words** exactly. Shared endpoint bases with 466 patches and exact typed packing project **10,818 upload transactions**, versus 85,243 today, while retaining the full model and binary128 calculation arithmetic. These are storage-format projections; the new on-chain reader, commitments and upload API are not implemented or gas-measured. The proposed format fits the existing 32-core/224-bank architecture and excludes the same unresolved additional input streams.

The [staged C4 mathematical candidate](evidence/c4-policy-candidate/README.md) now has bounded source/reference checks. It identifies an attractive short-distance divergence introduced by the current linear-charge/soft-core path and proposes explicit discharge, core-transformation and recharge stages. The proposal preserves the declared endpoint components but does not establish universal stability of the inherited native point-charge model. It remains unaccepted and unintegrated; its ADP/phosphate model does not replace the selected original vanadate model.
