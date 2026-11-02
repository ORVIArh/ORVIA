# Hybrid GPU result coordination

This is a new hybrid architecture. The existing 32-core/224-bank molecular implementation remains unchanged. The hybrid deployment is **one `ORVIAHybridCoordinator` plus 255 `ORVIAReportShard` instances: exactly 256 addresses**. The coordinator is also the only factory; there is no extra implementation, proxy or library deployment. Shards are created in owner-authorized batches of 1–8 using CREATE2, and every lifecycle operation requires all 255 to exist.

GPU computation is trusted operator work. EIP-712 verifies who attested to a result and binds its identities and progression; it does not prove that OpenMM ran correctly, that the inputs are scientifically accepted, or that a claimed validation flag is true. Full input/checkpoint/result files must remain available separately. Their on-chain hashes are not a data-availability service.

## Identities and lifecycle

`ExperimentConfig` binds five nonzero hashes: protocol, model, input artifacts, software and environment. `requiredChecks` and `allowedChecks` are frozen masks whose meanings must be defined in the hashed protocol. `diagnosticOnly` is also immutable. The owner registers an experiment exactly once, then starts globally unique run IDs with a nonzero run-configuration hash and initial-checkpoint hash. The configuration commitment binds all of these, the chain and coordinator.

Run IDs route deterministically to `uint256(keccak256(abi.encode(runId))) % 255`. Each lane stores many runs and immutable report history; no per-run contracts are created. Every shard pins its coordinator address/runtime hash, and the coordinator pins each shard runtime hash. `deploymentCommitment` accumulates the ordered addresses and runtime hashes.

The immutable operator signs the following EIP-712 type:

```
Report(bytes32 runId,bytes32 configurationHash,uint64 sequence,uint64 completedSteps,bytes32 previousCheckpointHash,bytes32 checkpointHash,bytes32 resultHash,uint8 outcome,uint32 checks,uint64 validUntil)
```

Domain: name `ORVIAHybridCoordinator`, version `1`, actual chain ID and deployed coordinator address. The mainnet release planner must select chain 4663; contracts themselves are chain-portable.

- Sequence begins at 1 and increases exactly by one. Each report references the last accepted checkpoint, initially the run's initial checkpoint.
- Outcome 0 is an intermediate checkpoint and requires strictly increasing `completedSteps`.
- Outcome 1 completes a run; outcome 2 marks failure. A final report can use the previous step count, but cannot decrease it.
- The hashed run configuration defines what the counter means. A fixed-coordinate benchmark can count force evaluations; it must not label them MD steps.
- Both checkpoint and result hashes are mandatory. Deadlines, low-s 65-byte ECDSA signatures, and operator identity are checked.
- Any account may relay a valid signature. Replay, changed fields, different chain/coordinator, stale lineage and reports after terminal status are rejected.
- The owner can cancel a running run with an immutable reason hash. Completed, failed and cancelled runs cannot resume or be rewritten.
- A completed non-diagnostic run must carry every registered required flag. A diagnostic run remains diagnostic even if an operator sets flags. A failed outcome remains failed. None of these flags automatically means scientific acceptance.
- `submitReports` accepts 1–8 reports and applies them atomically; an invalid member rolls back earlier members and events.

`runInfo` exposes the experiment, full configuration commitment, explicit run-configuration and initial-checkpoint hashes, current checkpoint/result hashes, counters, status and diagnostic flag. `reportAt` retains the exact checkpoint/result/attestation digest and counters for every accepted sequence.

## Operations and limits

Owner and operator are immutable EOAs/addresses. The production operator requested for release planning is `0x2541a9e93B5C853E9208b0C5C7386dD458424c77`; the constructor still requires explicit owner and operator arguments. Signer loss or compromise requires an operational migration/new deployment; this implementation has no hidden rotation or upgrade authority. Cancellation can stop an affected live run but does not erase history.

Registering a protocol or accepting an operator signature does not change the original chemical-state selection. A benchmark of an alternative ADP/phosphate model must retain that identity and its diagnostic status; it cannot silently substitute for the original vanadate experiment.

The sharded records authenticate hashes and statuses, not numerical ensemble completeness, paired-leg aggregation, retry policy or availability of GPU artifacts. Those must be implemented and tested by the release's orchestration/validation policy. This contract packet alone is not mainnet-readiness evidence.

## Local validation

Run `node --test scripts/hybrid/coordinator.test.mjs` from the repository root. The test uses public deterministic local-only keys that must never be funded; no production key or public transaction is used. It compiles only the new contracts with solc 0.8.26, optimizer 200, Shanghai and records source-bound evidence under the sibling AURA `output/hybrid-contract-tests` directory.

The suite checks all 256 deployed addresses and all 255 routing lanes, writer/runtime identities, immutable configurations, every signed-field mutation, chain/address/signer mismatch, expiry, malformed/high-s signatures, sequence/checkpoint monotonicity, diagnostic/failed/terminal states and atomic batches. `scripts/hybrid/attestation.mjs` provides the exact typed-data schema and checked integer normalization without signing or network access.
