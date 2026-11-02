#!/usr/bin/env python3
"""Bounded diagnostic coordinate relaxation. Does not approve a model or mutate inputs."""
import argparse, hashlib, json, math, os, time
from pathlib import Path

STAGES = [(1000.0, 200), (100.0, 200), (0.0, 400)]
TOLERANCES = {'energy_absolute_kJ_mol': 0.01, 'force_max_absolute_kJ_mol_nm': 0.05, 'force_relative_L2': 5e-5}
FORCE_MARGIN = 2**26  # Margin only; independent-engine comparison remains required.

def digest(b): return hashlib.sha256(b).hexdigest()
def write(path, obj):
    temporary = path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(obj, indent=2, allow_nan=False)+'\n'); temporary.replace(path)

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--system',type=Path,required=True);ap.add_argument('--positions',type=Path,required=True)
    ap.add_argument('--output-dir',type=Path,required=True);ap.add_argument('--precision',choices=['mixed','double'],default='double')
    ap.add_argument('--platform',choices=['CUDA','Reference'],default='CUDA')
    ap.add_argument('--precheck-platform',choices=['CPU','Reference'],default='CPU')
    ap.add_argument('--max-seconds',type=float,default=180)
    args=ap.parse_args()
    if not math.isfinite(args.max_seconds) or not 0<args.max_seconds<=600:ap.error('max-seconds must be in (0,600]')
    args.output_dir.mkdir(parents=True,exist_ok=True)
    if any(args.output_dir.iterdir()):ap.error('output-dir must be empty')
    started=time.perf_counter();report={'schema':'orvia.gpu-coordinate-repair-diagnostic.v1','status':'in_progress','passed':False,'production_ready':False,'scientific_acceptance':False,'input_files_modified':False,'stages':[],'predeclared':{'restraint_k_kJ_mol_nm2_and_max_iterations':STAGES,'minimizer_force_tolerance_kJ_mol_nm':10.0,'force_margin_kJ_mol_nm':FORCE_MARGIN,'comparison_tolerances':TOLERANCES,'nve_steps':10,'nve_dt_fs':0.1},'script_sha256':digest(Path(__file__).read_bytes()),'requested_platform':args.platform,'requested_precision':args.precision,'requested_precheck_platform':args.precheck_platform,'hardware_execution_verified':False,'contexts':{},'time_limit':{'cooperative_seconds':args.max_seconds,'external_process_group_watchdog_required':True,'note':'Context construction and native force calls cannot be interrupted by cooperative budget checks.'},'reference_test_mode':args.platform=='Reference'}
    path=args.output_dir/'repair-report.json';write(path,report)
    contexts=[]
    try:
        import numpy as np, openmm as mm
        from openmm import unit
        xml=args.system.read_bytes();raw=args.positions.read_bytes();data=json.loads(raw)
        positions=np.asarray(data['positions_nm'] if isinstance(data,dict) else data,dtype=float)
        original=mm.XmlSerializer.deserialize(xml.decode())
        if positions.shape!=(original.getNumParticles(),3) or not np.isfinite(positions).all():raise ValueError('Finite matching Nx3 positions required')
        box=np.asarray([v.value_in_unit(unit.nanometer) for v in original.getDefaultPeriodicBoxVectors()],dtype=float)
        if box.shape!=(3,3) or not np.isfinite(box).all():raise ValueError('Finite XML box required')
        if isinstance(data,dict):
            for field in ['box_vectors_nm','box_nm']:
                if field not in data:continue
                supplied=np.asarray(data[field],dtype=float)
                if supplied.shape==(3,):supplied=np.diag(supplied)
                if supplied.shape!=(3,3) or not np.isfinite(supplied).all() or not np.array_equal(supplied,box):
                    raise ValueError('Position-file box differs from immutable System XML: '+field)
        def position_payload(value):return {'positions_nm':value.tolist(),'box_vectors_nm':box.tolist()}
        report['inputs']={'system_sha256':digest(xml),'positions_sha256':digest(raw),'particles':len(positions),'constraints':original.getNumConstraints(),'force_types':[original.getForce(i).__class__.__name__ for i in range(original.getNumForces())]}
        report['inputs']['box_vectors_nm']=box.tolist();report['inputs']['periodic']=original.usesPeriodicBoundaryConditions()
        report['openmm_version']=mm.version.full_version
        report['numpy_version']=np.__version__
        def budget():
            if time.perf_counter()-started>args.max_seconds:raise TimeoutError('Diagnostic time budget exhausted')
        def context(system,platform,role):
            integrator=mm.VerletIntegrator(0.0001*unit.picoseconds);integrator.setConstraintTolerance(1e-8)
            props={'Precision':args.precision,'DeviceIndex':'0'} if platform=='CUDA' else {}
            if platform=='CPU':props={'Threads':'4'}
            c=mm.Context(system,integrator,mm.Platform.getPlatformByName(platform),props);contexts.append((c,integrator))
            actual=c.getPlatform();properties={name:actual.getPropertyValue(c,name) for name in actual.getPropertyNames()}
            report['contexts'][role]={'actual_platform':actual.getName(),'actual_properties':properties}
            if actual.getName()!=platform or platform=='CUDA' and properties.get('Precision')!=args.precision:
                raise RuntimeError('Requested platform/precision was not used')
            return c,integrator
        cpu,_=context(original,args.precheck_platform,'independent')
        cpu.setPositions(positions*unit.nanometer);cpu.applyConstraints(1e-8)
        positions=np.asarray(cpu.getState(getPositions=True).getPositions(asNumpy=True).value_in_unit(unit.nanometer))
        if not np.isfinite(positions).all():raise FloatingPointError('Nonfinite constraint-projected coordinates')
        write(args.output_dir/'projected-initial-positions.json',position_payload(positions))
        def observe(c):
            s=c.getState(getEnergy=True,getForces=True);energy=float(s.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole));force=np.asarray(s.getForces(asNumpy=True).value_in_unit(unit.kilojoule_per_mole/unit.nanometer))
            if not math.isfinite(energy) or not np.isfinite(force).all():raise FloatingPointError('Nonfinite energy/force')
            return energy,force
        def norm(value):
            if not np.isfinite(value).all():raise FloatingPointError('Nonfinite force differences')
            scale=float(np.max(np.abs(value)));result=0.0 if scale==0 else scale*float(np.sqrt(np.sum((value/scale)**2)))
            if not math.isfinite(result):raise FloatingPointError('Force norm overflow')
            return result
        def summary(value):return{'energy_kJ_mol':value[0],'max_abs_force_kJ_mol_nm':float(np.max(np.abs(value[1]))),'force_L2':norm(value[1])}
        def compare(a,b):
            delta=b[1]-a[1];reference_norm=norm(a[1]);difference_norm=norm(delta)
            metrics={'energy_absolute_kJ_mol':abs(b[0]-a[0]),'force_max_absolute_kJ_mol_nm':float(np.max(np.abs(delta))),'force_relative_L2':difference_norm/max(reference_norm,1e-12)}
            if not all(math.isfinite(v) for v in metrics.values()):raise FloatingPointError('Comparison metric overflow')
            metrics['passed']=all(v<=TOLERANCES[k] for k,v in metrics.items())
            metrics.update(reference_energy_kJ_mol=a[0],target_energy_kJ_mol=b[0],reference_force_L2=reference_norm,force_difference_L2=difference_norm)
            return metrics
        independent=observe(cpu);report['initial_independent']=summary(independent);write(path,report)
        if report['initial_independent']['max_abs_force_kJ_mol_nm']>=FORCE_MARGIN:raise ValueError('Independent initial force exceeds declared margin; no CUDA minimization attempted')
        budget();native_gpu,_=context(original,args.platform,'native_target');native_gpu.setPositions(positions*unit.nanometer)
        initial_target=observe(native_gpu);report['initial_target']=summary(initial_target);report['initial_comparison']=compare(independent,initial_target);write(path,report)
        report['hardware_execution_verified']=args.platform=='CUDA';report['actual_platform']=native_gpu.getPlatform().getName()
        report['actual_properties']=report['contexts']['native_target']['actual_properties'];write(path,report)
        if not report['initial_comparison']['passed']:raise ValueError('Initial independent/target strict force comparison failed; no minimization')
        restrained=mm.XmlSerializer.deserialize(xml.decode())
        expression='0.5*repair_k*periodicdistance(x,y,z,x0,y0,z0)^2' if original.usesPeriodicBoundaryConditions() else '0.5*repair_k*((x-x0)^2+(y-y0)^2+(z-z0)^2)'
        restraint=mm.CustomExternalForce(expression);restraint.addGlobalParameter('repair_k',1000.0)
        for name in ['x0','y0','z0']:restraint.addPerParticleParameter(name)
        for i,p in enumerate(positions):restraint.addParticle(i,list(map(float,p)))
        restrained.addForce(restraint);relax,_=context(restrained,args.platform,'restrained_target');relax.setPositions(positions*unit.nanometer)
        class StopAtBudget(mm.MinimizationReporter):
            def report(self,iteration,x,grad,args):return time.perf_counter()-started>args_outer.max_seconds
        args_outer=args
        for number,(strength,iterations) in enumerate(STAGES):
            budget();tick=time.perf_counter();relax.setParameter('repair_k',strength)
            mm.LocalEnergyMinimizer.minimize(relax,10.0*unit.kilojoule_per_mole/unit.nanometer,iterations,StopAtBudget())
            state=relax.getState(getPositions=True);positions=np.asarray(state.getPositions(asNumpy=True).value_in_unit(unit.nanometer))
            if not np.isfinite(positions).all():raise FloatingPointError('Nonfinite relaxed coordinates')
            position_file=args.output_dir/f'stage-{number}-positions.json';write(position_file,position_payload(positions))
            row={'stage':number,'restraint_k':strength,'max_iterations':iterations,'elapsed_seconds':time.perf_counter()-tick,'positions_sha256':digest(position_file.read_bytes()),'restrained_state':summary(observe(relax))}
            report['stages'].append(row);write(path,report);budget()
        cpu.setPositions(positions*unit.nanometer);native_gpu.setPositions(positions*unit.nanometer)
        final_cpu=observe(cpu);final_gpu=observe(native_gpu);report['final_independent']=summary(final_cpu);report['final_target']=summary(final_gpu);report['final_comparison']=compare(final_cpu,final_gpu);write(path,report)
        if report['final_independent']['max_abs_force_kJ_mol_nm']>=FORCE_MARGIN or not report['final_comparison']['passed']:raise ValueError('Final original-System force margin/strict comparison failed')
        native_gpu.setVelocities(np.zeros_like(positions)*unit.nanometer/unit.picosecond)
        report['nve_diagnostic']=[]
        integrator=native_gpu.getIntegrator()
        for step in range(1,11):
            budget();integrator.step(1);current=observe(native_gpu);row={'step':step,**summary(current)}
            if row['max_abs_force_kJ_mol_nm']>=FORCE_MARGIN:raise ValueError('NVE force exceeds declared margin')
            report['nve_diagnostic'].append(row);write(path,report)
        final=native_gpu.getState(getPositions=True);positions=np.asarray(final.getPositions(asNumpy=True).value_in_unit(unit.nanometer))
        if not np.isfinite(positions).all():raise FloatingPointError('Nonfinite final positions')
        write(args.output_dir/'final-positions.json',position_payload(positions));(args.output_dir/'final-checkpoint.chk').write_bytes(native_gpu.createCheckpoint())
        cpu.setPositions(positions*unit.nanometer);report['post_nve_comparison']=compare(observe(cpu),observe(native_gpu))
        if not report['post_nve_comparison']['passed']:raise ValueError('Post-NVE strict comparison failed')
        budget();report['passed']=True;report['status']='passed_diagnostic_only'
    except Exception as error:
        report['status']='failed';report['error']={'type':type(error).__name__,'message':str(error)[:2000]}
    finally:
        report['elapsed_seconds']=time.perf_counter()-started;write(path,report);contexts.clear()
    print(json.dumps({'passed':report['passed'],'status':report['status'],'output':str(path),'production_ready':False}))
    return 0 if report['passed'] else 1
if __name__=='__main__':raise SystemExit(main())
