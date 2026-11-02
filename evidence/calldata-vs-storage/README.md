# Calldata versus packed storage: GPU-backed comparison

**Measured result:** authenticated calldata costs less for whole-chunk reads; permanent packed storage costs less for small fields reused across many transactions. A hybrid input reader is the next candidate to implement and measure. This evidence does not select or deploy a production architecture.

The [full packed-input pass projection](FULL_PASS_ESTIMATE.md) now extends these measured rates to all 44.1 MB with 1 KiB or 16 KiB batches. It includes a deployment baseline, exact stream-aware transaction counts and refreshed prices; it remains a rough data-access projection, not a full simulation quote.

## Measured gas

Both paths use the same actual model bytes and produce the same result after exact binary64-to-binary128 expansion and an ordered digest. These are data-access microbenchmarks, not molecular force calculations. The calldata path includes its indexed Merkle proof; stored reads fetch only the slots needed by the selected fields.

| Data used per call | Stored | Calldata + proof |
|---|---:|---:|
| One 8-byte field | 33,657 gas | 65,970 gas |
| One 24-byte record crossing slots | 38,698 gas | 67,987 gas |
| Full 1 KiB chunk | 281,956 gas | 195,136 gas |
| Full 4 KiB, batched | 1,047,524 gas | 686,544 gas |
| Full 16 KiB, batched | 4,202,582 gas | 2,774,398 gas |

Permanent storage additionally requires **796,240 gas to upload the measured 1 KiB chunk**. Both paths share a 94,588-gas root registration, omitted from the comparison of recurring reads. Registering a root alone does not publish any model bytes.

Whole-chunk calldata reads save **30.79%–34.46%** in these cases. For one field reused in separate transactions, storage becomes cheaper including its initial upload **at the 25th 8-byte read**, or **the 28th 24-byte read**. These thresholds assume storing the full measured 1 KiB chunk. Smaller proof leaves, multiproofs, batching, caching and different input bytes can change them. They are not molecular-dynamics timesteps.

## Price snapshot

At **2 November 2026, 19:29 IST (13:59 UTC)**: chain 4663 gas price was **0.020148 gwei**, and ETH was **$2,286.015** from the [Coinbase spot endpoint](https://api.coinbase.com/v2/prices/ETH-USD/spot). Detailed source hashes and block information are in [pricing.json](pricing.json).

| 1,000 data-access calls | Stored | Calldata + proof |
|---|---:|---:|
| One 8-byte field per call | $1.55 | $3.04 |
| One 24-byte record per call | $1.78 | $3.13 |
| Full 1 KiB per call | $12.99 | $8.99 |
| Full 4 KiB per call | $48.25 | $31.62 |
| Full 16 KiB per call | $193.57 | $127.78 |

The measured initial 1 KiB storage upload adds **$0.03667** once. These prices exclude common root registration, contract deployment, other protocol state and molecular execution. Gas units were estimated at pinned mainnet block `0x6370174`; the later price snapshot is block `0x63703d7`. According to [Robinhood's fee documentation](https://docs.robinhood.com/chain/gas-and-fees/), standard estimates bundle execution and L1 posting fees. Prices and posting estimates can change.

## GPU and independent checks

The local **Apple M5 GPU** packed **5,157,130 original values** from eight actual model streams. All **34,925,056 output bytes, including stream-end padding,** matched independently prepared CPU output exactly; source round-trip checks also passed. No calculation precision was discarded: transport compression restores the original binary128 bits before computation. GPU work accelerates preparation; it does not execute EVM gas metering or reduce gas charges directly. GPU event timers were unsuitable for a defensible speedup claim, so none is made.

All fourteen base streams plus 466 endpoint patches total **44,065,024 packed bytes**. This is an input-size measurement, not a complete calldata campaign quote. The larger source model and the proposed 256-contract inventory remain intact.

- 78 local transaction receipts and 52 benchmark checks passed.
- 12 read-only target-chain estimates used the exact benchmark runtime and hypothetical prior state; no target contract was deployed.
- Independent review reproduced compilation, all 12 estimate request/response bindings and 1,540 relevant hypothetical state values.
- 340 selected chunk proofs were independently checked against actual full-stream packed inputs.
- Both EVM paths passed 12 additional literal IEEE edge vectors, including signed zero, subnormals and maximum finite values, plus unauthorized root rejection.

## Meaning for ORVIA

Use these results to prototype calldata for sequential/bulk immutable inputs, retain packed storage for heavily reused sparse inputs, and keep mutable positions, forces and progress in persistent state. The current Hamiltonian accesses small repeated fields as well as larger groups; a full integrated workload is needed to choose the boundary.

Contracts cannot fetch old transaction calldata directly during a later transaction; bytes and proofs must be resupplied. The [Ethereum storage guide](https://ethereum.org/developers/docs/data-availability/blockchain-data-storage-strategies) explains this distinction. A root commitment needs an accompanying availability/publication plan. This benchmark excludes a separate initial publication and operating the data supplier.

The test contract uses direct mappings, so production bank routing and code-hash checks are not priced. The target quotes use fixed first chunks of one float-only stream, not a representative random sample of both complete models. A production decoder also needs mixed integer/float records and explicit logical-length admission for end padding.

**There is no measured complete campaign cost or calldata transaction count yet.** The production reader, mixed-record integration, endpoint overlay, full force calculations and workload schedule remain unfinished. Existing 10,818-upload compression projections are not implemented by this benchmark. No public testnet was used, no wallet was accessed, and no public transaction was signed or sent. Scientific acceptance and mainnet readiness remain false.

## Reproducible evidence

- [comparison.json](comparison.json): exact gas, prices and break-even arithmetic.
- [evm-review.json](evm-review.json), [data-review.json](data-review.json), [gpu-output-review.json](gpu-output-review.json): independent checks.
- `evm-packet.zip`: executed Solidity benchmark, compiler input/output, receipts, edge cases, target state witnesses and script sources.
- `data-packet.zip`: packing/GPU/Merkle sources, manifests, compact actual samples and preparation reports. Large reproducible packed/GPU outputs are not duplicated.
- `review-scripts.zip`: independent review and pricing scripts, byte accounting and read-only RPC helper. Scripts retain the documented AURA sibling-directory layout; sample replay uses ORVIA's pinned dependencies, while a full source replay also needs the source-bound large input files.
- [manifest.json](manifest.json): exact public artifact hashes. The private RPC URL and wallet are excluded.
