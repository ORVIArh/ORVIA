# Runpod hybrid benchmark: prepared, not executed on CUDA

The proposed hybrid direction keeps a target of **256 on-chain contracts** for
experiment registration, commitments, checkpoints and results, while external
GPUs perform molecular calculations. This is an architecture proposal and
benchmark preparation; no hybrid reporting contracts or full scientific
campaign have been deployed by this work.

## Prepared package

[Download the complete benchmark bundle](orvia-runpod-benchmark.tar.gz). It
contains all benchmark scripts, pinned CUDA dependencies, the existing ligand
endpoint fixtures, both native full-size force fixtures and a payload manifest.
After extraction, see `orvia-benchmark/scripts/README.md` for installation and
execution. The bundle is 6.96 MB compressed (approximately 95 MB of input XML and
coordinates before compression).

| Fixture | Atoms | Water distance constraints | Purpose |
|---|---:|---:|---|
| Ligand A / B | 41 / 44 | 0 | Strict CUDA mixed/double versus Reference checks |
| Native complex candidate | 132,935 | 120,519 | Fixed-coordinate energy/force timing |
| Native solvent candidate | 151,505 | 151,179 | Fixed-coordinate energy/force timing |

Full-size exports retain the native complex C4 force, its exclusions, and rigid
water constraints. XML serialization roundtrips and source hashes were checked.
PME with a 1 nm cutoff and 0.0005 Ewald error tolerance are explicitly declared
benchmark settings, not accepted production settings. The inputs are native B
endpoints, not the larger alchemical hybrid with its extra ghost atom.

These are the existing ADP/phosphate candidates. They do not replace the selected
vanadate experiment. The complex retains unresolved structural and parameter
acceptance failures. No coordinates were minimized or changed during export.

## Validation completed locally

- Reference-only endpoint and orchestration checks passed, with GPU execution
  explicitly false.
- Changed manifest-covered inputs were rejected before running any calculation.
- Timeout handling stopped the child process and retained an incomplete report.
- The actual full-size archive passed hash verification and rejected missing
  CUDA without falling back to the CPU.

Reference orchestration tests used explicitly labelled small synthetic fixtures;
they do not constitute a full-size GPU benchmark. See
[preparation status](runpod-preparation-status.json) for source hashes and scope.

## Pending measurement and cost

The next run is one A100 80 GB with CUDA mixed and double precision. The observed
Runpod A100 rate was $1.79/hour on 2026-11-02, approximately $1.80/hour including
the selected 50 GB container disk, before applicable taxes. Current pricing and
availability must be checked at launch. [Runpod pricing](https://www.runpod.io/pricing)

The runner permits at most 300 seconds per child process and 1,800 seconds
overall. These are process limits, not billing limits. The operator must retrieve
and verify results, then stop the Pod; persistent storage may remain billable.

**No A100 throughput, CUDA numerical acceptance, full trajectory throughput, or
complete campaign price is claimed.** Fixed-coordinate force timings cannot be
converted directly into a complete simulation quote. Constraints, sampling,
analysis, retries, provisioning/storage and all on-chain deployment/setup/report
transactions must be measured and included in a total campaign estimate.

Signed GPU reports and hashes establish submission identity and committed data;
they do not prove the physics was computed correctly. Independent validation
and the remaining scientific acceptance work are still required.
