# Full hybrid inputs and static component checks

Two aligned full-system input sets have been assembled and checked against their
frozen native sources. This checkpoint covers input fidelity and static bonded
and C4 components. It establishes no complete Hamiltonian trajectory, binding
result, accepted alchemical C4 policy, or mainnet deployment. The streams have not
been uploaded or sealed on chain. Production protocol choices remain unset.

| Prepared leg | Native atoms | Hybrid atoms | Unique ABI words | Water constraints |
|---|---:|---:|---:|---:|
| Complex, residues 33–782 | 132,935 | 132,936 | 5,904,252 | 120,519 |
| Matched-box solvent | 151,505 | 151,506 | 4,999,584 | 151,179 |

Both legs use the frozen matched box, approximately
`11.3065147 × 11.1129538 × 12.4094174 nm`. The ligand union contains 45 atoms:
native B's 44 atoms retain their order, and the A-only H25 is inserted immediately
after them. Every existing native coordinate is unchanged. Explicit global maps
translate every environment record and constraint. Periodic improper atom tuple
order and Fourier multiplicity are preserved; exceptions use sorted unique
global pairs with `a < b`. Only the byte-identical whole particle stream is aliased.

The [assembly report](../reports/full_hybrid_assembly_validation.json) records:

- All **10,903,836** unique raw `bytes32` words checked for file hashes, encoding,
  widths, indices and the owning catalog's scalar restrictions.
- **67** independent preservation criteria across both legs, including all
  environment masses/charges/LJ parameters, ligand rows, native record and
  exclusion/scaling flags, constraints and written C4 tables.
- **2,559,978** bonded force components compared with OpenMM Reference. The
  assembled B model includes the explicit added ghost-H confinement bond; its
  energy and instantaneous anchor/ghost forces are retained in the comparison.
  Maximum energy error was `7.59e-9 kJ/mol`; maximum force error was
  `3.64e-12 kJ/mol/nm` under the preregistered tolerances.

The [C4 report](../reports/c4_endpoint_validation.json) records six static GPU
queries against a separate 90-digit sparse energy/force calculation and an
independently checked native long-range correction. Native B has 132,935 physical
atoms. Derived physical A has 132,932: it is a C4 component reference with absent
endpoint atoms removed, not a complete native A system or a retained-ghost
activity policy. All 2,392,803 force components passed the declared GPU absolute
plus relative tolerances. Maximum energy and force errors were approximately
`1.28e-4 kJ/mol` and `2.28e-3 kJ/mol/nm`. Full arrays and per-component limits remain
in the local archive.

The full-size static C4 queries actually used **Apple M5 / OpenCL single**.
Native B's uncut C4 query took approximately 1.23 seconds including context
creation; this measured one component at one frame. The bonded comparisons and
16 small C4 Reference contexts used the CPU. Solidity/EVM execution and its gas
benchmarks remain CPU work; GPU reference speed is not an EVM speedup. No
integrator step, optimizer restart, or molecular trajectory was performed.

## Native C4 policy remains unresolved for the hybrid

The exact native importer is pinned by source hash. The installed engine reports
**OpenMM `8.6.1.dev-b399af4`**, git revision
`b399af4725573963b46d6c1083fdcf7a37615857`, with `release=False`.
[`__version__` alone prints `8.6.1`; full runtime provenance is retained.](../evidence/full-hybrid-inputs/sources/runtime-provenance.json)
The actual native file uses the standalone `-c/r^4` custom force. Every native
nonbonded exception, including scaled 1–4 pairs, is excluded from that component.
The diagnostic periodic 1 nm setup preserves the importer's unswitched C4 and
long-range correction; an explicit tails-off comparison is separate. These are
diagnostic choices, not a selected production cutoff.

The pinned implementation's no-switch class average uses `N/(N+1)`, with
`n_ii = N_i(N_i+1)/2`; exclusions are not subtracted from this average.
Consequently a zero-type ghost can leave direct forces unchanged and still
change the correction. The sole Mg has no direct self-pair, while its nonzero
Mg–Mg coefficient contributes a self-class correction. These behaviors were
checked in eight small fixtures with tails off/on. See the
[pinned native implementation](https://github.com/openmm/openmm/blob/b399af4725573963b46d6c1083fdcf7a37615857/openmmapi/src/CustomNonbondedForceImpl.cpp#L179).

All five ligand-unique atoms have nonzero physical Mg–C4 coefficients. Setting
their charge and LJ epsilon to zero does not disable C4. The export retains
their physical type provenance; **hybrid ghost activity, lambda coupling,
softening and long-range treatment remain unselected**. Written native CCOEF
values, rather than the earlier pre-serialization JSON matrix, are authoritative.
Physical/model/parameter-quality and full-system constraint-dynamics acceptance
remain false.

## Reproduction and retained evidence

The compact [evidence package](../evidence/full-hybrid-inputs/README.md) contains
exact executed scripts, source and runtime hashes, predeclared policies, compact
results and retained failed-attempt metadata. It includes neither full raw
streams/parameters nor full force arrays or runtime binaries. The initial
exception-pair ordering failure, one checker field-name error and two native C4
harness assumptions remain recorded. Corrected checks were rerun against the
new source-bound artifacts; failed attempts were not relabeled as passes.

The local archive `full-hybrid-inputs-static-20261102T110015Z.zip` contains the
large artifacts, full arrays and 18 required frozen scientific inputs:

```text
153,788,213 bytes
SHA-256 77eb30f09c5397fb0a58ea176bd7048173ba77fc432c3a6a9a3a3256eaec78af
```

All 214 payload files were verified from the ZIP against its SHA-256 manifest.
The archive is kept outside Git. Its `scientific-inputs/` directory can be used as
the source root below; another source tree must match the same 18-input manifest.
Use an environment with the recorded OpenMM dev revision, matching importer,
NumPy and mpmath. The C4 GPU stage requires working OpenCL single support.

```sh
python evidence/full-hybrid-inputs/reproduce.py \
  --source-root /path/to/unpacked/scientific-inputs \
  --output /path/to/fresh-replay --check-inputs

python evidence/full-hybrid-inputs/reproduce.py \
  --source-root /path/to/unpacked/scientific-inputs \
  --output /path/to/fresh-replay --stage all
```

Individual stages are `assemble`, `verify`, `bonded`, `preserve`, `lrc`, and `c4`.
The adapter generates path-only source copies, rebases provenance before any
energy query, records original/adapted hashes, and preserves replay logs. It
refuses to replace an existing assembled payload. An actual packaging smoke
verified all input paths and adapter syntax, then replayed the 16 small Reference
contexts. The full-size historical comparisons were not rerun for packaging.
