#!/usr/bin/env python3
"""Reproduce ORVIA's ligand map/pose candidates and explicit scientific blockers.

This builds external model-input candidates, never force-field parameters or a
production trajectory. --check verifies all committed outputs without rewriting.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
from decimal import Decimal
import hashlib
import json
from pathlib import Path

from audit_structure import parse_cif
from audit_preparation import build_decisions
from audit_pair_identity import check_integrity, check_chemistry, require, RDKIT_VERSION, AuditFailure


EVIDENCE = [
    {'id': 'aficamten_structure', 'doi': '10.1038/s44161-024-00505-0',
     'url': 'https://www.nature.com/articles/s44161-024-00505-0',
     'finding': 'The primary aficamten structure paper deposits atomic model 9F6C. Its reported complex contains Mg/ADP/vanadate. A parameterized aficamten/compound17 RBFE system was not located in the reviewed availability statement.',
     'boundary': 'The availability statement is not proof that no relevant parameter set exists elsewhere.'},
    {'id': 'related_charmm_myosin', 'doi': '10.1038/s41467-024-47587-9',
     'url': 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11161628/',
     'finding': 'Related OM/mavacamten cardiac-myosin simulations use CHARMM36m and build Mg/ADP/phosphate from a Mg/ADP/vanadate structure.',
     'boundary': 'Those simulations concern different ligands and phosphate, not a validated aficamten/compound17 vanadate model.'},
    {'id': 'related_amber_myosin', 'doi': '10.3390/ijms251910425',
     'url': 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11477208/',
     'finding': 'Related OM simulations model missing loops, replace vanadate with H2PO4, convert trimethyllysine to lysine, and use AMBER ff14SB. Their trajectories are described as available upon request.',
     'boundary': 'These substitutions cannot silently preserve ORVIA-001 deposited chemistry; the reported trajectory availability is not an open downloadable prepared ORVIA input.'},
    {'id': 'ptm_parameters', 'doi': '10.1021/ct400556v',
     'url': 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3904396/',
     'finding': 'Forcefield_PTM supplies published trimethyllysine parameters compatible with AMBER ff03, among other modifications.',
     'boundary': 'Availability of a residue parameter set does not establish compatibility with a different chosen protein force field or validate the assembled myosin system.'},
    {'id': 'charmm_parameters', 'url': 'https://mackerell.umaryland.edu/charmm_ff.shtml',
     'finding': 'The force-field authors distribute versioned CHARMM topology and parameter files.',
     'boundary': 'No CHARMM release is silently adopted here; complete topology/parameter coverage, functional forms and license/provenance must be pinned before export.'},
]


def encoded_json(value):
    return (json.dumps(value, indent=2) + '\n').encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unique_map(target, query):
    matches = target.GetSubstructMatches(query, useChirality=True, uniquify=False)
    require(len(matches) == 1, f'Expected a unique chirality-preserving graph map; found {len(matches)}')
    return matches[0]


def coordinate_record(row):
    xyz = [row[k] for k in ('Cartn_x', 'Cartn_y', 'Cartn_z')]
    return {'source_atom_site_id': int(row['id']), 'label_atom_id': row['label_atom_id'],
            'element': row['type_symbol'], 'xyz_angstrom': xyz,
            'xyz_nm_exact_decimal': [str(Decimal(v) / 10) for v in xyz],
            'source_occupancy': row['occupancy'], 'source_B_angstrom_squared': row['B_iso_or_equiv']}


def sdf(mol, name):
    from rdkit import Chem
    copy = Chem.Mol(mol)
    copy.SetProp('_Name', name)
    block = Chem.MolToMolBlock(copy)
    restored = Chem.MolFromMolBlock(block, removeHs=False)
    require(restored is not None and Chem.MolToInchiKey(restored) == Chem.MolToInchiKey(copy),
            'SDF round trip changed chemical identity/stereochemistry')
    return (block + '>  <ORVIA_STATUS>\nUNPARAMETERIZED_HEAVY_ATOM_POSE_CANDIDATE\n\n'
            '>  <ORVIA_SOURCE>\n9F6C assembly 1; coordinates copied from source heavy atoms\n\n'
            '>  <ORVIA_LIMIT>\nNo hydrogens, partial charges, minimized state or validated binding pose\n\n$$$$\n').encode()


def build(root):
    from rdkit import Chem, rdBase
    from rdkit.Chem import rdMolDescriptors
    from rdkit.Geometry import Point3D
    require(rdBase.rdkitVersion == RDKIT_VERSION, 'Pinned RDKit is required')
    audit, rows, descriptors = check_integrity(root)
    check_chemistry(audit, rows, descriptors, optional=False)
    preparation = build_decisions(root)
    require(preparation == json.loads((root / 'data/preparation_decisions.json').read_text()),
            'Receptor selection differs from pinned preparation audit')
    cif = parse_cif(root / 'data/source/9F6C.cif')
    ccd = parse_cif(root / 'data/source/6I6.cif')
    selected_ids = preparation['candidate_decision']['source_atom_site_ids']
    by_id = {int(a['id']): a for a in cif['_atom_site']}
    selected = [by_id[i] for i in selected_ids]
    ligand = {a['label_atom_id']: a for a in selected if a['label_comp_id'] == '6I6'}
    require(len(ligand) == 25, 'Expected exactly 25 unique ligand atoms')
    atoms = [a for a in ccd['_chem_comp_atom'] if a['type_symbol'] != 'H']
    indices = {a['atom_id']: i for i, a in enumerate(atoms)}
    rw = Chem.RWMol()
    for a in atoms:
        atom = Chem.Atom(a['type_symbol']); atom.SetFormalCharge(int(a['charge']))
        rw.AddAtom(atom)
    order = {'SING': Chem.BondType.SINGLE, 'DOUB': Chem.BondType.DOUBLE}
    for bond in ccd['_chem_comp_bond']:
        a, b = bond['atom_id_1'], bond['atom_id_2']
        if a in indices and b in indices:
            rw.AddBond(indices[a], indices[b], order[bond['value_order']])
    ccd_mol = rw.GetMol(); Chem.SanitizeMol(ccd_mol)
    conformer = Chem.Conformer(len(atoms)); conformer.Set3D(True)
    for i, atom in enumerate(atoms):
        row = ligand[atom['atom_id']]
        conformer.SetAtomPosition(i, Point3D(*[float(row[k]) for k in ('Cartn_x', 'Cartn_y', 'Cartn_z')]))
    ccd_mol.AddConformer(conformer)
    Chem.AssignAtomChiralTagsFromStructure(ccd_mol)
    Chem.AssignStereochemistry(ccd_mol, force=True, cleanIt=True)
    a = Chem.MolFromSmiles(rows['17']['SMILES'])
    b = Chem.MolFromSmiles(rows['Aficamten']['SMILES'])
    b_to_ccd = unique_map(ccd_mol, b)
    require(Chem.MolToInchiKey(ccd_mol) == Chem.MolToInchiKey(b), 'Coordinate chirality differs from published B')
    edited = Chem.RWMol(b); edited.RemoveAtom(0); product = edited.GetMol(); Chem.SanitizeMol(product)
    require(Chem.MolToInchiKey(product) == Chem.MolToInchiKey(a), 'Terminal-carbon deletion changed the wrong group')
    a_to_product = unique_map(product, a)
    a_to_b = [i + 1 for i in a_to_product]
    require(len(set(a_to_b)) == 24 and set(a_to_b) == set(range(1, 25)), 'Incomplete or duplicated common-atom map')
    b_positions = [coordinate_record(ligand[atoms[i]['atom_id']]) for i in b_to_ccd]
    a_positions = [deepcopy(b_positions[i]) for i in a_to_b]
    for molecule, positions in [(a, a_positions), (b, b_positions)]:
        cf = Chem.Conformer(molecule.GetNumAtoms()); cf.Set3D(True)
        for i, row in enumerate(positions):
            cf.SetAtomPosition(i, Point3D(*map(float, row['xyz_angstrom'])))
        molecule.AddConformer(cf)
    mapping = {
        'schema_version': 'orvia.ligand-map-candidate.v1', 'experiment': 'ORVIA-001',
        'status': 'HEAVY_ATOM_MAP_AND_UNRELAXED_POSE_CANDIDATES_ONLY',
        'algorithm': 'Unique full-graph stereochemical match of author B to CCD graph/9F6C coordinates; remove B source atom0, sanitize, then unique match author A.',
        'software': {'name': 'RDKit', 'version': rdBase.rdkitVersion},
        'source_atom_index_convention': 'Zero-based atom indices in the exact author SMILES retained in compound17_pair_rows.json',
        'receptor_source': {'pdb': '9F6C', 'assembly': '1', 'ligand_label_asym_id': 'E', 'ligand_auth_asym_id': 'A', 'ligand_auth_seq_id': 1003},
        'common_heavy_atoms': [dict(a_source_index=i, b_source_index=j, ccd_atom_id=b_positions[j]['label_atom_id'], source_atom_site_id=b_positions[j]['source_atom_site_id']) for i, j in enumerate(a_to_b)],
        'B_only_heavy_atom': dict(b_source_index=0, ccd_atom_id=b_positions[0]['label_atom_id'], source_atom_site_id=b_positions[0]['source_atom_site_id'], element='C'),
        'adjacent_common_atom': dict(a_source_index=a_to_b.index(1), b_source_index=1, ccd_atom_id=b_positions[1]['label_atom_id'], implicit_H_A=3, implicit_H_B=2),
        'A': {'identity': 'Compound 17', 'formula': rdMolDescriptors.CalcMolFormula(a), 'inchi_key': Chem.MolToInchiKey(a), 'source_smiles': rows['17']['SMILES'], 'heavy_atom_pose': a_positions},
        'B': {'identity': 'Aficamten', 'formula': rdMolDescriptors.CalcMolFormula(b), 'inchi_key': Chem.MolToInchiKey(b), 'source_smiles': rows['Aficamten']['SMILES'], 'heavy_atom_pose': b_positions},
        'hydrogen_mapping_complete': False, 'force_field_assigned': False, 'relaxed_pose': False,
        'bound_pose_for_A_experimentally_verified': False,
        'limits': ['Deleting terminal C defines a chemically valid common scaffold and an initial heavy-atom pose hypothesis, not its equilibrium geometry.',
                   'Hydrogen coordinates/correspondence, endpoint charges, dummy-atom topology, soft-core schedule and parameterized endpoints remain unresolved.',
                   'Copying B coordinates does not establish compound17 binding mode or affinity.'],
    }
    atom_table = []
    for row in selected:
        atom_table.append(dict(coordinate_record(row), label_asym_id=row['label_asym_id'], auth_asym_id=row['auth_asym_id'],
                               auth_seq_id=row['auth_seq_id'], component=row['label_comp_id'], altloc=row['label_alt_id']))
    coordinates = {'schema_version': 'orvia.selected-heavy-coordinates.v1',
                   'status': 'INCOMPLETE_UNPARAMETERIZED_SOURCE_COORDINATE_CANDIDATE',
                   'source_sha256': preparation['source']['sha256'],
                   'source_atom_ids_sha256': preparation['candidate_decision']['source_atom_site_ids_sha256'],
                   'atoms': atom_table, 'atom_count': len(atom_table), 'hydrogens_present': False,
                   'prepared_system_atom_count': None, 'topology_complete': False}
    payloads = {
        'data/prepared_candidate/ligand_atom_map.json': encoded_json(mapping),
        'data/prepared_candidate/selected_heavy_coordinates.json': encoded_json(coordinates),
        'data/prepared_candidate/compound17_heavy_pose_candidate.sdf': sdf(a, 'ORVIA-001 A: compound17 candidate'),
        'data/prepared_candidate/aficamten_heavy_source_pose.sdf': sdf(b, 'ORVIA-001 B: aficamten source pose'),
    }
    readiness = {
        'schema_version': 'orvia.scientific-readiness.v1', 'as_of_date': '2026-11-02', 'experiment': 'ORVIA-001',
        'status': 'SCIENTIFIC_INPUTS_BLOCKED', 'ready_for_orvia_001_registration': False,
        'source_integrity_and_mapping_checks': 'PASS',
        'external_model_inputs_only': True, 'production_result_computed_offchain': False,
        'resolved_here': ['Unique 24-common-heavy-atom A/B correspondence with preserved R stereochemistry.',
                          'Source-name mapping from both published graphs to assembly1 ligand coordinates.',
                          'Complete export of selected 6032 existing heavy-atom coordinates in original angstrom strings and exact decimal nanometers.'],
        'outputs': {name: {'bytes': len(data), 'sha256': sha(data)} for name, data in payloads.items()},
        'source_files': {name: sha((root/name).read_bytes()) for name in ['data/source/9F6C.cif','data/source/6I6.cif','data/source/compound17_pair_rows.json','data/preparation_decisions.json']},
        'evidence_review': EVIDENCE,
        'search_scope': ['Primary aficamten structure/discovery evidence and their availability statements.',
                         'Related published cardiac-myosin molecular dynamics preparations.',
                         'Published trimethyllysine force fields and original force-field distribution.'],
        'scientific_input_blockers': [
            {'id': 'missing_structure', 'status': 'UNRESOLVED', 'required': 'Explicit reviewed model for 65 missing residues, TRP130 CG and termini, retaining provenance and validation for all introduced coordinates.'},
            {'id': 'cofactor_model', 'status': 'UNRESOLVED', 'required': 'Declared vanadate species/charge/coordination and compatible Mg/ADP/vanadate parameters with validation. No silent phosphate substitution or free vanadium-ion analogy.'},
            {'id': 'complete_force_field', 'status': 'UNRESOLVED', 'required': 'Exact compatible protein/M3L/ligand/cofactor/water/ion force-field files and charges, all bonded terms/exceptions and supported functional forms; independent energy/force comparisons.'},
            {'id': 'ligand_microstates_and_hybrid', 'status': 'UNRESOLVED', 'required': 'Simulation microstates, explicit hydrogens and their map, parameterized A/B endpoints, compound17 pose validation, hybrid topology and soft-core specification.'},
            {'id': 'solvated_legs', 'status': 'UNRESOLVED', 'required': 'Complete complex and solvent legs with registered water/ion model, box, concentrations, temperature, pressure and canonical atom order.'},
            {'id': 'sampling_and_acceptance', 'status': 'UNRESOLVED', 'required': 'Registered minimization/equilibration, lambda states, repeats/seeds, sample retention, overlap/decorrelation/uncertainty and failure/extension criteria; engine must implement every selected operation.'},
        ],
        'experimental_claim_limit': {'matched_affinity_pair_available': False,
            'required_for_deploying_research_software': False,
            'required_for_claiming_experimentally_validated_affinity': True,
            'note': 'A research model can report its prediction with model uncertainty; functional ATPase IC50 cannot be relabeled Kd. Mainnet deployment alone cannot establish biological validity.'},
        'engineering_and_chain_readiness': 'Owned by the deployment/engine readiness reports; this audit cannot clear those gates.'
    }
    payloads['data/scientific_readiness.json'] = encoded_json(readiness)
    return payloads, mapping


def self_test(mapping):
    from rdkit import Chem
    require(mapping['A']['formula'] == 'C17H17N5O2' and mapping['B']['formula'] == 'C18H19N5O2', 'Endpoint formulas changed')
    require(mapping['B_only_heavy_atom']['ccd_atom_id'] == 'C' and mapping['adjacent_common_atom']['ccd_atom_id'] == 'C1', 'Wrong methyl/ethyl edit')
    a = Chem.MolFromSmiles(mapping['A']['source_smiles'])
    wrong = Chem.Mol(a)
    for atom in wrong.GetAtoms():
        if atom.GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED: atom.InvertChirality()
    try: unique_map(a, wrong)
    except AuditFailure: pass
    else: raise ValueError('Wrong enantiomer was accepted')
    b = Chem.MolFromSmiles(mapping['B']['source_smiles'])
    wrong_edit = Chem.RWMol(b)
    wrong_edit.GetAtomWithIdx(18).SetNumExplicitHs(1)
    wrong_edit.RemoveAtom(19)
    wrong_edit = wrong_edit.GetMol(); Chem.SanitizeMol(wrong_edit)
    require(Chem.MolToInchiKey(wrong_edit) != Chem.MolToInchiKey(a), 'Wrong methyl deletion was accepted')
    for row in mapping['common_heavy_atoms']:
        arow = mapping['A']['heavy_atom_pose'][row['a_source_index']]
        brow = mapping['B']['heavy_atom_pose'][row['b_source_index']]
        require(arow == brow, 'Common atom coordinates differ')
        require(all(Decimal(x) == Decimal(y)*10 for x,y in zip(arow['xyz_angstrom'],arow['xyz_nm_exact_decimal'])), 'Unit conversion is not exact')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    payloads, mapping = build(args.root)
    if args.self_test: self_test(mapping)
    for name, data in payloads.items():
        target = args.root/name
        if args.check:
            require(target.read_bytes() == data, f'Committed scientific candidate differs: {name}')
        else:
            target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
    print(json.dumps({'status': 'PASS', 'common_heavy_atoms': 24, 'B_only_heavy_atoms': 1,
                      'selected_receptor_heavy_atom_rows': 6032, 'outputs_checked': len(payloads),
                      'self_test': 'PASS' if args.self_test else 'not requested',
                      'ready_for_orvia_001_registration': False}, indent=2))


if __name__ == '__main__':
    main()
