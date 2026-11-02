#!/usr/bin/env python3
"""Audit the pinned ORVIA-001 source structure; does not prepare a simulation.

Standard-library-only, read-only parsing of PDBx/mmCIF source categories.
The output deliberately distinguishes observed crystallographic atom rows from
the atom count of a prepared and solvated molecular system, which is unknown.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path


class CifToken(str):
    def __new__(cls, value, quoted=False):
        instance = str.__new__(cls, value)
        instance.quoted = quoted
        return instance


def tokens(text: str):
    """Tokenize mmCIF, including column-one semicolon text and quoted strings."""
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith(';'):
            parts = [line[1:]]
            i += 1
            while i < len(lines) and not lines[i].startswith(';'):
                parts.append(lines[i])
                i += 1
            if i == len(lines):
                raise ValueError('Unterminated mmCIF text field')
            yield CifToken('\n'.join(parts), True)
        else:
            j = 0
            while j < len(line):
                if line[j].isspace():
                    j += 1
                    continue
                if line[j] == '#':
                    break
                start = j
                if line[j] in "\"'":
                    quote = line[j]
                    j += 1
                    start = j
                    while j < len(line):
                        if line[j] == quote and (j + 1 == len(line) or line[j+1].isspace()):
                            break
                        j += 1
                    if j == len(line):
                        raise ValueError('Unterminated mmCIF quoted value')
                    yield CifToken(line[start:j], True)
                    j += 1
                else:
                    while j < len(line) and not line[j].isspace():
                        j += 1
                    yield CifToken(line[start:j])
        i += 1


def parse_cif(path: Path):
    ts = list(tokens(path.read_text()))
    categories: dict[str, list[dict[str, str]]] = {}
    singles: dict[str, dict[str, str]] = {}
    i = 0
    while i < len(ts):
        token = ts[i]
        if token == 'loop_' and not token.quoted:
            i += 1
            keys = []
            while i < len(ts) and ts[i].startswith('_') and not ts[i].quoted:
                keys.append(ts[i])
                i += 1
            if not keys:
                raise ValueError('Empty mmCIF loop')
            category = keys[0].split('.')[0]
            if any(k.split('.')[0] != category for k in keys):
                raise ValueError('Mixed-category loop')
            values = []
            while i < len(ts) and (ts[i].quoted or (ts[i] not in ('loop_', 'stop_') and not ts[i].startswith(('_', 'data_', 'save_')))):
                values.append(ts[i])
                i += 1
            if len(values) % len(keys):
                raise ValueError(f'Incomplete {category} loop: {len(values)} values / {len(keys)} columns')
            names = [k.split('.', 1)[1] for k in keys]
            categories[category] = [dict(zip(names, values[j:j+len(keys)])) for j in range(0, len(values), len(keys))]
        elif token.startswith('_') and not token.quoted:
            category, key = token.split('.', 1)
            if i + 1 >= len(ts):
                raise ValueError('Missing scalar value')
            singles.setdefault(category, {})[key] = ts[i+1]
            i += 2
        else:
            i += 1
    for category, row in singles.items():
        if category in categories:
            raise ValueError(f'Duplicate scalar/loop category {category}')
        categories[category] = [row]
    return categories


def counts(rows, key):
    return dict(sorted(Counter(r[key] for r in rows).items()))


def atom_summary(rows, polymer_ids):
    polymer = [r for r in rows if r['label_entity_id'] in polymer_ids]
    nonpolymer = [r for r in rows if r['label_entity_id'] not in polymer_ids]
    residues = {(r['label_asym_id'], r['label_seq_id']) for r in polymer}
    instances = {(r['label_asym_id'], r['label_comp_id'], r['auth_seq_id']) for r in nonpolymer}
    return {
        'observed_atom_rows_including_altlocs': len(rows),
        'polymer_atom_rows': len(polymer),
        'observed_polymer_residues': len(residues),
        'hydrogen_atom_rows': sum(r['type_symbol'] in ('H', 'D') for r in rows),
        'element_counts': counts(rows, 'type_symbol'),
        'nonpolymer_instances_by_component': dict(sorted(Counter(x[1] for x in instances).items())),
        'altloc_atom_rows': sum(r['label_alt_id'] not in ('.', '?') for r in rows),
        'atom_rows_with_zero_occupancy': sum(float(r['occupancy']) == 0 for r in rows),
        'atom_rows_with_fractional_occupancy': sum(0 < float(r['occupancy']) < 1 for r in rows),
    }


def build_audit(root: Path):
    source = root / 'data/source/9F6C.cif'
    cif = parse_cif(source)
    atoms = cif['_atom_site']
    entities = cif['_entity']
    polymer_ids = {r['id'] for r in entities if r['type'] == 'polymer'}
    unobserved = cif.get('_pdbx_unobs_or_zero_occ_residues', [])
    missing_atoms = cif.get('_pdbx_unobs_or_zero_occ_atoms', [])
    chain_ids = sorted({r['label_asym_id'] for r in atoms if r['label_entity_id'] in polymer_ids})
    assemblies = []
    assembly_details = {r['id']: r for r in cif['_pdbx_struct_assembly']}
    for row in cif['_pdbx_struct_assembly_gen']:
        # For this pinned structure only identity operations are present. Do not
        # accidentally count asymmetric-unit atoms as a transformed assembly.
        if row['oper_expression'] != '1':
            raise ValueError('This audit needs extension for non-identity assembly operators')
        asym_ids = row['asym_id_list'].split(',')
        selected = [r for r in atoms if r['label_asym_id'] in asym_ids]
        assemblies.append({**row, 'description': assembly_details[row['assembly_id']], **atom_summary(selected, polymer_ids)})
    file_records = []
    urls = {
        '9F6C.cif': 'https://files.rcsb.org/download/9F6C.cif',
        '9F6C.pdb': 'https://files.rcsb.org/download/9F6C.pdb',
        '6I6.cif': 'https://files.rcsb.org/ligands/download/6I6.cif',
    }
    for filename, url in urls.items():
        path = root / 'data/source' / filename
        if path.exists():
            raw = path.read_bytes()
            file_records.append({'path': str(path.relative_to(root)), 'source_url': url, 'size_bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    ligand = {}
    ligand_path = root / 'data/source/6I6.cif'
    if ligand_path.exists():
        ligand_cif = parse_cif(ligand_path)
        ligand = {'chemical_component': ligand_cif.get('_chem_comp', []), 'descriptors': ligand_cif.get('_pdbx_chem_comp_descriptor', [])}
    cross_format = {'status': 'NOT_CHECKED'}
    pdb_path = root / 'data/source/9F6C.pdb'
    if pdb_path.exists():
        pdb_atoms = [line for line in pdb_path.read_text().splitlines() if line.startswith(('ATOM  ', 'HETATM'))]
        pdb_alts = sum(line[16] != ' ' for line in pdb_atoms)
        cif_alts = sum(row['label_alt_id'] not in ('.', '?') for row in atoms)
        if len(pdb_atoms) != len(atoms) or pdb_alts != cif_alts:
            raise ValueError('PDB/mmCIF atom or alternate-location record counts disagree')
        cross_format = {'status': 'PASS', 'pdb_atom_records': len(pdb_atoms), 'pdb_altloc_atom_records': pdb_alts, 'checks': ['total_atom_records', 'alternate_location_atom_records']}
    return {
        'schema_version': 1,
        'experiment_id': 'ORVIA-001',
        'status': 'SOURCE_AUDIT_ONLY_NOT_SIMULATION_READY',
        'retrieval_date': '2026-11-01',
        'source_files': file_records,
        'cross_format_validation': cross_format,
        'entry_id': cif['_entry'][0]['id'],
        'source_revisions': cif.get('_pdbx_audit_revision_history', []),
        'source_revision_details': cif.get('_pdbx_audit_revision_details', []),
        'experimental_method': cif.get('_exptl', []),
        'resolution_angstrom': cif.get('_refine', [{}])[0].get('ls_d_res_high'),
        'organism_and_construct': {'entity': entities, 'entity_src_gen': cif.get('_entity_src_gen', []), 'entity_src_nat': cif.get('_entity_src_nat', []), 'struct_ref': cif.get('_struct_ref', [])},
        'polymer_sequence_lengths': {r['entity_id']: len(''.join(r['pdbx_seq_one_letter_code_can'].split())) for r in cif['_entity_poly']},
        'crystal_asymmetric_unit': atom_summary(atoms, polymer_ids),
        'models': counts(atoms, 'pdbx_PDB_model_num'),
        'polymer_chains': {chain: {**atom_summary([r for r in atoms if r['label_asym_id'] == chain], polymer_ids), 'unobserved_residue_records': [r for r in unobserved if r['label_asym_id'] == chain], 'unobserved_atom_records_count': sum(r['label_asym_id'] == chain for r in missing_atoms)} for chain in chain_ids},
        'author_defined_biological_assemblies': assemblies,
        'modified_residue_records': cif.get('_pdbx_struct_mod_residue', []),
        'unobserved_residue_records_count': len(unobserved),
        'unobserved_atom_records_count': len(missing_atoms),
        'aficamten_ccd_record': ligand,
        'candidate_transformation': {
            'from': 'compound 17 in Chuang et al. 2021 Table 5',
            'to': 'aficamten',
            'substituent_change': 'oxadiazole 5-position methyl to ethyl',
            'indane_stereochemistry': 'R',
            'source_doi': '10.1021/acs.jmedchem.1c01290',
            'published_cardiac_myofibril_ic50_micromolar': {'compound_17': 4.4, 'aficamten': 1.4},
            'measurement_type': 'functional cardiac-myofibril ATPase inhibition; not direct binding Kd/Ki',
            'compound_17_bound_pose_verified': False,
            'compound_17_machine_readable_identity_verified': False,
            'experimental_binding_ddg_available_in_this_package': False,
        },
        'preparation': {
            'selected_biological_assembly': None,
            'prepared_atom_count': None,
            'solvent_box': None,
            'force_field_versions': None,
            'protonation_assignment': None,
            'validated_magnesium_adp_vanadate_parameters': None,
            'state_specific_binding_affinity_benchmark': None,
        },
        'blockers': [
            'Select one biological assembly and review missing residues, missing atoms, altlocs, modified lysines and crystallographic waters.',
            'Resolve bovine construct versus human MYH7 interpretation; do not relabel bovine input as human.',
            'Freeze nucleotide/cofactor state and validate Mg-ADP-vanadate parameters; vanadate is not inorganic phosphate.',
            'Verify complete compound-17 identity, stereochemistry, protonation, atom mapping and common binding-mode assumption.',
            'Choose and pin complete force fields and validated special-residue/cofactor parameters.',
            'Prepare and validate both fully solvated systems, alchemical topology and charge treatment.',
            'Register justified sampling lengths, lambda schedule, independent seeds, diagnostics, stopping and extension criteria.',
            'Obtain matched affinity data or a separately validated mechanistic model before claiming biological free-energy accuracy.',
        ],
        'notes': [
            'Raw crystallographic atom counts are not prepared-solvated simulation atom counts.',
            'The asymmetric unit contains two copies of the motor domain; the author-defined assemblies are separate monomers.',
            'This audit computes file provenance and structure summaries only, not molecular simulation or binding free energies.',
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--check', action='store_true', help='Check reproducibility against the committed audit without writing')
    args = parser.parse_args()
    result = build_audit(args.root)
    output = args.root / 'data/inputs_audit.json'
    encoded = json.dumps(result, indent=2, sort_keys=True) + '\n'
    if args.check:
        if output.read_text() != encoded:
            raise SystemExit('FAIL: audit differs; inspect source hashes or parser changes')
        print('PASS: source hashes and structural audit reproduce exactly')
    else:
        output.write_text(encoded)
        print(f'Wrote {output}')
    print(json.dumps({'source_atom_rows': result['crystal_asymmetric_unit']['observed_atom_rows_including_altlocs'], 'assembly_atom_rows': {r['assembly_id']: r['observed_atom_rows_including_altlocs'] for r in result['author_defined_biological_assemblies']}, 'prepared_atom_count': None, 'status': result['status']}))


if __name__ == '__main__':
    main()
