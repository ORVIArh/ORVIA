#!/usr/bin/env python3
"""Bounded QM held-out optimization using a fresh CPU-built grid at every geometry.

Pilot mode is a scanner validation, not an accepted optimized conformer. A hard
process-group watchdog must surround this process, including native CUDA calls.
"""
import argparse
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time
import traceback

POLICY_SHA='dbea002e2ae847b10d7b65db37f1e877039b99b2c10a6443cc7046cc54121668'
LIMITS={'energy_absolute_error_hartree':1e-7,'gradient_max_absolute_error_hartree_per_bohr':1e-5}


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path,value):
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value,indent=2,allow_nan=False)+'\n');temp.replace(path)


def verify_gate(path,digest):
    if not re.fullmatch('[0-9a-f]{64}',digest) or sha(path)!=digest:raise ValueError('Unrecognized GPU runtime gate bytes')
    gate=json.loads(path.read_text())
    if gate.get('passed') is not True or gate.get('hardware_execution_verified') is not True or gate.get('status')!='passed_runtime_gate_only':raise ValueError('GPU runtime gate has not passed')
    cases=gate.get('cases',[])
    if {row.get('name') for row in cases}!={'full_A41_B3LYP_SVP','fragment20_PBE0_TZVP'} or len(cases)!=2:raise ValueError('Incomplete runtime gate')
    for row in cases:
        if row.get('passed') is not True:raise ValueError('Failed gate case')
        for name,limit in LIMITS.items():
            value=row['metrics'][name]
            if not isinstance(value,(float,int)) or not math.isfinite(value) or value>limit or value<0:raise ValueError('Gate metric violates fixed limit')
    if next(row for row in cases if row['name']=='full_A41_B3LYP_SVP')['finite_difference'].get('passed') is not True:raise ValueError('Gate finite differences failed')
    return gate


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job-input',type=Path,required=True);parser.add_argument('--policy',type=Path,required=True);parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--mode',choices=['pilot','optimize'],default='pilot');parser.add_argument('--backend',choices=['GPU','CPU-test'],default='GPU')
    parser.add_argument('--gate-report',type=Path);parser.add_argument('--gate-sha256');parser.add_argument('--pilot-steps',type=int,default=3)
    parser.add_argument('--pilot-report',type=Path);parser.add_argument('--pilot-sha256')
    parser.add_argument('--max-seconds',type=float,default=900);parser.add_argument('--mm-python',type=Path);parser.add_argument('--mm-reference-script',type=Path)
    parser.add_argument('--system',type=Path,help='Explicit bundled native endpoint System for final MM verification')
    args=parser.parse_args()
    if not(1<=args.max_seconds<=7200 and 1<=args.pilot_steps<=5):parser.error('Unsupported resource bound')
    if args.backend=='GPU' and (args.gate_report is None or args.gate_sha256 is None):parser.error('GPU execution requires the exact passed runtime gate')
    if args.mode=='optimize' and (args.backend!='GPU' or args.mm_python is None or args.mm_reference_script is None):parser.error('Accepted optimization requires validated GPU and native MM reference')
    if args.mode=='optimize' and (args.pilot_report is None or args.pilot_sha256 is None):parser.error('Optimization requires the exact passed scanner pilot')
    out=args.output_dir.resolve();out.mkdir(parents=True,exist_ok=False);started=time.monotonic();result_path=out/'result.json'
    result=dict(schema='orvia.quantum-quality-job.v1',status='in_progress',mode=args.mode,backend=args.backend,hardware_execution_verified=False,production_ready=False,scientific_acceptance=False,runner_sha256=sha(__file__),policy_sha256=sha(args.policy),input_sha256=sha(args.job_input),iterations=[],limits=LIMITS,external_hard_watchdog_required=True)
    write(result_path,result)
    def save():write(result_path,result)
    def budget():
        if time.monotonic()-started>args.max_seconds:raise TimeoutError('QM optimization cooperative deadline exhausted')
    try:
        import numpy as np
        from pyscf import gto,dft,lib
        from pyscf.geomopt import geometric_solver
        policy=json.loads(args.policy.read_text());inp=json.loads(args.job_input.read_text());q=policy['quantum']
        if sha(args.policy)!=POLICY_SHA or inp['policy_sha256']!=POLICY_SHA:raise ValueError('Original frozen quantum policy changed')
        if args.backend=='GPU':
            import cupy as cp
            import gpu4pyscf
            gate=verify_gate(args.gate_report,args.gate_sha256)
            versions={name:importlib.metadata.version(name) for name in gate['runtime']['packages']}
            if versions!=gate['runtime']['packages']:raise ValueError('Packages changed since validated GPU gate')
            if args.mode=='optimize':
                if sha(args.pilot_report)!=args.pilot_sha256:raise ValueError('Pilot hash mismatch')
                pilot=json.loads(args.pilot_report.read_text())
                if pilot.get('status')!='passed_gpu_optimization_pilot' or pilot.get('runner_sha256')!=sha(__file__) or pilot.get('runtime',{}).get('gate_sha256')!=args.gate_sha256 or pilot.get('pilot_finite_difference',{}).get('passed') is not True:raise ValueError('The current scanner has no passed GPU pilot')
            device=cp.cuda.Device(0);device.use();props=cp.cuda.runtime.getDeviceProperties(0)
            result['runtime']=dict(packages=versions,gate_sha256=args.gate_sha256,device_name=props['name'].decode() if isinstance(props['name'],bytes) else props['name'],cuda_runtime=cp.cuda.runtime.runtimeGetVersion(),cuda_driver=cp.cuda.runtime.driverGetVersion())
            if not re.fullmatch(r'heldout_[AB]_\+(030|090|150)',inp['job']) or len(inp['symbols'])!=(41 if inp['job'].split('_')[1]=='A' else 44):raise ValueError('Expected frozen native held-out job')
        else:
            cp=None
            result['runtime']=dict(python=sys.version,test_mode=True)
        lib.num_threads(q['threads'])
        result.update(job=inp['job'],method=inp['method'],basis=inp['basis'],auxiliary_basis=q['auxiliary_basis'],atom_count=len(inp['symbols']),constraints=inp['constraints'],optimized=args.mode=='optimize',**inp.get('metadata',{}))
        max_steps=q['geometry_max_steps'] if args.mode=='optimize' else args.pilot_steps
        result['maximum_geometry_steps']=max_steps
        def host(value):
            array=cp.asnumpy(value) if cp is not None and isinstance(value,cp.ndarray) else np.asarray(value)
            array=np.asarray(array,dtype=float)
            if not np.isfinite(array).all():raise FloatingPointError('Nonfinite numerical result')
            return array
        def grid_hash(grid):
            return {'count':len(grid.weights),'coordinates_sha256':hashlib.sha256(host(grid.coords).tobytes()).hexdigest(),'weights_sha256':hashlib.sha256(host(grid.weights).tobytes()).hexdigest()}
        def build(positions,tag):
            mol=gto.M(atom=list(zip(inp['symbols'],host(positions).tolist())),unit='Angstrom',basis=inp['basis'],charge=0,spin=0,symmetry=False,max_memory=q['max_memory_MB'],verbose=4,output=str(out/(tag+'.log')))
            mf=dft.RKS(mol).density_fit(auxbasis=q['auxiliary_basis']);mf.xc=inp['method'];mf.grids.level=q['integration_grid_level'];mf.conv_tol=q['scf_energy_tolerance_hartree'];mf.max_cycle=q['scf_max_cycles'];mf.max_memory=q['max_memory_MB'];mf.chkfile=None
            mf.callback=lambda env:budget()
            return mf
        def compare(cpu_result,gpu_result):
            metrics=dict(energy_absolute_error_hartree=abs(cpu_result[0]-gpu_result[0]),gradient_max_absolute_error_hartree_per_bohr=float(np.max(np.abs(cpu_result[1]-gpu_result[1]))))
            return {**metrics,'passed':all(value<=LIMITS[name] for name,value in metrics.items())}
        class SharedGridScanner(lib.GradScanner):
            def __init__(self,initial):
                self.mol=initial.mol;self.base=initial;self.verbose=4;self.stdout=(out/'optimizer.log').open('w');self.last_density=None;self.last_cpu=None;self.last_result=None
            def __call__(self,molecule):
                budget();number=len(result['iterations'])+1;cpu=build(molecule.atom_coords(unit='Angstrom'),f'iteration-{number:03d}')
                # Exactly the CPU initialization/pruning procedure, with the
                # previous geometry density as in a normal SCF scanner.
                dm=cpu.get_init_guess() if self.last_density is None else self.last_density
                cpu.initialize_grids(cpu.mol,dm)
                reference_grid=grid_hash(cpu.grids)
                engine=cpu.to_gpu() if args.backend=='GPU' else cpu
                if args.backend=='GPU':
                    if not type(engine).__module__.startswith('gpu4pyscf'):raise RuntimeError('No GPU implementation')
                    engine.grids.coords=cp.asarray(cpu.grids.coords);engine.grids.weights=cp.asarray(cpu.grids.weights)
                if grid_hash(engine.grids)!=reference_grid:raise ValueError('CPU quadrature was not copied exactly')
                tick=time.monotonic();energy=float(engine.kernel(dm0=cp.asarray(dm) if cp is not None else dm))
                if cp is not None:cp.cuda.get_current_stream().synchronize()
                if not engine.converged or not np.isfinite(energy):raise ValueError('SCF did not converge')
                grad=engine.nuc_grad_method();grad.grid_response=False;values=host(grad.kernel())
                if cp is not None:cp.cuda.get_current_stream().synchronize();result['hardware_execution_verified']=True
                self.last_density=host(engine.make_rdm1());self.last_cpu=cpu;self.last_result=(energy,values);self.base=engine;self.mol=cpu.mol
                result['iterations'].append(dict(iteration=number,energy_hartree=energy,gradient_hartree_per_bohr=values.tolist(),positions_angstrom=cpu.mol.atom_coords(unit='Angstrom').tolist(),grid=reference_grid,elapsed_seconds=time.monotonic()-tick,scf_converged=True))
                save();budget();return energy,values
            def oracle(self):
                budget();cpu=self.last_cpu;tick=time.monotonic();energy=float(cpu.kernel(dm0=self.last_density));grad=cpu.nuc_grad_method();grad.grid_response=False;values=host(grad.kernel())
                if not cpu.converged or not np.isfinite(energy):raise ValueError('Independent CPU oracle did not converge')
                checked=compare((energy,values),self.last_result);checked.update(cpu_energy_hartree=energy,cpu_gradient_hartree_per_bohr=values.tolist(),elapsed_seconds=time.monotonic()-tick)
                budget();return checked
        initial=build(inp['positions_angstrom'],'initial');scanner=SharedGridScanner(initial)
        scanner(initial.mol);result['initial_comparison']=scanner.oracle();result['initial_scf_converged']=True;save()
        if not result['initial_comparison']['passed']:raise ValueError('Initial CPU/GPU comparison failed')
        constraint_path=None
        if inp['constraints']:
            constraint_path=out/'constraints.txt';constraint_path.write_text('$set\n'+'\n'.join('dihedral '+' '.join(str(i+1) for i in quartet)+f' {angle}' for quartet,angle in inp['constraints'])+'\n$end\n')
        converged,optimized=geometric_solver.kernel(scanner,constraints=str(constraint_path) if constraint_path else None,maxsteps=max_steps,assert_convergence=True,convergence_energy=1e-6,convergence_grms=3e-4,convergence_gmax=4.5e-4,convergence_drms=1.2e-3,convergence_dmax=1.8e-3,callback=lambda env:budget())
        scanner(optimized);result['final_comparison']=scanner.oracle();result['geometry_converged']=bool(converged);result['final_scf_converged']=True
        positions=host(optimized.atom_coords(unit='Angstrom'));result['positions_angstrom']=positions.tolist();write(out/'positions.json',positions.tolist())
        rings=[]
        for ring in inp['retained_ring_indices']:
            for a,b in zip(ring,ring[1:]+ring[:1]):
                distance=float(np.linalg.norm(positions[a]-positions[b]));rings.append(dict(atoms=[a,b],distance_angstrom=distance,passed=.9<=distance<=1.8))
        result['ring_bonds']=rings;result['energy_hartree']=scanner.last_result[0];result['energy_kJ_per_mol']=scanner.last_result[0]*2625.4996394799
        if not result['final_comparison']['passed'] or not all(row['passed'] for row in rings):raise ValueError('Final numerical/ring geometry gate failed')
        if args.mode=='pilot':
            atom=min(22,len(positions)-1);axis=1 if args.backend=='GPU' else 2;derivatives=[];observations=[]
            for step in [.001,.0005]:
                energies=[]
                for sign in [-1,1]:
                    budget();shifted=positions.copy();shifted[atom,axis]+=step*sign*lib.param.BOHR
                    cpu=build(shifted,f'pilot-fd-{step}-{sign}');cpu.initialize_grids(cpu.mol,scanner.last_density)
                    engine=cpu.to_gpu() if args.backend=='GPU' else cpu
                    if cp is not None:engine.grids.coords=cp.asarray(cpu.grids.coords);engine.grids.weights=cp.asarray(cpu.grids.weights)
                    if grid_hash(engine.grids)!=grid_hash(cpu.grids):raise ValueError('Finite-difference quadrature mismatch')
                    energy=float(engine.kernel(dm0=cp.asarray(scanner.last_density) if cp is not None else scanner.last_density))
                    if cp is not None:cp.cuda.get_current_stream().synchronize()
                    if not engine.converged or not math.isfinite(energy):raise ValueError('Finite-difference SCF failed')
                    energies.append(energy);observations.append(dict(step_bohr=step,sign=sign,energy_hartree=energy,grid=grid_hash(cpu.grids)))
                derivatives.append((energies[1]-energies[0])/(2*step))
            analytic=float(scanner.last_result[1][atom,axis]);limit=1e-4
            result['pilot_finite_difference']=dict(component=[atom,axis],analytic_gradient_hartree_per_bohr=analytic,steps_bohr=[.001,.0005],derivatives_hartree_per_bohr=derivatives,observations=observations,unchanged_gradient_agreement_limit=limit,passed=all(abs(value-analytic)<=limit for value in derivatives) and abs(derivatives[0]-derivatives[1])<=limit)
            if not result['pilot_finite_difference']['passed']:raise ValueError('Scanner pilot finite differences failed')
        if args.mode=='optimize':
            if not converged:raise ValueError('Original geometry convergence criteria not met')
            system=args.system or Path(inp['system'])
            if sha(system)!=inp['metadata']['source_sha256']['system.xml']:raise ValueError('Native endpoint System differs from frozen source')
            subprocess.run([str(args.mm_python),str(args.mm_reference_script),'--system',str(system),'--positions',str(out/'positions.json'),'--output',str(out/'mm_reference.json')],check=True,timeout=min(120,max(.1,args.max_seconds-(time.monotonic()-started))))
            reference=json.loads((out/'mm_reference.json').read_text())
            if not math.isfinite(reference['energy_kJ_per_mol']) or any(not math.isfinite(row['energy_kJ_per_mol']) for row in reference['components']):raise ValueError('Nonfinite native MM reference')
            result['mm_reference']=reference;result['status']='completed'
        else:result['status']='passed_gpu_optimization_pilot' if args.backend=='GPU' else 'passed_cpu_test_only'
        budget();result['passed']=True;scanner.stdout.close()
    except Exception as error:
        result.update(status='failed',passed=False,error=dict(type=type(error).__name__,message=str(error)));(out/'failure.log').write_text(traceback.format_exc())
    result['elapsed_seconds']=time.monotonic()-started;save();print(json.dumps({'status':result['status'],'elapsed_seconds':result['elapsed_seconds'],'hardware_execution_verified':result['hardware_execution_verified']}),flush=True)
    return 0 if result.get('passed') else 2


if __name__=='__main__':raise SystemExit(main())
