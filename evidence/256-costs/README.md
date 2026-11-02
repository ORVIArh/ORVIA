# 256-contract deployment and existing-input cost evidence

These are dated read-only estimates and an input-upload projection. No public transaction was signed or sent. Scientific acceptance and production readiness remain false.

## What the transaction counts mean

The existing candidate inputs contain **24 distinct streams and 10,903,836 logical 32-byte words**. The current catalog appends at most 128 words per transaction. Summing the rounded-up batch count separately for each stream gives:

| Scope | Transactions |
| --- | ---: |
| Append the existing input words | 85,195 |
| Begin 24 streams and seal 24 streams | 48 |
| **Existing input upload** | **85,243** |
| Deploy/configure all 256 contracts | 91 |
| **Infrastructure plus existing input upload** | **85,334** |

The 91 infrastructure transactions consist of 32 core creations, 56 calls that each create four storage banks, and three configuration calls. The 256 contract count does not impose the 85,243 upload count.

The logical input serialization is **348,922,752 bytes**, about 349 MB. This is not 349 MB of newly populated EVM storage: 3,131,996 logical words are zero and do not create nonzero storage entries. The current implementation still processes, hashes and attempts to store those words. The remaining **7,771,840 words are nonzero**, and fresh persistent storage writes dominate the gas. Much endpoint A/B data is repeated, and each number currently uses a full 32-byte word. A lossless compressed reader could change these counts, but the estimates below price the current implementation.

## Dated cost scenario

The common pricing observation was taken at **2026-11-02 13:21:33 UTC**, chain 4663, block `0x636ace9`: **0.020056 gwei per gas** and **$2,276.575 per ETH**, using [Coinbase's ETH/USD spot endpoint](https://api.coinbase.com/v2/prices/ETH-USD/spot). Future prices and fees can change.

| Scope | Gas | ETH at sampled price | USD at sampled prices |
| --- | ---: | ---: | ---: |
| All 256 contracts and three bindings | 186,177,439 | 0.003734 | $8.50 |
| Existing 24-stream upload | 195,551,588,254–196,159,036,309 | 3.921983–3.934166 | $8,928.69–$8,956.42 |
| **Combined** | **195,737,765,693–196,345,213,748** | **3.925717–3.937900** | **$8,937.19–$8,964.92** |

A 20% gas allowance on the combined upper scenario is **$10,757.91 at the sampled prices**. It is not a maximum fee or a complete campaign budget.

All 91 infrastructure calls received individual target-provider estimates with their exact hypothetical preceding state. They were not deployed on mainnet. Input upload costs use **30 conditional target-provider estimates** plus the measured local execution model and exact source counts. The upload range is an empirical scenario, not a guaranteed interval or 85,243 individually quoted transactions.

These totals exclude protocol registration, unresolved C4/activity/phase/constraint inputs, topology validation, model initialization, minimization, equilibration, dynamics and analysis. They also do not establish acceptance of the prepared alternative model.

## Evidence and reproduction

- `cost-summary.json` retains exact decimal arithmetic and scope exclusions.
- `current-pricing.json` records the common price observation without the private RPC URL.
- `input-byte-counts.json` and `count-inputs.py` bind the source input counts and sampling method.
- `infrastructure-evidence.zip` contains the 91 estimates, request/state bindings, compact state history, final state, source scripts, replay instructions and its original manifest.
- `upload-evidence.zip` contains all 30 estimates, their state overrides, the local model, 188 integrity checks, source scripts, retained failed attempts and its original manifest.
- `manifest.json` binds the published files. Every archived payload was checked against its original manifest before packaging.

The scripts retain their original AURA workspace-relative paths. Extract archives separately and follow the enclosed READMEs; they are evidence packets rather than a self-contained installer. Raw molecular inputs are separately source-bound and are not duplicated in these archives. No wallet, signing key, password or private RPC credential is included.
