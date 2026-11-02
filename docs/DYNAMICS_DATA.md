# Dynamics input dataset

`DynamicsDataset` extends a sealed `DatasetCatalog` record with masses, initial velocities, angle and torsion terms, and explicit nonbonded pairs. All operands are readable on-chain. Registration checks provenance, exact stream coverage and immutable identity; the consuming dynamics coordinator must validate numerical values, indices and supported physical domains.

## Construction and registration

Deploy `DynamicsDataset(owner, baseCatalog)`. The base catalog address and runtime code hash are immutable. The owner creates input pages with `createPage(role, capacityWords)` and uploads/seals those `DataPage` instances directly. Only pages created by this specific dynamics catalog are accepted. The existing base catalog supplies initial coordinates and bonds through one frozen base dataset ID.

Registration takes a calldata tuple to fit the pinned non-viaIR compiler:

```solidity
registerDataset(bytes32 id, Registration input)

struct Registration {
    bytes32 baseDatasetId;
    address[] particlePages;
    address[] anglePages;
    address[] torsionPages;
    address[] pairPages;
    uint32 angleCount;
    uint32 torsionCount;
    uint32 pairCount;
}
```

The owner registers each nonzero ID once. Input pages must be nonempty, sealed, unique across all four streams and have the exact role. Each populated stream allows 1–16 pages; a zero-count optional stream must have zero pages. Particle count equals the base atom count (2–4,096). Angle, torsion and pair counts are independently 0–4,096. A failed registration leaves no partial metadata, page list or duplicate-page marking; the same ID can be retried with valid inputs.

`DataPage` capacities remain at most 4,096 words and each upload at most 128 words. Capacity is distinct from populated count. Empty pages never stand in for absent scientific interactions.

## Stream schemas

Stream numbers in `pageCount` and `pageInfo` are 0 particles, 1 angles, 2 torsions and 3 pairs. Every entry occupies one `bytes32`. Unsigned fields use the low 32 bits; binary128 values use the low 128 bits. All unused upper bits must be zero.

| Stream / role | Words per record, in order |
|---|---|
| 0 / `keccak256("ORVIA.PARTICLES.v1")` | `mass, vx, vy, vz` — all binary128 |
| 1 / `keccak256("ORVIA.ANGLES.v1")` | `a, b, c` — uint32; `k, theta0` — binary128 |
| 2 / `keccak256("ORVIA.TORSIONS.v1")` | `a, b, c, d, periodicity` — uint32; `k, phase` — binary128 |
| 3 / `keccak256("ORVIA.PAIRS.v1")` | `a, b` — uint32; `sigma, epsilon, chargeProduct, prefactor` — binary128 |

Public role getters are `PARTICLE_ROLE`, `ANGLE_ROLE`, `TORSION_ROLE` and `PAIR_ROLE`. Angles use atom b as the vertex. Torsion orientation and parameter domains are specified by the registered kernel. A pair explicitly supplies the inputs expected by the Lennard–Jones and direct Coulomb primitives; it does not silently choose a mixing, exclusion, cutoff or periodic electrostatics convention.

Page boundaries may split records at any word. Canonical-width checks use the global stream offset rather than restarting the schema at each page. Numerical checks are intentionally deferred: schema-valid bits can still represent NaN, negative mass or invalid atom indices, and cannot be treated as a validated experiment without the coordinator's checks.

## APIs

`datasetInfo(id)` returns `(commitment, baseDatasetId, atomCount, bondCount, angleCount, torsionCount, pairCount)`.

`readParticleWord`, `readAngleWord`, `readTorsionWord` and `readPairWord` take `(id, flatIndex)`. Each rejects unknown IDs, out-of-range indices, changed page metadata and noncanonical word encodings. A read scans at most 16 pages. `readPositionWord` and `readBondWord` check the pinned base catalog code and delegate to the frozen base record's canonical readers.

`assertDataset(id)` checks the base catalog runtime hash, the entire frozen base dataset and every additional page before returning the stored commitment. The consuming coordinator should call it when registering and advancing a run. `pageCount(id, stream)` and `pageInfo(id, stream, pageIndex)` expose ordered page metadata; `isCatalogPage(page)` exposes factory provenance.

The implemented catalogs and pages have no upgrade or post-seal mutation path. Pinning an arbitrary proxy's runtime code would not provide the same immutability guarantee.

## Exact commitment

All hashes use Solidity `abi.encode` and Keccak-256, not packed encoding. Each stream starts with `keccak256(abi.encode(bytes32(role), uint256(pageCount)))`. For each page in order it folds:

```text
stream = keccak256(abi.encode(
    bytes32(stream), uint256(pageIndex), address(page), bytes32(runtimeCodeHash),
    uint32(populatedWordCount), bytes32(rollingPageDigest)
))
```

Empty optional streams retain the role-specific initial hash with pageCount zero. Define `counts` as `uint32[4]` containing `[atomCount, angleCount, torsionCount, pairCount]` and `streams` as `bytes32[4]` containing the four stream hashes. Then:

```text
baseHeader = keccak256(abi.encode(
    address(baseCatalog), bytes32(baseCatalogCodeHash), bytes32(baseDatasetId),
    bytes32(baseDatasetCommitment), uint32(atomCount), uint32(bondCount)
))
datasetCommitment = keccak256(abi.encode(
    keccak256("ORVIA.DYNAMICS.DATASET.v1"), uint256(chainId), address(dynamicsCatalog),
    bytes32(datasetId), bytes32(baseHeader), uint32[4](counts), bytes32[4](streams)
))
```

Reusing the same immutable pages under a new dataset ID deliberately produces a new commitment. The hashes bind actual stored data and executable identities; they do not replace data availability or establish physical validity.

## Scope

This is a bounded dynamics-component input schema, not a complete solvated-protein force-field format. No automatic pair enumeration, mixing/exclusion policy, neighbor list, periodic box, reciprocal electrostatics or ligand parameterization is supplied by this catalog. Its counts do not establish that the eventual myosin system fits the current development bounds.

`test/dynamics-data.test.mjs` verifies split records, base delegation, independent commitment reconstruction, absent optional streams, immutability, access/provenance rules, canonical encodings and atomic rejection/retry.
