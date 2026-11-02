# Full hybrid input evidence

This compact checkpoint preserves static component evidence. It is not a full
Hamiltonian, trajectory, binding result, mainnet validation or scientific
acceptance. Start with [the scope and counts](../../docs/FULL_HYBRID_INPUTS.md),
[assembly report](../../reports/full_hybrid_assembly_validation.json), and
[C4 report](../../reports/c4_endpoint_validation.json).

`sources/` contains byte-identical executed scripts, the pinned native importer
and supporting native source. `policies/` retains the criteria declared before
energy queries. `historical/` retains compact current and failed-attempt evidence.
`inputs/` identifies the required raw files and the verified local archive;
large raw streams, parameters, full vectors and runtime binaries are outside Git.
The compact C4 export descriptor records hashes/counts for the omitted large maps.

The sole portable entry point is `reproduce.py`. Exact historical scripts retain
their original workspace paths. The adapter creates path-only copies in a fresh
output directory and records the changed source hashes; it does not edit the
frozen originals or native inputs. Its policies keep the numerical thresholds
while rebasing path/runtime provenance before any new energy query. Replays are
new evidence and do not change the historical records.

```sh
python evidence/full-hybrid-inputs/reproduce.py \
  --source-root /path/to/science-or-archive-scientific-inputs \
  --output /path/to/replay --check-inputs

python evidence/full-hybrid-inputs/reproduce.py \
  --source-root /path/to/science-or-archive-scientific-inputs \
  --output /path/to/replay --stage all
```

Run with the recorded `8.6.1.dev-b399af4` OpenMM revision and matching native
importer plus NumPy/mpmath. The adapter rejects a different importer/revision and
records the actual runtime build hashes. GPU C4 checks require OpenCL single.
`--stage lrc` can run its small fixtures without native inputs. Other stages are
`assemble`, `verify`, `bonded`, `preserve`, and `c4`.

The packaging smoke covers 18 input hashes, six path-adapted scripts and all 16
small Reference contexts. It does not rerun the full-size historical measurements.
Hybrid C4 activity/coupling and all production/scientific gates remain unaccepted.
