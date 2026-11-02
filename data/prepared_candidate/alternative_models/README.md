# Public cofactor evidence for an alternative ADP+Pi model

These files audit published source components. They are not registered ORVIA inputs and do not change the original vanadate-containing ORVIA-001 state.

`public_model_audit.json` records the topology/coordinate mismatch and unsupported whole-system reuse. `myosin5_cofactor_reference.json` preserves source-global atom/type identities, exact parameter text and deposited coordinates for 47 atoms: seven H2PO4 atoms, Mg and 39 ADP atoms. Internal bonded/Urey–Bradley/improper records and nonbonded coefficients against source types are extracted. This is not a complete interaction graph or exclusion policy. No raw charge is presented as elementary charge; its CHAMBER storage convention must be decoded by a tested format-aware importer.

Source: Klebl, McMillan, Risi et al., *Nature* 642, 519–526 (2025), [10.1038/s41586-025-08876-5](https://doi.org/10.1038/s41586-025-08876-5), data [10.6084/m9.figshare.24948180.v1](https://doi.org/10.6084/m9.figshare.24948180.v1), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The extraction and machine-readable audit are modifications by ORVIA; source numerical values are unchanged. The source is mutant mouse myosin-5 actomyosin, not cardiac myosin.

Reproduce using only Python's standard library:

```bash
python3 data/prepared_candidate/alternative_models/audit_public_models.py --check --self-test
```

Both complete selected source members are packaged as deterministic gzip files in `data/source/alternative_models/`, which is the default source directory regardless of the current working directory. The package includes attribution, licensing and compressed/uncompressed hashes in `PROVENANCE.json`. Checks run offline without any transient cache. `--check` verifies source lengths, ZIP CRC32 values and SHA-256 hashes, then compares every derived output byte without writing. `--self-test` confirms rejection of same-length tampering through both raw and compressed source paths, using temporary copies that are removed afterwards.

`--cache PATH` selects another source directory. Optional `--fetch` restores absent members by bounded HTTP byte ranges, refuses a server that ignores ranges, verifies source hashes before saving, and stores the verified source bytes with gzip compression. About 8.9 MB of compressed source material is included. The full 1.97 GB archive and trajectories are excluded and its reported whole-archive MD5 is not claimed independently verified.

The inspected topology has 29,549 atoms and no water, while the supplied PDB has 468,219 atoms. Absence of CMAP arrays in this analysis export also needs reconciliation. These inputs therefore supply evidence for parameter availability and future importer fixtures; they do not establish a complete simulation, transferable cardiac chemistry, validated affinity or mainnet readiness.

The positional identity audit checks all 29,549 topology atoms. The first 29,544 atom/residue names match the PDB; the final five topology Mg atoms overlap PDB acetate atom names instead. Truncation to the topology atom count therefore fails. The selected 47 cofactor atoms pass atom/residue-name checks before extraction. The separate charge audit decodes the CHAMBER storage convention using `sqrt(332.0716)`, recovering residue sums −1e (H2PO4), +2e (Mg) and −3e (ADP) within 1e−12e. This checks the source model only and leaves raw extracted charges unchanged. The self-test rejects the usual Amber 18.2223 factor and a selected-atom name mismatch. No cross-boundary record occurs in the eight inspected bonded arrays; this is not a complete exclusion/nonbonded/coordination audit.

See `docs/PROPOSED_ADPPI_PROTOCOL_v0_1.md` for a separately named, unapproved preparation proposal. It does not change the original vanadate-containing ORVIA-001 model or clear any production gate.
