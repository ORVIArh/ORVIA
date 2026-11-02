# Explicit ligand endpoints and hybrid input candidate

This increment creates actual hydrogen-complete, parameterized molecular inputs for the published neutral compound-17/aficamten pair. It is external model preparation. No production trajectory or binding free energy was calculated.

The source-derived heavy graphs retain their R stereochemistry and InChIKeys. Endpoint A has 41 atoms, B has 44; the explicit map has 40 common atoms, one A-only hydrogen and four B-only atoms. The canonical union has 45 atoms. New hydrogen coordinates use a declared geometry construction, with no force-based minimization hidden in that step.

Native AmberTools 26.0 Antechamber/SQM assigns AM1-BCC charges and GAFF2 atom types. `parmchk2` supplements the parameters and `tleap` creates native MOL2, PRMTOP and INPCRD files for both endpoints, without native topology errors/warnings. Raw quantum input/output and native logs are retained. The raw finite-text charge sums are −0.001999e and +0.000999e. A separately recorded uniform correction, smaller than 0.0001e per atom, closes the charge exactly in normalized MOL2 text; raw bytes and every pre/post charge remain available. Native PRMTOP formatting/import leaves approximately 2.5e−9e residuals, which are recorded rather than relabeled exact zero.

The native Antechamber SDF reader quantizes coordinates to 0.001 Å. Newly created hydrogen positions therefore differ from the four-decimal SDF by up to 0.0005 Å; ordered elements, bonded connectivity and the bounded coordinate change are checked explicitly. Experimental ligand heavy coordinates already have three-decimal precision.

## Explicit parameters and numerical validation

The strict importer exports masses, charges, LJ sigma/epsilon, every harmonic bond/angle, every ordered periodic torsion including native impropers, and every explicit exclusion/1–4 exception. It preserves the actual native charge products and LJ exception coefficients. Unsupported forces, virtual sites, parameter offsets and undeclared constraints are rejected instead of dropped. Units and functional forms are recorded in each `parameters.json`.

Endpoint A contains 44 bonds, 76 angles, 132 periodic torsions and 211 exceptions. Endpoint B contains 47 bonds, 82 angles, 141 periodic torsions and 229 exceptions. Each includes 14 native periodic impropers. Three snapshots per endpoint pass force-group energy comparisons and independent scalar-potential finite differences against OpenMM Reference. A separate nonzero-phase torsion case checks ordering/sign beyond the special 0/π phases.

The Coulomb prefactor is the explicit binary64 value derived from the installed OpenMM 8.6.1 CODATA constants. It is not silently replaced by a legacy rounded constant. The source package, tool versions, binaries and original force-field inputs are pinned in `toolchain.json`. AmberTools' retained license states that its `dat/leap` force-field parameter files are public domain; binary/source tooling has separate licenses. This statement does not relicense independently sourced PTM assets.

## Declared dummy policy

`hybrid_model.json` and `hybrid_streams.json` contain aligned endpoint records and the proposed single-anchor harmonic-bond-tree confinement policy. Inactive unique atoms have zero charge/LJ and zero angle/torsion amplitudes, while their native positive harmonic tree bonds remain. Cross A-only/B-only pairs are always excluded. The atom tuples from the native models are retained; reversed tuples can consequently occur as distinct records with zero-weight counterparts. There are 51 bond, 91 angle, 160 torsion and 239 exception records, represented by 7,191 bytes32 stream words.

The policy requires identical periodic box vectors for the complex and solvent legs. Parent-relative displacement coordinates on the periodic torus give a unit-Jacobian transformation of each singly anchored tree. Its partition function factors into edge integrals independent of the physical anchor coordinates. Matching boxes and edge potentials make these factors cancel across the thermodynamic cycle. Multiple anchors, cycles, additional inactive interactions or different leg boxes invalidate that argument. Instantaneous forces on physical anchors still include ghost-bond forces; unchanged physical marginals concern integration over ghost coordinates, not pointwise force equality.

Both 45-atom endpoint systems pass independent checks against the native physical endpoint plus the analytically evaluated ghost-tree energy and forces at three snapshots. This tests endpoint construction. It does not validate the intermediate alchemical path, finite Ewald convergence, a solvated cardiac system or production sampling.

## Parameter quality remains an explicit gate

`parmchk2` assigns high analogy scores of 232 and 780 to several torsion records. These are retained in `parameter_quality_review.json` with exact source lines. A successful native build and exact numerical translation do not validate their empirical accuracy. The review predeclares ring-preserving quantum conformer/gradient checks and amplitude sensitivity variants; its acceptance tolerances and quantum method remain unresolved. Scientific parameter acceptance and production readiness remain false.

## Reproduction

Create the dedicated preparation environment from the pinned package records in `toolchain.json`; it includes AmberTools 26.0, OpenMM 8.6.1, ParmEd 4.3.1 and RDKit 2026.03.1. The existing smaller research environment is not modified.

```sh
python scripts/preparation/prepare_ligand_endpoints.py --amber-prefix /path/to/preparation/environment
python scripts/preparation/export_amber_endpoint.py
python scripts/preparation/build_ligand_hybrid.py
python scripts/preparation/audit_ligand_parameter_quality.py
python -m unittest discover -s test/preparation -v
```

The eight focused tests cover identity/map reproduction, explicit charge correction, source-bound energy references, rejection of unsupported input forms, torsion ordering, rejection of invalid dummy networks, exact binary64-to-binary128 embedding, and native-plus-ghost endpoint energy/force agreement. Full cardiac preparation and its independent reference campaign remain separate work.
