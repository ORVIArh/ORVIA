# Robinhood target-node read-only numerical probe

On 2 November 2026, the Pinax endpoint listed in Robinhood's [connection documentation](https://docs.robinhood.com/chain/connecting/) passed a separately recorded read-only probe of two source-compiled ORVIA numerical kernels. This supplements the [local state-fork smoke](FORK_SMOKE.md): these calls execute through the target RPC provider rather than Ganache.

At source chain **4663**, pinned block **103951214** (`0x6322b6e`), block hash `0x810cbd206b365ca434c92ada0b1f26983c1a5fe5d4db338a6a6af8eda7c80471`:

- Contract-creation `eth_call` returned the exact compiled runtime bytes for `FloatMath` (5,499 bytes) and `InlineNonbondedKernel` (7,587 bytes).
- Temporary state overrides at explicitly synthetic addresses returned the exact ABI bytes for binary128 `1 + 2 = 3` and the direct-exception LJ fixture's energy `0` and force `[-24, 0, 0]`.
- The pinned block number, hash and state root matched at completion. Repeated code/nonce reads concern that historical snapshot; they are not latest-state monitoring or independent proof of persistence behavior.
- The provider advertised a Nitro client build. That client string and all RPC responses are trusted provider observations, not independent state proofs.

Only **14 read-only RPC requests** were issued. The harness exposes a fixed read-method allowlist and has no signer, key, send or signing method. No mainnet transaction was sent. State overrides and creation calls do not deploy persistent contracts or spend gas funds.

## Reproduce and inspect

The [recorded report](../reports/target-execution-probe.json) binds the three Solidity source hashes, dependency lock, compiler/settings, complete standard-input digest, harness hash, request/response digests and exact expected/observed return bytes. The [companion manifest](../reports/target-execution-probe-manifest.json) binds its portable harness, report and README.

Download `ORVIA-v0.5.1-target-node-execution-probe.zip` from the [v0.5.1 development release](https://github.com/ORVIArh/ORVIA/releases/tag/v0.5.1). It is a separate supplementary research artifact, **outside the main offline source-bound test suite**. Install the project's pinned npm dependencies, then run the extracted harness with the project-root path:

```sh
ORVIA_PROBE_BLOCK=0x6322b6e node target-execution-probe.mjs /absolute/path/to/ORVIA
```

The harness rejects redirects, checks response identity, invalidates old success before network work and exits nonzero on failure. Public endpoint/archive availability can change. See the bundled README for exact source and replay requirements.

## Acceptance boundary

This establishes provider-observed, read-only numerical execution of **two kernels**. It does not validate transaction admission, all Robinhood execution behavior, the full molecular Hamiltonian or pipeline, production code-size limits, sustained throughput, complete gas/fees, scientific sampling or a binding-free-energy result. Simulation-specific gas rules can differ from transaction execution. All 64 production instances remain planned, and mainnet readiness remains false.
