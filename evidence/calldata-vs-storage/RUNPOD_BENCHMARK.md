# Runpod hybrid benchmark: A100 executed, scientific gates remain

On 2026-11-02, one NVIDIA A100-SXM4-80GB completed all four native full-size
fixed-coordinate force benchmarks. The endpoint numerical gate failed. The
results were downloaded, their archive SHA-256 verified, and the Pod stopped.
Runpod then showed compute and container storage **Not running**, total
**$0.00/hour**; the refreshed account spend rate was also $0.000/hour.

[Execution summary](runpod-a100-execution.json) ·
[Raw reports and environment](runpod-a100-20261102-results.tar.gz) ·
[Exact launcher used](runpod-a100-launcher.sh)

## Measured force throughput

| Native candidate | Atoms | CUDA precision | Force evaluations/second |
|---|---:|---|---:|
| Complex | 132,935 | Mixed | 206.39 |
| Complex | 132,935 | Double | 132.29 |
| Solvent | 151,505 | Mixed | 161.77 |
| Solvent | 151,505 | Double | 131.51 |

Each measurement contains three repeats of 20 evaluations after five warmups.
Timing includes coordinate resubmission, energy/force evaluation and readback,
and finite-value checks. It excludes context startup and warmup. These are
short hardware measurements, not sustained simulation rates. All 17 payload
hashes and both full-size input identities were verified. Actual CUDA precision,
GPU identity, input hashes and per-repeat timings are in the raw reports.

**Finite does not mean physically valid.** Candidate energies are extremely
large (about 9.32e9 and 1.29e13 kJ/mol); maximum force components are close to
2^31 kJ/mol/nm. These values require structural and numerical range/overflow
checks. The force benchmark's hardware-pass flag must not be treated as a
validated force-field or trajectory result. No full-size dynamics ran.

## Endpoint accuracy

| Endpoint / precision | Original + 8 perturbations | 20-step trajectory | Minimized-coordinate comparison |
|---|---:|---|---|
| A / mixed | 0/9 pass | Force comparison fails | Absolute and relative force fail |
| B / mixed | 0/9 pass | Force comparison fails | Absolute and relative force fail |
| A / double | 9/9 pass | Pass | Relative force fails |
| B / double | 9/9 pass | Pass | Relative force fails |

Double precision's minimized relative force L2 errors are **0.00148428** and
**0.00151191**, versus the predeclared **0.00005** limit. Absolute force errors
are 0.00419784 and 0.00427053 kJ/mol/nm (below 0.05), and energy errors also pass.
The small reference force norms at minimized coordinates make the relative
metric sensitive; this does not establish the implementation cause or justify
relaxing the threshold. Neither precision fully passes the declared gate.
The runner correctly exits 2 while preserving the successful hardware timings.

## Runtime and total session cost

The benchmark runner took **37.76 seconds**; the wrapper, including package
installation and download, took **60 seconds**. This excludes provisioning,
operator checks and result retrieval. The complete observed GPU session was
approximately three minutes at $1.79/hour compute plus $0.007/hour container
disk: **about $0.08–$0.09 total estimated usage**. This is not a settled invoice;
Runpod says billing data is one hour behind, and no usage charge had posted.
No persistent volume was created and ongoing spend was verified as zero.

Environment: official `runpod/pytorch:1.5.0-cu1281-torch280-ubuntu2404`, Secure
Cloud US-MD-1, Python 3.12.3, OpenMM package 8.6.1 (runtime build
`8.6.1.dev-b399af4`), NumPy 2.5.4, NVIDIA driver 595.91.07. The source bundle
was pinned to commit `dd01848fd9d6b83ec8471b2453f6eabf2d61236e`.

**The total scientific campaign price remains unknown.** Neither ns/day nor
full simulation cost can be inferred from these force timings. Full accepted
integration, all sampling windows/repeats, analysis, retries, provisioning,
storage, 256-contract deployment/setup and every report transaction must be
included before quoting that total.

## Scope and remaining work

The proposed hybrid direction keeps a target of **256 on-chain contracts** for
experiment registration, commitments, checkpoints and results, while external
GPUs perform molecular calculations. This is an architecture proposal and
benchmark implementation; no hybrid reporting contracts or full scientific
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

## Next validation gates

Resolve the minimized-coordinate double-precision discrepancy and the full-size
structure/range failures, approve the scientific model and protocol, then measure
validated full trajectories and alchemical sampling. The 256-contract hybrid
reporting design also requires implementation and validation before deployment.
No mainnet or public-testnet transaction was sent during this benchmark.

The launcher used a 1,200-second runner deadline and a 240-second child deadline,
within a roughly 30-minute preparation/run allowance. These limits stop
processes, not billing; the Pod was stopped separately after retrieval.

Signed GPU reports and hashes establish submission identity and committed data;
they do not prove the physics was computed correctly. Independent validation
and the remaining scientific acceptance work are still required.
