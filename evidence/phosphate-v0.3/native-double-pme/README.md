# Phosphate v0.3: full native PME numerical diagnostic

Both repaired native B models passed the original CPU Reference versus H200 CUDA-double energy/force tolerances at the initial, relaxed and post-diagnostic frames. The complex has 132,935 particles; solvent has 151,505. This is a numerical and geometry checkpoint for the separately named ADP/phosphate candidate. Scientific campaign acceptance remains **false**.

The fixes preserve native physical parameters. Reference and CUDA use the same actual PME alpha and 96×90×100 grid; an experimental four-file OpenMM patch retains native parameters as binary64 in the tested double-PME path. CPU/Reference source is unmodified. The original engine, grid-mismatch and native-parameter failures are retained in the accuracy packet.

| Leg/frame | Absolute energy error (kJ/mol) | Maximum force error (kJ/mol/nm) | Relative force L2 error |
|---|---:|---:|---:|
| Complex initial | 0.0052769410 | 0.0042278992 | 5.0656171e-7 |
| Complex relaxed | 0.0026040012 | 0.0041785201 | 4.5434366e-7 |
| Complex after diagnostic | 0.0026073847 | 0.0041782946 | 4.5434954e-7 |
| Solvent initial | 0.0001289381 | 0.0042292248 | 1.7903000e-8 |
| Solvent relaxed | 0.0000207727 | 0.0037437421 | 2.1335104e-8 |
| Solvent after diagnostic | 0.0000200099 | 0.0037435038 | 2.1329754e-8 |

All three gates must pass: absolute energy ≤0.01, maximum absolute force ≤0.05 and relative force L2 ≤5e-5. These thresholds were unchanged. Full reports, exact build/patch identities and final coordinate arrays are in `accuracy-evidence.zip`; each archive has a complete SHA-256 payload map. `summary.json` binds both public archives and the full local result archive.

The public runtime is `engine-runtime-with-licenses.zip`. It preserves the original runtime archive byte-for-byte and supplies the exact official pinned `docs-source/licenses` texts alongside it. The original exporter missed these licenses; that historical archive is preserved, and the corrected exporter now requires and Git-object-verifies all upstream license files. Do not redistribute the historical runtime alone. The package is Linux x86-64/CPython 3.12/CUDA specific; dependency and relocation limits are recorded in the summary.

Independent post-relax checks found no implemented stereochemistry, bonded-geometry or severe positive-LJ-contact violations. Mg’s O/N/S distance-shell count changes from six to seven within 0.35nm; this is a proximity diagnostic, not validated coordination energetics.

The run used bounded restraint relaxation (200/200/400 iteration caps), followed by only ten 0.1fs steps from zero velocities: **1fs per leg**. It does not certify converged minimization, energy conservation, a production timestep, thermal equilibration, sampling or ns/day. Final maximum native forces remain about 2,941 and 2,324 kJ/mol/nm. Hybrid A/B equivalence, C4/charge coupling, parameter-quality gates, ensemble stability and free-energy uncertainty remain separate work. No molecular result or onchain proof is claimed.

To reproduce, use the exact archived patch/build scripts against official OpenMM commit `b399af4725573963b46d6c1083fdcf7a37615857` in a separate Linux CUDA environment, verify the original input archive hash, and run the archived matched validation worker through its external process-group watchdog. Source input XML/initial coordinates and full intermediate arrays/checkpoints remain in the hash-bound local archives; the public compact packet is not a standalone replacement for those source inputs. The archived build report predates numerical validation and intentionally retains its historical `numericalValidationPassed:false`.
