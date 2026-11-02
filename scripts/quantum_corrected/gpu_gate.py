#!/usr/bin/env python3
"""Compare CPU and CUDA QM at frozen geometries, without changing parameters.

This is a numerical runtime gate, not a quantum parameter-quality acceptance.
The outer launcher must enforce a hard process-group deadline.
"""
import argparse
import contextlib
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import platform
import sys
import time
import traceback


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--max-seconds', type=float, default=540)
    args = parser.parse_args()
    if not 1 <= args.max_seconds <= 900:
        parser.error('max-seconds must be within1..900')
    args.output.mkdir(parents=True, exist_ok=False)
    start = time.monotonic(); report_path = args.output / 'gpu-gate.json'
    report = dict(schema='orvia.qm-cuda-runtime-gate.v1', status='in_progress', passed=False, hardware_execution_verified=False, production_ready=False, scientific_acceptance=False, automatic_parameter_transfer=False, source_sha256=sha(__file__), cases=[])
    def save():
        temp = report_path.with_suffix('.tmp')
        temp.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n'); temp.replace(report_path)
    def budget():
        if time.monotonic()-start > args.max_seconds:
            raise TimeoutError('Cooperative QM gate deadline exceeded')
    save()
    try:
        import numpy as np
        import cupy as cp
        import pyscf
        import gpu4pyscf
        from pyscf import gto, dft, lib
        from pyscf.dft import libxc
        policy_path = args.bundle / 'policy.json'; policy = json.loads(policy_path.read_text())
        report['policy_sha256'] = sha(policy_path); report['policy'] = policy
        lib.num_threads(policy['cpu_threads'])
        capture = io.StringIO()
        with contextlib.redirect_stdout(capture):
            np.show_config()
        device = cp.cuda.Device(0); device.use()
        props = cp.cuda.runtime.getDeviceProperties(device.id)
        device_name = props['name'].decode() if isinstance(props['name'], bytes) else props['name']
        report['runtime'] = dict(python=sys.version, host=platform.platform(), executable=sys.executable, packages={name:importlib.metadata.version(name) for name in policy['package_names']}, libxc=libxc.__version__, numpy_configuration=capture.getvalue(), cpu_threads=lib.num_threads(), gpu_name=device_name, gpu_device_id=device.id, cuda_runtime=cp.cuda.runtime.runtimeGetVersion(), cuda_driver=cp.cuda.runtime.driverGetVersion(), gpu_total_memory_bytes=props['totalGlobalMem'])
        def host(value):
            array = cp.asnumpy(value) if isinstance(value, cp.ndarray) else np.asarray(value)
            array = np.asarray(array, dtype=np.float64)
            if not np.isfinite(array).all():
                raise FloatingPointError('Nonfinite numerical runtime observation')
            return array
        def grid_hash(grid):
            coords = host(grid.coords); weights = host(grid.weights)
            return dict(count=len(weights), coordinates_sha256=hashlib.sha256(coords.tobytes()).hexdigest(), weights_sha256=hashlib.sha256(weights.tobytes()).hexdigest())
        def build(case, positions, tag):
            mol = gto.M(atom=list(zip(case['symbols'],positions.tolist())), unit='Angstrom', basis=case['basis'], charge=0, spin=0, symmetry=False, max_memory=policy['max_memory_MB'], verbose=4, output=str(args.output / (tag+'.log')))
            mf = dft.RKS(mol).density_fit(auxbasis=policy['auxiliary_basis'])
            mf.xc=case['method']; mf.grids.level=policy['grid_level']
            mf.conv_tol=policy['scf_tolerance_hartree']; mf.max_cycle=policy['scf_max_cycles']
            mf.max_memory=policy['max_memory_MB']; mf.chkfile=None
            return mf
        def measure(mf, tag, gradient=True):
            budget(); tick = time.monotonic(); energy = float(mf.kernel())
            cp.cuda.get_current_stream().synchronize()
            if not mf.converged or not np.isfinite(energy):
                raise ValueError(tag+' SCF did not converge to finite energy')
            result = dict(energy_hartree=energy, scf_seconds=time.monotonic()-tick, converged=True)
            if gradient:
                grad=mf.nuc_grad_method(); grad.grid_response=policy['gradient_grid_response']
                tick=time.monotonic(); values=host(grad.kernel()); cp.cuda.get_current_stream().synchronize()
                result.update(gradient_hartree_per_bohr=values.tolist(), gradient_seconds=time.monotonic()-tick, gradient_grid_response=bool(grad.grid_response))
            budget(); return result
        for case in policy['cases']:
            budget(); coordinates_path=args.bundle/case['geometry_file']; data=json.loads(coordinates_path.read_text())
            positions=host(data['positions_angstrom']); case={**case,'symbols':data['symbols']}
            if positions.shape != (len(case['symbols']),3):
                raise ValueError('Unexpected geometry shape')
            row=dict(name=case['name'], atom_count=len(positions), method=case['method'], basis=case['basis'], geometry_sha256=sha(coordinates_path), passed=False)
            report['cases'].append(row); save()
            cpu=build(case,positions,case['name']+'-cpu'); cpu_result=measure(cpu,'CPU')
            row['cpu']=cpu_result; row['cpu_grid']=grid_hash(cpu.grids); row['xc_components_cpu']=libxc.parse_xc(case['method']); save()
            # Preserve the exact CPU quadrature after its ordinary initialization.
            # CUDA sorts points internally, which may change byte ordering but not
            # the quadrature. This probe does not approve later automatic grids.
            fresh=build(case,positions,case['name']+'-gpu'); gpu=fresh.to_gpu()
            if not type(gpu).__module__.startswith('gpu4pyscf'):
                raise RuntimeError('to_gpu did not create GPU4PySCF')
            gpu.grids.coords=cp.asarray(cpu.grids.coords); gpu.grids.weights=cp.asarray(cpu.grids.weights)
            row['gpu_grid_before']=grid_hash(gpu.grids)
            if row['gpu_grid_before'] != row['cpu_grid']:
                raise ValueError('Exact common quadrature transfer failed')
            gpu_result=measure(gpu,'GPU'); row['gpu']=gpu_result
            report['hardware_execution_verified']=True
            grad=gpu.nuc_grad_method(); grad.grid_response=policy['gradient_grid_response']
            repeated=host(grad.kernel()); cp.cuda.get_current_stream().synchronize()
            difference=host(gpu_result['gradient_hartree_per_bohr'])-host(cpu_result['gradient_hartree_per_bohr'])
            repeat_difference=repeated-host(gpu_result['gradient_hartree_per_bohr'])
            metrics=dict(energy_absolute_error_hartree=abs(gpu_result['energy_hartree']-cpu_result['energy_hartree']), gradient_max_absolute_error_hartree_per_bohr=float(np.max(np.abs(difference))), repeated_gradient_max_absolute_error_hartree_per_bohr=float(np.max(np.abs(repeat_difference))))
            row['metrics']=metrics; save()
            if case.get('finite_difference_component') is not None:
                atom,axis=case['finite_difference_component']; derivatives={'CPU':[],'GPU':[]}
                for h in policy['finite_difference_steps_bohr']:
                    energies={'CPU':[],'GPU':[]}
                    for sign in [-1,1]:
                        shifted=positions.copy(); shifted[atom,axis]+=sign*h*lib.param.BOHR
                        tag=f"{case['name']}-fd-{h}-{sign}"
                        c=build(case,shifted,tag+'-cpu'); energies['CPU'].append(measure(c,'CPU finite difference',gradient=False)['energy_hartree'])
                        g=build(case,shifted,tag+'-gpu').to_gpu(); g.grids.coords=cp.asarray(c.grids.coords); g.grids.weights=cp.asarray(c.grids.weights)
                        energies['GPU'].append(measure(g,'GPU finite difference',gradient=False)['energy_hartree'])
                    for backend in derivatives:
                        derivatives[backend].append((energies[backend][1]-energies[backend][0])/(2*h))
                row['finite_difference']=dict(component=[atom,axis],steps_bohr=policy['finite_difference_steps_bohr'],derivatives_hartree_per_bohr=derivatives)
                row['finite_difference']['passed']=all(abs(value-host(row[backend.lower()]['gradient_hartree_per_bohr'])[atom,axis])<=policy['limits']['finite_difference_gradient_absolute_error_hartree_per_bohr'] for backend in derivatives for value in derivatives[backend]) and all(abs(values[0]-values[1])<=policy['limits']['finite_difference_step_absolute_error_hartree_per_bohr'] for values in derivatives.values())
            row['passed']=all(metrics[key]<=policy['limits'][key] for key in metrics) and row.get('finite_difference',{}).get('passed',True)
            save()
        budget(); report['passed']=bool(report['cases']) and all(case['passed'] for case in report['cases'])
        report['status']='passed_runtime_gate_only' if report['passed'] else 'failed_strict_comparison'
    except Exception as error:
        report.update(status='failed', error=dict(type=type(error).__name__,message=str(error)))
        (args.output/'failure.log').write_text(traceback.format_exc())
    report['elapsed_seconds']=time.monotonic()-start; save()
    print(json.dumps({'status':report['status'],'passed':report['passed'],'hardware_execution_verified':report['hardware_execution_verified']}),flush=True)
    return 0 if report['passed'] else 2


if __name__=='__main__':
    raise SystemExit(main())
