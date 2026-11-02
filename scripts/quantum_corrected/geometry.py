#!/usr/bin/env python3
"""Generate one frozen-policy job input with RDKit in the preparation environment."""
import argparse
import hashlib
import json
from pathlib import Path
from rdkit import Chem
from rdkit.Chem import rdMolTransforms
import numpy as np


def prepare(root, name):
    out = root / 'data/prepared_candidate/quantum'
    policy = json.loads((out / 'quality_policy.json').read_text())
    meta = json.loads((out / 'fragment_map.json').read_text())
    policy_sha = hashlib.sha256((out / 'quality_policy.json').read_bytes()).hexdigest()
    if meta['policy_sha256'] != policy_sha:
        raise ValueError('Fragment policy identity mismatch')
    endpoint = None
    if name.startswith('heldout_'):
        _, endpoint, angle = name.split('_')
        angle = int(angle)
        if endpoint not in policy['held_out_full_molecule']['endpoints'] or angle not in policy['held_out_full_molecule']['aryl_angles_degrees']:
            raise ValueError('Unknown held-out job')
        native = root / 'data/prepared_candidate/ligand_endpoints_v0_1' / endpoint
        molecule = Chem.SDMolSupplier(str(native / 'input.sdf'), removeHs=False)[0]
        quartet = [2, 3, 4, 5] if endpoint == 'A' else [3, 4, 5, 6]
        rdMolTransforms.SetDihedralDeg(molecule.GetConformer(), *quartet, angle)
        positions = np.asarray(molecule.GetConformer().GetPositions())
        positions -= positions.mean(axis=0)
        constraints = [(quartet, angle)]
        rings = [list(ring) for ring in molecule.GetRingInfo().AtomRings()]
        metadata = dict(scan_kind='heldout_full_molecule', endpoint=endpoint, angle_degrees=angle, split='held_out_full_molecule', source_sha256={x: hashlib.sha256((native / x).read_bytes()).hexdigest() for x in ['input.sdf', 'system.xml', 'parameters.json']})
    else:
        native = out / 'fragment'
        molecule = Chem.SDMolSupplier(str(native / 'input.sdf'), removeHs=False)[0]
        rings = meta['retained_ring_indices']
        constraints = []
        metadata = {}
        if name == 'fragment_baseline':
            positions = np.asarray(molecule.GetConformer().GetPositions())
            positions -= positions.mean(axis=0)
        elif name.startswith('fragment_'):
            _, kind, angle = name.split('_')
            angle = int(angle)
            if kind not in ('aryl', 'ring') or angle not in policy['scans'][kind]['angles_degrees']:
                raise ValueError('Unknown fragment job')
            baseline = json.loads((out / 'jobs/fragment_baseline/result.json').read_text())
            if baseline['status'] != 'completed':
                raise ValueError('New baseline is not complete')
            for i, point in enumerate(baseline['positions_angstrom']):
                molecule.GetConformer().SetAtomPosition(i, point)
            quartet = meta['scan_quartets'][kind]
            if kind == 'aryl':
                rdMolTransforms.SetDihedralDeg(molecule.GetConformer(), *quartet, angle)
            constraints = [(quartet, angle)]
            if kind == 'ring':
                constraints.append((meta['scan_quartets']['aryl'], 0))
            positions = np.asarray(molecule.GetConformer().GetPositions())
            metadata = dict(scan_kind=kind, angle_degrees=angle, split='train' if angle in policy['scans'][kind]['training_angles_degrees'] else 'held_out')
        elif name.startswith('sensitivity_aryl_'):
            angle = int(name.split('_')[-1])
            if angle not in policy['second_method_sensitivity']['fragment_aryl_angles_degrees']:
                raise ValueError('Unknown sensitivity job')
            first = json.loads((out / 'jobs' / f'fragment_aryl_{angle:+04d}' / 'result.json').read_text())
            if first['status'] != 'completed':
                raise ValueError('New primary-method geometry is not complete')
            positions = np.asarray(first['positions_angstrom'])
            metadata = dict(scan_kind='sensitivity', angle_degrees=angle, split='independent_method')
        else:
            raise ValueError('Unknown job')
    return dict(job=name, symbols=[atom.GetSymbol() for atom in molecule.GetAtoms()], positions_angstrom=positions.tolist(), constraints=constraints, retained_ring_indices=rings, metadata=metadata, system=str(native / 'system.xml'), policy_sha256=policy_sha, optimize=not name.startswith('sensitivity_'), method=policy['second_method_sensitivity']['method'] if name.startswith('sensitivity_') else policy['quantum']['method'], basis=policy['second_method_sensitivity']['basis'] if name.startswith('sensitivity_') else policy['quantum']['basis'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--job', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(json.dumps(prepare(args.root.resolve(), args.job), indent=2, allow_nan=False) + '\n')
