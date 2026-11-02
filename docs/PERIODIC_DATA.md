# Periodic nonbonded input dataset

`PeriodicDataset` freezes an orthorhombic box, cutoff policy, per-atom nonbonded parameters and explicit pair exceptions on top of a sealed `DynamicsDataset`. The source dynamics dataset must have **zero explicit pair records**. The periodic coordinator instead enumerates every distinct unordered pair, so the old explicit pair list cannot silently omit or duplicate interactions.

This dataset fixes data availability and identity. It does not by itself establish a complete force field, valid prepared chemistry, acceptable reaction-field approximation or a binding-free-energy protocol.

## Construction and registration

Deploy `PeriodicDataset(owner, dynamicsCatalog)`. Both arguments must be valid: the owner is nonzero and the dynamics catalog has deployed code. The dynamics catalog address and runtime code hash are immutable. The implemented catalogs have no upgrade path; code hashes alone would not freeze the behavior of an arbitrary storage-backed proxy.

Only the owner may create input pages or register a new nonzero dataset ID. `createPage(role, capacityWords)` uses the existing `DataPage` implementation; the page owner uploads its words and irreversibly seals the page. Only pages created by this particular periodic catalog are accepted.

The registration signature is:

```solidity
registerDataset(bytes32 id, Registration input)

struct Registration {
    bytes32 dynamicsDatasetId;
    address[] nonbondedPages;
    address[] exceptionPages;
    uint32 exceptionCount;
    bytes16[3] box;
    bytes16 switchDistance;
    bytes16 cutoff;
    bytes16 prefactor;
}
```

The source dynamics dataset must contain 2–4,096 atoms and at least one bond, matching its existing schema, and must have `pairCount == 0`. Angle and torsion streams are inherited unchanged. The number of explicit exceptions is at most 4,096 and no greater than `N*(N-1)/2`.

Each nonempty stream uses 1–16 nonempty sealed pages. The nonbonded stream is always required; an absent exception stream has exactly zero pages and zero records. Pages must be unique within the registration and have the exact role. Total populated words must equal the declared record count times the record width. Page capacities and upload limits remain those of `DataPage`: at most 4,096 words per page and at most 128 words per append.

Registration is atomic. Any rejection rolls back stored configuration, page metadata and duplicate-page marks, so the owner can retry the same dataset ID with valid inputs. A successful ID cannot be reconfigured.

## On-chain configuration checks

Registration immediately validates these binary128-format configuration values:

- Every box length is positive and finite.
- `0 < switchDistance < cutoff`.
- `2*cutoff < box[axis]` for all three axes, strictly excluding the ambiguous half-box cutoff.
- `prefactor` is finite and nonnegative; either encoding of zero is accepted and the supplied bits remain part of the commitment.

Positive binary128 encodings are ordered by their unsigned integer value. The strict box check doubles the cutoff exactly by advancing its exponent, or shifting a subnormal significand. A finite cutoff whose doubling overflows is rejected. This avoids rounding a half-box value down near the subnormal boundary and requires no mutable numerical dependency. These configuration checks do not guarantee the domain of all subsequent arithmetic: a mathematically positive but extremely small box or cutoff may still fail a kernel's finite arithmetic or coordinate domain requirements.

## Stream schemas

Every word occupies `bytes32`. Integers use the low 32 bits; binary128 bit patterns use the low 128 bits. Unused high bits must be zero when read. Page boundaries may split a record at any word; canonical widths follow the **global record offset**, not the local page offset.

| Stream | Role getter / value | Words per record |
|---:|---|---|
| 0 | `NONBONDED_ROLE = keccak256("ORVIA.NONBONDED.v1")` | `sigma, epsilon, charge` — three binary128 values for each atom in source atom order |
| 1 | `EXCEPTION_ROLE = keccak256("ORVIA.EXCEPTIONS.v1")` | `a, b, kind` — uint32; `sigma, epsilon, chargeProduct` — binary128 |

The consuming coordinator validates positive sigma, nonnegative epsilon, finite charges and supported numerical domains during bounded initialization. Exception records must be canonical ordered pairs (`a < b`) in strictly increasing pair order. Kind 1 denotes an exclusion and requires all three numeric fields to be canonical positive zero. Kind 2 supplies explicit sigma, epsilon and charge product for the registered direct exception kernel. Those semantic restrictions are deliberately checked in resumable coordinator work, not in an unbounded registration loop. A schema-valid word can still be NaN, an invalid index, an unsupported kind or an unsuitable physical parameter.

Exception parameters are declared inputs. The catalog does not infer bonded exclusions, scale factors or ligand topology. The downstream protocol must verify that every required force-field exception is present and correct. Every pair absent from the exception table is an ordinary mixed nonbonded pair, including bonded pairs if their exclusions were omitted.

## Read APIs

`datasetInfo(id)` returns:

```text
(commitment, dynamicsDatasetId, atomCount, bondCount,
 angleCount, torsionCount, pairCount)
```

Here `pairCount` is the exact exhaustive count `N*(N-1)/2`, including pairs subsequently excluded or outside the cutoff. It is not the number of nonzero interactions or a retained neighbor list.

`periodicInfo(id)` returns:

```text
(box[3], switchDistance, cutoff, prefactor, exceptionCount)
```

`readNonbondedWord(id, index)` and `readExceptionWord(id, index)` read flat word indices, reject unknown datasets and out-of-range indices, verify the selected page and enforce canonical field widths. A read scans at most 16 page records.

`readPositionWord`, `readBondWord`, `readParticleWord`, `readAngleWord` and `readTorsionWord` check the pinned dynamics catalog code and delegate to that frozen source dataset. The existing lower-level catalog and page checks apply transitively to those reads.

`pageCount(id, stream)` and `pageInfo(id, stream, pageIndex)` expose the periodic catalog's two ordered page streams. `pageInfo` returns `(page, codeHash, digest, wordCount)`. `isCatalogPage(page)` exposes factory provenance.

`assertDataset(id)` verifies the pinned dynamics catalog code, the complete source dataset and every periodic input page, then returns the committed identity. A coordinator should use this assertion at registration and advancement; an individual word read does not inspect unrelated streams.

## Exact commitment

All hashes use Keccak-256 with Solidity `abi.encode`, never packed encoding. Each stream starts with:

```text
stream = keccak256(abi.encode(bytes32(role), uint256(pageCount)))
```

For each page in input order:

```text
stream = keccak256(abi.encode(
    bytes32(stream), uint256(pageIndex), address(page),
    bytes32(runtimeCodeHash), uint32(populatedWordCount), bytes32(rollingPageDigest)
))
```

The empty exception stream retains its role-specific initial hash for page count zero. Define `counts` as `uint32[5]` containing `[atoms, bonds, angles, torsions, exceptions]`, and `streams` as the two ordered `bytes32` stream hashes. Then:

```text
dynamicsHeader = keccak256(abi.encode(
    address(dynamicsCatalog), bytes32(dynamicsCatalogCodeHash),
    bytes32(dynamicsDatasetId), bytes32(dynamicsDatasetCommitment), uint32[5](counts)
))
configuration = keccak256(abi.encode(
    bytes16[3](box), bytes16(switchDistance), bytes16(cutoff), bytes16(prefactor)
))
datasetCommitment = keccak256(abi.encode(
    keccak256("ORVIA.PERIODIC.DATASET.v1"), uint256(chainId),
    address(periodicCatalog), bytes32(datasetId), bytes32(dynamicsHeader),
    bytes32(configuration), bytes32[2](streams)
))
```

A new dataset ID deliberately produces a new commitment even when all scientific inputs are identical. The complete identity binds original coordinates and dynamics streams transitively, the periodic configuration, declared exception count, actual paged parameters, chain and catalog instance.

`test/periodic-data.test.mjs` independently reconstructs the page and dataset hashes, exercises split-record schemas and all delegated readers, rejects ambiguous source pair lists, checks exact normal/subnormal configuration boundaries, validates atomic registration retry and tests altered transitive code detection in a local EVM.
