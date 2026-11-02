# ORVIA-001-ADPPI candidate protocol v0.1

**UNAPPROVED DRAFT — NOT REGISTERED — NO PREPARED SYSTEM OR SCIENTIFIC RESULT.**

This is a separately named preparation proposal. The original [ORVIA-001 protocol](PROTOCOL_ORVIA_001.md), based on the deposited Mg/ADP/vanadate state, remains unchanged. Selecting this proposal would change the molecular state and require its own input freeze and protocol identity. It does not remove a vanadate blocker from the original experiment.

The machine-readable companion is `data/protocols/orvia_001_adppi_candidate_v0_1.json`. Its null fields are unresolved registration requirements, not defaults. `approved`, `registered` and `ready_for_execution` are all false.

## Proposed question and model

Retain the compound 17 → aficamten methyl-to-ethyl comparison and the bovine cardiac-myosin assembly-1 binding-pose candidate from 9F6C. Investigate a **separately prepared Mg/ADP/H2PO4 state**, with M3L129 and M3L549 retained unless a future explicitly named sensitivity model changes them. Use both the complete protein-bound system and the dissolved-ligand system and the existing sign convention:

`ΔΔGbind = ΔGcomplex(17→aficamten) − ΔGsolvent(17→aficamten)`.

The proposed cofactor identities are ADP3−, Mg2+ and H2PO4−. These charges are recoverable from one public reference model, not a determination that they are the correct microstates for cardiac myosin under unspecified conditions. Histidine/ligand states, termini, pH assumptions and Mg coordination remain open. This candidate may be rejected by the preparation review.

The [published myosin-5 methods](https://pmc.ncbi.nlm.nih.gov/articles/PMC12158783/) used CHARMM36m, CHARMM-GUI ADP/H2PO4 components and explicit solvent. This supports investigating one internally compatible CHARMM-family parameterization. The source is mutant mouse myosin-5 actomyosin; it is not an aficamten/cardiac parameter set. No force-field release, cardiac coordinates, charges or fitted parameters are adopted by this proposal. The source's buffer, backbone restraints, solvent-box geometry and sampling lengths are not copied to this different binding experiment.

## Evidence now checked offline

The extended public-model audit checks every positional atom and residue name across the 29,549-atom source topology against the corresponding PDB prefix. The first 29,544 match. The last five topology Mg atoms instead overlap PDB acetate atoms. Consequently, **truncating the PDB to the topology atom count cannot produce a matching runnable pair**. The full PDB contains 468,219 atoms.

The 47 selected cofactor atoms precede that mismatch and pass individual atom/residue identity checks. Under the [CHAMBER convention documented by ParmEd](https://parmed.github.io/ParmEd/html/_modules/parmed/amber/_chamberparm.html), source charge values divide by `sqrt(332.0716)`. The sums recover H2PO4 −1e, Mg +2e and ADP −3e to within 1e−12e. The usual Amber factor 18.2223 is different; the self-test rejects that substitution. These derived sums do not change the preserved raw parameters or create a production parameter file.

There are no cross-boundary records touching the selected 47 atoms in the eight inspected bonded-term arrays. That observation does not cover the complete exclusion policy, external nonbonded interactions, Mg coordination or any absent force-field term. The export still lacks CMAP arrays despite its source CHARMM36 label; the full intended Hamiltonian must be reconciled from a complete parameter release and model-generation record.

Reproduce from packaged source bytes without a network connection:

```bash
python3 data/prepared_candidate/alternative_models/audit_public_models.py --check --self-test
```

This verifies original hashes/CRC32 and compares regenerated audit bytes. Adversarial checks reject same-length tampering, an incorrect charge scaling factor and a mismatched selected cofactor atom name. All scientific-run readiness values remain false.

## Required preparation sequence

1. **Declare the construct and missing structure.** The 65 absent sequence positions include N-terminal 1–32 and internal 202–210, 370, 626–644 and 732–735. Decide the actual construct boundary and capping before building coordinates; do not infer that every absent terminal residue must be appended. Repair TRP130 CG. Preserve all deposited and introduced atom provenance separately. The 626–644 loop has pocket-facing flanks and needs structural/pose sensitivity checks rather than an arbitrary single loop.
2. **Assemble a complete compatible force field.** Pin protein, M3L, both ligand endpoints, ADP/H2PO4/Mg, water and ions to exact files, licenses and versions. Do not blend the public myosin-5 model with another phosphate stream. Enumerate every force term, pair-specific rule, 1–4 exception and exclusion. An importer must reject unsupported terms. The extracted components provide reference evidence, not a complete transferable model.
3. **Resolve endpoint chemistry and topology.** Retain the verified 24-heavy-atom common scaffold and R stereochemistry. Add and map explicit hydrogens, verify the chosen ligand microstates and endpoint charge sums, define dummy atoms, soft-core behavior and every lambda-dependent term. Validate the inherited compound-17 pose; its coordinates are a hypothesis.
4. **Build two matched solvated legs.** Freeze full topology/coordinate correspondence, box vectors, atom order, crystallographic-water/sulfate decisions, bulk-water/ion model and counts, conditions and units. Supply a provenance record for every introduced value. No prefix truncation or unexplained deletion may repair a mismatch.
5. **Compare the complete Hamiltonian independently.** Check energy components, forces, coordinate/parameter units and endpoint equivalence against an established implementation using identical inputs. Freeze tolerances before evaluating the final benchmark. A correct cofactor charge sum alone does not clear this phase.
6. **Freeze sampling before production.** A candidate planning value is 300 K and at least three independent repeats per leg; these are proposed settings, not approved conditions or sufficient sampling. Determine the ensemble, box/density method, integrator/constraints, timestep, electrostatics, lambda schedule, equilibration, production lengths, seeds, sample retention, overlap, effective-sample and uncertainty thresholds from validation. Do not copy a TYK2 benchmark duration or declare convergence from repeat count alone.
7. **Exercise the complete on-chain path.** The chosen production engine must integrate the selected force field, thermostat/constraints/electrostatics, alchemical sampler and correlation-aware analysis. Demonstrate partition/retry invariants and full-system gas/storage costs. All production minimization, equilibration, sampling and estimation remain on-chain; conventional calculations are development references.

## Inputs that this audit cannot supply

No verified full cardiac cofactor parameter set, missing-loop coordinates, M3L-compatible full parameter release, aficamten/17 endpoint parameters, hydrogen-complete hybrid topology, prepared solvated legs or full-system reference energy/force data is present. Those files and their preparation records must be produced or obtained; choosing labels or deriving charge sums does not supply them. No numeric numerical-error or convergence threshold is silently invented here.

If the original vanadate state is retained, a separately validated vanadate species/coordination/parameter set is still required. If this ADPPI alternative is selected later, a result must explicitly identify its changed molecular state. Neither model has matched direct-affinity validation for the compound pair; ATPase IC50 remains functional context.

Before registration, replace every unresolved machine-readable field with a reviewed value and immutable artifact hash, close the complete-Hamiltonian and engine gates, then create a distinct frozen protocol version. This draft itself cannot authorize a molecular run or mainnet readiness claim.
