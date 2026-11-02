#!/usr/bin/env python3
"""Offline source-integrity audit with optional, version-pinned chemical checks.

Default mode uses only the standard library. --chemistry requires RDKit and
reproduces the graph checks; --chemistry-if-available explicitly reports a skip
when RDKit is absent. Neither mode downloads publisher supplements or authorizes
a scientific run. The historical PDF visual review is not re-performed here.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys

from audit_structure import parse_cif


RDKIT_VERSION = "2026.09.1"
PINNED_LOCAL = {
    "data/source/compound17_pair_rows.json": (
        717, "c34d542efb07a4fb7d9e6eccbe808146a8f3e1c064c2db1ef563e04f70d5dd99"
    ),
    "data/source/compound17_publisher_metadata.json": (
        1658, "f8b990ed9d71916ae12bbbcaa1ccd7fa28116af6e1f29a01f6aa6ca522716c99"
    ),
    "data/source/6I6.cif": (
        9686, "2fbc550eabade8660ade0c020cd4761cd8e7135c23fae61f819ece1ab808757f"
    ),
}
PINNED_ORIGINAL_HASHES = {
    "10.1021/acs.jmedchem.1c01290.s001":
        "9218df309e2ae3469dd521ddbfdedf7d9515f379e03b777e8da97e4f961c08bb",
    "10.1021/acs.jmedchem.1c01290.s003":
        "29406eb5e3bed02dbe0867228b6a7e1f76c42227ac54e239cd8536a7f8adb782",
}


class AuditFailure(Exception):
    """An input, provenance, dependency or chemical assertion failed."""


def require(condition: bool, message: str) -> None:
    # Deliberately avoid assert: checks must remain enabled under python -O.
    if not condition:
        raise AuditFailure(message)


def indexed(records: list[dict], key: str) -> dict:
    result = {r[key]: r for r in records}
    require(len(result) == len(records), f"Duplicate records for {key}")
    return result


def check_integrity(root: Path) -> tuple[dict, dict, list[dict]]:
    for relative, (size, digest) in PINNED_LOCAL.items():
        payload = (root / relative).read_bytes()
        require(len(payload) == size, f"Byte count mismatch: {relative}")
        require(hashlib.sha256(payload).hexdigest() == digest,
                f"SHA-256 mismatch: {relative}")

    audit = json.loads((root / "data/pair_identity_audit.json").read_text())
    extract = json.loads((root / "data/source/compound17_pair_rows.json").read_text())
    metadata = json.loads((root / "data/source/compound17_publisher_metadata.json").read_text())
    require(audit["schema_version"] == "orvia.pair-identity.v0.2", "Unexpected audit schema")
    require(audit["experiment_id"] == "ORVIA-001", "Unexpected experiment")
    require(audit["status"] == "PUBLISHED_PAIR_IDENTITY_RESOLVED_SCIENTIFIC_RUN_BLOCKED",
            "Pair identity audit must not clear the scientific run")
    require(audit["unresolved"]["scientific_run_authorized_by_this_audit"] is False,
            "Pair identity audit cannot authorize a scientific run")
    require(all(value is None for key, value in audit["unresolved"].items()
                if key != "scientific_run_authorized_by_this_audit"),
            "This historical identity audit must preserve its unresolved model inputs")

    local_records = indexed(audit["local_factual_records"], "path")
    expected_local = set(PINNED_LOCAL) - {"data/source/6I6.cif"}
    require(set(local_records) == expected_local, "Unexpected local factual-record set")
    for path, record in local_records.items():
        require((record["bytes"], record["sha256"]) == PINNED_LOCAL[path],
                f"Audit manifest differs from pinned factual record: {path}")

    originals = indexed(audit["primary_sources"], "doi")
    meta_by_doi = indexed(metadata, "doi")
    require(set(originals) == set(meta_by_doi) == set(PINNED_ORIGINAL_HASHES),
            "Unexpected publisher source set")
    for doi, record in originals.items():
        meta = meta_by_doi[doi]
        require(record["sha256"] == PINNED_ORIGINAL_HASHES[doi],
                f"Original source hash record changed: {doi}")
        require(len(meta["files"]) == 1, f"Unexpected publisher file count: {doi}")
        file = meta["files"][0]
        require(record["license"] == meta["license"], f"License metadata mismatch: {doi}")
        require(meta["license"]["name"] == "CC BY-NC 4.0", f"Unexpected license: {doi}")
        for audit_key, metadata_key in (
            ("figshare_article_id", "article_id"), ("figshare_version", "version"),
            ("resource_doi", "resource_doi"), ("metadata_url", "url"),
            ("published_date", "published_date"), ("modified_date", "modified_date"),
        ):
            require(record[audit_key] == meta[metadata_key],
                    f"Publisher metadata mismatch: {doi}, {audit_key}")
        for audit_key, file_key in (
            ("original_filename", "name"), ("bytes", "size"),
            ("publisher_md5", "computed_md5"), ("figshare_file_id", "id"),
            ("download_url", "download_url"),
        ):
            require(record[audit_key] == file[file_key],
                    f"Publisher file metadata mismatch: {doi}, {audit_key}")

    rows = indexed(extract["rows"], "Compound number / name")
    require(set(rows) == set(audit["compounds"]) == {"17", "Aficamten"},
            "Exactly the two audited candidate rows are required")
    csv_doi = "10.1021/acs.jmedchem.1c01290.s003"
    require(extract["source_doi"] == csv_doi, "Wrong source for factual extract")
    require(extract["source_sha256"] == PINNED_ORIGINAL_HASHES[csv_doi],
            "Factual extract points to an unpinned original")
    for name, row in rows.items():
        require(row == audit["compounds"][name]["source_csv_row"],
                f"Published row differs from identity audit: {name}")
    assay = audit["assay_provenance_discrepancy"]
    require(assay["chosen_calibration_value"] is None, "No affinity calibration was selected")
    require(assay["author_CSV"] == {"17": 4.2, "aficamten": 1.3, "source_doi": csv_doi},
            "Author CSV assay provenance changed")
    require(assay["main_article_Table5"] == {
        "17": 4.4, "aficamten": 1.4, "source_doi": "10.1021/acs.jmedchem.1c01290"
    }, "Article assay provenance changed")
    require(float(rows["17"]["CDMF IC50 (uM)"]) == assay["author_CSV"]["17"] and
            float(rows["Aficamten"]["CDMF IC50 (uM)"]) == assay["author_CSV"]["aficamten"],
            "Assay extract is inconsistent with its provenance record")

    # Parse the pinned CCD bytes themselves, not only a derived JSON descriptor.
    ccd = parse_cif(root / "data/source/6I6.cif")
    require(ccd["_chem_comp"][0]["id"] == "6I6", "Wrong CCD component")
    descriptors = ccd["_pdbx_chem_comp_descriptor"]
    return audit, rows, descriptors


def check_chemistry(audit: dict, rows: dict, ccd_descriptors: list[dict], *, optional: bool) -> dict:
    try:
        from rdkit import Chem, rdBase
        from rdkit.Chem import rdMolDescriptors
    except ImportError as error:
        if optional and isinstance(error, ModuleNotFoundError) and error.name == "rdkit":
            return {"status": "SKIPPED", "reason": "RDKit not installed; graph checks did not run"}
        raise AuditFailure(
            "Chemistry requires the pinned research dependencies: "
            "python3 -m pip install -r requirements-research.txt"
        ) from error

    require(rdBase.rdkitVersion == RDKIT_VERSION == audit["verification"]["version"],
            f"RDKit version mismatch: found {rdBase.rdkitVersion}, require {RDKIT_VERSION}")
    molecules = {}
    for name, row in rows.items():
        molecule = Chem.MolFromSmiles(row["SMILES"])
        require(molecule is not None, f"Cannot parse source SMILES: {name}")
        actual = {
            "canonical_isomeric_smiles": Chem.MolToSmiles(molecule),
            "formula": rdMolDescriptors.CalcMolFormula(molecule),
            "standard_inchi": Chem.MolToInchi(molecule),
            "standard_inchikey": Chem.MolToInchiKey(molecule),
            "formal_charge_of_published_graph": Chem.GetFormalCharge(molecule),
            "heavy_atom_count": molecule.GetNumHeavyAtoms(),
            "stereocenters": [
                {"source_smiles_atom_index_zero_based": i, "cip": cip}
                for i, cip in Chem.FindMolChiralCenters(molecule)
            ],
        }
        require(actual == audit["compounds"][name]["derived_descriptors"],
                f"Computed descriptors differ from recorded audit: {name}")
        require([r["cip"] for r in actual["stereocenters"]] == ["R"],
                f"Expected exactly one specified R stereocenter: {name}")
        require(actual["formal_charge_of_published_graph"] == 0,
                f"Expected neutral published graph: {name}")
        molecules[name] = molecule

    a, b = molecules["17"], molecules["Aficamten"]
    source_smiles = [r["descriptor"] for r in ccd_descriptors if r["type"] == "SMILES_CANONICAL"]
    require(len(source_smiles) == 2, "Expected both pinned CCD canonical SMILES descriptors")
    for descriptor in source_smiles:
        ccd_molecule = Chem.MolFromSmiles(descriptor)
        require(ccd_molecule is not None, "Cannot parse CCD SMILES")
        require(Chem.MolToSmiles(ccd_molecule) == Chem.MolToSmiles(b),
                "Author aficamten graph differs from CCD 6I6")
        require(Chem.MolToInchiKey(ccd_molecule) == Chem.MolToInchiKey(b),
                "Author aficamten InChIKey differs from CCD 6I6")

    edit = audit["verification"]["B_to_A_graph_check"]
    require(edit["source_B_smiles_removed_atom_index_zero_based"] == 0 and
            edit["source_B_smiles_retained_adjacent_atom_index_zero_based"] == 1,
            "Recorded graph-edit indices changed")
    edited = Chem.RWMol(b)
    terminal = edited.GetAtomWithIdx(0)
    require(terminal.GetSymbol() == "C" and terminal.GetDegree() == 1 and
            terminal.GetTotalNumHs() == 3, "Graph-edit atom is not terminal methyl carbon")
    adjacent = terminal.GetNeighbors()[0]
    require(adjacent.GetIdx() == 1 and adjacent.GetSymbol() == "C" and
            adjacent.GetTotalNumHs() == 2, "Expected ethyl methylene neighbour")
    edited.RemoveAtom(0)
    product = edited.GetMol()
    Chem.SanitizeMol(product)
    require(Chem.MolToSmiles(product) == Chem.MolToSmiles(a),
            "Removing terminal ethyl carbon did not reproduce compound17")

    elements_a = Counter(atom.GetSymbol() for atom in Chem.AddHs(a).GetAtoms())
    elements_b = Counter(atom.GetSymbol() for atom in Chem.AddHs(b).GetAtoms())
    delta = {element: elements_b[element] - elements_a[element]
             for element in set(elements_a) | set(elements_b)
             if elements_b[element] != elements_a[element]}
    require(delta == {"C": 1, "H": 2}, "Elemental transformation is not +CH2")
    require(b.GetNumHeavyAtoms() - a.GetNumHeavyAtoms() == 1, "Heavy-atom delta is not +1")
    require(Chem.GetFormalCharge(b) - Chem.GetFormalCharge(a) == 0, "Formal-charge delta changed")
    for key in ("aficamten_author_csv_equals_6I6_canonical_isomeric_graph",
                "aficamten_author_csv_equals_6I6_inchikey", "both_compounds_have_one_R_stereocenter",
                "neutral_published_graphs"):
        require(audit["verification"][key] is True, f"Recorded graph assertion changed: {key}")
    require(edit["exact_graph_identity_after_edit"] is True, "Recorded graph identity changed")
    require(audit["verification"]["A_to_B_formula_delta"] == "C1H2" and
            audit["verification"]["A_to_B_heavy_atom_delta"] == 1 and
            audit["verification"]["A_to_B_formal_charge_delta_of_published_graph"] == 0,
            "Recorded transformation deltas changed")
    return {"status": "PASS", "tool": "RDKit", "version": rdBase.rdkitVersion,
            "compounds_checked": 2, "ccd_smiles_checked": len(source_smiles),
            "graph_edit": "compound17 + CH2 = aficamten; R stereochemistry retained"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--chemistry", action="store_true", help="Require the pinned RDKit and check graphs")
    mode.add_argument("--chemistry-if-available", action="store_true", help="Check graphs if RDKit is installed; otherwise explicitly SKIP")
    parser.add_argument("--json", action="store_true", help="Emit a machine-readable audit result")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1],
                        help="Project root; defaults to the script's parent project")
    args = parser.parse_args()
    try:
        audit, rows, descriptors = check_integrity(args.root.resolve())
        chemistry = {"status": "NOT_REQUESTED", "reason": "Use --chemistry to reproduce graph checks"}
        if args.chemistry or args.chemistry_if_available:
            chemistry = check_chemistry(audit, rows, descriptors, optional=args.chemistry_if_available)
        result = {"integrity": "PASS", "pinned_local_files_checked": len(PINNED_LOCAL),
                  "published_rows_checked": len(rows), "original_publisher_bytes_downloaded": False,
                  "chemistry": chemistry, "scientific_run_ready": False,
                  "scope": "Development input audit; historical PDF visual review is not repeated"}
        if args.json:
            print(json.dumps(result, indent=2, sort_keys=True))
        else:
            print("PASS: pinned local source hashes, two published rows and provenance agree")
            print(f"CHEMISTRY {chemistry['status']}: " +
                  (f"RDKit {chemistry['version']}; graph, stereochemistry and CCD checks reproduce"
                   if chemistry["status"] == "PASS" else chemistry["reason"]))
            print("SCIENTIFIC RUN: BLOCKED; this identity audit does not resolve model inputs")
        return 0
    except (AuditFailure, OSError, ValueError, KeyError, TypeError, IndexError) as error:
        if args.json:
            print(json.dumps({"status": "FAIL", "error": str(error)}, sort_keys=True))
        else:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
