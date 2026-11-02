# ORVIA-001 input decisions, v0.2

**Published chemical-pair identity resolved. Scientific run remains blocked.**

This addendum documents the compound 17 source-identity resolution now incorporated into `PROTOCOL_ORVIA_001.md`. The original `data/inputs_audit.json` remains the historical structural audit; `data/pair_identity_audit.json` records this later chemical-pair audit. This work does not resolve a simulation microstate, atom mapping, force field, bound pose, sampling protocol or experimental binding affinity.

## Concrete result

The authors deposited a machine-readable SMILES/assay CSV alongside the discovery article. Both compound 17 and aficamten appear explicitly in that file. The supplementary synthesis PDF, page S21, independently names and depicts compound 17 as the **1R** indane enantiomer; compound 18 is the **1S** enantiomer. The PDF page was visually inspected, including the chemical drawings, and agrees with the CSV stereochemistry. [Primary CSV](https://doi.org/10.1021/acs.jmedchem.1c01290.s003); [primary synthesis SI](https://doi.org/10.1021/acs.jmedchem.1c01290.s001).

Compound 17's published name is **1-Methyl-N-[(1R)-5-(5-methyl-1,2,4-oxadiazol-3-yl)-2,3-dihydro-1H-inden-1-yl]-1H-pyrazole-4-carboxamide**. This identifies which methyl substituent changes: the oxadiazole-5 methyl becomes ethyl; the pyrazole N-methyl remains present.

The following descriptors were **computed during this audit with RDKit 2026.09.1** from the author-supplied SMILES. The InChIKeys are computed identifiers, not new experimental measurements.

| Identity check | Compound 17 (A) | Aficamten (B) |
|---|---|---|
| Formula | C17H17N5O2 | C18H19N5O2 |
| Heavy atoms | 24 | 25 |
| Specified stereocenter | One, R | One, R |
| Formal charge of published graph | 0 | 0 |
| Computed standard InChIKey | `VTXZRNAUVAGCBA-OAHLLOKOSA-N` | `IOVAZWDIRCRMTM-OAHLLOKOSA-N` |

The aficamten graph from the author CSV matches the pinned PDB CCD `6I6` graph, including stereochemistry, by canonical isomeric SMILES and InChIKey. Deleting the terminal carbon of aficamten's oxadiazole ethyl group and sanitising the graph yields compound 17 exactly. Therefore the published neutral-graph transformation has a net **+CH2**, **+1 heavy atom**, and **0 formal-charge** change for A to B. This check establishes connectivity; it is not a registered alchemical topology or a proof that the same protonation state applies in solution and the binding site.

## Assay discrepancy retained

| Primary record | Compound 17 IC50, micromolar | Aficamten IC50, micromolar |
|---|---:|---:|
| Discovery article, Table 5 | 4.4 | 1.4 |
| Author supplementary CSV | 4.2 | 1.3 |

Both are cardiac-myofibril ATPase inhibition records. Their difference remains unexplained in this audit. We preserve both, with separate provenance; we do not average them, silently replace one with the other, or assume rounding. Neither record supplies the matched Kd values required for an experimental binding-free-energy comparison. [Article/Table 5](https://doi.org/10.1021/acs.jmedchem.1c01290); [author CSV](https://doi.org/10.1021/acs.jmedchem.1c01290.s003).

The SI assay description uses bovine cardiac myofibrils and a coupled ATPase readout, reinforcing that this is a functional sarcomeric assay rather than a direct equilibrium binding experiment. Its biochemical conditions do not automatically select the simulation ensemble or receptor state. [SI page S50](https://doi.org/10.1021/acs.jmedchem.1c01290.s001).

## Pinned evidence and reproducibility

Original publisher bytes were obtained through ACS Figshare. File size and MD5 match the publisher metadata. SHA-256 values below pin the exact content inspected. **The complete PDF and CSV are not included in this project.** ACS Figshare identifies both supplements as **CC BY-NC 4.0**; this audit does not assume that the main article's different license overrides the supplements' license. [Publisher license record for the PDF](https://api.figshare.com/v2/articles/16734771); [publisher license record for the CSV](https://api.figshare.com/v2/articles/16734777).

| Inspected original filename, not redistributed | Bytes | SHA-256 |
|---|---:|---|
| `jm1c01290_si_001.pdf` | 684609 | `9218df309e2ae3469dd521ddbfdedf7d9515f379e03b777e8da97e4f961c08bb` |
| `jm1c01290_si_003.csv` | 2779 | `29406eb5e3bed02dbe0867228b6a7e1f76c42227ac54e239cd8536a7f8adb782` |

- Synthesis SI: [publisher metadata](https://api.figshare.com/v2/articles/16734771), [original file](https://ndownloader.figshare.com/files/30975255), original filename `jm1c01290_si_001.pdf`.
- Author CSV: [publisher metadata](https://api.figshare.com/v2/articles/16734777), [original file](https://ndownloader.figshare.com/files/30975261), original filename `jm1c01290_si_003.csv`.

Attribution: Chihyuan Chuang and colleagues, *Discovery of Aficamten (CK-274), a Next-Generation Cardiac Myosin Inhibitor for the Treatment of Hypertrophic Cardiomyopathy*, ACS, 2021; supplementary assets `.s001` and `.s003`, [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). The supplied `data/source/compound17_pair_rows.json` contains only the two factual chemical/assay records, copied without changing their values. `data/source/compound17_publisher_metadata.json` retains only factual provenance, file metadata and license declarations. Our calculated descriptors and decisions are separated in `data/pair_identity_audit.json`.

The executable audit is `scripts/audit_pair_identity.py`. Its default mode uses only the Python standard library, performs no downloads, and checks the pinned local bytes, the two factual rows, publisher provenance, license declarations and consistency with the recorded audit. It also parses the pinned `6I6.cif` directly using the existing CIF reader.

```sh
python3 scripts/audit_pair_identity.py
```

To reproduce the molecular graph assertions, install the development-only dependency in an isolated environment. The audited setup was **CPython 3.12.14** and **RDKit package 2026.9.1**, whose runtime version string is `2026.09.1`. The package requirement is pinned in `requirements-research.txt`; this is not a molecular force-field version or a production-engine dependency.

```sh
python3 -m venv .venv-research
.venv-research/bin/python -m pip install -r requirements-research.txt
.venv-research/bin/python scripts/audit_pair_identity.py --chemistry
```

`--chemistry` fails if RDKit is missing, the runtime version differs, or a graph assertion fails. It reproduces all recorded descriptors (including stereocenter indices, standard InChI and InChIKey), checks both independent canonical SMILES descriptors in CCD 6I6, removes the specified terminal ethyl carbon to recover compound 17, and calculates the +CH2/+1-heavy-atom/zero-charge delta. These are off-chain development input checks, not production simulation steps.

For a general project check that may run without research dependencies, use:

```sh
python3 scripts/audit_pair_identity.py --chemistry-if-available --json
```

This mode reports **SKIPPED** if RDKit is absent and does not claim that chemistry passed. An installed but incompatible RDKit version fails. Use mandatory `--chemistry` in a research-validation environment. Plain default mode reports **NOT_REQUESTED** for chemistry. `--json` produces machine-readable statuses; `--root PATH` audits an alternate project copy.

No mode downloads or redistributes the complete publisher supplements. The original-byte SHA-256 and MD5 checks were performed at retrieval and remain documented here; default offline execution validates the delivered factual evidence, not unavailable original PDF/CSV bytes. Rechecking original bytes requires independently retrieving the linked originals under their stated license. Historical visual inspection of SI page S21 is recorded, not re-performed by the script. No successful mode clears the scientific-run gate.

## What this permits next

The engineering lane can now consume the exact published identities as candidate molecular inputs, with the published stereochemistry preserved. It can build a reviewed atom correspondence and endpoint topology candidate, then verify that all common atoms and the R center are handled consistently. Simulation protonation/tautomer choices, charges and force-field parameters must be separate, explicit decisions.

The next scientifically useful preparation step is a documented bound-state model review: select a 9F6C monomer assembly, resolve missing structure and alternate conformations, declare modified-residue and Mg/ADP/vanadate treatment, and assess whether a compound 17 pose derived from aficamten is defensible. A common pose is a modelling hypothesis until validated. This audit neither assigns that pose nor substitutes vanadate, deletes cofactors, or invents parameters.

Human translation remains unresolved because the structural and functional sources audited here are bovine. A matched state-specific affinity experiment or a separately validated assay-to-binding model is still needed for biological validation. Complete explicit-solvent systems, two alchemical legs, independent repeats, adequate sampling and the full on-chain engine remain required by ORVIA-001.
