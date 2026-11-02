# H200 parallel diagnostic evidence

**The original 400,000-step attempt timed out after 338,800 reported steps. All four 80,000-step baselines passed; none of its four checkpoint replays finished.** The worker processes stopped after 590.469 seconds. The Runpod pod was left running.

This packet concerns the separately named **ORVIA-ADP-PHOSPHATE-v0.3** experiment: two replicas each of the 132,935-particle complex and 151,505-particle solvent model, using double precision and the original strict numerical checks. It is diagnostic evidence, not a completed binding-free-energy campaign or scientific acceptance.

| Measured item | Result |
|---|---:|
| Passed baseline integration steps | 320,000 |
| Interrupted replay steps observed | 18,800 |
| GPU utilization, arithmetic mean of 119 samples | 95.66% |
| GPU utilization, peak sample | 100% |
| Peak sampled GPU memory | 2,662 MiB |
| Peak sampled power / temperature | 531.14 W / 59°C |
| Actual trajectories | 2 × 101 frames, each spanning 8 ps |

Utilization is a whole-device sample; it does not measure achieved FLOPS or prove optimal hardware performance. Four identical initializations are a load and within-replica restart test, not independent statistical samples. Eight baseline Reference/CUDA comparisons passed unchanged tolerances. Energy-range measurements are retained, but no energy-conservation acceptance threshold or production-sampling result is claimed. Force-range checks cover recorded observations every 100 steps, not every internal force evaluation.

**The separate recovery also failed its strict replay checks**, after completing all 80,000 new steps in 144.76 seconds without a timeout. All four restored positions, velocities, boxes and times exactly; all twelve energy/force comparisons passed. The four position/velocity continuation limits failed. The original timeout remains failed, and the 418,800 aggregate reported executed steps do not constitute an accepted 400,000-step cohort. `completedPlannedCohortSteps` remains null.

Complex replay differences were 1.04495e-7 nm in position and 1.22028e-5 nm/ps in velocity; solvent differences were 5.23461e-8 nm and 4.19687e-6 nm/ps. The unchanged limits are 1e-9 nm and 1e-8 nm/ps. Both replicas of each model reproduced the same discrepancy. The exact implementation cause remains unconfirmed; no threshold was relaxed, no engine patch was applied, and no successful scientific result is claimed.

Download **orvia-h200-parallel-evidence.zip** alongside this README. The archive contains original final results, four baseline reports, interrupted replay evidence, all GPU samples, both true trajectories, frozen source/manifests, independent reviews, and a full original-file hash inventory. Large NPZ observations and native checkpoint payloads are omitted from this compact download; their identities and the complete original archive's SHA-256 are retained. It also contains the reviewed recovery protocol and any explicitly included recovery results. There are no wallet or service credentials.

The original full archive is 261,194,543 bytes with SHA-256 `af8fccbda4890ba976a34ad316ec2da04a8cc084c6557da3fb667d460a22039d`. The original job ID is `orvia-stress-20261102-02`; recovery uses the separate ID `orvia-stress-replay-20261102-03`. Both full archive identities and individual file hashes are retained inside the compact packet. The 400,000-step planned cohort has not been accepted.
