#!/usr/bin/env python3
"""One fresh same-policy QM calculation; launched only by the bounded supervisor."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n')
    temp.replace(path)


def runtime(root):
    import numpy, scipy, h5py, pyscf, geometric
    from pyscf.dft import libxc
    pinned = json.loads((root / 'lineage/runtime_openblas.json').read_text())
    versions = dict(numpy=numpy.__version__, scipy=scipy.__version__, h5py=h5py.__version__, pyscf=pyscf.__version__, libxc=libxc.__version__, geometric=geometric.__version__)
    if Path(sys.executable).resolve() != Path(pinned['executable']).resolve():
        raise ValueError('This CPU reproduction requires the independently checked local OpenBLAS backend')
    if any(versions[k] != pinned[k] for k in ['numpy', 'scipy', 'h5py', 'pyscf', 'libxc']) or versions['geometric'] != '1.1.1':
        raise ValueError('Checked runtime package versions changed')
    for item in pinned['files']:
        if sha(item['path']) != item['sha256']:
            raise ValueError('Checked numerical runtime bytes changed: ' + item['path'])
    return dict(executable=sys.executable, versions=versions, native_libraries_verified=len(pinned['files']), backend='CPU OpenBLAS', gpu_execution=False)


def calculate(args):
    import numpy as np
    from pyscf import gto, dft, lib
    from pyscf.geomopt import geometric_solver
    out = args.root / 'data/prepared_candidate/quantum'
    inp = json.loads(args.input.read_text())
    policy_path = out / 'quality_policy.json'
    policy = json.loads(policy_path.read_text())
    q = policy['quantum']
    if sha(policy_path) != inp['policy_sha256']:
        raise ValueError('Job and policy mismatch')
    directory = out / 'jobs' / inp['job']
    directory.mkdir(parents=True, exist_ok=True)
    dest = directory / 'result.json'
    if dest.exists():
        raise ValueError('Existing scientific result retained; refusing overwrite')
    started = time.monotonic()
    result = dict(schema='orvia.quantum-quality-job.v1', job=inp['job'], status='in_progress', production_ready=False, scientific_acceptance=False, policy_sha256=sha(policy_path), runner_sha256=sha(__file__), input_sha256=sha(args.input), method=inp['method'], basis=inp['basis'], auxiliary_basis=q['auxiliary_basis'], scf_tolerance_hartree=q['scf_energy_tolerance_hartree'], atom_count=len(inp['symbols']), constraints=inp['constraints'], optimized=inp['optimize'], max_memory_MB=q['max_memory_MB'], threads=q['threads'], **inp['metadata'])
    save(dest, result)
    try:
        result['runtime'] = runtime(args.root)
        lib.num_threads(q['threads'])
        result['effective_threads'] = lib.num_threads()
        def method(positions, filename):
            mol = gto.M(atom=list(zip(inp['symbols'], positions.tolist())), unit='Angstrom', basis=inp['basis'], charge=0, spin=0, symmetry=False, max_memory=q['max_memory_MB'], verbose=4, output=str(directory / filename))
            mf = dft.RKS(mol).density_fit(auxbasis=q['auxiliary_basis'])
            mf.xc = inp['method']; mf.grids.level = q['integration_grid_level']
            mf.conv_tol = q['scf_energy_tolerance_hartree']; mf.max_cycle = q['scf_max_cycles']
            mf.max_memory = q['max_memory_MB']; mf.chkfile = None
            return mf
        positions = np.asarray(inp['positions_angstrom'], dtype=float)
        if positions.shape != (len(inp['symbols']), 3) or not np.isfinite(positions).all():
            raise ValueError('Invalid initial coordinates')
        mf = method(positions, 'scf.log')
        tick = time.monotonic(); energy = float(mf.kernel())
        if not mf.converged or not np.isfinite(energy):
            raise ValueError('Initial SCF did not converge to finite energy')
        result.update(initial_scf_converged=True, initial_energy_hartree=energy, initial_scf_seconds=time.monotonic()-tick)
        save(dest, result)
        if inp['optimize']:
            constraint_path = None
            if inp['constraints']:
                constraint_path = directory / 'constraints.txt'
                constraint_path.write_text('$set\n' + '\n'.join('dihedral ' + ' '.join(str(i+1) for i in quartet) + f' {angle}' for quartet, angle in inp['constraints']) + '\n$end\n')
            converged, optimized = geometric_solver.kernel(mf, constraints=str(constraint_path) if constraint_path else None, maxsteps=q['geometry_max_steps'], assert_convergence=True, convergence_energy=1e-6, convergence_grms=3e-4, convergence_gmax=4.5e-4, convergence_drms=1.2e-3, convergence_dmax=1.8e-3)
            result['geometry_converged'] = bool(converged)
            positions = optimized.atom_coords(unit='Angstrom')
            if not converged:
                raise ValueError('Geometry optimization did not converge')
        else:
            result['geometry_converged'] = None
        if not np.isfinite(positions).all():
            raise ValueError('Nonfinite optimized coordinates')
        checks = []
        for ring in inp['retained_ring_indices']:
            for a, b in zip(ring, ring[1:] + ring[:1]):
                distance = float(np.linalg.norm(positions[a]-positions[b]))
                checks.append(dict(atoms=[a,b], distance_angstrom=distance, passed=0.9 <= distance <= 1.8))
        result['ring_bonds'] = checks
        if not all(item['passed'] for item in checks):
            raise ValueError('Ring bond outside unchanged 0.9..1.8 angstrom criterion')
        final = method(positions, 'final_scf.log'); energy = float(final.kernel())
        if not final.converged or not np.isfinite(energy):
            raise ValueError('Final SCF did not converge to finite energy')
        result.update(final_scf_converged=True, energy_hartree=energy, energy_kJ_per_mol=energy*2625.4996394799, positions_angstrom=positions.tolist())
        save(directory / 'positions.json', positions.tolist())
        subprocess.run([str(args.preparation_python), str(args.root / 'scripts/quantum/mm_reference.py'), '--system', inp['system'], '--positions', str(directory / 'positions.json'), '--output', str(directory / 'mm_reference.json')], check=True, timeout=120)
        result['mm_reference'] = json.loads((directory / 'mm_reference.json').read_text())
        if not np.isfinite(result['mm_reference']['energy_kJ_per_mol']):
            raise ValueError('Nonfinite native Reference MM energy')
        result['status'] = 'completed'
    except Exception as error:
        result.update(status='failed', error=str(error))
        (directory / 'failure.log').write_text(traceback.format_exc())
    result['elapsed_seconds'] = time.monotonic()-started
    save(dest, result)
    print(json.dumps({'job': inp['job'], 'status': result['status'], 'elapsed_seconds': result['elapsed_seconds']}), flush=True)
    return 0 if result['status'] == 'completed' else 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--preparation-python', type=Path)
    parser.add_argument('--runtime-only', action='store_true')
    args = parser.parse_args(); args.root = args.root.resolve()
    if args.runtime_only:
        print(json.dumps(runtime(args.root)))
    else:
        if args.input is None or args.preparation_python is None:
            parser.error('Calculation requires input and preparation Python')
        raise SystemExit(calculate(args))
