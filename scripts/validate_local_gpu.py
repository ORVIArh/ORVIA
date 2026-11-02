#!/usr/bin/env python3
"""Local preparation GPU accuracy probe; no production scientific result."""
from pathlib import Path
import argparse
import json,hashlib,time,math,random,ctypes as c
import numpy as np
import openmm as mm
from openmm import unit
parser=argparse.ArgumentParser(description='Compare actual local OpenCL GPU with OpenMM Reference on prepared endpoint fixtures.')
parser.add_argument('--endpoint-root',type=Path,required=True)
parser.add_argument('--output',type=Path,default=Path('reports/local_gpu_validation.json'))
args=parser.parse_args()
base=args.endpoint_root
output=args.output
output.parent.mkdir(parents=True,exist_ok=True)
# Fixed before evaluating either endpoint. Single precision is a preparation/reference accelerator, not an oracle for on-chain arithmetic.
tolerances={'energy_absolute_kJ_mol':0.01,'force_max_absolute_kJ_mol_nm':0.05,'force_relative_L2':5e-5,'trajectory_position_RMS_nm':1e-5}
def observe(ctx):
 state=ctx.getState(getEnergy=True,getForces=True)
 return float(state.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole)),np.asarray(state.getForces(asNumpy=True).value_in_unit(unit.kilojoule_per_mole/unit.nanometer))
def metrics(ref,gpu):
 re,rf=ref;ge,gf=gpu;diff=gf-rf
 return {'energy_absolute_kJ_mol':abs(ge-re),'force_max_absolute_kJ_mol_nm':float(np.max(np.abs(diff))),'force_relative_L2':float(np.linalg.norm(diff)/max(np.linalg.norm(rf),1e-12)),'reference_energy_kJ_mol':re,'gpu_energy_kJ_mol':ge,'reference_force_L2':float(np.linalg.norm(rf))}
report={'schema_version':'orvia.local-gpu-validation.v1','scope':'Actual Apple M5 OpenCL single-precision preparation/reference checks on real41/44-atom ligand endpoints; no full cardiac model, production inference, on-chain transaction or sampling-convergence claim.','openmm_version':mm.version.full_version,'validator_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'tolerances_predeclared':tolerances,'endpoint_checks':[],'production_ready':False}
for endpoint in ['A','B']:
 started=time.time();p=base/endpoint;source=(p/'system.xml').read_text();params=json.loads((p/'parameters.json').read_text());positions=np.array(params['positions_nm'],dtype=float)
 contexts=[];integrators=[]
 try:
  for platform,props in [('Reference',{}),('OpenCL',{'Precision':'single','DeviceIndex':'0','OpenCLPlatformIndex':'0'})]:
   integrator=mm.VerletIntegrator(0.0002*unit.picoseconds);integrators.append(integrator)
   context=mm.Context(mm.XmlSerializer.deserialize(source),integrator,mm.Platform.getPlatformByName(platform),props);contexts.append(context)
  platform=contexts[1].getPlatform();properties={k:platform.getPropertyValue(contexts[1],k) for k in platform.getPropertyNames()}
  scenarios=[];rng=np.random.default_rng(9917)
  for index in range(9):
   sample=positions if index==0 else positions+rng.normal(0,0.002,positions.shape)
   for ctx in contexts:ctx.setPositions(sample*unit.nanometer)
   record=metrics(observe(contexts[0]),observe(contexts[1]));record['scenario']='original' if index==0 else f'perturbation_{index}'
   record['passed']=all(math.isfinite(record[key]) and record[key]<=tolerances[key] for key in ['energy_absolute_kJ_mol','force_max_absolute_kJ_mol_nm','force_relative_L2'])
   scenarios.append(record)
  for ctx in contexts:ctx.setPositions(positions*unit.nanometer);ctx.setVelocities(np.zeros(positions.shape)*unit.nanometer/unit.picosecond)
  for integrator in integrators:integrator.step(20)
  trajectory_positions=[np.asarray(ctx.getState(getPositions=True).getPositions(asNumpy=True).value_in_unit(unit.nanometer)) for ctx in contexts]
  position_rms=float(np.sqrt(np.mean((trajectory_positions[1]-trajectory_positions[0])**2)))
  trajectory_pass=position_rms<=tolerances['trajectory_position_RMS_nm']
  final=metrics(observe(contexts[0]),observe(contexts[1]))
  trajectory_pass=trajectory_pass and all(final[key]<=tolerances[key] for key in ['energy_absolute_kJ_mol','force_max_absolute_kJ_mol_nm','force_relative_L2'])
  contexts[1].setPositions(positions*unit.nanometer)
  mm.LocalEnergyMinimizer.minimize(contexts[1],1.0*unit.kilojoule_per_mole/unit.nanometer,1000)
  minimized=contexts[1].getState(getPositions=True).getPositions()
  contexts[0].setPositions(minimized)
  minimized_comparison=metrics(observe(contexts[0]),observe(contexts[1]))
  minimized_comparison['passed']=all(minimized_comparison[key]<=tolerances[key] for key in ['energy_absolute_kJ_mol','force_max_absolute_kJ_mol_nm','force_relative_L2'])
  report['endpoint_checks'].append({'endpoint':endpoint,'atoms':params['atom_count'],'input_sha256':{n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in ['system.xml','parameters.json']},'gpu_properties':properties,'scenarios':scenarios,'deterministic_short_trajectory':{'steps':20,'dt_ps':0.0002,'position_RMS_difference_nm':position_rms,'final_comparison':final},'external_gpu_minimized_fixture':minimized_comparison,'trajectory_passed':trajectory_pass,'elapsed_seconds':time.time()-started,'passed':all(s['passed'] for s in scenarios) and trajectory_pass})
 finally:
  contexts.clear();integrators.clear()
report['status']='passed' if all(e['passed'] for e in report['endpoint_checks']) else 'failed_strict_single_precision_tolerance'
report['hardware_execution_verified']=all(e['gpu_properties']['Precision']=='single' for e in report['endpoint_checks'])
report['strict_numerical_acceptance']=report['status']=='passed'
report['recommended_use']='Single GPU for external coordinate preparation with independent Reference/CPU final cleanup and audit; not a double-precision or on-chain arithmetic oracle.'
output.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'status':report['status'],'report':str(output),'endpoints':[(e['endpoint'],e['atoms'],e['gpu_properties'],max(s['energy_absolute_kJ_mol'] for s in e['scenarios']),max(s['force_max_absolute_kJ_mol_nm'] for s in e['scenarios']),e['deterministic_short_trajectory']['position_RMS_difference_nm']) for e in report['endpoint_checks']]},indent=2))

raise SystemExit(0 if report['status']=='passed' else 2)
