# Published source members for offline reproduction

This directory contains two complete, unchanged source files, packaged using deterministic gzip compression:

- `Primed_input.pdb.gz`: `MD_trajectories/Primed_input.pdb` from the published archive.
- `Input_parm.prmtop.gz`: `MD_trajectories/Primed_RPI/Input_parm.prmtop` from the published archive.

Source: Klebl, McMillan, Risi et al., *Swinging lever mechanism of myosin directly shown by time-resolved cryo-EM*, *Nature* 642, 519–526 (2025), [article DOI](https://doi.org/10.1038/s41586-025-08876-5), [dataset DOI](https://doi.org/10.6084/m9.figshare.24948180.v1). The dataset is licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). ORVIA selected these members and compressed them; their decompressed source bytes are unchanged. `PROVENANCE.json` records exact package and original-content hashes.

Only these two members are included. The full 1.97 GB archive, trajectories and other models are excluded. The files describe mutant mouse myosin-5 actomyosin, not cardiac myosin or an aficamten complex. The analysis topology and solvated coordinate file have different atom counts and are not a directly runnable matched pair. Reusing them requires the scientific and force-field checks documented in `data/prepared_candidate/alternative_models/README.md`.

From the project root, verify every source hash and regenerate-derived-byte comparison offline:

```bash
python3 data/prepared_candidate/alternative_models/audit_public_models.py --check --self-test
```
