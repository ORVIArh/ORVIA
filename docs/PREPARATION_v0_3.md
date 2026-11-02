# ORVIA-001 receptor-preparation candidate, v0.3

**Candidate: deposited biological assembly 1, bovine chain A. This is not a prepared molecular-dynamics system.**

This increment makes the receptor-selection decision concrete and reproducible. It compares both deposited monomers using the pinned 9F6C coordinates, selects a candidate by structural completeness, and records every retained source atom row. It does not fill missing coordinates, assign chemistry, minimize, solvate or calculate a binding energy.

## Why assembly 1 is the current candidate

| Coordinate audit | Assembly 1 / chain A | Assembly 2 / chain B |
|---|---:|---:|
| Observed polymer residues | 717 | 706 |
| Missing residues in the 782-residue construct | 65 | 76 |
| Selected positive-occupancy heavy-atom rows | 6,032 | 5,882 |
| Retained crystallographic waters | 196 | 134 |
| Protein contact residues within 4.5 Å of aficamten | 21 | 21 |
| Protein contact residues within 6.0 Å of aficamten | 27 | 27 |
| Residues with alternate conformers | 2 | 1 |
| Mean ligand B factor, Å² | 55.9928 | 50.7940 |

The selection criterion is **more observed protein and fewer missing residues**. Assembly 1 has eleven more observed residues. The two assemblies share the same 27 residue identities in the 6 Å contact set. Across those residues, the RMS difference between their minimum ligand distances is 0.098154 Å, with a maximum absolute difference of 0.230886 Å. This quantity is **not** an aligned coordinate RMSD: it compares one scalar minimum heavy-atom distance per corresponding residue.

There is counterevidence to retain: assembly 2 has fewer alternate-conformation residues and a lower mean ligand B factor. Completeness does not prove that assembly 1 has a more accurate binding site. Assembly 2 remains a receptor-sensitivity candidate, and both static structures leave conformational sampling unresolved.

Contacts are calculated from positive-occupancy heavy atoms using Euclidean distances within the deposited biological assembly. No crystal symmetry mates, lattice contacts, hydrogen-bond assignments or inferred waters enter the metric. A contact cutoff defines this audit, not an interaction cutoff for simulation.

## Exact coordinate-candidate selection

`data/preparation_decisions.json` contains the selected assembly, complete source `atom_site.id` list, per-assembly measurements, missing-residue ranges, altloc choices and the unresolved preparation work. The source remains unmodified.

1. Use assembly 1's label asym IDs `A,C,D,E,F,G,L` and its deposited identity operation. Keep one monomer; do not concatenate the other crystal copy.
2. Keep blank/common atoms plus **one whole-residue alternate conformer**. Rank conformers by mean occupancy over matching atom sets. Equal occupancies use the lexicographically first altloc label, which is `A` here. The script rejects unequal alternative atom sets rather than choosing atom by atom.
3. Retain positive-occupancy heavy atoms. Preserve the deposited occupancy and B-factor values. A selected 0.50-occupancy conformer is not relabelled as experimentally full occupancy.
4. Retain all selected protein, aficamten, magnesium, ADP, vanadate, sulfate and crystallographic water rows. No component is deleted because it is distant from the ligand.
5. Preserve residue identities, including `M3L129` and `M3L549`, source numbering and bovine species. No mutation, vanadate-to-phosphate substitution, human relabelling or inferred protonation occurs.
6. Exclude the zero-occupancy `TRP130 CG` row from the candidate mask and contact calculations, while explicitly marking that chemical atom for rebuilding/review. This exclusion leaves an incomplete topology; it is not permission to simulate a damaged tryptophan ring.

Assembly 1's `GLN564` and `ARG663` alternate conformers have equal 0.50 occupancy. Their chosen conformers are respectively 19.661 Å and 12.830 Å from the nearest ligand heavy atom. The deterministic choice is therefore explicit, but it is not evidence that the chosen alternative is physically preferred or that it cannot affect dynamics.

The selected-row list contains **6,032 existing heavy-atom coordinate rows**, not a solvated-system atom count. Its SHA-256 is `2958b08823f0f1fb76672fee40e0404f3f1dbd468309308a171630bc4141bc74`, computed over the source atom IDs in ascending order, one decimal integer per line with a final newline. Coordinates are inherited in Å from the pinned source. A later numerical-input export must declare any Å-to-nm conversion and its rounding.

## Missing structure and cofactors remain substantive work

Assembly 1 has missing ranges **1–32, 202–210, 370, 626–644 and 732–735**. Loop 626–644 is bracketed by observed Cα atoms whose nearest ligand distances are 17.327 Å and 11.717 Å. These are distances to observed anchors, **not** distances to the absent loop. They do not justify deleting the loop or claiming it cannot reach or influence the pocket. Terminal treatment and every gap need a registered modelling decision and subsequent validation.

| Retained nonwater component in assembly 1 | Minimum heavy-atom distance to aficamten, Å |
|---|---:|
| Magnesium | 8.953 |
| ADP | 10.392 |
| Vanadate | 6.553 |
| Sulfate | 32.501 |

These coordinate distances do not choose the force-field treatment. In particular, the magnesium–ADP–vanadate state, modified lysines and sulfate require explicit chemistry and parameter decisions. All 196 deposited waters remain in the coordinate candidate; three have oxygen atoms within 4.5 Å of aficamten. Water retention, orientation, bulk solvent and ions still require a preparation protocol.

The published ligand identities are resolved by the v0.2 audit. Simulation microstates, alchemical correspondence, compound 17's bound pose, special parameters, complete solvent systems and an appropriate affinity benchmark remain unresolved. The candidate also remains a **bovine** construct; it is not automatically a human MYH7 model.

## Reproduction and evidence boundary

```bash
python3 scripts/audit_preparation.py --check --self-test
```

The standard-library-only script rechecks the exact source SHA-256, regenerates all selection metrics and atom IDs, compares the result with the committed JSON, and exercises occupancy/tie selection, incomplete-conformer rejection and a known 3–4–5 coordinate-distance check. To deliberately regenerate the decision record after reviewing a change, omit `--check`.

The pinned source is [RCSB 9F6C mmCIF](https://files.rcsb.org/download/9F6C.cif), SHA-256 `9b7f16917441dbb4afe4bca3b3ee2866878ecc97f566fba738f33490572de3aa`. Assembly definitions, atom coordinates, occupancies, B factors and missing-residue records come from that source. The derived contact metrics and selection ranking are ORVIA's development audit, not deposited experimental findings.

This is a declared external model-preparation input. It supplies no off-chain trajectory or free-energy result to the production computation. The original structural-audit snapshot remains intact; this separate candidate record does not silently freeze the scientific protocol or make the system ready to run.
