# ORVIA paged numerical inputs

`DatasetCatalog` registers immutable, readable numerical datasets for the experimental harmonic-bond component. It creates trusted `DataPage` instances, checks their roles and exact word coverage, and commits their ordered identities and frozen contents. This is an input path for the component fixture; it does not establish a prepared molecular system, complete force field or production simulation.

## Ownership and registration

Deploy `DatasetCatalog(owner)`. The immutable owner calls `createPage(role, capacityWords)`, then uploads and seals each returned `DataPage` directly. Page ownership is the catalog owner, so the catalog does not need to relay uploads. `PageCreated` records the page address, role and capacity. The catalog accepts only pages created by its own factory; a separately deployed lookalike page is rejected.

The supported role constants are:

| Constant | Value |
|---|---|
| `POSITION_ROLE` | `keccak256("ORVIA.POSITIONS.v1")` |
| `BOND_ROLE` | `keccak256("ORVIA.BONDS.v1")` |

Existing `DataPage` limits apply: a capacity of 1–4,096 words, at most 128 words per append, and a nonempty page before irreversible sealing. Capacity is an upload bound; registration uses the actual populated word count.

The owner registers an unused nonzero ID through:

```solidity
registerDataset(id, positionPages, bondPages, atomCount, bondCount)
```

Each ordered page list must contain 1–16 catalog-created, sealed, nonempty pages of the matching role. Page addresses must be unique across both lists within a dataset. An immutable page can be reused by a different dataset ID. Atom count is 2–4,096; bond count is 1–16,384. Position pages must contain exactly `3 * atomCount` words in total and bond pages exactly `4 * bondCount` words. Failed registration leaves no partially registered dataset. A registered ID cannot be edited, removed or reassigned.

## Canonical word schema

Each entry occupies one complete EVM `bytes32` word. Position and bond pages form separate flat streams; page boundaries may split an atom or bond record.

| Stream offset | Meaning | Canonical encoding |
|---|---|---|
| Position `3 * atom + 0` | x coordinate | Binary128 bit pattern in the low 128 bits; upper 128 bits zero |
| Position `3 * atom + 1` | y coordinate | Same |
| Position `3 * atom + 2` | z coordinate | Same |
| Bond `4 * bond + 0` | Atom index a | Unsigned integer in the low 32 bits; upper 224 bits zero |
| Bond `4 * bond + 1` | Atom index b | Same |
| Bond `4 * bond + 2` | Force constant k | Binary128 bit pattern in the low 128 bits; upper 128 bits zero |
| Bond `4 * bond + 3` | Equilibrium length r0 | Same |

For Solidity encoding, a binary128 value `bytes16 value` becomes `bytes32(uint256(uint128(value)))`. Casting `bytes16` directly to `bytes32` puts the value in the high half and does not implement this schema. Readers decode the low half with `bytes16(uint128(uint256(word)))`.

Registration validates provenance and stream coverage without reading every numerical word. `readPositionWord` and `readBondWord` reject nonzero unused upper bits when the selected word is read. Bond field selection uses the global stream index, including across page boundaries. The consuming coordinator must additionally reject nonfinite coordinates/parameters, out-of-range or self-referencing atom indices, unsupported parameter values and singular geometries. A registered dataset is therefore not a claim that all its numerical operands have already passed those checks.

## Commitment and verification

Registration freezes each page's address, runtime code hash, actual word count and rolling digest. Each page has its own code hash because constructor immutables can differ. `DataPage` includes its role and capacity in the initial rolling digest and folds each appended word in order.

The dataset commitment uses Solidity `abi.encode` and `keccak256` with the following exact structure:

```text
stream = keccak256(abi.encode(role, uint256(numberOfPages)))
for each page i, in supplied order:
    stream = keccak256(abi.encode(
        stream, uint256(i), address(page), bytes32(codeHash),
        uint32(wordCount), bytes32(rollingDigest)
    ))

commitment = keccak256(abi.encode(
    keccak256("ORVIA.DATASET.v1"), uint256(chainId), address(catalog),
    bytes32(datasetId), uint32(atomCount), uint32(bondCount),
    bytes32(positionStream), bytes32(bondStream)
))
```

This binds chain, catalog, dataset ID, schema roles, counts, page order and frozen page metadata. Changing any of those inputs changes the commitment. It is an integrity commitment, not a substitute for storing the numerical input bytes on-chain.

`assertDataset(id)` rechecks every page's runtime code hash, sealing status, digest and count before returning the stored commitment. Each numerical-word read also rechecks the selected page. Catalog-created pages have no mutation path after sealing and no upgrade mechanism. Callers should bind the catalog and dataset commitment to their experiment version and use the catalog's assertions when accepting and advancing a run.

## Read APIs

| Function | Result |
|---|---|
| `datasetInfo(id)` | Frozen commitment, atom count and bond count |
| `assertDataset(id)` | Frozen commitment after rechecking all registered pages |
| `readPositionWord(id, index)` | Canonical position word from the flat stream |
| `readBondWord(id, index)` | Canonical bond word from the flat stream |
| `pageCount(id, bondStream)` | Number of pages; `false` selects positions, `true` selects bonds |
| `pageInfo(id, bondStream, pageIndex)` | Frozen page address, code hash, digest and word count |
| `isCatalogPage(page)` | Whether this catalog created the page |

Unknown datasets and out-of-range indices revert. A read scans at most 16 page records. The bytes remain directly readable from both the catalog and their source pages; no off-chain content service is needed to recover the operands. Numerical canonicality checks apply to catalog readers, while direct `DataPage` reads expose raw stored words.

Dataset-specific page counts are workload dependent. They do not change the distinction between the project's 64 planned production slots and the currently implemented experimental components. Full molecular input schemas and mutable simulation pages remain separate work.
