# Local hybrid report workflow

These tools connect retrieved GPU artifacts to the dedicated 256-contract hybrid registry. They do not make a GPU calculation trustless or scientifically accepted. The operator attests to the reviewed files; the chain enforces identity, authorization, report order and immutable history.

Current admitted protocols are deliberately separate:

- `phosphate-native-force-v1`: the frozen ADP/phosphate native-B fixed-coordinate A100 benchmark. It is not the original vanadate model or an alchemical simulation. All worker files and the pinned input/program manifest are verified. Strict endpoint failures remain failures.
- `endpoint-precision-v1`: the reviewed H200 41/44-atom endpoint precision diagnostic, with recomputed tolerance decisions, energy/norm consistency, source hashes and original thresholds. It is not a full periodic model.

Both are diagnostic-only. An approved future full-model protocol needs its own reviewed validator/registry entry. The contracts support explicitly registered non-diagnostic policies; these scripts do not silently promote existing diagnostics.

## Retrieve and admit

Retrieve the complete worker result directory/archive and verify its transfer hash before stopping the GPU instance. Preserve failure logs and raw reports. Never upload the local wallet or RPC configuration to the worker.

For the endpoint diagnostic, an artifact-spec file contains:

```json
{"protocol":"endpoint-precision-v1","reportFile":"/absolute/path/precision-diagnostics.json"}
```

For the original full native force benchmark:

```json
{"protocol":"phosphate-native-force-v1","bundleRoot":"/absolute/path/orvia-benchmark","resultsRoot":"/absolute/path/results"}
```

A portable local example can use the frozen repository H200 evidence. From the repository root, verify the archive before extracting it into a new directory:

```sh
shasum -a 256 evidence/hybrid256/h200-precision-results.tar.gz
mkdir /absolute/path/h200-evidence
tar -xzf evidence/hybrid256/h200-precision-results.tar.gz -C /absolute/path/h200-evidence
```

The expected SHA-256 is `030dea7f6c6e3e97d57a04e73acd09ab9c88937ba35072935e794834dad9134a`. Set `reportFile` to `/absolute/path/h200-evidence/results/precision-diagnostics.json`. This historical fixture remains an endpoint diagnostic, even if recorded on-chain later.

Admission recomputes identities and consistency checks. A well-formed diagnostic failure can be recorded as failure; altered sources, false success flags, incorrect identities or inconsistent numeric evidence are rejected. Saved `admissible: true` JSON is not authority: signing requires a fresh in-memory assessment from the registered validator.

## Prepare a reviewable operation

The existing deployment planner produces the release plan and intended public-address specification. Choose a unique 32-byte run ID, then run locally:

```sh
node scripts/hybrid/report_operator.mjs prepare \
  --release-plan /absolute/path/release-plan.json \
  --release-spec /absolute/path/release-spec.json \
  --artifact-spec /absolute/path/artifact-spec.json \
  --run-id 0xYOUR_UNIQUE_32_BYTE_RUN_ID \
  --output /absolute/path/operation-plan.json
```

The output prints its SHA-256. All later commands require that reviewed hash, and re-read the raw artifacts, source modules and release plan. A copied or edited assessment is not accepted. The operation binds an explicit experiment, run configuration, input-state commitment and result manifest. Registering a retrieved diagnostic is retrospective evidence; it does not claim prior on-chain preregistration.

## Check, register, sign and relay

Run these commands in your own local Terminal. Substitute the operation plan's exact 64-hex SHA-256 for `PLAN_SHA256`.

```sh
node scripts/hybrid/report_operator.mjs check --plan /absolute/path/operation-plan.json --plan-sha PLAN_SHA256
node scripts/hybrid/report_operator.mjs register --plan /absolute/path/operation-plan.json --plan-sha PLAN_SHA256
node scripts/hybrid/report_operator.mjs sign --plan /absolute/path/operation-plan.json --plan-sha PLAN_SHA256 --output /absolute/path/signed-report.json
node scripts/hybrid/report_operator.mjs submit --plan /absolute/path/operation-plan.json --plan-sha PLAN_SHA256 --signed /absolute/path/signed-report.json
```

`check` verifies chain 4663, coordinator and run-shard runtime bytes, ownership, all-shards readiness, configuration and lineage without decrypting a wallet. `register` sends only missing, exact owner-authorized experiment/run registrations. `sign` creates an expiring EIP-712 signature locally and does not broadcast. `submit` verifies the signature, admitted result, current run sequence/checkpoint and target runtime before a zero-value report transaction. Registration and submission still spend gas. Exact already-anchored reports are recognized without another transaction.

The wallet is the existing encrypted local file outside the repository. Passwords are accepted only through its hidden TTY helper, never arguments or environment variables. RPC configuration stays in the existing protected local file. The shared sender lock prevents this workflow racing the deployment CLI. Signed transaction journals are private and preserve exact transactions for reconciliation; there is no replacement transaction or automatic gas-price bump. A transaction may be retransmitted only as the identical signed bytes after fresh checks and within the reviewed fee ceiling.

Each transaction is capped at 1,000,000 gas. The interactive workflow displays a fee-price ceiling and requires explicit confirmation. These are transaction guards, not a scientific or whole-campaign cost estimate. Recheck fees and results before submitting.

## Test without a wallet or public network

`npm run test:hybrid` uses public synthetic local-only keys and Ganache. Frozen repository archives supply the raw diagnostic fixtures; no outside private workspace, GPU, wallet or public transaction is required. Tests cover actual 256-address provisioning, every storage lane, signature replay/domain/malleability, diagnostic/failure status, artifact tampering, exact EIP-712 equality, registration/submission and journal reconciliation.
