# ORVIA-ADP-PHOSPHATE-v0.2 validation evidence

The user selected the existing ADP/phosphate model as a separately named experiment on 2 November 2026. It does not replace or validate the original vanadate experiment. The native complex contains 132,935 atoms; the native solvent model contains 151,505 atoms.

## Coordinate repair

The candidate retains the original force-field parameters, atom identities, periodic boxes and water internal geometry. It incorporates the previously regularized protein loop near residue 370, followed by bounded rigid translations of overlapping water molecules and monatomic ions. The repair removes all detected pairs below 0.60 of the Lennard-Jones minimum distance: 79 pairs in the complex and 612 in solvent. See [the repair summary](coordinate-repair-summary.json) for movement limits and provenance. This geometrical result is not equilibration or scientific acceptance.

## First full-model GPU comparison

The H200 CUDA-double diagnostic ran on 2 November 2026, 16:27:20–16:27:51 UTC. It stopped before minimization because the unchanged absolute error limits were exceeded. Both relative force errors passed; that alone is insufficient for acceptance.

| Model | Absolute energy error (kJ/mol) | Maximum force error (kJ/mol/nm) | Relative force L2 error |
|---|---:|---:|---:|
| Complex | 0.85143746 | 0.55583179 | 0.00003031236 |
| Solvent | 0.46414436 | 0.30145165 | 0.00002189153 |
| Required limit | 0.01 | 0.05 | 0.00005 |

The [machine-readable summary](initial-comparison-summary.json) and [raw input/output evidence](h200-initial-comparison.tar.gz) preserve the failure. The archive SHA-256 is `6fce335791741f6222531f925aa267ddc92fae09dc2efcfa5f4a39d37be8cd74`. The separately passing [small-endpoint precision repair](../hybrid256/) does not establish accuracy for these periodic models. PME-grid and per-force diagnostics are the next checks; the tolerances remain unchanged.

No production trajectory, binding-affinity result or scientific mainnet acceptance is asserted by these artifacts.

## PME grid diagnosis

The follow-up [component probe](h200-pme-components.tar.gz) uses the candidate coordinates before constraint projection, so its absolute energies differ from the first diagnostic. It records the actual grids rather than assuming an explicit request is honored unchanged. Reference chose 91×90×100; CUDA rounded the first dimension to 96. Giving Reference the actual CUDA grid reduces the maximum force discrepancy below the original 0.05 limit in both models. All force comparisons pass, but total energy still fails:

| Same-grid result | Total energy error (kJ/mol) | Maximum force error (kJ/mol/nm) |
|---|---:|---:|
| Complex | 0.26886724 | 0.00615323 |
| Solvent | 0.37326921 | 0.00425744 |

The residual is concentrated in native nonbonded energy terms; the [complex](pme-complex.json) and [solvent](pme-solvent.json) reports preserve each component. These results identify the next numerical repair and do not approve minimization or production sampling. The archive SHA-256 is `1ae5f3d3a80b2e3b3b1e36ad5433e42b94d94674c9e4f1ab4d3bd808ff7fcaa9`.
