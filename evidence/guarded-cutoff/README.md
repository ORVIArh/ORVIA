# Frozen guarded-cutoff comparison

This directory preserves historical component evidence for the original
`FloatMath`/ABDK binary128 Hamiltonian cutoff change. It does not validate the
current combined engine, a full protein force pass, a trajectory, a target-chain
fee, or scientific model acceptance.

The baseline Hamiltonian SHA-256 is
`e9b600dbb007e1d6f479db23eea48316eadc21b4333ca9f0a37c5712a92a30ee`;
the candidate is
`a90eb8f88c0d2fdd7a6478a74510e88589099a5c79d3cd359443d363b847596b`.
The frozen `baseline-sources.json` retains every compiler input source byte used
in the comparison. The compiler was solc 0.8.26, optimizer 200, Shanghai.

Both historical reports passed: 34 profiles and 54 evaluations per implementation,
with 40 complete evaluations, 14 matching expected rejections, and 1,020 raw force
and energy-component words compared. Stage/cursor/mode traces and expected error
selectors matched. The mixed 4- and 8-atom fixtures include bonds, angles,
torsions, inside/outside normal pairs, direct/excluded exceptions, and endpoint
and interior lambda states. Native work-1/work-8 complete outputs also matched.

The native 16-atom work-8 pair stage used 48,751,689 baseline versus 29,306,414
candidate gas: 39.8864% less. Complete advancement receipts used 429,283,576 versus
410,569,038 gas; these totals exclude registration, setup, upload, and deployment.
The eligibility prepass adds gas and eligible inside pairs duplicate the norm;
small neutral inside fixtures cost about 4% more. This is not a universal speedup.
The local EVM allowed large contracts and is not a target-client throughput test.

`publication-copy-manifest.json` verifies copies from the original evidence
directory. `artifact-manifest.json` preserves its original payload map, whose
paths refer to that original workspace. Absolute paths in the original reports
are provenance, not portable replay dependencies. `outside-pair-input.json` is a
byte-identical colocated native fixture; no GPU source path is required to run
the comparison. The old `gas-report.source.json` is retained only to bind the
optional outside-census sensitivity in `review-summary.json`. Reproducing that
full-model sensitivity additionally requires its separately source-hashed model
and census assets; it is not a complete force or campaign budget.

The original executed runner bytes remain unchanged:

- `benchmark-primary-run.mjs`: SHA-256
  `6ac7e0a0183b4e53005ded73643085d927ec99be4fa14480e5ff7b89dc95c9b7`.
- `mixed-benchmark.mjs`: SHA-256
  `50f948d3e1aa6e25c0887d2cdb16991d38f20d181dbde194987242e3ee8f462e`.

Original preparation, generation and analysis helpers retain their historical
workspace paths as provenance. The supported portable entry point is
`replay.mjs`; do not regenerate the frozen candidate from current contracts.

From the repository root, install the pinned Node dependencies, then use the
portable adapter:

```sh
npm ci
node evidence/guarded-cutoff/replay.mjs --compile-only
node evidence/guarded-cutoff/replay.mjs --native-only
node evidence/guarded-cutoff/replay.mjs
node evidence/guarded-cutoff/replay.mjs --mixed
```

The last two commands replay all 54 comparisons together and can take tens of
minutes. The adapter writes a fresh, ignored `replays/` directory and changes only
workspace paths in a generated runner. It checks that both standard compiler
input hashes still match the historical reports. It never overwrites the frozen
reports or substitutes current contracts for the frozen source bundle. A compile
smoke result establishes portable compilation only; it does not rerun numerical
or gas comparisons.

`packaging-smoke.json` records a successful portable compile smoke with both
compiler input hashes matching the historical runs. The 54 comparisons were not
rerun for packaging. `publication-manifest.json` binds the published payload.

The shortcut assumes authenticated sealed immutable input pages. Arbitrary
mid-run page-code replacement can change when a fault is detected; the historical
comparison does not claim equivalence under `evm_setAccountCode`. Scientific,
parameter-quality and physical-model gates remain false. No transaction was sent
to mainnet.
