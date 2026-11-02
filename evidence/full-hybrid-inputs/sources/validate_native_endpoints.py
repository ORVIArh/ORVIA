#!/usr/bin/env python3
"""Source-bound C4 component diagnostics; no hybrid activity/coupling admission."""
from __future__ import annotations
from pathlib import Path
from collections import Counter
import argparse,datetime,gzip,hashlib,importlib.util,inspect,json,math,struct,tempfile,time,traceback
import mpmath as mp
import numpy as np
import openmm as mm
from openmm import app,unit,version
from openmm.app.internal import amber_file_parser

HERE=Path(__file__).resolve().parent
ASSEMBLY=HERE.parent
ROOT=ASSEMBLY.parents[1]
SCI=ROOT/'work/scientific-preparation/data/prepared_candidate'
COMPLEX=SCI/'cardiac_adppi_ff03_m3l_33_782_solvated_v0_1'
LIG=SCI/'ligand_endpoints_v0_1'
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):
 p=Path(p);return json.loads(gzip.decompress(p.read_bytes())if p.suffix=='.gz'else p.read_bytes())
def encoded(v):return(json.dumps(v,sort_keys=True,indent=2,allow_nan=False)+'\n').encode()
def save(p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(encoded(v))
def quad(v):
 b=struct.unpack('>Q',struct.pack('>d',float(v)))[0];s=b>>63;e=(b>>52)&2047;f=b&((1<<52)-1)
 if not math.isfinite(float(v)):raise ValueError('Nonfinite C4 coefficient')
 if not e:
  if f:raise ValueError('Unexpected subnormal C4 coefficient')
  return 0
 return(s<<127)|((e-1023+16383)<<112)|(f<<60)
def stream(p,values,indices=False):
 data=b''.join((int(v)if indices else quad(v)).to_bytes(32,'big')for v in values)
 with p.open('wb')as f:
  with gzip.GzipFile(fileobj=f,mode='wb',filename='',mtime=0)as g:g.write(data)
 return{'path':str(p.relative_to(HERE)),'words':len(data)//32,'rawSha256':sha(data),'gzipSha256':sha(p.read_bytes()),'gzipBytes':p.stat().st_size,'scalarEncoding':'uint256'if indices else'exact binary128 embedding of pinned importer binary64 coefficient'}
def read_force(system):
 forces=[f for f in system.getForces()if isinstance(f,mm.CustomNonbondedForce)]
 assert len(forces)==1
 f=forces[0];assert f.getNumPerParticleParameters()==1 and f.getPerParticleParameterName(0)=='type'
 assert f.getNumInteractionGroups()==0 and f.getNumGlobalParameters()==0 and f.getNumComputedValues()==0
 names=[f.getTabulatedFunctionName(i)for i in range(f.getNumTabulatedFunctions())];assert names in (['ccoef'],['acoef','bcoef','ccoef'])
 if names==['ccoef']:assert f.getEnergyFunction()=='-c/r^4; c=ccoef(type1, type2)'
 return f
def force_from(template,types,exclusions,lrc_override=None):
 f=mm.CustomNonbondedForce(template.getEnergyFunction());f.setName(template.getName())
 f.addPerParticleParameter('type')
 for i in range(template.getNumTabulatedFunctions()):
  name=template.getTabulatedFunctionName(i);x,y,values=template.getTabulatedFunction(i).getFunctionParameters()
  f.addTabulatedFunction(name,mm.Discrete2DFunction(x,y,values if name=='ccoef'else[0.]*len(values)))
 for t in types:f.addParticle([int(t)])
 for a,b in exclusions:f.addExclusion(int(a),int(b))
 f.setNonbondedMethod(template.getNonbondedMethod());f.setCutoffDistance(template.getCutoffDistance());f.setUseLongRangeCorrection(template.getUseLongRangeCorrection()if lrc_override is None else lrc_override)
 f.setUseSwitchingFunction(template.getUseSwitchingFunction());f.setSwitchingDistance(template.getSwitchingDistance())
 return f
def matrix_of(force):
 index=next(i for i in range(force.getNumTabulatedFunctions())if force.getTabulatedFunctionName(i)=='ccoef')
 x,y,values=force.getTabulatedFunction(index).getFunctionParameters();assert x==y
 matrix=np.asarray(values,dtype=np.float64).reshape((x,y),order='F');assert np.array_equal(matrix,matrix.T)
 return matrix
def analytic_sparse(positions,types,matrix,box,periodic,cutoff):
 """Independent 90-digit explicit -C4/r4 gradient; actual source has one Mg."""
 mp.mp.dps=90;xyz=np.asarray(positions);types=np.asarray(types);mgs=np.flatnonzero(types==32);assert len(mgs)==1;mg=int(mgs[0])
 nz=np.argwhere(matrix!=0);assert all(a==32 or b==32 for a,b in nz)
 partners=np.flatnonzero((matrix[32,types]!=0)&(np.arange(len(types))!=mg))
 force=np.zeros_like(xyz);energy=mp.mpf(0);accum=[mp.mpf(0)]*3;inside=0;minimum_margin=mp.inf
 p0=[mp.mpf(float(v))for v in xyz[mg]];length=[mp.mpf(float(v))for v in box];rc=mp.mpf(cutoff)
 for atom in partners:
  d=[mp.mpf(float(xyz[atom,k]))-p0[k]for k in range(3)]
  if periodic:
   for k in range(3):
    d[k]-=int(d[k]/length[k])*length[k]
    if d[k]>length[k]/2:d[k]-=length[k]
    elif d[k]<-length[k]/2:d[k]+=length[k]
  r2=sum(v*v for v in d);assert r2>0
  if periodic:
   minimum_margin=min(minimum_margin,abs(r2-rc*rc))
   if r2>=rc*rc:continue
  inside+=1;c=mp.mpf(float(matrix[32,types[atom]]));energy-=c/(r2*r2);factor=4*c/(r2*r2*r2)
  for k in range(3):
   value=factor*d[k];accum[k]+=value;force[atom,k]=-float(value)
 force[mg]=list(map(float,accum))
 return energy,force,{'nonzeroMgPairsBeforeCutoff':len(partners),'includedPairs':inside,'minimumSquaredCutoffMarginNm2':None if not periodic else mp.nstr(minimum_margin,30),'MgPhysicalIndex':mg,'nativeMgMgCoefficientKjNm4':float(matrix[32,32]),'physicalSelfPairAbsentButNativeLrcClassSelfTermRetained':True}
def get_gpu(force,masses,positions,box):
 system=mm.System()
 for mass in masses:system.addParticle(float(mass)*unit.dalton)
 system.setDefaultPeriodicBoxVectors(mm.Vec3(box[0],0,0),mm.Vec3(0,box[1],0),mm.Vec3(0,0,box[2]));system.addForce(force)
 integrator=mm.VerletIntegrator(.001*unit.picosecond);platform=mm.Platform.getPlatformByName('OpenCL');start=time.perf_counter();context=mm.Context(system,integrator,platform,{'Precision':'single'})
 try:
  context.setPositions(np.asarray(positions)*unit.nanometer);state=context.getState(getEnergy=True,getForces=True)
  energy=float(state.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole));forces=np.asarray(state.getForces(asNumpy=True).value_in_unit(unit.kilojoule_per_mole/unit.nanometer)).copy();props={}
  for name in platform.getPropertyNames():
   try:props[name]=platform.getPropertyValue(context,name)
   except Exception:pass
  assert math.isfinite(energy)and np.isfinite(forces).all()
  return energy,forces,{'platform':platform.getName(),'properties':props,'secondsIncludingContext':time.perf_counter()-start,'stepsIntegrated':0}
 finally:del context,integrator,system

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--native-b-only',action='store_true');args=parser.parse_args()
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');run=HERE/'attempts'/stamp;run.mkdir(parents=True,exist_ok=False)
 policy={'schema':'orvia.c4-physical-endpoint-diagnostic-policy.v1','preregisteredBeforeFirstEnergy':True,'oracleDecimalDigits':90,
  'physicalEndpoints':['nativeB44','derivedPhysicalA41'],'derivedAStatus':'C4-only reference derived from pinned native matrix and A native atom types/exclusions at preserved assembled coordinates; not a complete native A system.',
  'diagnosticMethods':['nativeNoCutoff_noLRC','nativeCutoffPeriodic1nm_LRC','counterfactualCutoffPeriodic1nm_noLRC'],
  'switching':'Pinned OpenMM Amber importer leaves C4 custom force unswitched; require false.',
  'gpuEnergyTolerance':{'absolute':1e-3,'relative':2e-5,'additionalLrcAbsolute':1e-6,'additionalLrcRelative':2e-5},
  'gpuForcePerComponentTolerance':{'absolute':1e-3,'relative':5e-5},'lrcAnalyticEnergyTolerance':{'absolute':1e-6,'relative':2e-5},
  'referenceSmallFixturePolicy':'Independent script preregisters1e-8+1e-10relative direct E/F and1e-6+2e-5relative LRC.',
  'inactiveRetainedHybridGhostC4Activity':None,'lambdaC4Coupling':None,'scientificAcceptance':False,'productionReady':False,'fullCompositionExecutable':False}
 save(run/'policy.json',policy)
 summary={'schema':'orvia.c4-physical-endpoint-validation.v1','status':'in_progress','passed':False,'policySha256':sha((run/'policy.json').read_bytes()),'scriptSha256':sha(Path(__file__).read_bytes()),'sources':[],'cases':[],'failures':[],'scientificAcceptance':False,'productionReady':False,'alchemicalC4PolicyAccepted':False,'mainnetTransactionsSent':0,'engineVersion':version.full_version,'engineGitRevision':version.git_revision,'engineRelease':version.release}
 destination=run/'summary.json'
 def update():save(destination,summary)
 update()
 try:
  helper=HERE/'independent-lrc/analytic_c4.py';spec=importlib.util.spec_from_file_location('independent_c4_analytic',helper);oracle=importlib.util.module_from_spec(spec);spec.loader.exec_module(oracle)
  sources=[Path(__file__),helper,Path(inspect.getsourcefile(amber_file_parser)),COMPLEX/'complex_1264.prmtop.gz',COMPLEX/'complex.inpcrd.gz',LIG/'A/ligand.prmtop',LIG/'A/parameters.json',LIG/'B/parameters.json',LIG/'hybrid_model.json',ASSEMBLY/'legs/complex33/catalog-candidate.json',ASSEMBLY/'legs/complex33/global-map.json.gz',ASSEMBLY/'legs/complex33/A.parameters.json.gz']
  import openmm._openmm as binding
  sources.append(Path(binding.__file__))
  for p in sources:summary['sources'].append({'path':str(p),'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())})
  plugin=Path(mm.Platform.getDefaultPluginsDirectory());prefix=Path(__import__('sys').executable).parents[1]
  for p in sorted(set(list(plugin.glob('*OpenMM*'))+list((prefix/'lib').glob('libOpenMM*.dylib')))):
   if p.is_file():summary['sources'].append({'path':str(p),'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())})
  (run/'pinned-amber-file-parser.py').write_bytes(Path(inspect.getsourcefile(amber_file_parser)).read_bytes());update()
  with tempfile.TemporaryDirectory(prefix='native-',dir=run)as temporary:
   tmp=Path(temporary);topfile=tmp/'native.prmtop';coordfile=tmp/'native.inpcrd';topfile.write_bytes(gzip.decompress((COMPLEX/'complex_1264.prmtop.gz').read_bytes()));coordfile.write_bytes(gzip.decompress((COMPLEX/'complex.inpcrd.gz').read_bytes()))
   top=app.AmberPrmtopFile(str(topfile));coordinates=app.AmberInpcrdFile(str(coordfile));positions=np.asarray(coordinates.positions.value_in_unit(unit.nanometer));raw=top._prmtop._raw_data;N=len(positions);box=np.diag(np.asarray(coordinates.boxVectors.value_in_unit(unit.nanometer))).tolist()
   systems={};templates={}
   for method in ['NoCutoff','CutoffPeriodic']:
    system=top.createSystem(nonbondedMethod=getattr(app,method),nonbondedCutoff=1*unit.nanometer,constraints=None,rigidWater=False,removeCMMotion=False);systems[method]=system;templates[method]=read_force(system)
   native=templates['NoCutoff'];matrix=matrix_of(native);nt=len(matrix);native_types=np.asarray([int(native.getParticleParameters(i)[0])for i in range(N)]);native_exclusions=[tuple(map(int,native.getExclusionParticles(i)))for i in range(native.getNumExclusions())]
   nb=next(f for f in systems['NoCutoff'].getForces()if isinstance(f,mm.NonbondedForce));nb_pairs={tuple(sorted(map(int,nb.getExceptionParameters(i)[:2])))for i in range(nb.getNumExceptions())};assert nb_pairs=={tuple(sorted(p))for p in native_exclusions}and len(nb_pairs)==186900
   assert not native.getUseLongRangeCorrection()and not native.getUseSwitchingFunction()
   assert templates['CutoffPeriodic'].getUseLongRangeCorrection()and not templates['CutoffPeriodic'].getUseSwitchingFunction()
   assert np.array_equal(matrix,matrix_of(templates['CutoffPeriodic']))
   mapping=read(ASSEMBLY/'legs/complex33/global-map.json.gz');pA=read(ASSEMBLY/'legs/complex33/A.parameters.json.gz');hybrid=read(LIG/'hybrid_model.json');G=mapping['ligandHybridToGlobal'];F=mapping['nativeGlobalMap'];union_types=np.insert(native_types,mapping['insertion'],21);union_xyz=np.asarray(pA['positions_nm']);assert np.array_equal(union_xyz[F],positions)
   A_native=app.AmberPrmtopFile(str(LIG/'A/ligand.prmtop'));atypes=A_native._prmtop._raw_data['AMBER_ATOM_TYPE'];btypes=raw['AMBER_ATOM_TYPE'];L=mapping['ligandNativeStart'];amap=hybrid['endpoint_maps']['A'];bmap=hybrid['endpoint_maps']['B'];invb={h:i for i,h in enumerate(bmap)}
   for i,h in enumerate(amap):
    if h in invb:assert atypes[i]==btypes[L+invb[h]]
    else:assert h==25 and atypes[i]=='hc'
   assert btypes[list(native_types).index(21)]=='hc'
   # Physical A reference has absent B-only atoms removed. This does not mask
   # retained hybrid ghosts or define an alchemical C4 activity policy.
   absent_A={G[h]for h in hybrid['unique_atoms']['B']};active_A=[i for i in range(N+1)if i not in absent_A];to_A={g:i for i,g in enumerate(active_A)}
   env_exclusions=[(F[a],F[b])for a,b in native_exclusions if not(L<=a<L+44 and L<=b<L+44)];local_A=[(G[amap[a]],G[amap[b]])for a,b,*rest in read(LIG/'A/parameters.json')['exceptions']];physical_A_exclusions=[(to_A[a],to_A[b])for a,b in env_exclusions+local_A];assert len(physical_A_exclusions)==186882
   endpoints={'B':{'types':native_types,'positions':positions,'masses':[float(m.value_in_unit(unit.dalton))for m in [systems['NoCutoff'].getParticleMass(i)for i in range(N)]],'exclusions':native_exclusions,'source':'Exact native B importer frame'},
    'A':{'types':union_types[active_A],'positions':union_xyz[active_A],'masses':[pA['masses_Da'][i]for i in active_A],'exclusions':physical_A_exclusions,'source':'Derived physical A C4 component only; no full A prmtop or hybrid activity policy'}}
   exports=run/'exports';exports.mkdir();streams={'matrix':stream(exports/'matrix-importer-binary128.words.bin.gz',matrix.flatten(order='F')),'nativeB.types':stream(exports/'nativeB.types.words.bin.gz',native_types,True),'physicalA.types':stream(exports/'physicalA.types.words.bin.gz',endpoints['A']['types'],True),'union.physicalTypes':stream(exports/'union.physicalTypes.words.bin.gz',union_types,True),'nativeB.exclusions':stream(exports/'nativeB.exclusions.words.bin.gz',[v for row in sorted(nb_pairs)for v in row],True),'physicalA.exclusions':stream(exports/'physicalA.exclusions.words.bin.gz',[v for row in sorted(tuple(sorted(r))for r in physical_A_exclusions)for v in row],True)}
   export_manifest={'schema':'orvia.c4-source-type-matrix-export.v1','status':'PHYSICAL_ENDPOINT_COMPONENTS_ONLY_HYBRID_ACTIVITY_UNSELECTED','streams':streams,'matrixShape':[nt,nt],'matrixStorageOrder':'i+typeCount*j, zero-based type indices','nativeWrittenCoefficientStrings':raw['LENNARD_JONES_CCOEF'],'nativeWrittenUnits':'kcal*angstrom^4/mol','importerMatrixUnits':'kJ*nm^4/mol','importerSourceSha256':sha(Path(inspect.getsourcefile(amber_file_parser)).read_bytes()),'importerEnergyExpression':native.getEnergyFunction(),'allNativeExceptionsExcluded':True,'retainedUnionGhostPhysicalTypeCoefficientsNonzero':True,'unionInactiveC4ActivityStream':None,'lambdaC4Policy':None,'scientificAcceptance':False,'productionReady':False,'physicalAAtomSelection':active_A,'physicalBToUnion':F,'unionGhostGlobalIndices':{e:[G[h]for h in hybrid['unique_atoms'][e]]for e in ['A','B']}}
   save(exports/'manifest.json',export_manifest);summary['exportManifest']={'path':str((exports/'manifest.json').relative_to(HERE)),'sha256':sha((exports/'manifest.json').read_bytes())};update()
   for endpoint in (['B']if args.native_b_only else ['B','A']):
    e=endpoints[endpoint];types=e['types'];counts=dict(Counter(map(int,types)));coeff={(i,j):float(matrix[i,j])for i in range(nt)for j in range(i,nt)if matrix[i,j]!=0}
    # Every nonzero C4 pair involves the sole Mg. Native Mg has no exclusions.
    mg=int(np.flatnonzero(types==32)[0]);assert not any(mg in row for row in e['exclusions'])
    for label,method,periodic,lrc in [('NoCutoff','NoCutoff',False,False),('CutoffPeriodic1nm_LRC','CutoffPeriodic',True,True),('CutoffPeriodic1nm_noLRC','CutoffPeriodic',True,False)]:
     exact,expected_force,info=analytic_sparse(e['positions'],types,matrix,box,periodic,1.)
     tail=oracle.analytic_lrc_energy(counts,coeff,box,1.,decimal_digits=100)if lrc else mp.mpf(0);expected_energy=exact+tail
     force=force_from(templates[method],types,e['exclusions'],lrc_override=lrc);actual_energy,actual_force,device=get_gpu(force,e['masses'],e['positions'],box)
     energy_error=abs(actual_energy-float(expected_energy));energy_tol=1e-3+2e-5*abs(float(expected_energy))+1e-6+2e-5*abs(float(tail));force_error=np.abs(actual_force-expected_force);force_tol=1e-3+5e-5*np.abs(expected_force);passed=energy_error<=energy_tol and np.all(force_error<=force_tol)
     arrays=run/(endpoint+'-'+label+'.npz');np.savez_compressed(arrays,actual_forces=actual_force,expected_90digit_forces_rounded_binary64=expected_force,force_errors=force_error,force_tolerances=force_tol,positions=e['positions'],types=types)
     case={'endpoint':endpoint,'method':label,'source':e['source'],'atoms':len(types),'allExceptionExclusions':len(e['exclusions']),'periodic':periodic,'cutoffNm':1. if periodic else None,'switching':False,'LRC':lrc,'oracleDirectEnergyKjMol':mp.nstr(exact,100),'oracleLrcEnergyKjMol':mp.nstr(tail,100),'oracleTotalEnergyKjMol':mp.nstr(expected_energy,100),'actualGpuEnergyKjMol':actual_energy,'energyError':energy_error,'energyTolerance':energy_tol,'maxForceError':float(force_error.max()),'forceComponentsChecked':actual_force.size,'failedForceComponents':int(np.count_nonzero(force_error>force_tol)),'passed':bool(passed),'device':device,'pairDomain':info,'arrays':{'path':str(arrays.relative_to(HERE)),'sha256':sha(arrays.read_bytes())}}
     summary['cases'].append(case);update();print(json.dumps({k:case[k]for k in ['endpoint','method','atoms','passed','energyError','maxForceError']}),flush=True)
     if not passed:raise ValueError('Predeclared endpoint tolerance failed:'+endpoint+'/'+label)
  for item in summary['sources']:assert sha(Path(item['path']).read_bytes())==item['sha256'],'Source changed during validation'
  summary['status']='passed_native_b_only_endpoint_component'if args.native_b_only else'passed_physical_endpoint_components';summary['passed']=True
 except Exception as e:summary['status']='failed';summary['failures'].append({'message':str(e),'traceback':traceback.format_exc()});raise
 finally:update()
 print('summary',destination,'sha256',sha(destination.read_bytes()),flush=True)

if __name__=='__main__':main()
