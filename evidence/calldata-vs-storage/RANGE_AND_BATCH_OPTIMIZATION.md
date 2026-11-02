# Shared proofs and bundled transactions

**Best tested candidate: four 16 KiB range operations in one transaction.** It preserves the model bytes and calculation precision, reduces transaction count by 75% for those four operations, and uses 2.63% less estimated gas than sending them separately. This is an isolated data-access prototype; it is not integrated into the 256-contract engine or deployed.

## Comparison

All three cases consume the **same first 64 KiB of actual complex33 nonbonded input** on the same compiled benchmark runtime and at the same Robinhood mainnet block. Each path verifies the input, expands the original floating-point values exactly and computes ordered digests.

| Processing the same 64 KiB | Transactions | Target gas estimate |
|---|---:|---:|
| Four separate 16 KiB range calls | 4 | 10,834,995 |
| **Four 16 KiB range calls bundled** | **1** | **10,549,574** |
| One 64 KiB range call | 1 | 12,349,477 |

The bundle saves **285,421 gas (2.63%)** versus four separate transactions, or **14.57%** versus one large 64 KiB operation. The four bundled results and result events exactly match the four separate calls. The single 64 KiB operation processes the same values but has one independently seeded digest instead of four.

Local EVM receipt totals were respectively **10,393,288**, **10,331,640** and **12,134,703 gas**. The bundle's local execution saving is only **61,648 gas (0.59%)**. The larger target-estimate difference includes the target fee estimator's treatment of the transaction encodings; it is not all an execution saving. According to [Robinhood's fee documentation](https://docs.robinhood.com/chain/gas-and-fees/), standard gas estimates include execution and data-posting fees. Do not add a second L1 posting fee.

The target snapshot is block `0x63769ad`, hash `0xe454bce15614c974b891257b55ff6076f487a38fd51de571e81b66d246443cc5`. These were read-only estimates using exact compiled code and hypothetical preceding state. No public transaction was sent, and future fees can differ.

## What bundling changes

The prototype exposes one bounded `consumeRanges` entry point accepting up to four operations, each at most 16 KiB. It calls the existing authenticated range reader separately for each operation. Separate child memory frames avoid the higher memory cost measured in the one-operation 64 KiB case. The wrapper still pays for argument copying and every proof, decode and digest operation.

This is **one on-chain transaction containing four calls**. Submitting four ordinary transactions together leaves four transactions and does not reproduce this result. A future production implementation can add the entry point to a planned contract; this experiment does not propose adding a 257th contract.

The call is atomic: a bad proof in the fourth operation reverts the entire batch. A local regression first verified the three valid preceding results, then confirmed the corrupted-fourth transaction had failed status, zero surviving logs and unchanged application storage. Failed transactions still consume gas. Batch size therefore needs a bound, and inputs should be checked before submission.

The wrapper is nonpayable, calls only itself and accepts no arbitrary target or delegatecall. The experimental child reader is permissionless and does not use the caller for authorization. A production integration must preserve its own caller and state rules; the self-call pattern cannot simply be copied into sender-authorized operations.

## Shared-proof improvement

Before bundling, an aligned range proof removes repeated Merkle branches while keeping the original root and index-bound leaf format. For 16 KiB it transmits **8 ancestor hashes (256 bytes)** instead of **192 hashes (6,144 bytes)**. All sixteen original leaves are still hashed and authenticated.

The separately compiled range comparison, at the same pinned block, measured **2,909,375 gas** for sixteen individual proofs versus **2,701,791 gas** for one shared range proof: **7.135% less gas**. Its runtime differs from the bundled-runtime comparison above. A one-leaf or sparse read was slightly more expensive with the generic range reader, so it should not replace every small read indiscriminately. Do not multiply the 7.135% and 2.63% figures into an unmeasured full-model saving.

## Full-input transaction layout

The existing packed input remains **44,065,024 bytes across 24 streams**. Decomposing each stream into aligned powers-of-two with a 16 KiB maximum produces **2,727 range operations**: 2,679 full 16 KiB operations plus 48 smaller tail operations. The older 2,703-call estimate allowed arbitrary final batch sizes; aligned proofs require splitting some tails.

Packing up to four range operations per transaction gives a projected **682 data transactions**. Adding the previous illustrative **115 setup transactions** gives **797 setup-plus-pass transactions**. This assumes the batching interface can group operations from different streams and that all required codecs are integrated. It is an exact count for that proposed layout, not an executed full-model run or an updated deployment quote.

The separate range-rate model in `range-optimization-summary.json` projects about **$344.70** for setup plus one input pass, versus **$372.15** for the contemporaneous individual-proof baseline, at the recorded 20:13:59 IST price snapshot on 2 November 2026. These are **unbundled, rough data-access projections** and do not quote the 682-transaction bundle layout. Older dollar estimates use different fee snapshots and should not be compared as measured optimization savings.

About half the packed input requires mixed-field or endpoint-patch decoding that this float-only fixture does not implement. Production bank routing, code-hash checks, initialization, forces, molecular dynamics, working state, data availability and resupply are unpriced. The existing setup allowance must be replaced after production bytecode is finalized. **A full simulation's gas, transaction count and deployment readiness remain unproven.**

## Evidence and reproduction

- [batch-optimization-summary.json](batch-optimization-summary.json): exact comparison arithmetic, source/report hashes and projected transaction layout.
- [range-optimization-summary.json](range-optimization-summary.json): range-size measurements, historical conversion prices and explicitly limited full-input rate projections.
- `range-data-packet.zip`: original-root range producer, actual sample bytes and proofs.
- `range-evm-packet.zip`: range source, pinned compiler inputs, 29 checks, local receipts, 14 read-only target estimates and exact state witnesses.
- `bundle-evm-packet.zip`: bounded wrapper, 13 primary checks, fourth-child rollback supplement, local receipts and six read-only target estimates.
- `optimization-review-packet.zip`: independent data/source/compilation checks, original binary128 source-digest checks, all 20 target request/response/runtime witness checks, count and pricing scripts, and the read-only RPC helper.
- [manifest.json](manifest.json): hashes of every public artifact in this folder.

Extract the three data/EVM archives under a common `AURA/output` directory and the review archive under `AURA`; use the pinned dependencies in `ORVIA/node_modules`. The range runner supports `--local-only`, and the bundle's fourth-child rollback regression runs entirely locally. The bundle comparison runner also performs read-only target estimates; see the included READMEs. Independent full-source checks need the original large input files and prior data manifest identified by the archived hashes. Those large files are not duplicated here. The private RPC URL and encrypted wallet are excluded. No additional GPU work was necessary: the optimization reused previously verified packed bytes.

Scientific acceptance and mainnet readiness remain false. No public testnet, wallet access, signing or mainnet deployment occurred.
