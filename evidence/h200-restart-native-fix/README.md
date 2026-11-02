# H200 native checkpoint-replay validation

**The repaired engine passed 400,000 integration steps on H200 in 806.093 seconds. All four 20,000-step replays have zero position, velocity and force-vector differences.** Independent result and local retained-array reviews passed. The validated runtime is selected for future jobs. This resolves the strict numerical restart failure for these tested models; scientific acceptance, production sampling and binding-free-energy results remain separate.

The run covers `complex33` (132,935 particles) and `solvent33` (151,505 particles), with two replicas per model. Each replica runs an 80,000-step baseline, saves a checkpoint at step 60,000, and replays the final 20,000 steps. All restores are exact and the original acceptance thresholds are unchanged.

| Fresh Reference check | Maximum observed error | Unchanged limit |
| --- | ---: | ---: |
| Energy (kJ/mol) | 0.002501264 | 0.01 |
| Force (kJ/mol/nm) | 0.004270316 | 0.05 |
| Force relative L2 | 4.31715 × 10⁻⁷ | 5 × 10⁻⁵ |

## Recent iterations

| Run | Integration steps executed | Outcome |
| --- | ---: | --- |
| Original stress attempt | 338,800 | Timed out; preserved as failed |
| Dedicated restart replay | 80,000 | Strict continuation failed |
| Short restart diagnostic | 1,000 | Short-test gates passed |
| Force-group probe | 2,200 | Mismatch localized to direct nonbonded forces |
| Observer-isolation control | 80,000 | Strict continuation still failed |
| Native candidate screening | 82,000 | Passed in 190.803 s |
| Full native validation | 400,000 | Passed in 806.093 s |
| **Total across these runs** | **984,000** | Aggregate across models and replicas |

This total is not one continuous trajectory and excludes earlier research and quantum work. Historical failed attempts remain unchanged; the repaired engine is evaluated by its new runs.

## Repair and active runtime

On pinned OpenMM commit `b399af4725573963b46d6c1083fdcf7a37615857`, the engine retains the existing ORVIA double-precision parameter patch and adds two changes only when `DeterministicForces=true`: rebuild neighbor lists on each force evaluation, and suppress adaptive early atom reorder whose history is absent from checkpoints. The normal reorder counter is checkpointed. Equations, model parameters, PME, cutoffs, integrator and thresholds are unchanged.

Direct-space forces are summed within tiles before conversion to fixed-point integers. Cached versus rebuilt neighbor groupings can therefore change rounding. The original-engine probe found force differences only in the direct nonbonded group; reciprocal and other forces were exact. The observer-only control failed, while the native repair passed both screening and full validation.

Runtime release `10ccb08c0bac32b1f4079ef0` is selected through `/workspace/orvia-active-runtime.json`, using `/workspace/orvia-restart-candidate-v1/prefix`. The receipt verified all approval hashes at `2026-11-02T20:06:04Z`. Future bounded runs use `runtime_release.py launch --output NEW_DIR`; old frozen launchers remain unchanged. A new public telemetry job requires its own explicit profile and scoped token.

The H200 pod stayed allocated and online after completion; the recorded post-run check showed 0% utilization and 26°C. The completed validation worker exited successfully, and terminal telemetry was delivered to [the live dashboard](https://orvia.fyi/live) under job `orvia-restart-validation-20261103-01`. No on-chain report was submitted by this validation.

## Evidence and reproduction

[review-evidence.zip](review-evidence.zip) contains exact current sources, build/patch records, preserved failed attempts, attribution and observer-control evidence, screening/full plans and reports, reviewer outputs, live bridge/activation sources, telemetry, and runtime-selection receipts. `artifact-manifest.json` gives each included file's SHA-256 and size. The initial builder packet is preserved separately under `history/native-packet-v1/`; it is not the manifest for the updated resumable builder.

The full result SHA-256 is `10ccb08c0bac32b1f4079ef0592b1675637451c370cf69a78f583e61d26fd604`. Local independent review recomputed comparisons from all 32 retained NPZ arrays with NumPy 2.0.2; it did not rerun molecular force evaluation. Its report SHA-256 is `21b5b6938380eda6e2187b4b37c239d2138cffa9a5f6680b7d3d70ab7946d78a`. Structural review separately checked source/result hashes, lineage, counters and reported gates.

Raw arrays, native checkpoints and libraries are omitted from the compact ZIP. `retained-artifact-manifest.json` preserves their reported hashes and available sizes; checkpoint sizes remain null where unreported. Full-array download archive hashes are retained in `evidence/runtime-selection-returned/packages.json`; no public raw-artifact download link is claimed. Reproduction requires the frozen ORVIA v4 model inputs, original stress packet and native-double engine/wrapper, pinned OpenMM source and CUDA environment.

From extracted `source/native/`, use fresh output directories:

```sh
python3 build_candidate.py --output /workspace/orvia-restart-candidate-v1
python3 validate_candidate.py --mode screen --output /workspace/orvia-restart-screen-new
python3 validate_candidate.py --mode full --output /workspace/orvia-restart-full-new
```

On the already promoted pod, use `python3 runtime_release.py launch --output /workspace/orvia-next-run` for a new bounded run (screen mode by default; `--mode full` selects full validation). `build_candidate.py --resume` is only for its own interrupted build and preserves prior reports. Re-running array review requires the retained NPZ files listed in the manifest.
