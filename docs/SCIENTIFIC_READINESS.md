# ORVIA-001 scientific input readiness

The ligand heavy-atom correspondence and source-coordinate export are now reproducible. A complete, parameterized cardiac-myosin/ligand/solvent system is not available in this checkpoint. This document separates what can be assembled from verified data from what would require an unsupported chemical assumption.

## Completed input work

`scripts/scientific_readiness.py` reconstructs the graph of CCD 6I6 from its atom/bond tables, attaches the selected 9F6C assembly-1 coordinates, and assigns stereochemistry from those coordinates. Its full chirality-preserving match to the published aficamten SMILES is unique and reproduces the expected R enantiomer and InChIKey. Removing the terminal ethyl carbon yields the published compound 17 graph. Matching that product to the independently supplied compound 17 SMILES also gives one unique map.

| Derived input | Result |
|---|---|
| Common ligand heavy atoms | 24, with source-SMILES indices and CCD names |
| Aficamten-only heavy atom | CCD `C`, author aficamten atom index 0 |
| Retained substituent carbon | CCD `C1`, aficamten index 1; methyl in 17, methylene in aficamten |
| Compound 17 graph | C17H17N5O2; R stereocenter preserved |
| Aficamten graph | C18H19N5O2; R stereocenter preserved |
| Receptor coordinate candidate | All 6,032 previously selected heavy-atom rows exported |

The map is in `data/prepared_candidate/ligand_atom_map.json`. The two SDF files are heavy-atom coordinate candidates with chemically assigned bond orders and stereochemistry. Compound 17 inherits its 24 common coordinates from aficamten; this is an explicit initial-pose hypothesis. Nothing has been minimized, assigned a partial charge, equilibrated or sampled. Both SDFs retain embedded status/limitation fields and pass a chemical-identity round trip.

`selected_heavy_coordinates.json` preserves each original coordinate string in Å, exact decimal conversion to nm, source atom identity, occupancy and B factor. It includes protein, cofactors, ligand, sulfate and selected crystallographic waters. It does not add the missing TRP130 atom, missing residues, hydrogens, caps, bulk water or counterions. Consequently, 6,032 remains a count of selected deposited heavy-atom rows, not a prepared simulation atom count.

The heavy-atom map is not a complete alchemical topology. Explicit hydrogens must be assigned and mapped: the common substituent carbon has three hydrogens in compound 17 and two in aficamten, while the new terminal carbon has three. Partial-charge changes, dummy atoms, bonded interpolation, constraints and soft-core terms still require a consistent endpoint model. A common heavy-atom scaffold does not make those choices automatic.

## What the primary evidence resolves

The [aficamten structure paper](https://www.nature.com/articles/s44161-024-00505-0) reports the Mg/ADP/vanadate complex and provides PDB 9F6C in its data-availability statement. The reviewed material did not yield a complete parameterized ORVIA RBFE system. That bounded search result does not prove that none exists elsewhere.

Related [OM/mavacamten cardiac-myosin work](https://pmc.ncbi.nlm.nih.gov/articles/PMC11161628/) uses CHARMM36m and describes phosphate built from a vanadate-containing structure. Related [AMBER myosin work](https://pmc.ncbi.nlm.nih.gov/articles/PMC11477208/) explicitly replaces vanadate with H2PO4, changes trimethyllysine to lysine, and builds missing loops with Modeller; its trajectories are request-only. Those are published choices for different models. Copying them without changing ORVIA's registered molecular-state declaration would be incorrect.

Trimethyllysine is not a fundamentally unparameterizable residue. [Forcefield_PTM](https://pmc.ncbi.nlm.nih.gov/articles/PMC3904396/) publishes parameters compatible with AMBER ff03. The [CHARMM authors](https://mackerell.umaryland.edu/charmm_ff.shtml) also distribute topology/parameter releases. A selected set must be matched to the chosen whole-system force field. Neither availability establishes compatibility with an arbitrary protein/ligand combination, and neither resolves Mg/ADP/vanadate coordination.

These sources were reviewed on 2026-11-01. No author was contacted. The project does not silently adopt a preparation from these papers. A subsequent public-component audit is described below.

## Remaining concrete requirements

| Requirement | Evidence needed to clear it |
|---|---|
| Missing structure | A declared model for the 65 absent residues, incomplete TRP130 and termini; provenance for introduced coordinates and structural validation |
| Cofactors | Explicit vanadate species, protonation/charge and coordination; compatible Mg/ADP/vanadate parameters and a quantitative validation target |
| Complete force field | Pinned parameter files and licenses, partial charges, bonded terms, exceptions and unit conventions for every atom in both legs |
| Ligand endpoints | Declared microstates, explicit hydrogen topology/map, parameterized endpoints and checks of the compound 17 pose hypothesis |
| Solvent systems | Complete complex and solvent legs, water/ion model, box, concentration and thermodynamic conditions |
| Sampling protocol | Minimization/equilibration, lambda schedule, repeats, deterministic seeds, retained samples, estimator/uncertainty and failure criteria |
| Numerical translation | Agreement with an independent established engine for identical complete inputs, including every selected force-field term |

A generic free-ion vanadium parameter is not equivalent to a coordinated vanadate model. Changing vanadate to phosphate, deleting cofactors or mutating M3L to lysine changes the scientific system. Such alternatives can be separately named sensitivity models after their own preparation and review; they cannot silently close the current input gate.

The protein force-field choice also affects implementation. A CHARMM-family model can require Urey–Bradley, harmonic impropers, CMAP corrections and pair-specific nonbonded rules. An AMBER-family choice has different conventions and compatibility requirements. Declaring that a kernel exists does not prove it can consume an arbitrary chosen force field. Parameter import must reject unsupported terms and missing entries instead of dropping them.

## Deployment versus biological validation

A matched direct-affinity measurement for compound 17 and aficamten is not present in the audited project. That prevents a claim of experimentally validated relative binding affinity. It is not intrinsically required to deploy research software or to run a clearly declared predictive model. Functional ATPase IC50 must still not be relabeled Kd or converted into a validated binding free-energy difference.

Conversely, software deployment does not close the missing-chemistry or sampling requirements. An ORVIA-001 experiment needs a complete declared Hamiltonian and prepared inputs before it can be registered as that scientific calculation. The report therefore retains `ready_for_orvia_001_registration: false`. Engineering and chain readiness remain separate gates owned by their corresponding reports.

## Reproduction

Run with the existing pinned research environment:

```bash
.venv-research/bin/python scripts/scientific_readiness.py --check --self-test
```

Without `--check`, the script regenerates the candidate exports and `data/scientific_readiness.json`. It rechecks source hashes and prior audits, graph identities, coordinate-derived chirality, both unique maps, exact coordinate-unit conversion and SDF identity preservation. Adversarial checks reject the opposite enantiomer and removal of the unrelated pyrazole methyl group. Candidate outputs carry their own hashes and cannot be promoted to complete simulation inputs by this audit.

The script performs no network access. It reproduces local source-derived artifacts; it does not re-run the literature search, solve molecular preparation, validate a force field or calculate production scientific answers off-chain.

## Alternative molecular states and public components

Vanadate is an unresolved input for the selected ORVIA-001 state, but is not an unavoidable requirement for every cardiac-myosin research model. The user's broad cardiac-drug objective permits a rational, explicitly declared ADP+Pi model. The published cardiac preparations above provide a precedent. Such a change needs a new molecular-state/protocol identifier, recorded residue/protonation choices and a complete compatible force field; it does not require inventing vanadium parameters.

The [2025 myosin-5 study](https://www.nature.com/articles/s41586-025-08876-5) deposits topology/trajectory material in [Figshare 24948180](https://doi.org/10.6084/m9.figshare.24948180.v1), under CC BY 4.0. Its primary methods model ADP and H2PO4 with CHARMM-GUI components. The project inspected two actual archive members rather than treating the availability statement as proof of completeness. The source is mutant mouse myosin-5 actomyosin, not cardiac myosin or an aficamten complex.

The audit found a 29,549-atom analysis topology and a separate 468,219-atom solvated PDB. These are not a directly runnable matching topology/coordinate pair. Explicit parameters and coordinates for 47 active-site cofactor atoms—H2PO4, Mg and ADP—were extracted without fitting or unit conversion. The source topology contains CHARMM Urey–Bradley, harmonic improper and special 1–4 nonbonded arrays; no CMAP arrays occur in the inspected export. That discrepancy with the stated protein force field needs resolution before whole-model reuse. Detailed source SHA-256/CRC32 values, raw parameter text and limitations are retained in `data/prepared_candidate/alternative_models/`.

The two complete selected source files are included in compressed form under `data/source/alternative_models/`, with CC BY 4.0 attribution and exact hashes. The alternative audit defaults to these packaged sources and reproduces offline with `python3 data/prepared_candidate/alternative_models/audit_public_models.py --check --self-test`. Its self-test rejects same-length source tampering; the full 1.97 GB archive is excluded.

The [myosin-VI recovery-stroke study](https://pmc.ncbi.nlm.nih.gov/articles/PMC11086841/) also deposits a [public topology archive](https://doi.org/10.5281/zenodo.8415241). Inspection found an ATP-state system plus reusable CHARMM nucleotide/ion files and a phosphate stream. It is useful component evidence, but a noncardiac ATP-state system does not establish aficamten binding in cardiac ADP+Pi myosin. Its phosphate stream and the myosin-5 H2PO4 model have different parameters; they must not be blended without declaring and validating the resulting force field.

A [cardiac-myosin modification dataset](https://zenodo.org/records/15278114) advertises complete AMBER inputs, but its [primary study](https://doi.org/10.1111/apha.70240) uses the 4DB1 post-rigor ATP model, not the selected aficamten pre-powerstroke state. The 16 GB trajectory archives were not downloaded or certified as ready drug inputs. The [2025 aficamten/phosphate-release study](https://doi.org/10.1002/pro.70289) states that underlying data are available on request; no open complete preparation was established from that statement.

The immediate defensible next model is therefore a separately declared cardiac ADP+H2PO4 candidate built from the verified 9F6C binding pose, using one compatible parameter family throughout. This audit resolves the claim that public phosphate/nucleotide components are absent. It does **not** supply the complete cardiac system, ligand force fields, missing-loop model, cofactor-transfer validation or independent energy/force comparison. Those are concrete preparation/validation work; specialist input or an author-supplied complete preparation may be needed where public methods omit the required choices. Keeping the original vanadate state instead requires its unresolved coordination/parameterization evidence.

The 2026-11-02 audit now checks positional identity across the entire analysis-topology prefix: 29,544 atom/residue names match, followed by five topology Mg atoms that instead overlap acetate atoms in the PDB. A simple prefix truncation cannot repair this topology/coordinate pair. The 47 extracted cofactor atoms pass their own identity checks; decoding their charges using the CHAMBER factor `sqrt(332.0716)` recovers H2PO4 −1e, Mg +2e and ADP −3e within 1e−12e. These checks do not supply missing interaction terms, validate cardiac transfer or promote the public components to a prepared model. The reproduction self-test rejects an incorrect charge convention and a selected-atom identity mismatch as well as source-byte tampering.

A [separately named ADPPI candidate protocol v0.1](PROPOSED_ADPPI_PROTOCOL_v0_1.md) now records the preparation sequence, evidentiary limits and unresolved registration fields. It is explicitly unapproved and unregistered. The original vanadate-containing ORVIA-001 protocol and its blocked input gate are unchanged.

Matched direct-affinity data remain a requirement for an experimentally validated affinity claim, not a launch requirement for clearly labelled research software. The present model audit leaves production readiness false.
