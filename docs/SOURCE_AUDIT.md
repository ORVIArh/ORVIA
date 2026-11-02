# ORVIA-001 source audit

Status: **source audit complete; molecular simulation inputs not prepared**.

The downloaded structure is PDB **9F6C**, version **2.0**, revised **2 September 2026**. The deposited revision history identifies metalloprotein remediation. The structure is a bovine cardiac-myosin motor domain in a pre-powerstroke state with aficamten, ADP, magnesium and vanadate. It is not a human MYH7 structure or a complete thick filament.

## Pinned source files

Retrieved 1 November 2026 from the official RCSB file service:

| File | Bytes | SHA-256 |
|---|---:|---|
| `data/source/9F6C.cif` | 2,361,217 | `9b7f16917441dbb4afe4bca3b3ee2866878ecc97f566fba738f33490572de3aa` |
| `data/source/9F6C.pdb` | 1,980,450 | `c50361481c26d160fe589da039de6f0892e8df8725c38a1e7c6f6610a57e2939` |
| `data/source/6I6.cif` | 9,686 | `2fbc550eabade8660ade0c020cd4761cd8e7135c23fae61f819ece1ab808757f` |

The mmCIF file is the authoritative input for the audit. The PDB file supplies an independent fixed-column check of total atom records and alternate-location records. The CCD file identifies aficamten (component `6I6`, formula `C18 H19 N5 O2`, formal charge zero in this chemical-component record, InChIKey `IOVAZWDIRCRMTM-OAHLLOKOSA-N`). A CCD charge is not a substitute for choosing protonation under the final simulation conditions.

## Structure inventory

Counts below are **raw crystallographic atom rows**, including alternate locations. They are not solvated simulation sizes.

| Property | Crystal asymmetric unit | Assembly 1 | Assembly 2 |
|---|---:|---:|---:|
| Atom rows | 11,944 | 6,053 | 5,891 |
| Polymer atom rows | 11,493 | 5,794 | 5,699 |
| Observed polymer residues | 1,423 | 717 | 706 |
| Crystallographic water molecules | 330 | 196 | 134 |
| Alternate-location atom rows | 56 | 40 | 16 |
| Hydrogen atom rows | 0 | 0 | 0 |
| Zero-occupancy atom rows | 2 | 1 | 1 |

The deposited polymer sequence is 782 residues long. Chain A has 65 unobserved-residue records and chain B has 76. The observed-plus-unobserved residue counts reconcile to 782 for each chain. There are also two unobserved/zero-occupancy atom records, one per chain. These categories require chemical review rather than simply deleting every listed record.

The deposited biological assemblies are **two separate author-defined monomers**. Assembly 1 comprises label asym IDs `A,C,D,E,F,G,L`; assembly 2 comprises `B,H,I,J,K,M`. Both use the identity symmetry operation. Treating the two crystal copies as a physiological myosin dimer would be unsupported.

Each assembly contains one aficamten, one ADP, one magnesium ion and one vanadate. Assembly 1 additionally includes a sulfate. Both chains contain trimethyllysine component `M3L` at residues 129 and 549. Selection, retention, protonation and parameterisation of these species remain unresolved. Vanadate cannot simply be relabelled as inorganic phosphate.

## Candidate chemical transformation

The 2021 aficamten discovery paper, Table 5, reports an oxadiazole-5-position methyl group for **compound 17** and an ethyl group for **aficamten**. Compound 17 and aficamten have R indane stereochemistry. The reported cardiac-myofibril IC50 values are 4.4 and 1.4 micromolar respectively.

These are functional ATPase-inhibition measurements. They do not establish a measured binding ΔΔG, and this package does not convert their ratio to one. The [v0.2 pair audit](INPUT_DECISIONS_v0_2.md) now verifies the published machine-readable identities and stereochemistry. It also records distinct author-CSV IC50 values (4.2 and 1.3 micromolar) alongside the article values without assuming a reconciliation. Simulation protonation, atom mapping and compound 17's bound pose remain unresolved. The assumption that it occupies the aficamten site remains to be tested. `data/inputs_audit.json` preserves the original structural-audit snapshot; the separate pair audit records this subsequent identity resolution.

## Reproduce the audit

From the project root:

```bash
python3 scripts/audit_structure.py --check
```

To intentionally regenerate the audit after reviewing a source or parser change:

```bash
python3 scripts/audit_structure.py
```

`data/inputs_audit.json` contains source hashes, revision metadata, category-level counts, biological assembly definitions, missing-residue records, the CCD descriptors and explicit unresolved fields. No network access or third-party Python packages are required to reproduce the audit from the included source files.

## Scientific run blockers

1. Choose and justify a single biological assembly; review missing residues/atoms, alternate conformations, occupancies, terminal treatment and modified lysines.
2. Specify whether the first calculation models the deposited bovine construct or a separately validated human system. This package supports only the source identification, not a human translation.
3. Fix the motor/nucleotide state and validate special parameters for the magnesium–ADP–vanadate system.
4. Verify compound 17 and its common binding-mode assumption.
5. Pin the force fields, charges, protonation, solvent box, ionic conditions and both prepared systems.
6. Register a justified alchemical schedule, repeat seeds, sampling lengths and convergence/extension policy.
7. Obtain matched affinity data or a separately validated mechanistic assay model before claiming biological free-energy accuracy.

## Primary sources

- [9F6C structural record](https://www.rcsb.org/structure/9F6C)
- [9F6C mmCIF](https://files.rcsb.org/download/9F6C.cif)
- [9F6C PDB](https://files.rcsb.org/download/9F6C.pdb)
- [Aficamten chemical-component record](https://files.rcsb.org/ligands/download/6I6.cif)
- Chuang et al. (2021), [Discovery of Aficamten (CK-274)](https://doi.org/10.1021/acs.jmedchem.1c01290), Table 5. The publisher's indexed table was inspected; this package does not include a downloaded full-text copy of that paper.
- Hartman et al. (2024), [Aficamten is a small-molecule cardiac myosin inhibitor designed to treat hypertrophic cardiomyopathy](https://pmc.ncbi.nlm.nih.gov/articles/PMC11358156/).

This audit is development provenance work. It is not an on-chain scientific run, molecular-dynamics trajectory or binding prediction.
