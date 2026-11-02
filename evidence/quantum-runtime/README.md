# Quantum GPU runtime gate

Both fixed-geometry CPU/GPU comparisons passed on the Runpod H200 on 2 November 2026. The gate completed in 399.11 seconds, excluding environment installation. It used the same CPU-generated quadrature on both backends and the declared, hash-pinned package versions. This validates the tested numerical execution only; it does not approve force-field parameters or the full molecular experiment.

| Test | Absolute energy error (Hartree) | Maximum gradient error (Hartree/Bohr) | Repeated GPU gradient error |
|---|---:|---:|---:|
| Native A, 41 atoms, B3LYP/def2-SVP | 9.55e-11 | 2.28e-6 | 9.95e-14 |
| Fragment, 20 atoms, PBE0/def2-TZVP | 1.82e-12 | 2.59e-6 | 1.12e-13 |

The respective limits were 1e-7, 1e-5 and 1e-7. For the full A molecule, independent central finite differences at 0.001 and 0.0005 Bohr also passed the predeclared 1e-4 gradient and step-consistency limits. All outcomes and method/runtime settings are in [gpu-gate.json](gpu-gate.json).

The [input bundle](gpu-runtime-gate-input.tar.gz) contains the frozen policy, geometries, runner and hash-locked installation requirements. The [raw result archive](h200-runtime-gate-results.tar.gz) retains the environment, logs and measurements; [artifact-hashes.json](artifact-hashes.json) records exact transfer identities.

Subsequent GPU geometry optimization must preserve the CPU grid recipe at every new geometry and independently compare initial/final energies and gradients. This gate does not validate uncontrolled default-grid substitution. The corrected parameter campaign remains separate from the earlier failed runtime and must still satisfy its original scientific limits.

## Current scientific status

The fixed-geometry GPU gate above passed. The separate [geometry-changing scanner pilot](gpu-scanner-pilot.json) also passed on the H200 in 430.19 seconds. It rebuilt the CPU quadrature at every geometry and compared initial/final CPU and GPU results: maximum gradient errors were 4.47e-6 and 3.53e-7 Hartree/Bohr. Its largest independent finite-difference disagreement was 9.11e-6 Hartree/Bohr, below the unchanged 1e-4 limit. This three-step pilot did not converge the geometry and is not an accepted optimized conformer; the separate [six-job held-out campaign](../quantum-heldouts/) subsequently completed with converged geometries and passing native-energy MAE checks for both endpoints. The corrected CPU campaign runs independently with fresh calculations; the stopped original campaign and its failures remain retained. See [gate-status.json](gate-status.json) for the dated snapshot. The two native full-molecule held-out energy subchecks pass; overall parameter-quality and scientific acceptance remain unresolved.

The original coefficient design has a structural rank limit: its nine training rows contain two identically zero within-scan baseline rows, so its rank cannot exceed seven, yet it attempts to identify eight independent Fourier coefficients. Better numerics cannot remove this counting limit. The earlier measured rank was six. The [rank audit](design-rank-audit.json) distinguishes this identifiability problem from native-energy quality; it does not discard method-sensitivity or held-out failures.

A [separately frozen follow-up proposal](training-design-proposal.tar.gz) starts with two new mixed aryl/ring configurations, adds two predetermined configurations only if needed, and reserves two genuinely new held-outs. It keeps the original held-out labels, conditioning limit and error thresholds. It is **not executed** and does not guarantee full rank: aromatic symmetry may leave individual coefficients unidentified. No force-field parameters are written or approved by this proposal.

The [phosphate v0.3 coordinate repair](../phosphate-v0.3/) passes independent geometry checks, while its numerical, parameter, alchemical and sampling gates remain separate. Total production simulation cost is still unestablished; a runtime test or a contract-deployment quote is not a full-campaign price.
