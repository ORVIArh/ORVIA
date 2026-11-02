# ORVIA mainnet readiness and deployment rehearsal

**Current release state: blocked for a complete ORVIA-001 mainnet launch. No Robinhood transaction has been broadcast.** The deployment tools distinguish a reproducible local fixture deployment from the complete scientific production system. New numerical modules do not automatically clear prepared-input, integration, size, cost or target-chain validation requirements.

**Deployment policy: mainnet only (chain 4663).** Validation uses local EVMs, mainnet-pinned local forks and read-only mainnet calls. No public testnet deployment is planned or required. The user's removal of the funding cap does not waive scientific, source-integrity or full-workload acceptance.

The active design is [ORVIA-256](ARCHITECTURE_256.md): 32 core components and 224 fixed storage banks. Its [complete local prototype](COMPLETE_256_PROTOTYPE.md) has passed, and the two large coordinator constructors returned exact runtime bytes in [read-only mainnet calls](TARGET_256_CREATION_PROBE.md). The raw C4 component remains outside the alchemical Hamiltonian, and full-model scientific and workload acceptance remain incomplete. The legacy rehearsal and 64-slot gate described below are retained for reproducibility; they do not authorize the active 256-contract release.

## Verified network documentation

Robinhood's official documentation, checked on 2026-11-02, identifies mainnet chain ID **4663**, ETH gas and `https://robinhoodchain.blockscout.com`. Its public RPC is `https://rpc.mainnet.chain.robinhood.com`; the documentation describes it as rate-limited and recommends a provider endpoint for production.

The documented code limits are 96 KB runtime and 192 KB initcode. Tooling uses 98,304 and 196,608 bytes as planning conversions and includes constructor arguments in initcode measurements. Exact live chain configuration and target execution remain separate verification requirements. The current local rehearsal keeps the ordinary Ethereum 24 KB runtime limit enabled; passing it is useful local evidence, not a Robinhood fork test.

Robinhood fees contain both L2 execution and L1 data-posting costs. Its standard `eth_estimateGas` estimate includes both. Multiplying a Ganache execution-gas measurement by a Robinhood gas price would omit target-specific behavior and is not a valid final fee quote. Neither `prevrandao` nor transaction timing supplies a scientific random seed.

Sources:

- [Connecting to Robinhood Chain](https://docs.robinhood.com/chain/connecting/)
- [Differences from Ethereum](https://docs.robinhood.com/chain/differences-from-ethereum/)
- [Gas and fees](https://docs.robinhood.com/chain/gas-and-fees/)
- [Deployment and Blockscout verification](https://docs.robinhood.com/chain/deploy-smart-contracts/)

## Read-only preflight

```bash
python3 scripts/preflight.py
```

The script calls only `eth_chainId`, `eth_getBlockByNumber` and `eth_gasPrice`. Set `ORVIA_RPC_URL` privately to use an operator-configured provider. Provider paths and credentials are omitted from the saved report and errors. No key is read and no transaction is signed or sent.

`reports/mainnet_preflight.json` records the actual responses. The official public endpoint returned HTTP 403 in this workspace. On 2 November 2026, the Pinax endpoint listed in Robinhood documentation passed all three read-only methods and observed chain ID 4663. The separate reports retain both probes. A block-pinned local state-fork numerical-kernel smoke also passed; see [FORK_SMOKE.md](FORK_SMOKE.md) for the strict distinction between Ganache state-fork checks and Robinhood Nitro execution validation. Complete target execution and live transaction fee estimates remain unverified. The report fails closed rather than treating documentation as a successful RPC observation. Exit code 2 means blocked/inconclusive; it does not mean a deployment occurred.

## Historical periodic-fixture local deployment

```bash
npm run compile
node scripts/deploy.mjs --local-rehearsal
```

This command creates its own in-process Ganache chain with ID 31337 and a deterministic **local development** account. It never consumes a mainnet RPC URL or private key. The runner checks the chain ID before sending and refuses a remote/mainnet rehearsal target.

It deploys the 16 active v0.4 periodic-fixture core instances in dependency order, then creates seven populated input pages through the actual catalog factories. These **23 local instances** are the existing four-atom periodic validation system. They are not the planned production deployment count and are not assigned empty production roles to increase that count.

The rehearsal:

1. Reconstructs the exact compiler input and rejects source files changed since compilation.
2. Predicts CREATE addresses from the known local sender/nonce sequence and checks every actual address.
3. Measures each deployment's complete constructor initcode, estimated gas and actual gas.
4. Compares deployed runtime against the compiler template outside compiler-declared immutable slots, then checks immutable owner, writer and dependency getters separately.
5. Binds the working page, registers the protocol and independently reconstructs its module-code commitment.
6. Uploads all seven input streams, recomputes their digests, seals them and reads back every populated word.
7. Registers the layered datasets and experiment, then executes one permissionless loading work unit from a different local account.

The smoke step does not complete a trajectory. Full numerical trajectories remain covered by their separate integration suites. Gas is broken down into core deployment, input-page deployment, upload, sealing, registration, configuration and smoke execution; it is not a maximum-size-system or mainnet fee quote.

Outputs:

- `reports/deployment_rehearsal.json`: actual local addresses, transaction hashes, constructor descriptors, bytecode hashes, checked dependencies and gas.
- `reports/deployment_fixture_plan.json`: deterministic local constructor/address plan.
- `reports/deployment_standard_input.json`: standard compiler input for source-verification reproduction.

The standard-input digest in descriptors is SHA-256 over canonical JSON with sorted object keys, not the formatted file's raw bytes. Source file hashes remain hashes of exact UTF-8 source text. Blockscout verification has **not** been submitted. Each descriptor includes the fully qualified source/contract name, compiler and encoded constructor arguments needed for a later actual deployment's verification.

## Live unsigned fee quotes

```bash
node scripts/quote.mjs unsigned-transaction.json
```

The input contains `chainId: 4663`, a real nonzero public `from` address, optional `to`, hexadecimal `data`, `value` and optionally `nonce`. No signing fields or private keys are accepted. A creation request contains the exact constructor initcode and no `to`. A call request contains the actual destination and exact calldata.

The quoter verifies chain ID, records a reference block, obtains the pending nonce when omitted, requests a target-node gas estimate and checks the sender's balance. It reports the fee estimate and a 20% gas allowance at the quoted gas price. That allowance is not protection against subsequent price changes. Re-estimate immediately before signing.

The tool only quotes a transaction executable against the current pending chain state. Constructors referencing not-yet-deployed dependencies require a target fork or the earlier deployments first. A quote for the first independent contract is not a quote for all later contracts or the entire scientific run. Read-only access now succeeds through the documented Pinax provider; a complete production quote still needs the actual public operator, exact transaction plan and executable dependency state. The retained HTTP 403 concerns the separate official-public endpoint probe.

## Legacy readiness gate and current release blockers

```bash
node scripts/deploy.mjs --readiness
```

`reports/mainnet_readiness.json` lists every declared production slot, its experimental candidate sources and whether a complete measured production implementation is actually validated. The inventory is generated from the manifest; it does not convert a candidate source association into a completed slot. The declared production count must match its justified slot list and remain at least the requested minimum of 50.

That slot logic belongs to the older manifest. While `data/architecture_256.json` is active, the command explicitly rejects authorization from that legacy gate. A source-bound 256-address release adapter, exact production input commitments and corresponding acceptance evidence are required before this restriction can be replaced.

The gate consumes the current-version validation report, live preflight, `data/scientific_readiness.json`, per-slot evidence, public operator configuration and complete production acceptance evidence. Missing files keep readiness false. It requires `ready_for_orvia_001_registration == true` in the scientific audit. The gate cannot independently certify scientific truth merely because a JSON flag is set; those evidence records must arise from the actual reviewed checks.

| Blocker class | Required resolution |
|---|---|
| External RPC evidence | A working authorized mainnet endpoint, chain verification, target-fork rehearsal and live fee estimation |
| Scientific inputs | A complete prepared model, including justified Mg–ADP–vanadate and modified-residue treatment, repaired structure, ligand mapping, solvent/ions and complete parameter validation |
| Implementation/integration | All registered Hamiltonian, dynamics, stochastic, alchemical and analysis stages connected to production-sized paged state, with immutable identities and bounded stages |
| Validation/cost | Complete-system reference comparisons, failure/restart and capacity tests, maximum-work gas, sampling/estimator checks and reproducible source verification |
| Full pipeline/workload | Source/model/protocol-bound end-to-end evidence for every required capability, complete-system phase gas measurements and an acceptable schedule based on observed target allocation |
| Operator configuration | Public deployer address, nonce-pinned final transaction plan, fresh quotes and sufficient ETH; signing material stays outside the release |

The supplied 1,024-atom dynamics guard and 65,536-word working namespace do not accommodate the eventual full solvated myosin model. Enlarging a constant alone does not establish affordable or bounded transaction execution: page scans, validation, force passes, retention and complete-system gas must all be measured. Input-page partitions must grow or change based on real prepared data rather than retaining an arbitrary instance count at the expense of availability.

This checkpoint provides no mainnet broadcaster or private-key loader. Unsupported broadcast flags are rejected immediately. Once a complete production plan and all evidence exist, a separately reviewed signing/broadcast step can operate on that exact plan. `--local-rehearsal` and `--readiness` never deploy anything externally.

## Complete production acceptance input

`data/production_acceptance.json` is deliberately absent until real integrated evidence exists. Filling all production-slot flags, passing a current-version component suite, setting the scientific flag, connecting RPC and configuring an operator **cannot pass readiness without this additional evidence**. Focused tests construct exactly that hypothetical situation and confirm rejection.

The acceptance format has `schemaVersion: 1`, `scope: "ORVIA-001-full-rbfe"`, `bindings`, an `evidence` descriptor array, a `capabilities` array and a `workload` object. Required binding keys are:

| Key | Current release source |
|---|---|
| `architectureVersion` | Manifest architecture version |
| `targetChainId` | 4663 |
| `sourceBundleSha256` | Reconstructed, current compiler standard-input digest from `verificationBundle()` |
| `manifestSha256` | SHA-256 of canonical current manifest JSON |
| `scientificAuditSha256` | SHA-256 of canonical current scientific-readiness JSON |
| `validationSha256` | SHA-256 of canonical current full-validation report JSON |
| `preparedModelSha256` | Scientific audit's `accepted_model_sha256` |
| `protocolKeccak256` | Manifest's `production_protocol_keccak256` |
| `productionPlanSha256` | Public operator configuration's nonce-pinned plan digest |

Missing accepted model/protocol bindings fail the gate. Every referenced evidence record must contain exactly matching binding values. This prevents reusing a small fixture or an earlier code/model/protocol report merely because its test name sounds relevant.

Evidence descriptors contain `id`, `path` and raw-file `sha256`. Files must be JSON under `reports/production/` or `data/production/`; path escapes, missing files, changed bytes and duplicate IDs are rejected. The loader reads local files only. Each record requires `schemaVersion: 1`, matching `evidenceId`, its required `kind`, `status: "passed"` and the release `bindings`. Hash checks establish integrity and identity, **not the truth of a measurement or an independent review**.

The stable capability IDs in `PRODUCTION_CAPABILITIES` are:

1. `prepared_input_loading_and_sealing`
2. `minimization_and_constraints`
3. `equilibration_and_production_sampling`
4. `periodic_long_range_electrostatics`
5. `alchemical_lambda_protocol`
6. `onchain_complete_cross_state_energies`
7. `predeclared_paired_repeats_and_sample_chronology`
8. `free_energy_overlap_correlation_and_uncertainty_acceptance`
9. `permissionless_resume_partition_and_fault_recovery`
10. `full_model_target_execution_and_source_verification`

Each acceptance capability entry references an evidence ID. That record must have `kind: "pipeline_execution"`, `scope: "full_prepared_model_pipeline"`, include the capability ID, and identify `execution.chainId: 4663`, `execution.mode: "target_chain_fork"` and an actual fork block hash. A single comprehensive report may cover several capabilities. Standalone kernel or four-atom fixture reports do not satisfy this scope. The capability list concerns a connected complete selected protocol; it is not a claim that adding one contract with each name implements it.

## Full-system workload acceptance

The acceptance `workload` object references `measurementEvidenceId` and `throughputEvidenceId`, and specifies positive decimal-string `gasBudget` and `maxDurationSeconds`. The duration must equal the operator configuration's public `acceptedMaxDurationSeconds`; the tool does not choose an acceptable scientific runtime for the operator.

The workload measurement record must have `kind: "full_system_workload_measurement"`, `scope: "full_prepared_model_complete_protocol"`, target-fork execution identity, `maxTransactionGas`, and `modelAtomCounts.complex` / `.solvent` matching the scientific audit's `accepted_model_atom_counts`. Measurements must therefore concern both complete accepted systems rather than a convenient small fixture.

Its `phaseMeasurements` must cover every stable `WORKLOAD_PHASES` entry, without unknown or duplicate phases:

- `deployment_and_input_loading`
- `equilibration`
- `production_sampling`
- `alchemical_cross_state_energy`
- `free_energy_and_uncertainty_analysis`
- `recovery_and_state_io`

Each phase supplies positive decimal-string `measuredGasPerUnit` and `campaignUnits`. Units must represent the complete bound campaign, including its windows, legs, repeats, steps, sampling and recovery allowance as appropriate. The gate sums the products with exact integer arithmetic and requires `gasBudget` to cover that sum. Reviewers still must establish that the chosen units and measurements actually represent the protocol; JSON arithmetic alone cannot do that.

The throughput record must have `kind: "allocated_throughput_measurement"`, `scope: "observed_allocated_target_chain_gas"`, `execution.mode: "target_chain_observation"`, chain ID 4663, start/end block hashes, positive `observedAllocatedGas`, `observationSeconds` and `transactionGasLimit`. Hypothetical throughput from the workload illustration cannot satisfy this record. The gate requires the measured maximum transaction to fit the recorded limit and the budget divided by the observed allocation rate to fit the accepted duration. Observed allocation is not a guarantee of future allocation; schedule and contingency review remain necessary.

`WORKLOAD_FEASIBILITY.md` records the current external-call pair costs and clearly labeled scaling examples. `COMPUTE_COST.md` records an optional inline implementation's approximately twofold pair-gas improvement with sampled byte-for-byte equivalence and its explicit integration in bounded neighbor NVE. Neither supplies production acceptance: these are local numerical experiments, and the neighbor NVE integration is not a complete production molecular-sampling path.

## Engineering review boundaries

The deployment rehearsal checks source freshness, constructor and runtime identity, dependency wiring, ownership, input integrity and a permissionless execution entry point. It does not replace a full independent security review. Particular production review areas are maximum-page assertion costs, malicious or incomplete input registration, cross-run state isolation, every stage barrier, retry behavior, numerical exceptional domains, counter exhaustion, sample provenance/retention, solver nonconvergence and incorrect scientific success status.

Immutable provided components are the supported dependency model. Pinning the runtime hash of an arbitrary upgradeable proxy would not freeze its storage-backed behavior. Transaction sender, swap order, timestamp and block randomness must not alter scientific summation or stochastic streams.

## v0.5.1 continuation evidence

`reports/mainnet_preflight.json` is the successful provider read; `reports/official_public_preflight.json` retains the failed official-public probe. `reports/target_fork_smoke.json` records the kernel-only local state fork. None can replace the complete prepared-model pipeline/workload acceptance required by the production gate. No mainnet transactions were sent.

## Supplementary actual target-node numerical execution

The separate [target-node read-only probe](TARGET_NODE_EXECUTION.md) now passes exact creation-runtime and scalar/pair return checks through the Robinhood provider for two kernels. It is distinct from the Ganache state-fork smoke and from full transaction/model acceptance. The source-bound offline suite does not include this separately packaged network experiment. No transaction was sent and the mainnet gate remains closed.
