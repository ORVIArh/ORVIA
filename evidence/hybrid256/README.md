# GPU hybrid release evidence

The separately named **ORVIA-ADP-PHOSPHATE-v0.2** experiment was selected by the user on 2026-11-02. It uses ADP/phosphate, not the original vanadate chemical state. The original experiment and source coordinates remain preserved. [Selection record](../../data/experiments/adp-phosphate-v0.2/experiment.json).

## Confirmed endpoint accuracy repair

On 2026-11-02 at 16:20 UTC, a Runpod NVIDIA H200 executed the repaired endpoint calculations using CUDA double precision. Both endpoints passed all original and eight perturbed-coordinate comparisons, their 20-step deterministic trajectories, and comparisons at all three minimized-coordinate fixtures each. This resolves the small-endpoint strict test that failed in the [earlier A100 run](../calldata-vs-storage/RUNPOD_BENCHMARK.md).

The native OpenMM GPU kernels store several force-field parameters in float32 even when calculation precision is double. A Reference-platform surrogate that deliberately reproduces that rounding matches the A100 static-force errors within 4.87e-7 kJ/mol/nm. The repaired path uses equivalent custom forces with binary64 parameters, compared with the untouched native Reference oracle. The Hamiltonian parameters and acceptance tolerances were not relaxed. [Upstream native parameter storage](https://github.com/openmm/openmm/blob/b399af4/platforms/common/src/CommonKernels.cpp#L490).

| Check | Original acceptance limit | Largest observed repaired error |
|---|---:|---:|
| Static maximum force component | 0.05 kJ/mol/nm | 3.51e-9 kJ/mol/nm |
| Short-trajectory maximum force component | 0.05 kJ/mol/nm | 4.90e-8 kJ/mol/nm |
| Minimized relative force L2 | 5e-5 | 2.35e-9 |

Energy absolute tolerance remains 0.01 kJ/mol; trajectory position RMS tolerance remains 1e-5 nm. These also passed. The source-bound raw report includes every metric, input identity, actual platform, and environment. The diagnostic took 5.87 seconds; setup plus execution took 19.78 seconds. Those timings exclude cloud provisioning and retrieval and are not full campaign costs.

**Scope:** these are the 41- and 44-atom nonperiodic endpoints. The repair intentionally rejects unsupported large/periodic input. This does not validate the full protein/solvent systems, a free-energy result, or production simulation throughput. Those require their own repaired coordinates, periodic-force checks and trajectory evidence.

- [Machine-readable summary](h200-precision-summary.json)
- [Raw H200 results](h200-precision-results.tar.gz), SHA-256 `030dea7f6c6e3e97d57a04e73acd09ab9c88937ba35072935e794834dad9134a`
- [Exact input/script bundle](cuda-precision-retest.tar.gz), SHA-256 `bf8240d2f00009184c107299e08eddfa5530ba4369320a48d6f48681d3a0e69f`
- [Bounded launcher](precision-retest-launcher.sh); verifies bundle identities and preserves failures. Its deadline stops the process, not GPU billing.

## 256-contract implementation

The new [hybrid contracts](../../contracts/hybrid/) implement one coordinator/factory plus 255 direct report shards, **exactly 256 contracts**, with 33 deployment/provisioning transactions. No proxy implementation, helper factory or library contract is added.

[The local test report](contract-tests.json) passes 15 groups of checks and exercises every one of the 255 routing lanes. It covers signatures and domain binding, all signed-field mutations, replay/expiry/high-s rejection, exact deployment identities, immutable experiment/run configuration, checkpoint progression, terminal states, runtime dependencies and atomic batches. The complete local deployment used 229,756,606 execution gas. This local number is not a live chain fee quote and excludes experiment setup/reporting/GPU costs.

Owner/operator addresses are immutable. Lost or compromised keys require a new deployment; the owner can cancel individual runs. EIP-712 signatures establish the operator and committed report, **not proof of correct molecular computation**. Checkpoint/result artifacts must remain retrievable separately.

No public testnet or mainnet transactions are part of these tests. Full periodic-model validation, deployment rehearsal/live fee quote and the end-to-end reporting workflow are recorded separately as they complete. Until that evidence exists, this directory must not be treated as a production-readiness certificate.

## Reviewed infrastructure deployment package

Two local deployment rehearsals agree on all 256 runtime identities and the complete 33-transaction sequence. Ten planner tests and nine operator tests pass, including tampered/rehashed plans, exact immutable fields, predecessor storage, nonce safety, wrong chains, fee checks, journal recovery and reorg checks. [Review evidence](deployment-security-review.json).

The target RPC accepted every estimate, including all 32 prerequisite-state overrides. At block `0x6384f30` on 2026-11-02 at 16:22:48 UTC, the **total infrastructure estimate is 231,618,594 gas × 20,310,000 wei/gas = 0.00470417364414 ETH**. Funding all transaction gas limits with a 25% margin reserves **0.00588021708564 ETH** at that price; unused gas is not charged. The public wallet held 0.038676614738669727 ETH and pending nonce 0. [Quote](mainnet-infrastructure-quote.json) · [Read-only evidence](mainnet-read-only-evidence.json).

The estimate covers all contracts and shard provisioning. It excludes experiment registration, result reports and GPU campaigns, which remain part of any future total scientific-run quote. Each actual transaction is re-estimated before signing. These estimates do not deploy anything.

[Frozen release archive](deployment-release.tar.gz), SHA-256 `2e940e52a15cd79dc010658b36b85468f9730c7fd27075d68ba322e4b1cc16f1`, contains the plan, independent specification, all runtime/address identities, quote, source snapshots and a local encrypted-wallet launcher. [Release metadata](deployment-release-metadata.json). The launcher is bound to the prepared local workspace; reading the archive does not broadcast. Running its deployment command locally does. Secrets and the private RPC URL are excluded.
