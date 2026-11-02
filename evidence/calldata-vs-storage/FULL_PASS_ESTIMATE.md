# Full packed-input pass: 1 KiB versus 16 KiB calldata

**Historical estimate.** The [shared-proof and transaction-batching follow-up](RANGE_AND_BATCH_OPTIMIZATION.md) now includes newer measurements and a proposed 682-data-transaction layout. The figures below retain their original fee snapshot and individual-proof assumptions.

**Rough projection for one complete pass over the current 44,065,024 packed input bytes, not a complete molecular simulation:** approximately **$395.72 using 1 KiB calls**, or **$354.25 using 16 KiB calls**, including the existing 256-contract deployment baseline and an illustrative root-registration allowance.

This scales the measured data-access/expansion/digest rates from the [calldata comparison](README.md). It is not 43,042 or 2,703 individually simulated transactions, and it is not a production deployment quote. The integrated calldata reader is not implemented.

## Comparison

| Quantity | 1 KiB per call | 16 KiB per call |
|---|---:|---:|
| Full input-pass transactions | 43,042 | 2,703 |
| Projected input-pass gas | 8,399,043,712 | 7,499,197,794 |
| Projected input-pass cost | $387.04 | $345.57 |
| Setup transactions | 115 | 115 |
| Setup gas allowance | 188,447,551 | 188,447,551 |
| Total transactions: setup + one pass | **43,157** | **2,818** |
| Total projected gas | **8,587,491,263** | **7,687,645,345** |
| Total projected ETH | **0.1729864240** | **0.1548599278** |
| Total projected USD | **$395.72** | **$354.25** |

The 16 KiB option uses **93.72% fewer input-pass transactions** and **10.71% less projected input-pass gas**. The same input volume still has to be authenticated and decoded.

Setup combines the existing **91-transaction, 186,177,439-gas** quote for 32 core contracts and 224 banks with an assumed **24 root registrations at 94,588 gas each**. The former is an existing infrastructure baseline; adding the production reader changes source/bytecode and requires new quotes. The latter is a budgeting assumption, not a finalized protocol API. At the price snapshot, setup totals **$8.68**.

## Exact counting and calculation

The input set contains 14 base streams totaling 44,050,112 bytes plus 10 endpoint-patch streams totaling 14,912 bytes. Count each stream separately:

`calls = sum(ceil(stream_bytes / batch_payload_bytes))`

- 1 KiB: 43,024 base-stream calls + 18 patch calls = **43,042**; multiply by the measured **195,136 gas** per full reference batch.
- 16 KiB: 2,693 base-stream calls + 10 patch calls = **2,703**; multiply by **2,774,398 gas** per full reference batch.

The 16 KiB case batches **sixteen 1 KiB leaves with their individual proofs**, not one new 16 KiB Merkle leaf. Both cases preserve stream boundaries. Dividing the total bytes once would produce 43,033 and 2,690 calls; those smaller counts assume an unimplemented cross-stream batching API and are not used here.

Short last batches are charged at the full measured batch rate in this simple projection. This is not a proven upper bound: actual input entropy, differing proof depths, mixed integer/float records, endpoint-patch decoding, production bank routing and code-hash checks can change gas in either direction. The reference target estimates used first chunks of the complex nonbonded stream and 12-level proofs.

Of the full payload, 22,755,392 bytes use the float-only base codec, while 21,309,632 bytes are mixed-format streams or patches. The measured consumer does not implement that mixed/patch decoding. Applying its per-byte throughput rate to those bytes is an explicit sizing assumption, not evidence that the full typed model has executed at this cost.

These counts describe **calldata consumption**. They do not change the separate compressed permanent-storage upload projection of 10,818 transactions. The tested permanent-storage writer accepts at most 4 KiB per call; it has no measured 16 KiB upload operation.

## Pricing and scope

Prices were checked on **2 November 2026 at 19:51:43 IST (14:21:43 UTC)**: **0.020144 gwei** and **$2,287.575/ETH**. [full-pass-estimate.json](full-pass-estimate.json) preserves the exact block, source hashes, per-stream counts and arithmetic. The ETH conversion comes from the [Coinbase spot endpoint](https://api.coinbase.com/v2/prices/ETH-USD/spot). Gas-unit reference estimates are from the earlier pinned benchmark and infrastructure snapshots; only the conversion prices were refreshed here.

The [Robinhood fee documentation](https://docs.robinhood.com/chain/gas-and-fees/) says standard estimates include execution and data-posting fees, so no second L1 fee is added to those reference rates.

**Every additional identical full data pass would add approximately $387.04 or $345.57 at these same rates.** A data pass is not one force evaluation, MD step or complete campaign. A scientific run can read some inputs repeatedly and others sparsely, and it must compute forces and update working state. Those operations are not priced by this digest benchmark.

Excluded: production decoder/routing integration; additional C4/constraints/activity inputs; separate initial publication and supplying data later; model initialization; evolving positions, forces and progress; all molecular dynamics and analysis. Actual campaign gas and transaction counts remain unknown. No wallet access, signing, public testnet or mainnet transactions occurred; mainnet readiness remains false.

The [source archive](full-pass-estimate-sources.zip) includes the standard-library calculator, exact count inputs and price snapshot. Extract it and run `python3 output/calldata-full-pass-estimate/calculate.py --aura-root .` to reproduce the arithmetic without a GPU, network or full 44 MB data copy. The original input packing was GPU-verified in the linked comparison.
