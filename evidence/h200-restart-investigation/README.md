# H200 restart investigation — 3 November 2026

**The short restart diagnostic passed. The earlier 20,000-step continuation failure remains unresolved.** This is diagnostic evidence, not scientific acceptance or a new on-chain result.

The failure in `orvia-stress-replay-20261102-03` was a strict coordinate/velocity tolerance failure, not a timeout. No GPU hardware failure was identified. All four historical checkpoint restores recovered positions, velocities, box and time exactly, and all twelve historical energy/force comparisons passed; continued trajectories later exceeded the position and velocity thresholds.

The follow-up used the H200 with double-precision CUDA on both full models: `complex33` (132,935 particles) and `solvent33` (151,505 particles). It compared same-context, new-context and fresh-process checkpoint continuations at steps **0, 1, 10 and 100**. All 24 comparison points passed the unchanged strict thresholds. It executed **1,000 new integration steps in aggregate across both models and branches**, completing in **46.414 seconds**; this was not a 1,000-step continuation test.

| Largest short-diagnostic difference | Position (nm) | Velocity (nm/ps) |
| --- | ---: | ---: |
| complex33 | 7.461 × 10⁻¹⁴ | 3.178 × 10⁻¹¹ |
| solvent33 | 1.035 × 10⁻¹³ | 3.053 × 10⁻¹¹ |
| Strict threshold | 1 × 10⁻⁹ | 1 × 10⁻⁸ |

Exact state restoration did not guarantee bitwise-identical forces in every branch. Tiny initial force differences are observed; the native root cause of the longer continuation divergence is **not proven**. No tolerance was relaxed and the historical failed attempt remains failed.

The H200 pod was left online. At the recorded post-diagnostic check (`2026-11-02T19:24:53Z`), it was idle at 0% utilization and 27°C. The website's failure-status wording was clarified in live deploy `6ae8e30e5b7abc25b9990fa4`. No transaction or accepted scientific report was submitted by this investigation.

## Evidence

[Download review-evidence.zip](review-evidence.zip) for the exact diagnostic source, returned JSON and logs, historical failure review, operation summary, and independent review script/report. `artifact-manifest.json` inside the archive records each included file's SHA-256 and size, plus the hashes of the two omitted native diagnostic checkpoints. The returned `original-inventory.json` preserves the historical artifact inventory, including checkpoint and NPZ hashes.

The archive is intentionally compact: native `.chk` and `.npz` data are not included. The independent review was performed against the complete local diagnostic return, including both checkpoints. It verifies source/result bindings and recomputes the reported threshold gates; it does not independently reproduce the molecular calculations or rehash the historical remote evidence. Re-running the review script requires restoring the omitted checkpoints at their recorded paths.

The original downloaded archive SHA-256 is `6b8a7fd45eded8b9a3671abb3bb7b4236a73596418c8fcfddcfa84f1637b49de`. This compact `review-evidence.zip` SHA-256 is `faf05f87cb01ea66d8166d6b1d2892ffd8ae2834e9d3362bf66a95736b7d964d`.
