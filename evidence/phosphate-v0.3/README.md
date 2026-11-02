# Phosphate v0.3: geometry repair verified

This is a new coordinate candidate for the separately named AMBER ADP/phosphate experiment. It preserves the native force-field XML, atom identities, periodic boxes and the v0.2 research protocol's numerical, parameter and sampling limits. The complex has **132,935 atoms**; the solvent model has **151,505 atoms**. Scientific acceptance and production readiness remain **false**.

Four protein alpha stereocenters in previously modeled, unobserved loops were corrected to the intended L configuration: author residues Thr629, Ile631, Lys637 and Phe735. Thr629's beta center was also corrected; Ile631's existing beta configuration was preserved. The repair moved 343 unobserved protein atoms while holding the other 11,699 protein atoms fixed relative to v0.2. Temporary preparation restraints and fixed masses are not present in the native simulation XML.

The [independent geometry audit](independent-geometry.json) verifies all 701 protein alpha centers and 89 Thr/Ile beta centers, retains the native B ligand's R configuration at atom 13, and finds no unexplained stereochemical inversion. Its reference convention was independently checked against the native [AMBER ff03 residue library](ff03-stereochemistry-reference.json). The stricter [bond, angle and clash check](strict-geometry.json) also passes:

| Check | v0.3 result |
|---|---:|
| Incorrect or degenerate checked protein stereocenters | 0 |
| Bond-length errors above 0.25 angstrom | 0 |
| Bond-angle errors above 30 degrees | 0 |
| Heavy-atom overlaps above the prior 0.8-angstrom limit | 0 |
| Maximum bond-length error | 0.147686 angstrom |
| Maximum bond-angle error | 22.230944 degrees |
| Nonexcluded positive-LJ contacts below 0.60 of their native minimum distance | 0 in both models |

The same bounded whole-water/ion translation procedure removed the new candidate's close solvent contacts. The magnesium shell retains six O/N/S neighbors within 0.35 nm. Shell consistency is a geometric observation, not validation of magnesium coordination energetics.

## Reproducible inputs

The [public input archive](phosphate-v0.3-inputs.tar.gz) contains both unchanged native XML files, the final v0.3 coordinates, both protocol documents, and geometry evidence. Verify every file against [input-manifest.json](input-manifest.json). The [artifact identities](artifact-hashes.json) bind the archive, model files, original protocol and amendment.

Public archive SHA-256: `68b8eb37010bb108e05aefff9d19d9fac5bf39fa3946ecb82edd731ce4507fc0`.

The public archive omits private local paths and is intentionally a different archive from the internal execution package. Native XML and coordinate bytes are identical. Evidence reports label their original source hashes and replace only local path prefixes; numeric measurements are unchanged. The archive contains inputs, not an independently validated GPU engine.

## Remaining scientific gates

The [v0.2 periodic GPU comparison](../phosphate-v0.2/) and its residual energy mismatch remain preserved. A corrected periodic engine must pass the unchanged strict full-model comparisons before production sampling. Native A/ghost endpoint construction, alchemical endpoint equivalence and corrections, integrator/ensemble validation, parameter checks and converged sampling also remain necessary. The [quantum runtime check](../quantum-runtime/) is separate from parameter validation.

No production trajectory, binding-affinity result or scientific mainnet acceptance is asserted. Geometric consistency does not establish equilibration or select a physically correct loop conformation.
