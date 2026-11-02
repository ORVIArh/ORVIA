# Local Apple M5 preparation GPU

The installed OpenMM 8.6.1 OpenCL platform creates a real **Apple M5** context when
`Precision=single`, `DeviceIndex=0`, and `OpenCLPlatformIndex=0` are selected.
Native Apple OpenCL enumerates the device. The existing Khronos loader and Apple
wrapper work; no package replacement or OS changes were required. Mixed and
double precision fail device selection. OpenMM's mixed mode performs integration
in double precision, while single mode performs nearly all calculations in
single precision; see the [official platform properties](https://docs.openmm.org/latest/userguide/library/04_platform_specifics.html).

`scripts/validate_local_gpu.py` compares the actual 41/44-atom ligand endpoint
systems against OpenMM Reference at their original coordinates, eight fixed-seed
perturbations, and after twenty deterministic Verlet steps. It also performs a
separate GPU preparation minimization and compares both platforms at those same
minimized coordinates. It never alters the source molecular files.

```sh
python scripts/validate_local_gpu.py --endpoint-root data/prepared_candidate/ligand_endpoints_v0_1
```

Run with the separately installed preparation environment containing OpenMM and
NumPy. The report records exact source input hashes, validator hash, platform
properties, fixed tolerances and every comparison. Exit 2 means the strict
numerical criteria failed; it does not mean GPU execution was unavailable.

The current report deliberately retains **failed strict single-precision
acceptance**. Original-coordinate force differences are around 0.42 kJ/mol/nm,
despite total energy differences below 0.001 kJ/mol. After GPU minimization,
maximum force differences fall below 0.007 kJ/mol/nm, but the fixed relative force
criterion still fails near small residual forces. Twenty-step position RMS
differences are below 0.000001 nm; this does not establish long-trajectory or
ensemble agreement. No tolerance was relaxed after seeing these outcomes.

The GPU is available for external coordinate preparation. Use independent
Reference/CPU final cleanup and energy/force audits before accepting prepared
inputs. Single precision is not the independent oracle for on-chain arithmetic,
and these ligand checks do not validate a complete cardiac-myosin system or a
binding-free-energy campaign.
