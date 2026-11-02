#!/usr/bin/env python3
"""Reproduce a candidate receptor selection from pinned 9F6C coordinates.

No atoms are invented, protonated, minimized, parameterized or solvated. The
selected row IDs describe an incomplete coordinate candidate, not an MD system.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from decimal import Decimal
import hashlib
import json
import math
from pathlib import Path
import statistics

from audit_structure import parse_cif

SOURCE_SHA256 = '9b7f16917441dbb4afe4bca3b3ee2866878ecc97f566fba738f33490572de3aa'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def residue_key(atom):
    return (atom['label_asym_id'], atom['auth_seq_id'], atom['pdbx_PDB_ins_code'],
            atom['label_comp_id'], atom['label_seq_id'])


def coordinate(atom):
    return tuple(float(atom[key]) for key in ('Cartn_x', 'Cartn_y', 'Cartn_z'))


def distance_squared(a, b):
    return sum((x - y) ** 2 for x, y in zip(coordinate(a), coordinate(b)))


def minimum_distance(rows, ligand):
    require(bool(rows) and bool(ligand), 'Cannot compute a distance to an empty selection')
    return math.sqrt(min(distance_squared(a, b) for a in rows for b in ligand))


def atom_identity(row):
    return {key: row[key] for key in ('id', 'label_asym_id', 'auth_asym_id',
                                    'auth_seq_id', 'label_comp_id', 'label_atom_id', 'label_alt_id')}


def select_conformers(rows):
    """Choose an entire residue conformer; never mix A/B atom-wise."""
    grouped = defaultdict(list)
    for row in rows:
        grouped[residue_key(row)].append(row)
    retained, choices, zero_rows = [], [], []
    for key, group in grouped.items():
        alternatives = defaultdict(list)
        common = []
        for row in group:
            if row['label_alt_id'] in ('.', '?'):
                common.append(row)
            else:
                alternatives[row['label_alt_id']].append(row)
        keep = list(common)
        if alternatives:
            name_sets = {label: {row['label_atom_id'] for row in atoms}
                         for label, atoms in alternatives.items()}
            require(len({tuple(sorted(names)) for names in name_sets.values()}) == 1,
                    f'Unequal alternative atom sets require manual review: {key}')
            require(not ({row['label_atom_id'] for row in common} & next(iter(name_sets.values()))),
                    f'Common and alternative atoms overlap: {key}')
            occupancy = {label: sum(Decimal(row['occupancy']) for row in atoms) / len(atoms)
                         for label, atoms in alternatives.items()}
            ranked = sorted(alternatives, key=lambda label: (-occupancy[label], label))
            chosen = ranked[0]
            keep.extend(alternatives[chosen])
            choices.append({
                'label_asym_id': key[0], 'auth_seq_id': int(key[1]), 'component': key[3],
                'chosen_altloc': chosen,
                'occupancy_tie': len([x for x in occupancy.values() if x == occupancy[chosen]]) > 1,
                'alternatives': {label: {
                    'atom_rows': len(atoms), 'mean_occupancy': str(occupancy[label]),
                    'mean_B_angstrom_squared': round(statistics.mean(float(row['B_iso_or_equiv']) for row in atoms), 4)
                } for label, atoms in sorted(alternatives.items())},
                'choice_basis': 'Highest mean occupancy across the complete residue conformer; equal occupancy breaks by lexicographic altloc label. A tie is not evidence that the chosen conformer is more physical.'
            })
        for row in keep:
            occupancy = Decimal(row['occupancy'])
            require(Decimal(0) <= occupancy <= Decimal(1), 'Out-of-range source occupancy')
            if occupancy == 0:
                zero_rows.append(atom_identity(row))
            elif row['type_symbol'] not in ('H', 'D'):
                retained.append(row)
    retained.sort(key=lambda row: int(row['id']))
    return retained, sorted(choices, key=lambda item: item['auth_seq_id']), zero_rows


def consecutive_ranges(values):
    groups = []
    for value in sorted(values):
        if groups and value == groups[-1][-1] + 1:
            groups[-1].append(value)
        else:
            groups.append([value])
    return groups


def summarize_assembly(cif, row):
    require(row['oper_expression'] == '1', 'Nonidentity assembly operations need explicit transformation support')
    asym_ids = row['asym_id_list'].split(',')
    atoms = [atom for atom in cif['_atom_site'] if atom['label_asym_id'] in asym_ids]
    require({atom['pdbx_PDB_model_num'] for atom in atoms} == {'1'}, 'Unexpected structural models')
    polymer_ids = {entity['id'] for entity in cif['_entity'] if entity['type'] == 'polymer'}
    chains = sorted({atom['label_asym_id'] for atom in atoms if atom['label_entity_id'] in polymer_ids})
    require(len(chains) == 1, 'Expected a single polymer chain per deposited assembly')
    chain = chains[0]
    selected, alternates, zero_rows = select_conformers(atoms)
    polymer = [atom for atom in selected if atom['label_asym_id'] == chain]
    ligand = [atom for atom in selected if atom['label_comp_id'] == '6I6']
    require(len(ligand) == 25 and len({atom['label_asym_id'] for atom in ligand}) == 1,
            'Expected one complete 25-heavy-atom aficamten record')
    require(all(atom['occupancy'] == '1.00' for atom in ligand), 'Ligand occupancy requires review')
    residues = defaultdict(list)
    for atom in polymer:
        residues[(int(atom['auth_seq_id']), atom['label_comp_id'])].append(atom)
    contacts = []
    for (number, component), group in sorted(residues.items()):
        distance = minimum_distance(group, ligand)
        if distance <= 6.0:
            contacts.append({'auth_seq_id': number, 'component': component,
                             'minimum_heavy_atom_distance_angstrom': round(distance, 6),
                             'within_4_5_angstrom': distance <= 4.5})
    missing = [int(record['auth_seq_id']) for record in cif['_pdbx_unobs_or_zero_occ_residues']
               if record['label_asym_id'] == chain]
    gaps = []
    for gap in consecutive_ranges(missing):
        anchors = []
        for number in (gap[0] - 1, gap[-1] + 1):
            anchor = [atom for atom in polymer if int(atom['auth_seq_id']) == number and atom['label_atom_id'] == 'CA']
            if anchor:
                require(len(anchor) == 1, 'Alternative C-alpha was not resolved consistently')
                anchors.append({'auth_seq_id': number,
                                'CA_to_ligand_minimum_distance_angstrom': round(minimum_distance(anchor, ligand), 6)})
        gaps.append({'first_auth_seq_id': gap[0], 'last_auth_seq_id': gap[-1], 'residue_count': len(gap),
                     'observed_flanking_CA_anchors': anchors,
                     'missing_residue_coordinates_available': False})
    nonpolymer = defaultdict(list)
    for atom in selected:
        if atom['label_entity_id'] not in polymer_ids:
            nonpolymer[(atom['label_asym_id'], atom['auth_seq_id'], atom['label_comp_id'])].append(atom)
    components = []
    waters = []
    for (asym_id, residue, component), group in sorted(nonpolymer.items()):
        distance = minimum_distance(group, ligand)
        if component == 'HOH':
            if distance <= 4.5:
                waters.append({'label_asym_id': asym_id, 'auth_seq_id': int(residue),
                               'minimum_distance_angstrom': round(distance, 6)})
        else:
            components.append({'label_asym_id': asym_id, 'auth_seq_id': int(residue), 'component': component,
                               'heavy_atom_rows': len(group), 'minimum_distance_to_aficamten_angstrom': round(distance, 6)})
    for alternate in alternates:
        group = [atom for atom in polymer if int(atom['auth_seq_id']) == alternate['auth_seq_id']]
        alternate['chosen_conformer_minimum_distance_to_aficamten_angstrom'] = round(minimum_distance(group, ligand), 6)
    modified = []
    for (number, component), group in residues.items():
        if component == 'M3L':
            modified.append({'auth_seq_id': number, 'component': component,
                             'minimum_distance_to_aficamten_angstrom': round(minimum_distance(group, ligand), 6)})
    observed = len(residues)
    require(observed + len(missing) == 782, 'Observed plus missing residues do not reconcile')
    record = {
        'assembly_id': row['assembly_id'], 'polymer_label_asym_id': chain,
        'source_label_asym_ids': asym_ids, 'operator_expression': row['oper_expression'],
        'source_atom_rows': len(atoms), 'selected_positive_occupancy_heavy_atom_rows': len(selected),
        'observed_polymer_residues': observed, 'unobserved_residues': len(missing),
        'selected_crystallographic_waters': sum(component == 'HOH' for _, _, component in nonpolymer),
        'ligand_heavy_atom_rows': len(ligand),
        'ligand_mean_B_angstrom_squared': round(statistics.mean(float(atom['B_iso_or_equiv']) for atom in ligand), 4),
        'contacts_within_6_angstrom': contacts,
        'contact_residues_within_4_5_angstrom': sum(contact['within_4_5_angstrom'] for contact in contacts),
        'contact_residues_within_6_angstrom': len(contacts),
        'crystallographic_waters_within_4_5_angstrom': waters,
        'altloc_choices': alternates, 'zero_occupancy_atoms_excluded_from_candidate_mask': zero_rows,
        'missing_residue_ranges': gaps, 'retained_nonwater_nonpolymer_components': components,
        'retained_modified_residues': sorted(modified, key=lambda item: item['auth_seq_id']),
    }
    return record, selected


def build_decisions(root):
    source = root / 'data/source/9F6C.cif'
    source_bytes = source.read_bytes()
    require(hashlib.sha256(source_bytes).hexdigest() == SOURCE_SHA256, 'Pinned 9F6C source hash changed')
    cif = parse_cif(source)
    summaries, masks = [], {}
    for assembly in cif['_pdbx_struct_assembly_gen']:
        summary, selected = summarize_assembly(cif, assembly)
        summaries.append(summary)
        masks[assembly['assembly_id']] = selected
    require(len(summaries) == 2, 'Expected the two deposited monomer assemblies')
    ranked = sorted(summaries, key=lambda item: (-item['observed_polymer_residues'], item['unobserved_residues'], item['assembly_id']))
    candidate = ranked[0]
    require(candidate['assembly_id'] == '1', 'Candidate criterion no longer selects the audited assembly')
    contact_maps = [{(r['auth_seq_id'], r['component']): r['minimum_heavy_atom_distance_angstrom']
                     for r in assembly['contacts_within_6_angstrom']} for assembly in summaries]
    common = sorted(set(contact_maps[0]) & set(contact_maps[1]))
    differences = [contact_maps[0][key] - contact_maps[1][key] for key in common]
    ids = [int(atom['id']) for atom in masks[candidate['assembly_id']]]
    require(len(ids) == len(set(ids)), 'Duplicate selected source atom IDs')
    return {
        'schema_version': 'orvia.preparation-candidate.v0.3', 'experiment_id': 'ORVIA-001',
        'as_of_date': '2026-11-01', 'status': 'CANDIDATE_RECEPTOR_SELECTION_NOT_SIMULATION_READY',
        'source': {'path': 'data/source/9F6C.cif', 'sha256': SOURCE_SHA256, 'bytes': len(source_bytes),
                   'url': 'https://files.rcsb.org/download/9F6C.cif', 'coordinate_unit': 'angstrom',
                   'source_type': 'Deposited experimental model; external scientific input'},
        'analysis_scope': 'Local source-coordinate audit and explicit engineering candidate selection; no production molecular simulation or energy calculation.',
        'assembly_comparison': summaries,
        'pocket_comparison': {
            'definition': 'Protein residues having at least one retained positive-occupancy heavy atom within 6.0 angstrom of a ligand heavy atom; distance is Euclidean in the deposited biological assembly, without crystal symmetry mates.',
            'common_contact_residue_count': len(common),
            'same_residue_and_component_set_within_6_angstrom': set(contact_maps[0]) == set(contact_maps[1]),
            'RMS_difference_of_common_residue_minimum_distances_angstrom': round(math.sqrt(statistics.mean(x * x for x in differences)), 6),
            'maximum_absolute_difference_of_common_residue_minimum_distances_angstrom': round(max(abs(x) for x in differences), 6),
            'not_an_alignment_RMSD': True,
            'inference_limit': 'Agreement of these static contact-distance sets does not prove binding-pose equivalence, identical conformational ensembles, or converged affinity predictions.'
        },
        'candidate_decision': {
            'assembly_id': candidate['assembly_id'], 'polymer_label_asym_id': candidate['polymer_label_asym_id'],
            'species': 'Bos taurus', 'receptor_state': 'Deposited aficamten/Mg/ADP/vanadate motor-domain model',
            'decision_class': 'Reversible preparation candidate, not frozen production protocol',
            'criterion': 'Prefer the deposited monomer with more observed polymer residues and fewer missing residues, while retaining the other monomer as a sensitivity candidate.',
            'rationale': 'Assembly 1 contains 11 more observed residues and 11 fewer missing residues; the 6-angstrom protein contact residue set is shared by both assemblies.',
            'counterevidence': 'Assembly 2 has fewer alternate-location residues and a lower mean ligand B factor; greater overall completeness is not proof of a more accurate binding site.',
            'source_atom_site_ids': ids,
            'source_atom_site_ids_sha256': hashlib.sha256(('\n'.join(map(str, ids)) + '\n').encode()).hexdigest(),
            'selected_heavy_atom_row_count': len(ids),
            'selection_policy': {
                'assembly_operator': 'Use the deposited identity operation for assembly 1; do not add the second crystal copy or symmetry mates.',
                'alternate_conformations': 'Keep blank/common atoms and exactly one complete residue conformer with greatest mean occupancy; ties choose lexicographically smallest altloc label. Preserve source occupancy values rather than relabeling selected 0.5 occupancy as 1.0.',
                'zero_occupancy': 'Exclude zero-occupancy rows from this coordinate-candidate mask and contact metrics; record the missing chemical atom for later rebuilding. Exclusion is not a valid completed topology.',
                'components': 'Retain every other selected protein, aficamten, magnesium, ADP, vanadate, sulfate and crystallographic water row. No distance-based component deletion.',
                'residue_identity': 'Preserve M3L129/M3L549, deposited chain/residue labels and bovine identity. Do not mutate or relabel residues.',
                'coordinates': 'Copy existing coordinate values only. No missing residues/atoms, hydrogens, caps, bulk solvent, ions, protonation or charges are generated.'
            },
            'ready_for_molecular_dynamics': False,
            'prepared_system_atom_count': None,
            'unresolved_chemistry': [
                'Build and validate 65 missing residues, including loop 626-644 near the pocket flanks, and choose terminal/capping treatment.',
                'Rebuild/review TRP130 CG, whose deposited atom row has zero occupancy, before constructing a chemically complete topology.',
                'Assess alternate-conformation and assembly sensitivity rather than treating deterministic tie-breaking as a physical choice.',
                'Validate modified-lysine, Mg/ADP/vanadate and sulfate treatment; no parameters or replacements are selected.',
                'Decide crystallographic-water retention and full explicit-solvent/ion setup using a registered preparation method.',
                'Select ligand/protein microstates, the alchemical mapping, compound17 bound pose and validated force-field parameters.',
                'Resolve bovine-to-human interpretation and an appropriate state-specific affinity benchmark.'
            ]
        }
    }


def self_test():
    def atom(name, alt, occupancy, number):
        return {'id': str(number), 'label_asym_id': 'X', 'auth_seq_id': '1', 'pdbx_PDB_ins_code': '?',
                'label_comp_id': 'GLY', 'label_seq_id': '1', 'label_atom_id': name,
                'label_alt_id': alt, 'occupancy': occupancy, 'B_iso_or_equiv': '10', 'type_symbol': 'C'}
    rows = [atom('CA', 'A', '0.25', 1), atom('CA', 'B', '0.75', 2), atom('C', '.', '1.0', 3)]
    selected, choices, _ = select_conformers(rows)
    require([r['id'] for r in selected] == ['2', '3'], 'Occupancy selection failed')
    rows[0]['occupancy'] = rows[1]['occupancy'] = '0.50'
    selected, choices, _ = select_conformers(rows)
    require([r['id'] for r in selected] == ['1', '3'] and choices[0]['occupancy_tie'], 'Tie policy failed')
    rows[1]['label_atom_id'] = 'CB'
    try:
        select_conformers(rows)
    except ValueError:
        pass
    else:
        raise ValueError('Incomplete alternative conformers must require review')
    a = {'Cartn_x': '0', 'Cartn_y': '0', 'Cartn_z': '0'}
    b = {'Cartn_x': '3', 'Cartn_y': '4', 'Cartn_z': '0'}
    require(minimum_distance([a], [b]) == 5, 'Coordinate distance units/check failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
    result = build_decisions(args.root)
    target = args.root / 'data/preparation_decisions.json'
    if args.check:
        require(json.loads(target.read_text()) == result, 'Committed preparation decisions differ from reproduction')
    else:
        target.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': 'PASS', 'candidate_assembly': result['candidate_decision']['assembly_id'],
                      'selected_heavy_atom_rows': result['candidate_decision']['selected_heavy_atom_row_count'],
                      'common_6A_contact_residues': result['pocket_comparison']['common_contact_residue_count'],
                      'molecular_dynamics_ready': False, 'self_test': 'PASS' if args.self_test else 'not requested'}, indent=2))


if __name__ == '__main__':
    main()
