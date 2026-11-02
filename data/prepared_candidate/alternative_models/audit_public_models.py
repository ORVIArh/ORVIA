#!/usr/bin/env python3
"""Audit public myosin components; never creates an ORVIA production topology.

The two selected source members are packaged as gzip files for offline checks.
Optional fetching uses bounded byte ranges. Member SHA-256 and ZIP CRC32 are
checked; the complete 1.97 GB ZIP is not downloaded.
The outputs preserve source decimal text. No charges or chemistry are fitted.
"""
from __future__ import annotations

import argparse
from collections import Counter
from decimal import Decimal, localcontext
import gzip
import hashlib
import json
from pathlib import Path
import re
import struct
import tempfile
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parent
DEFAULT_CACHE = ROOT.parent.parent / "source" / "alternative_models"
URL = "https://ndownloader.figshare.com/files/52336004"
MEMBERS = [
    dict(name="MD_trajectories/Primed_input.pdb", offset=281, compressed=7660313,
         size=36989365, crc32="72516113",
         sha256="aaa0e02334fb5d553750a451c4a5304823199a31a55747c25dbbc44a93269017"),
    dict(name="MD_trajectories/Primed_RPI/Input_parm.prmtop", offset=1348960111,
         compressed=1454021, size=11380370, crc32="f10b25f4",
         sha256="4bd79fded29062a2d848119343666c6fde47ed1cf58253664a4d84555b299b7f"),
]


def bounded_range(start: int, length: int) -> bytes:
    request = urllib.request.Request(URL, headers={"Range": f"bytes={start}-{start+length-1}"})
    with urllib.request.urlopen(request, timeout=45) as response:
        if response.status != 206:
            raise ValueError("Server did not honor bounded range request")
        raw = response.read(length + 1)
    if len(raw) != length:
        raise ValueError("Incorrect range length")
    return raw


def read_member(cache: Path, entry: dict, fetch: bool) -> bytes:
    path = cache / Path(entry["name"]).name
    packed_path = path.with_name(path.name + ".gz")
    if not path.exists() and not packed_path.exists() and fetch:
        header = struct.unpack("<4s5H3L2H", bounded_range(entry["offset"], 30))
        if header[0] != b"PK\x03\x04" or header[3] != 8:
            raise ValueError("Expected a deflated ZIP local member")
        start = entry["offset"] + 30 + header[-2] + header[-1]
        raw = zlib.decompress(bounded_range(start, entry["compressed"]), -15)
        # Verify before persisting downloaded content.
        verify_member(raw, entry)
        cache.mkdir(parents=True, exist_ok=True)
        packed_path.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    if path.exists():
        with path.open("rb") as handle:
            raw = handle.read(entry["size"] + 1)
    elif packed_path.exists():
        with gzip.open(packed_path, "rb") as handle:
            raw = handle.read(entry["size"] + 1)
    else:
        raise FileNotFoundError(f"Missing packaged source {packed_path}; restore source package or use --fetch")
    verify_member(raw, entry)
    return raw


def verify_member(raw: bytes, entry: dict) -> None:
    if len(raw) != entry["size"] or hashlib.sha256(raw).hexdigest() != entry["sha256"]:
        raise ValueError(f"Wrong pinned source member: {entry['name']}")
    if f"{zlib.crc32(raw):08x}" != entry["crc32"]:
        raise ValueError("ZIP CRC32 mismatch")


def self_test(cache: Path) -> None:
    """Reject same-length source tampering in raw and compressed inputs."""
    entry = MEMBERS[1]
    raw = read_member(cache, entry, False)
    changed = bytes([raw[0] ^ 1]) + raw[1:]
    with tempfile.TemporaryDirectory(prefix="orvia-public-source-test-") as directory:
        scratch = Path(directory)
        name = Path(entry["name"]).name
        for compressed in (False, True):
            path = scratch / (name + ".gz" if compressed else name)
            path.write_bytes(gzip.compress(changed, mtime=0) if compressed else changed)
            try:
                read_member(scratch, entry, False)
            except ValueError as error:
                if not str(error).startswith("Wrong pinned source member:"):
                    raise
            else:
                raise AssertionError("Same-length tampered source accepted")
            path.unlink()
    s, _ = sections(read_member(cache, entry, False))
    pdb_rows = [line for line in read_member(cache, MEMBERS[0], False).decode("ascii").splitlines()
                if line.startswith(("ATOM  ", "HETATM"))]
    identities = coordinate_identity(s, pdb_rows)
    assert identities["matching_prefix_atoms"] == 29544
    assert identities["mismatch_count"] == 5
    selected_residues = [1857, 1858, 1859]
    charge_audit(s, selected_residues)
    # Amber's usual 18.2223 is not the CHAMBER scaling constant.
    try:
        charge_audit(s, selected_residues, factor=Decimal("18.2223"))
    except ValueError as error:
        assert "charge" in str(error)
    else:
        raise AssertionError("Wrong charge-storage convention accepted")
    changed = list(pdb_rows)
    j = int(s["RESIDUE_POINTER"][selected_residues[0]]) - 1
    changed[j] = changed[j][:12] + "BAD " + changed[j][16:]
    assert coordinate_identity(s, changed)["mismatch_count"] == 6
    try:
        require_matching_coordinates(s, changed, [j])
    except ValueError:
        pass
    else:
        raise AssertionError("Cofactor atom-name mismatch accepted")


def sections(raw: bytes) -> tuple[dict[str, list[str]], dict[str, str]]:
    result, formats = {}, {}
    for part in raw.decode("ascii").split("%FLAG ")[1:]:
        lines = part.splitlines()
        name = lines[0].strip()
        formats[name] = lines[1].strip()
        if name == "FORCE_FIELD_TYPE":
            result[name] = [line.strip() for line in lines[2:] if line.strip()]
            continue
        match = re.fullmatch(r"%FORMAT\(\d*[a-zA-Z](\d+)(?:\.\d+)?\)", formats[name])
        if not match:
            raise ValueError(f"Unsupported source format: {name}: {formats[name]}")
        width = int(match[1])
        result[name] = [line[i:i+width].strip() for line in lines[2:] if not line.startswith("%")
                        for i in range(0, len(line), width) if line[i:i+width].strip()]
    return result, formats


def coordinate_identity(s: dict, rows: list[str]) -> dict:
    """Audit positional identity, without guessing an atom mapping or stripping ions."""
    n = int(s["POINTERS"][0])
    mismatches, first_mismatch = [], None
    starts = list(map(int, s["RESIDUE_POINTER"])) + [n + 1]
    for residue_index, label in enumerate(s["RESIDUE_LABEL"]):
        for j in range(starts[residue_index] - 1, starts[residue_index + 1] - 1):
            if j >= len(rows):
                raise ValueError("Coordinate source shorter than topology")
            actual = dict(atom_name=rows[j][12:16].strip(), residue_name=rows[j][17:21].strip())
            expected = dict(atom_name=s["ATOM_NAME"][j], residue_name=label)
            if actual != expected:
                if first_mismatch is None:
                    first_mismatch = j
                mismatches.append(dict(source_atom_index=j, expected_topology=expected,
                                       positional_pdb=actual))
    return dict(index_base=0, compared_atoms=n, coordinate_atoms=len(rows),
                matching_prefix_atoms=n if first_mismatch is None else first_mismatch,
                mismatch_count=len(mismatches), mismatches=mismatches,
                directly_runnable_matching_pair=False,
                interpretation="A matching prefix is component evidence, not a complete coordinate/topology correspondence.")


def require_matching_coordinates(s: dict, rows: list[str], atom_indices: list[int]) -> None:
    mismatches = {item["source_atom_index"] for item in coordinate_identity(s, rows)["mismatches"]}
    if mismatches.intersection(atom_indices):
        raise ValueError("Selected cofactor coordinate/topology identity mismatch")


def charge_audit(s: dict, selected_residues: list[int], factor: Decimal | None = None) -> dict:
    """Decode source charges for an audit only; do not create simulation parameters."""
    with localcontext() as context:
        context.prec = 50
        scaling = Decimal("332.0716").sqrt() if factor is None else factor
        records = []
        expected = {"H2PO": -1, "MG": 2, "ADP": -3}
        for r in selected_residues:
            start, end = int(s["RESIDUE_POINTER"][r]) - 1, int(s["RESIDUE_POINTER"][r + 1]) - 1
            total = sum((Decimal(raw) for raw in s["CHARGE"][start:end]), Decimal(0)) / scaling
            label = s["RESIDUE_LABEL"][r]
            if abs(total - expected[label]) > Decimal("1e-12"):
                raise ValueError(f"Source {label} charge does not match CHAMBER convention")
            records.append(dict(source_residue_index=r, residue_label=label, atom_count=end-start,
                                sum_charge_e=format(total, ".30f"),
                                nearest_integer_charge_e=expected[label],
                                absolute_residual_e=format(abs(total-expected[label]), ".30f")))
        return dict(storage_convention="CHAMBER: raw CHARGE / sqrt(332.0716)",
                    scaling_factor_decimal=format(scaling, ".40f"),
                    primary_implementation_source="https://parmed.github.io/ParmEd/html/_modules/parmed/amber/_chamberparm.html",
                    tolerance_e="1e-12", residues=records,
                    inference_limit="Net charges in this source model; not a pH assignment or transferable cardiac force field.",
                    production_parameters_exported=False)


def audit(cache: Path, fetch: bool) -> dict[str, dict]:
    pdb, topology = [read_member(cache, item, fetch) for item in MEMBERS]
    s, formats = sections(topology)
    pointers = list(map(int, s["POINTERS"]))
    atom_count, type_count, residue_count = pointers[0], pointers[1], pointers[11]
    assert atom_count == len(s["ATOM_NAME"]) == 29549
    assert residue_count == len(s["RESIDUE_LABEL"]) == 1871
    rows = [line for line in pdb.decode("ascii").splitlines() if line.startswith(("ATOM  ", "HETATM"))]
    assert len(rows) == 468219
    # These three contiguous residues are the primed myosin active-site cofactors.
    selected_residue_indices = [1857, 1858, 1859]  # zero based in the source topology
    assert [s["RESIDUE_LABEL"][r] for r in selected_residue_indices] == ["H2PO", "MG", "ADP"]
    atom_indices = []
    residues = []
    for r in selected_residue_indices:
        start = int(s["RESIDUE_POINTER"][r]) - 1
        end = int(s["RESIDUE_POINTER"][r+1]) - 1
        atom_indices.extend(range(start, end))
        residues.append(dict(source_residue_index=r, label=s["RESIDUE_LABEL"][r],
                             source_atom_indices=list(range(start, end))))
    assert len(atom_indices) == 47
    require_matching_coordinates(s, rows, atom_indices)
    identities = coordinate_identity(s, rows)
    charges = charge_audit(s, selected_residue_indices)
    atoms = []
    for j in atom_indices:
        row = rows[j]
        assert row[12:16].strip() == s["ATOM_NAME"][j]
        atoms.append(dict(source_atom_index=j, atom_name=s["ATOM_NAME"][j],
                          residue_name=row[17:21].strip(),
                          source_coordinates_angstrom=[row[k:k+8].strip() for k in [30,38,46]],
                          atomic_number=int(s["ATOMIC_NUMBER"][j]), mass_raw=s["MASS"][j],
                          charge_storage_raw=s["CHARGE"][j],
                          source_type_index=int(s["ATOM_TYPE_INDEX"][j]),
                          source_type_name=s["AMBER_ATOM_TYPE"][j]))
    selected = set(atom_indices)
    term_specs = [
        ("BONDS_INC_HYDROGEN", 3, 3, 0, ["BOND_FORCE_CONSTANT", "BOND_EQUIL_VALUE"]),
        ("BONDS_WITHOUT_HYDROGEN", 3, 3, 0, ["BOND_FORCE_CONSTANT", "BOND_EQUIL_VALUE"]),
        ("ANGLES_INC_HYDROGEN", 4, 3, 0, ["ANGLE_FORCE_CONSTANT", "ANGLE_EQUIL_VALUE"]),
        ("ANGLES_WITHOUT_HYDROGEN", 4, 3, 0, ["ANGLE_FORCE_CONSTANT", "ANGLE_EQUIL_VALUE"]),
        ("DIHEDRALS_INC_HYDROGEN", 5, 3, 0, ["DIHEDRAL_FORCE_CONSTANT", "DIHEDRAL_PERIODICITY", "DIHEDRAL_PHASE", "SCEE_SCALE_FACTOR", "SCNB_SCALE_FACTOR"]),
        ("DIHEDRALS_WITHOUT_HYDROGEN", 5, 3, 0, ["DIHEDRAL_FORCE_CONSTANT", "DIHEDRAL_PERIODICITY", "DIHEDRAL_PHASE", "SCEE_SCALE_FACTOR", "SCNB_SCALE_FACTOR"]),
        ("CHARMM_UREY_BRADLEY", 3, 1, 1, ["CHARMM_UREY_BRADLEY_FORCE_CONSTANT", "CHARMM_UREY_BRADLEY_EQUIL_VALUE"]),
        ("CHARMM_IMPROPERS", 5, 1, 1, ["CHARMM_IMPROPER_FORCE_CONSTANT", "CHARMM_IMPROPER_PHASE"]),
    ]
    terms = {}
    boundary_terms = {}
    for flag, stride, divisor, decrement, parameter_flags in term_specs:
        records = []
        crossing = 0
        values = list(map(int, s[flag]))
        assert len(values) % stride == 0
        for at in range(0, len(values), stride):
            record = values[at:at+stride]
            indices = [abs(x)//divisor-decrement for x in record[:-1]]
            if any(j in selected for j in indices) and not all(j in selected for j in indices):
                crossing += 1
            if all(j in selected for j in indices):
                index = record[-1] - 1
                records.append(dict(source_record=record, source_atom_indices=indices,
                                    parameters_raw={key:s[key][index] for key in parameter_flags}))
        terms[flag] = records
        boundary_terms[flag] = crossing
    types = sorted({a["source_type_index"] for a in atoms})
    lj_pairs = []
    for a in types:
        for b in range(1, type_count+1):
            index = int(s["NONBONDED_PARM_INDEX"][(a-1)*type_count+b-1]) - 1
            if index < 0:
                raise ValueError("Unsupported hydrogen-bond nonbonded table")
            lj_pairs.append(dict(source_types=[a,b], source_parameter_index=index+1,
                                 coefficients_raw={key:s[key][index] for key in [
                                     "LENNARD_JONES_ACOEF", "LENNARD_JONES_BCOEF",
                                     "LENNARD_JONES_14_ACOEF", "LENNARD_JONES_14_BCOEF"]}))
    provenance = dict(article_doi="10.1038/s41586-025-08876-5",
                      dataset_doi="10.6084/m9.figshare.24948180.v1", source_url=URL,
                      source_archive_bytes=1973011747,
                      source_archive_reported_md5="6ba4268bb23317f68f50dc9d6cb49cda",
                      complete_archive_downloaded=False, members=MEMBERS,
                      license="CC BY 4.0", attribution="Klebl, McMillan, Risi et al., Nature 642, 519–526 (2025)")
    reference = dict(schema="orvia.public-cofactor-reference.v1", provenance=provenance,
                     status="REFERENCE_ONLY_NOT_A_PRODUCTION_FORCE_FIELD",
                     notes=["Source is mutant mouse myosin-5 actomyosin, not cardiac myosin.",
                            "Atom/type/parameter indices are source-global; atom indices are zero based.",
                            "Charges are unconverted CHAMBER storage values, not elementary-charge values.",
                            "Raw parameter text requires a format-aware compatible force-field importer.",
                            "This extraction is not a complete interaction graph, exclusion policy, or solvated topology.",
                            "No values have been fitted, rounded, or transferred to ORVIA-001."],
                     residues=residues, atoms=atoms, internal_terms=terms, nonbonded_type_pairs=lj_pairs)
    summary = dict(schema="orvia.public-model-audit.v1", provenance=provenance,
                   source_force_field_label=s["FORCE_FIELD_TYPE"],
                   topology_atoms=atom_count, topology_residues=residue_count,
                   topology_residue_counts=dict(sorted(Counter(s["RESIDUE_LABEL"]).items())),
                   source_pdb_atoms=len(rows),
                   positional_identity_audit=identities,
                   selected_cofactor_charge_audit=charges,
                   selected_cofactor_cross_boundary_bonded_records=boundary_terms,
                   source_pdb_atom_residue_counts=dict(sorted(Counter(row[17:21].strip() for row in rows).items())),
                   selected_cofactor_atoms=len(atoms), selected_cofactor_residues=residues,
                   internal_term_counts={flag:len(records) for flag,records in terms.items()},
                   declared_formats=formats,
                   cmap_flags_present=[name for name in s if "CMAP" in name],
                   decision="Published component evidence supports investigating a separately declared ADP+Pi model; it does not complete ORVIA-001.",
                   limitations=["Analysis topology has 29,549 atoms, while supplied solvated PDB has 468,219; these cannot be used directly as a matching runnable pair.",
                                "The first 29,544 positional atom/residue identities match, but the final five topology Mg atoms overlap PDB acetate atoms; a simple prefix truncation does not repair the pair.",
                                "The 47 extracted cofactor atoms pass positional name/residue checks and source charge sums, not full interaction, coordination, transferability or thermodynamic validation.",
                                "No CMAP flags occur in the inspected exported topology; reconcile this with the declared protein force field before reuse.",
                                "No aficamten, compound17, or cardiac-myosin prepared complex occurs in this selected source.",
                                "Compatible complete protein/cofactor/ligand parameters, solvent and ions, missing residues, hybrid mapping and validation remain necessary.",
                                "A clinical or experimentally validated affinity claim is not implied; matched Kd is not a prerequisite for deploying a research engine."])
    return {"public_model_audit.json": summary, "myosin5_cofactor_reference.json": reference}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE,
                        help="Source directory; defaults to packaged data/source/alternative_models")
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--self-test", action="store_true",
                        help="Reject same-length tampered raw and gzip sources in temporary files")
    args = parser.parse_args()
    outputs = audit(args.cache, args.fetch)
    if args.self_test:
        self_test(args.cache)
    for name, output in outputs.items():
        encoded = json.dumps(output, indent=2, ensure_ascii=False) + "\n"
        path = ROOT/name
        if args.check:
            if path.read_text() != encoded:
                raise ValueError(f"Derived file differs: {name}")
        else:
            path.write_text(encoded)
    print(json.dumps(dict(passed=True, outputs=len(outputs), cofactor_atoms=47,
                          production_ready=False, checked=args.check,
                          self_test="PASS" if args.self_test else "NOT_RUN")))


if __name__ == "__main__":
    main()
