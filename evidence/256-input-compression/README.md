# Lossless input-storage audit

The complete scripts, reports and referenced subfolders below are in [`review-packet.zip`](review-packet.zip). Extract it to inspect or reproduce the audit. [`review-manifest.json`](review-manifest.json) is the original packet manifest; [`summary.json`](summary.json) contains the compact results. The raw model streams are separately source-bound and are not included in this small review packet.

The current 24 unique streams contain **10,903,836 logical 32-byte words**: 348,922,752 serialized bytes, about 349 MB. A/B particle streams are already shared. Much of the remaining size comes from storing nearly identical endpoint data twice and giving every small index or float an entire 32-byte word.

Every logical word was checked and reconstructed byte-for-byte in this audit. No coordinate, force-field parameter, atom, interaction or precision was removed. Source files and canonical contracts were not changed.

| Format | Physical payload words/slots | Nonzero data slots | Upload transactions |
|---|---:|---:|---:|
| Current 24 streams | 10,903,836 | 7,771,840 | 85,243 |
| Shared A base + exact B patches | 6,447,931 | 4,455,231 | 50,434 |
| Same overlay + two 128-bit values per slot | 3,224,200 | 2,628,702 | 25,249 |
| Same overlay + exact binary64/uint32 transport | 1,377,032 | 1,377,030 | 10,818 |

Upload counts include 128 payload records per append plus 24 stream-begin and 24 seal transactions. The current count is 85,195 appends + 48 begin/seal calls. Compressed-format counts are **projections requiring a new catalog/bank encoding implementation**. They are not gas estimates, prices, measured mainnet behavior or a deployment claim. Payload counts exclude stream/header/routing metadata. The 48 setup calls assume base/codec metadata is established within begin/seal; extra configuration calls would increase the projection.

## The simplest safe saving

Across both legs, B differs from A in only **466 words**: 233 per leg. The changes are 50 nonbonded, 6 bond, 24 angle, 31 torsion and 122 exception words per leg. Of these, 58 total change to zero. All other endpoint words remain identical, and the existing shared particle alias stays shared.

Store each A stream once and represent B as a sealed reference to A plus these exact patches. All input words have zero upper 128 bits, verified across the entire source. A patch's stored value can therefore use a spare bit to distinguish “present with value zero” from “no patch.” One slot per patch suffices; a payload containing a 64-bit logical index and the 128-bit value also fits in one upload word. Any generic zero-write elision must happen **after patch decoding and presence tagging**: the payload for index 0/value 0 can itself be zero, while its stored PRESENT-tagged value is nonzero and must be retained. `overlay-patches/` contains these 466 encoded records and their hashes.

The reader returns a patch when present and otherwise returns the frozen base word. Overlay depth must be limited to one. Per-role patches are confined to small bands of 69–1,401 logical indices, so reads outside authenticated min/max bounds can go directly to the base. Exact B reconstruction and every source hash were verified.

## Packing and zero handling

The two-per-slot format concatenates the low 128 bits of consecutive logical words; the reader extracts and zero-extends the selected half. Its full byte roundtrip is verified. This changes storage representation, not binary128 arithmetic or parameter precision.

The independent role-typed audit also checked **all 7,138,962 floating-point words**: every one is an exact embedding of an IEEE binary64 value, including 3,131,850 positive zeros. Every one of the 3,764,874 integer words fits uint32. Packing eight-byte float bits and four-byte integers, then expanding before use, reconstructs the original binary128 words exactly. This is a transport/storage encoding; **simulation arithmetic remains binary128**. The dense layout plus the same overlays needs 1,377,032 payload slots and projects 10,818 upload calls. Every source word was reconstructed under four typed formats: 43,615,344 layout-word comparisons. The optional uint24/u8 layout is slightly smaller but requires narrower explicit domain admission; it is documented in `typed-packing/README.md` rather than selected as the default proposal.


The 349 MB figure is logical serialization, **not 349 MB of incremental trie state**. The current data has 3,131,996 zero words. Those already leave no nonzero mapping slot even though the current append code executes zero writes, sends those words and hashes their logical positions. Simply skipping a fresh zero SSTORE saves execution work; it does not by itself reduce the existing upload transaction count or save an already empty slot. Table counts distinguish physical payload capacity from actually nonzero data slots.

## Implementation requirements and scope

A versioned commitment must bind encoding, role, logical length, the sealed base commitment and sorted unique patches. Reject duplicate/out-of-order/out-of-range patch indices and noncanonical upper bits; preserve changed-to-zero patches. Seal before allowing reads, pin bank code hashes, and preserve coverage/authentication. A source hash supplied by an owner is not a substitute for this on-chain content binding.

The format can be implemented inside the existing catalog and its **96 input banks**, keeping the total **32 core + 224 bank addresses** (the other 128 banks hold working state). No extra deployed decoder or off-chain production data availability is needed. The decoder can maintain the same logical `readWord`/`readWords` results; commitments must identify the new representation explicitly.

Read overhead and decoding gas must be measured after implementation. Fewer upload/storage words do not prove the same percentage reduction in total campaign cost. Native/experimental C4, constraints, explicit activity metadata and future protocol inputs are not included in these 24 core streams. Scientific/model/policy acceptance remains false.

Reproduce with the full source stream archive available locally:

```sh
/absolute/path/to/python audit_overlay.py \
  --input-root /absolute/path/to/full-hybrid-inputs \
  --output-root /absolute/path/to/new-audit-output
```

The script requires NumPy, writes only its output directory, verifies compressed/raw input hashes before use, and rechecks all source hashes afterward. `overlay-audit.json` contains per-stream counts, exact patch index bands, roundtrip results and source bindings. `typed-packing/` contains the separate typed audit, its source hashes and reproduction instructions; `independent-review/` preserves the independently executed overlay reconstruction (1,590 checks). CPU vector operations are sufficient; GPU computation adds no benefit for this small byte-level audit.
