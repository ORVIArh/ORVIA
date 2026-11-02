# Fixed-bank molecular input storage

`BankedInputCatalog` stores sealed molecular input streams in **96 permanent `InputWordBank` contracts plus one catalog**. Every stream shares those banks. Uploading another 4096 words, adding a stream, or passing another routing cycle creates no contracts. Storage slots and upload gas still grow with the data.

This is a storage component for the larger on-chain architecture. It does not complete the scientific pipeline, accept a prepared model, or establish mainnet readiness.

## Allocation and routing

The constructor accepts a nonzero owner and deploys no children. The owner calls `createBanks(count)` with 1–4 banks per transaction until `bankCount()` reaches 96. Creating a 97th bank is impossible through this interface. Each bank has a deterministic CREATE2 address, an immutable bank index, an immutable router, and the router's runtime code hash. The catalog records and authenticates each child's runtime code hash.

Streams can begin only after all 96 banks exist. For a zero-based global word index:

```text
bank index = floor(global index / 4096) mod 96
storage key inside that bank = (stream ID, global index)
```

Indices 0 and 393216 therefore use bank 0 but different storage keys. Two streams with the same global index also use different keys. A batch of at most 128 consecutive words touches at most two banks. Reads use direct arithmetic lookup rather than scanning stream pages.

## Interface and invariants

| Operation | Behavior |
| --- | --- |
| `createBanks(uint8 count)` | Owner-only incremental creation, maximum four per call and 96 total. |
| `bankInfo(uint8 index)` | Returns the permanent address and recorded runtime hash. |
| `beginStream(bytes32 id, bytes32 role, uint64 totalWords)` | Declares one new stream with exact expected coverage. Zero-length streams are permitted. |
| `appendWords(bytes32 id, bytes32[] values)` | Appends 1–128 words at the next canonical offset. Callers cannot select an offset, replace earlier words, or exceed declared coverage. |
| `sealStream(bytes32 id)` | Requires exactly the declared number of words and permanently freezes the stream. |
| `assertStream(bytes32 id)` | Returns the sealed commitment and total word count. |
| `readWord(bytes32 id, uint64 index)` | Reads one authenticated word from a sealed stream. |
| `readWords(bytes32 id, uint64 start, uint32 count)` | Reads 0–128 authenticated words from a sealed stream, including across a bank boundary. |
| `streamInfo(bytes32 id)` | Preserves the existing consumer ABI. Its `pageCount` output is the logical number of occupied 4096-word blocks, **not a deployed-contract count**. |

The `assertStream`, `readWord`, `readWords`, and `streamInfo` signatures match `PartitionedInputCatalog`. The existing catalog remains available as a research fixture. Importers must use `appendWords` for this implementation; there is no `createPage`, `appendPage`, or external-bank adoption path.

Only the catalog can write its banks, and the bank checks the catalog's pinned runtime hash. The catalog exposes no arbitrary bank-write function: its only write path advances an unsealed stream's next offset. Every catalog read and write authenticates the bank it touches. Direct reads of raw bank storage do not establish coverage or sealing; consumers must use the catalog interface.

## Commitments

All hashes use `keccak256(abi.encode(...))`; text domains below are `bytes32` values. The bank-set commitment starts with `(ORVIA-INPUT-BANKS-v1, chainId, catalog, uint256(96), uint256(4096))` and folds each `(previousCommitment, uint8(index), bankAddress, bankCodeHash)` in increasing bank order.

A stream starts with `(ORVIA-BANKED-INPUT-v1, chainId, catalog, streamId, role, uint64(totalWords), banksCommitment)`. Each appended word updates the digest with `(previousDigest, uint64(globalIndex), word)`. The final commitment binds `(ORVIA-SEALED-BANKS-v1, chainId, catalog, streamId, role, uint64(totalWords), finalDigest, banksCommitment)`.

This encoding commits word order, stream identity, role, expected size, deployment, chain, and bank set. The word-by-word digest is independent of transaction batch boundaries. It commits the submitted bits; it does not prove their scientific correctness.

## Focused local evidence

Run `node --test test/banked-input.test.mjs` from the repository root. It compiles this source in memory and writes only its own `reports/banked_input_validation.json`; it does not regenerate the global build or validation report.

The test invalidates its prior result before compiling, requires Solidity 0.8.26, and records eight check groups covering real deployment of all 96 children, factory/address/hash identity, authorization, exact coverage, a 4133-word upload crossing the 4096-word boundary, an independently reconstructed commitment, replay with different transaction partitions, immutable sealed streams, zero values, empty streams, cross-stream isolation, bounds, and bank-code tampering. An actual reverted cross-bank append checks that a failure at the second bank rolls back the first bank's write and the stream cursor; subsequent completion must still match an independently reconstructed commitment. A separate local harness checks non-aliasing at global indices 0 and 393216; this is **not** a claim that 384000-plus canonical words were uploaded. Pure routing is also checked near the `uint64` limit.

Measured local deployment gas was **1,673,103** for the catalog and **40,231,604** for the 96 banks: **41,904,707 total**. That run used 25 bank-creation transactions to exercise partial initialization (one bank first, then groups of four, and a final group of three). These are local EVM execution measurements, exclude input loading and mainnet data-posting fees, and do not quote the complete 256-contract system.
