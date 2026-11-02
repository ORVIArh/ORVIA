# Six native full-molecule quantum held-outs

All six declared full-molecule optimizations completed on the H200 with the original geometry convergence limits and preserved stereochemistry. Each initial and final GPU result passed an independent CPU energy/gradient comparison. **The native held-out relative-energy checks pass for both endpoints; overall scientific acceptance remains false.**

The six-job run used two workers and took **1,266.49 seconds** of wall time, including CPU reference calculations. This is not a pure GPU timing or a full molecular-simulation cost. Each job was bounded at 1,200 seconds, the session at 4,200 seconds, and each optimization retained the original maximum of 60 geometry steps. No completed calculation was selected away.

| Endpoint | Optimized angles | Native relative-energy MAE (kJ/mol) | Original limit | Result |
|---|---|---:|---:|---|
| A, 41 atoms | 30, 90, 150 degrees | 1.076729 | 4.184 | Pass |
| B, 44 atoms | 30, 90, 150 degrees | 1.368979 | 4.184 | Pass |

Within each endpoint, QM energies and native molecular-mechanics energies are separately shifted to their respective minimum over the three fixed angles. The reported MAE is the mean absolute difference between those two three-point relative-energy profiles. These gas-phase conformer checks are not binding-affinity results. Native A retains R at atom 9; native B retains R at atom 13. The largest checked dihedral constraint deviation is 0.000142 degrees.

## Numerical integrity

The calculations used B3LYP/def2-SVP, the declared density-fitting auxiliary basis, grid level 2, SCF tolerance 1e-9, and the unchanged original optimization criteria. The scanner rebuilt the CPU quadrature at every geometry and copied that grid exactly to the GPU. The prior [fixed-geometry gate and scanner pilot](../quantum-runtime/) remain separately recorded.

Across all six initial and final comparisons, the largest absolute energy error was **6.54e-10 Hartree** against a 1e-7 limit; the largest gradient-component error was **4.66e-6 Hartree/Bohr** against a 1e-5 limit. Native molecular-mechanics energies were evaluated using the independent OpenMM Reference platform and the frozen native endpoint XML.

[Independent review](independent-review.json) records every result hash, numerical error, convergence and stereochemistry check, and relative-energy calculation. [Execution summary](execution-summary.json) retains all six exit codes and timings. The [raw archive](h200-six-heldout-results.tar.gz) includes per-job results, optimizer and SCF logs, coordinates, native MM evaluations, launcher source and input manifest. The [frozen input bundle](gpu-heldout-inputs.tar.gz) contains the exact worker, policy, six job descriptors and native endpoint files. Verify it using [artifact hashes](artifact-hashes.json).

Raw archive SHA-256: `46e8a5a550eac2693a1060925a07000539944bc5d3fe0a6f143718d681102f48`.

## Remaining gates

These results complete the six native full-molecule held-out subchecks. They do not resolve the original fragment design's structural rank limit or method/basis sensitivity, approve transferred Fourier coefficients, validate magnesium chemistry, or establish alchemical endpoint equivalence, equilibrium sampling or affinity accuracy. The independently running corrected CPU campaign is retained separately; its partial results are not silently replaced by these GPU results. No force-field parameters are automatically written or transferred.
