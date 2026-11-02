#!/usr/bin/env python3
"""Bounded fixed-frame PME/grid and per-force diagnostics. Run under outer watchdog."""
import argparse,hashlib,json,time,traceback
from pathlib import Path
import numpy as np
import openmm as mm
from openmm import unit

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def norm(x):
 m=float(np.max(np.abs(x),initial=0));return 0. if not m else m*float(np.sqrt(np.sum((x/m)**2)))
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--system',type=Path,required=True);ap.add_argument('--positions',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);ap.add_argument('--align-grid',action='store_true');ap.add_argument('--device-index',default='0');ap.add_argument('--max-wall-seconds',type=float,default=180);a=ap.parse_args();start=time.perf_counter();a.output.parent.mkdir(parents=True,exist_ok=True)
 if a.output.exists():raise FileExistsError(a.output)
 report={'schema':'orvia.fixed-frame-pme-component-probe.v1','status':'in_progress','completed':False,'scientificAcceptance':False,'openmmVersion':getattr(mm.version,'full_version',mm.__version__),'inputs':{'systemSha256':sha(a.system),'positionsSha256':sha(a.positions),'scriptSha256':sha(__file__)},'contexts':[],'comparisons':[],'warning':'Internal deadline checks cannot interrupt native calls; mandatory external process-group watchdog.'}
 def save():a.output.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
 def budget():
  if time.perf_counter()-start>a.max_wall_seconds:raise TimeoutError('Probe wall budget exceeded between operations')
 save()
 try:
  raw=a.system.read_text();system=mm.XmlSerializer.deserialize(raw);position_data=json.loads(a.positions.read_text());xyz=np.array(position_data['positions_nm']);assert xyz.shape==(system.getNumParticles(),3)and np.isfinite(xyz).all();box=np.array([[v.value_in_unit(unit.nanometer)for v in row]for row in system.getDefaultPeriodicBoxVectors()]);assert np.allclose(box,np.array(position_data['box_vectors_nm']),rtol=0,atol=1e-9)
  labels={};nb=None
  for i,f in enumerate(system.getForces()):
   f.setForceGroup(i);labels[i]=str(i)+':'+type(f).__name__
   if isinstance(f,mm.NonbondedForce):
    assert nb is None;nb=f
  assert nb is not None and nb.getNonbondedMethod()==mm.NonbondedForce.PME
  reciprocal=system.getNumForces();nb.setReciprocalSpaceForceGroup(reciprocal);labels[reciprocal]=str(reciprocal)+':NonbondedForce.reciprocal';labels[nb.getForceGroup()]=str(nb.getForceGroup())+':NonbondedForce.direct';group_xml=mm.XmlSerializer.serialize(system)
  report['forceGroups']={str(k):v for k,v in labels.items()};report['atoms']=system.getNumParticles();report['constraints']=system.getNumConstraints();report['nativeEwaldErrorTolerance']=nb.getEwaldErrorTolerance()
  tolerance={'energyAbsoluteKjMol':.01,'maxForceAbsoluteKjMolNm':.05,'relativeForceL2':5e-5};report['diagnosticStrictThresholds']=tolerance
  def create(platform,explicit=None):
   budget();s=mm.XmlSerializer.deserialize(group_xml);f=next(f for f in s.getForces()if isinstance(f,mm.NonbondedForce))
   if explicit:f.setPMEParameters(explicit[0],*explicit[1:])
   integrator=mm.VerletIntegrator(.001*unit.picosecond);p=mm.Platform.getPlatformByName(platform);props={'Precision':'double','DeviceIndex':a.device_index,'UseCpuPme':'false'}if platform=='CUDA'else{}
   context=mm.Context(s,integrator,p,props);context.setPositions(xyz*unit.nanometer);actual={name:p.getPropertyValue(context,name)for name in p.getPropertyNames()};assert context.getPlatform().getName()==platform
   if platform=='CUDA':assert actual['Precision']=='double'and actual['UseCpuPme']=='false'
   params=f.getPMEParametersInContext(context);alpha=params[0];alpha=float(alpha.value_in_unit(1/unit.nanometer))if hasattr(alpha,'value_in_unit')else float(alpha);params=[alpha,*map(int,params[1:])]
   record={'platform':platform,'properties':actual,'requestedExplicitPME':explicit,'actualPMEAlphaInvNmAndGrid':params,'components':[]};report['contexts'].append(record);save();values={}
   for key,mask in [('total',-1)]+[(labels[i],1<<i)for i in labels]:
    budget();t=time.perf_counter();state=context.getState(getEnergy=True,getForces=True,groups=mask);energy=float(state.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole));force=np.array(state.getForces(asNumpy=True).value_in_unit(unit.kilojoule_per_mole/unit.nanometer));assert np.isfinite(energy)and np.isfinite(force).all();values[key]=(energy,force);record['components'].append({'name':key,'energyKjMol':energy,'forceL2':norm(force),'maximumAbsForce':float(np.max(np.abs(force))),'elapsedSeconds':time.perf_counter()-t});save()
   del context,integrator
   return values,params
  reference,refparams=create('Reference')
  def compare(name,ref,refparams,target,params):
   rows=[]
   for key,(energy,force)in ref.items():
    e,f=target[key];delta=f-force;maximum=float(np.max(np.abs(delta)));relative=norm(delta)/max(norm(force),1e-12);ed=abs(e-energy);passed=ed<=.01 and maximum<=.05 and relative<=5e-5;rows.append({'component':key,'referenceEnergy':energy,'targetEnergy':e,'energyAbsoluteDifference':ed,'maximumForceDifference':maximum,'relativeForceL2':relative,'strictDiagnosticPassed':passed})
   report['comparisons'].append({'name':name,'referencePME':refparams,'targetPME':params,'gridAndAlphaEqual':refparams==params,'components':rows});save()
  target,cudaparams=create('CUDA');compare('CUDA_auto',reference,refparams,target,cudaparams)
  if a.align_grid:
   aligned,alignedparams=create('CUDA',refparams);compare('CUDA_reference_grid',reference,refparams,aligned,alignedparams)
   if alignedparams!=refparams:
    opposite,oppositeparams=create('Reference',cudaparams)
    compare('CUDA_auto_vs_Reference_CUDA_grid',opposite,oppositeparams,target,cudaparams)
  budget();assert sha(a.system)==report['inputs']['systemSha256']and sha(a.positions)==report['inputs']['positionsSha256'];report['completed']=True;report['status']='completed_diagnostic_not_physical_acceptance'
 except Exception as e:report.update(status='failed_or_incomplete',error={'message':str(e),'traceback':traceback.format_exc()});raise
 finally:report['elapsedSeconds']=time.perf_counter()-start;save()
if __name__=='__main__':main()
