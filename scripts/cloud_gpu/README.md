# Runpod CUDA benchmark preparation

This package prepares external GPU benchmarks for a proposed hybrid ORVIA system
with a 256-contract target. It does not deploy contracts, launch a cloud instance,
sign a transaction, or establish scientific acceptance.

## What is measured

1. Compare the existing 41- and 44-atom ligand endpoints with OpenMM Reference,
   using the existing strict tolerances, seeded coordinate perturbations, and
   short deterministic trajectories. CUDA mixed and double precision are tested.
2. Time fixed-coordinate energy/force evaluations for the native 132,935-atom
   complex and 151,505-atom solvent candidates. The complex's native 12-6-4 term
   and explicit water constraints must be retained by the export checks.

The full-size candidates use the previously prepared ADP/phosphate alternative.
They are not an approved replacement for the original vanadate experiment and
are not the alchemical 132,936/151,506-atom hybrid inputs. Known structure and
parameter acceptance failures remain. Fixed-coordinate force timings do not
measure trajectory throughput, constraint convergence, cross-state sampling,
analysis, or the total campaign price. Force-mode `ns_per_day` stays null.

## Reproduce a bundle locally

Use a Python environment with OpenMM and NumPy. The exporter and packager print
their accepted command-line options with `--help`. Export the existing native
candidate sources first, then run:

```sh
python scripts/cloud_gpu/prepare_bundle.py \
  --full-inputs /path/to/exported/full-inputs \
  --output /path/to/orvia-benchmark.tar.gz
```

Only an explicit list of scripts and input files is included. The archive has
SHA-256 hashes and sizes for every payload. It excludes wallets, RPC settings,
cloud credentials, environment files, and local account-status records.

## Run on an NVIDIA Pod

Initial configuration: one A100 80 GB, an official Runpod CUDA 12-compatible
Linux/Python template, and enough disk for the environment and bundle. The
observed template was `runpod/pytorch:1.5.0-cu1281-torch280-ubuntu2404`.
Recheck availability, the actual checkout price, and the image version before
launch. A100 was listed at $1.79/hour on 2026-11-02; this is a compute rate, not
a campaign quote. Disk and applicable taxes add to the charge.

Extract the archive into persistent workspace storage, then:

```sh
cd /workspace/orvia-benchmark
python3 -m venv /workspace/orvia-benchmark-env
/workspace/orvia-benchmark-env/bin/python -m pip install --no-input -r scripts/requirements-cuda.txt
/workspace/orvia-benchmark-env/bin/python -m pip freeze > environment.txt
/workspace/orvia-benchmark-env/bin/python scripts/run_benchmark.py \
  --bundle-root . --output-dir results --platform CUDA
```

Each subprocess has a maximum 300-second allowance; the runner has a maximum
1,800-second allowance. These limits stop benchmark processes, **not Pod billing**.
The operator must retrieve all results, verify local copies, and stop the Pod
after the run. If using only container disk, retrieve results before stopping:
container disk is erased when a Pod stops. Retained volumes can incur storage
charges after compute stops. Dependency installation and provisioning are outside
the runner's time allowance and must also be monitored.

The result directory must be new and empty. Missing CUDA fails explicitly;
there is no automatic CPU fallback. `--platform Reference` is only a local smoke
test and is never recorded as CUDA hardware validation. A failed endpoint
tolerance check may still permit a hardware timing run when the requested CUDA
context was successfully created; the report keeps those outcomes separate.

## Interpretation

All reports retain `production_ready: false` and `scientific_acceptance: false`.
A successful benchmark establishes execution and measured timing for these
inputs only. The proposed hybrid reporting contracts and full GPU alchemical
workflow still require implementation and validation. Signed reports and hashes
provide identity and data integrity, not cryptographic proof of correct physics.

To estimate the full hybrid campaign, measure the complete accepted GPU workflow,
all windows/repeats, sampling, analysis, retries, provisioning and storage, then
add 256-contract deployment, setup and every checkpoint/result transaction.

## Official references

- [Runpod agent setup](https://agents.runpod.io/)
- [Runpod pricing](https://www.runpod.io/pricing)
- [Runpod storage](https://docs.runpod.io/pods/storage/types)
- [OpenMM installation](https://docs.openmm.org/latest/userguide/application/01_getting_started.html)
- [OpenMM CUDA precision](https://docs.openmm.org/latest/userguide/library/04_platform_specifics.html)
