#!/usr/bin/env python3
"""Independent linear source-preservation audit. No Context, force, or dynamics."""
from pathlib import Path
from datetime import datetime,timezone
from collections import Counter
import gzip,hashlib,json,os,tempfile,traceback
OUT=Path(__file__).resolve().parent;PACKAGE=OUT.parent
BASE=Path('/Users/abhijith/Documents/ChatGPT/AURA/work/scientific-preparation/data/prepared_candidate')
DEFS={'complex33':('cardiac_adppi_ff03_m3l_33_782_solvated_v0_1','complex.prmtop.gz','complex.inpcrd.gz',12042),'solvent33':('ligand_adppi_ff03_m3l_33_782_solvated_v0_1','solvent.prmtop.gz','solvent.inpcrd.gz',0)}
FIELDS={'harmonic_bonds':2,'harmonic_angles':3,'periodic_torsions':4,'exceptions':2}
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):
 b=p.read_bytes();return json.loads(gzip.decompress(b)if p.suffix=='.gz'else b)
def save(p,r):p.write_text(json.dumps(r,indent=2,sort_keys=True)+'\n')
def check(report,ok,label,**facts):
 report['checks'].append(dict(passed=bool(ok),criterion=label,**facts))
 if not ok:report['failed_criteria'].append(label)
def mismatch_artifact(target,name,expected,actual):
 absent=expected-actual;extra=actual-expected
 if not absent and not extra:return None
 p=target/(name+'.json.gz');b=(json.dumps(dict(missing=[dict(row=list(k),multiplicity=v)for k,v in absent.items()],extra=[dict(row=list(k),multiplicity=v)for k,v in extra.items()]),sort_keys=True)+'\n').encode();p.write_bytes(gzip.compress(b,mtime=0));return dict(path=str(p),sha256=sha(p),missing=sum(absent.values()),extra=sum(extra.values()))
def native_export(mm,unit,np,top):
 system=top.createSystem(nonbondedMethod=__import__('openmm.app',fromlist=['NoCutoff']).NoCutoff,constraints=None,rigidWater=False,removeCMMotion=False)
 r={k:[]for k in FIELDS};r['masses_Da']=[float(system.getParticleMass(i).value_in_unit(unit.dalton))for i in range(system.getNumParticles())];r['particles']=[]
 for force in system.getForces():
  name=type(force).__name__
  if name=='HarmonicBondForce':
   for i in range(force.getNumBonds()):
    a,b,r0,k=force.getBondParameters(i);r['harmonic_bonds'].append([a,b,float(r0.value_in_unit(unit.nanometer)),float(k.value_in_unit(unit.kilojoule_per_mole/unit.nanometer**2))])
  elif name=='HarmonicAngleForce':
   for i in range(force.getNumAngles()):
    a,b,c,t,k=force.getAngleParameters(i);r['harmonic_angles'].append([a,b,c,float(t.value_in_unit(unit.radian)),float(k.value_in_unit(unit.kilojoule_per_mole/unit.radian**2))])
  elif name=='PeriodicTorsionForce':
   for i in range(force.getNumTorsions()):
    a,b,c,d,n,t,k=force.getTorsionParameters(i);r['periodic_torsions'].append([a,b,c,d,n,float(t.value_in_unit(unit.radian)),float(k.value_in_unit(unit.kilojoule_per_mole))])
  elif name=='NonbondedForce':
   for i in range(force.getNumParticles()):
    q,s,e=force.getParticleParameters(i);r['particles'].append([float(q.value_in_unit(unit.elementary_charge)),float(s.value_in_unit(unit.nanometer)),float(e.value_in_unit(unit.kilojoule_per_mole))])
   for i in range(force.getNumExceptions()):
    a,b,q,s,e=force.getExceptionParameters(i);r['exceptions'].append([min(a,b),max(a,b),float(q.value_in_unit(unit.elementary_charge**2)),float(s.value_in_unit(unit.nanometer)),float(e.value_in_unit(unit.kilojoule_per_mole))])
  else:raise ValueError('Unsupported source force:'+name)
 del system
 r['exceptions'].sort(key=lambda x:x[:2]);return r

def audit_leg(name,attempt):
 import numpy as np
 import openmm as mm
 from openmm import app,unit
 directory,topname,coordname,L=DEFS[name];directory=BASE/directory;leg=PACKAGE/'legs'/name;target=attempt/name;target.mkdir()
 paths=dict(catalog=leg/'catalog-candidate.json',A=leg/'A.parameters.json.gz',B=leg/'B.parameters.json.gz',global_map=leg/'global-map.json.gz',normalizations=leg/'normalizations.json.gz',native_records=leg/'native-records.json.gz',constraints=leg/'constraints.unresolved.json.gz',c4=leg/'c4.unresolved.json.gz',native_topology=directory/topname,native_coordinates=directory/coordname,native_constraints=directory/'water_constraints.json.gz',hybrid_model=BASE/'ligand_endpoints_v0_1/hybrid_model.json')
 if name=='complex33':paths['native1264']=directory/'complex_1264.prmtop.gz'
 report=dict(leg=name,status='in_progress',passed=False,checks=[],failed_criteria=[],source_files={k:dict(path=str(p),sha256=sha(p))for k,p in paths.items()},context_created=False,force_evaluated=False,optimizer_run=False,production_ready=False)
 save(target/'report.json',report)
 try:
  catalog=read(paths['catalog']);assert catalog['sourceHashesVerifiedAfterAssembly'] is True
  endpoints={e:read(paths[e])for e in ['A','B']};mapping=read(paths['global_map']);frozen=read(paths['hybrid_model']);provenance=read(paths['native_records']);normal=read(paths['normalizations']);constraints=read(paths['constraints']);c4=read(paths['c4']);insertion=L+44
  for e in ['A','B']:check(report,sha(paths[e])==catalog['parameters'][e]['sha256'],e+' finalized parameter hash')
  with tempfile.TemporaryDirectory(prefix='preservation-',dir=attempt)as tmp:
   tmp=Path(tmp);tp=tmp/'native.prmtop';cp=tmp/'native.inpcrd';tp.write_bytes(gzip.decompress(paths['native_topology'].read_bytes()));cp.write_bytes(gzip.decompress(paths['native_coordinates'].read_bytes()));top=app.AmberPrmtopFile(str(tp));coord=app.AmberInpcrdFile(str(cp));native=native_export(mm,unit,np,top);raw=top._prmtop._raw_data;xyz=np.asarray(coord.positions.value_in_unit(unit.nanometer))
   n=len(native['masses_Da']);F=np.arange(n,dtype=np.int64);F[insertion:]+=1;G={h:L+i for i,h in enumerate(frozen['endpoint_maps']['B'])};G[25]=insertion;glist=[G[h]for h in range(45)];env=[i for i in range(n)if not L<=i<L+44]
   check(report,mapping['nativeGlobalMap']==F.tolist()and mapping['ligandHybridToGlobal']==glist,'Independently reconstructed global maps')
   expected_particles={e:[row[:]for row in native['particles'][:insertion]]+[[0.,1.,0.]]+[row[:]for row in native['particles'][insertion:]]for e in ['A','B']}
   stats={}
   for e,p in endpoints.items():
    hp=frozen['endpoint_parameters'][e]
    for h,g in G.items():expected_particles[e][g]=hp['particles'][h][:]
    native_env=np.column_stack([np.asarray(native['masses_Da'])[env],np.asarray(native['particles'])[env]])
    actual_env=np.column_stack([np.asarray(p['masses_Da'])[F[env]],np.asarray(p['particles'])[F[env]]]);delta=np.abs(actual_env-native_env)
    field_stats={key:dict(compared=len(env),nonidentical=int(np.count_nonzero(delta[:,j])),maximum_absolute_difference=float(delta[:,j].max()))for j,key in enumerate(['mass','charge','sigma','epsilon'])}
    check(report,np.array_equal(actual_env,native_env),e+' all native environment masses/q/sigma/epsilon exactly preserved',fields=field_stats);stats[e]=field_stats
    actual_lig=np.column_stack([np.asarray(p['masses_Da'])[glist],np.asarray(p['particles'])[glist]])
    frozen_lig=np.column_stack([hp['masses_Da'],hp['particles']])
    check(report,np.array_equal(actual_lig,frozen_lig),e+' all45 ligand rows exactly equal frozen hybrid',scalar_values_compared=int(actual_lig.size))
    check(report,np.array_equal(np.asarray(p['positions_nm'])[F],xyz),e+' all native coordinates exactly preserved',scalar_values_compared=int(xyz.size))
    check(report,normal[e]['atoms']==[],e+' no particle sigma normalization required/applied',normalization_count=len(normal[e]['atoms']))
   report['environment_particle_stats']=stats
   native_lig=np.column_stack([np.asarray(native['masses_Da'])[L:L+44],np.asarray(native['particles'])[L:L+44]])
   frozen_b=np.column_stack([[frozen['endpoint_parameters']['B']['masses_Da'][h]for h in frozen['endpoint_maps']['B']],[frozen['endpoint_parameters']['B']['particles'][h]for h in frozen['endpoint_maps']['B']]])
   ld=np.abs(native_lig-frozen_b);report['native_full_B_to_frozen_B_last_digit_comparison']={key:dict(compared=44,nonidentical=int(np.count_nonzero(ld[:,j])),maximum_absolute_difference=float(ld[:,j].max()),note='Diagnostic of explicit frozen ligand replacement; environment preservation is checked separately with exact equality.')for j,key in enumerate(['mass','charge','sigma','epsilon'])}
   expected={e:{}for e in ['A','B']};coverage={}
   for field,width in FIELDS.items():
    envrows=[];removed=0;cross=0
    for row in native[field]:
     inside=[L<=int(i)<L+44 for i in row[:width]]
     if all(inside):removed+=1;continue
     if any(inside):cross+=1
     envrows.append([int(F[int(i)])for i in row[:width]]+row[width:])
    coverage[field]=dict(native=len(native[field]),retained_native_environment=len(envrows),replaced_native_ligand=removed,cross_component_records=cross)
    check(report,cross==0,field+' native ligand/environment isolation')
    for e in ['A','B']:
     rows=[r[:]for r in envrows]+[[G[int(i)]for i in row[:width]]+row[width:]for row in frozen['endpoint_parameters'][e][field]]
     if field=='exceptions':
      for row in rows:row[0],row[1]=sorted(row[:2])
     expected[e][field]=rows
   # Canonical exclusion representation is an explicitly declared ABI transform.
   ea={tuple(r[:2]):r for r in expected['A']['exceptions']};eb={tuple(r[:2]):r for r in expected['B']['exceptions']}
   check(report,set(ea)==set(eb),'Endpoint exception pair identities align')
   normalization_counts={e:0 for e in ['A','B']}
   for pair,a in ea.items():
    b=eb[pair];kind=1 if a[2]==a[4]==b[2]==b[4]==0 else 2
    for e,row in [('A',a),('B',b)]:
     if kind==1:
      if row[2:]!=[0.,0.,0.]:normalization_counts[e]+=1
      row[2:]=[0.,0.,0.]
     elif row[3]<=0:row[3]=(expected_particles[e][row[0]][1]+expected_particles[e][row[1]][1])/2
   report['canonical_zero_exclusion_sigma_changes']=normalization_counts
   report['multiplicity_coverage']=coverage
   for e,p in endpoints.items():
    for field in FIELDS:
     want=Counter(map(tuple,expected[e][field]));got=Counter(map(tuple,p[field]));artifact=mismatch_artifact(target,e+'-'+field+'-mismatches',want,got)
     check(report,want==got,e+' '+field+' exact ordered-tuple/parameter multiset and multiplicity',expected_records=sum(want.values()),actual_records=sum(got.values()),unique_expected_records=len(want),mismatch_artifact=artifact)
    pairs=[tuple(r[:2])for r in p['exceptions']]
    check(report,all(a<b for a,b in pairs)and pairs==sorted(pairs)and len(pairs)==len(set(pairs)),e+' exceptions strictly a<b, globally sorted, unique')
   expected_flags=['BONDS_INC_HYDROGEN','BONDS_WITHOUT_HYDROGEN','ANGLES_INC_HYDROGEN','ANGLES_WITHOUT_HYDROGEN','DIHEDRALS_INC_HYDROGEN','DIHEDRALS_WITHOUT_HYDROGEN','NUMBER_EXCLUDED_ATOMS','EXCLUDED_ATOMS_LIST','SCEE_SCALE_FACTOR','SCNB_SCALE_FACTOR']
   check(report,set(provenance['nativeRecordArrays'])==set(expected_flags)and all(provenance['nativeRecordArrays'][k]==raw[k]for k in expected_flags),'All native signed record/exclusion/scaling flag arrays exactly retained',arrays=len(expected_flags))
   torsions=[]
   for k in ['DIHEDRALS_INC_HYDROGEN','DIHEDRALS_WITHOUT_HYDROGEN']:
    tokens=raw[k]
    torsions.extend([list(map(int,tokens[i:i+5]))for i in range(0,len(tokens),5)])
   active=[r for r in torsions if r[2]>=0 and r[3]>=0]
   report['native_torsion_sign_flags']=dict(records=len(torsions),proper=sum(r[3]>=0 for r in torsions),improper=sum(r[3]<0 for r in torsions),ignored_14=sum(r[2]<0 for r in torsions),active_14_records=len(active),active_14_unique_pairs=len({tuple(sorted([r[0]//3,r[3]//3]))for r in active}),raw_exact_duplicate_records=len(torsions)-len({tuple(r)for r in torsions}))
   native_constraints=read(paths['native_constraints']);want=[[int(F[a]),int(F[b]),d]for a,b,d in native_constraints['constraints']]
   check(report,constraints['constraints']==want and constraints['nativeConstraintsSha256']==sha(paths['native_constraints']),'All water constraints map exactly with identical distance values/order',constraints=len(want))
   check(report,constraints['constraints_implemented_and_validated_on_chain'] is False and constraints['additional_solute_H_constraints_selected'] is False,'Constraint implementation/additional-H choices remain unaccepted')
   if name=='complex33':
    p1264=tmp/'native1264.prmtop';p1264.write_bytes(gzip.decompress(paths['native1264'].read_bytes()));raw1264=app.AmberPrmtopFile(str(p1264))._prmtop._raw_data
    keys=['LENNARD_JONES_CCOEF','NONBONDED_PARM_INDEX','ATOM_TYPE_INDEX','AMBER_ATOM_TYPE']
    check(report,set(c4['nativeWrittenTables'])==set(keys)and all(c4['nativeWrittenTables'][k]==raw1264[k]for k in keys),'C4 sidecar raw written native1264 tables exactly retained',table_lengths={k:len(raw1264[k])for k in keys})
    check(report,c4['sourceCompressedPrmtopSha256']==sha(paths['native1264'])and c4['sourceDecompressedPrmtopSha256']==hashlib.sha256(p1264.read_bytes()).hexdigest(),'C4 native source hashes bind actual written1264')
    check(report,all(raw[k]==raw1264[k]for k in set(raw)&set(raw1264)),'All base/1264 common native flags remain identical')
    check(report,c4['lambdaPolicy'] is None and c4['inactiveGhostC4Policy'] is None and c4['unionOnlyPhysicalTypeAssignmentCandidate']['admitted'] is False,'Unresolved alchemical C4 choices remain unselected')
   else:check(report,c4['status']=='NOT_APPLICABLE_NO_C4_ION'and c4['lambdaPolicy'] is None,'Solvent C4 correctly inapplicable and no invented policy')
   streams=catalog['streams'];sa,sb=streams['A.particles'],streams['B.particles'];mass_identical=endpoints['A']['masses_Da']==endpoints['B']['masses_Da']
   alias_same=sb.get('aliasOf')=='A.particles'and sa['path']==sb['path']and sa['sha256']==sb['sha256']and sha(PACKAGE/sa['path'])==sa['sha256']
   check(report,mass_identical and alias_same,'Whole particle stream alias uses identical source mass/zero-velocity rows and the exact same verified file',raw_word_scan='Not duplicated; parent independently decodes all ABI words.',shared_file=sa['path'])
  check(report,all(sha(Path(r['path']))==r['sha256']for r in report['source_files'].values()),'All audited source bytes unchanged during check')
  report.update(passed=not report['failed_criteria'],status='passed_preservation'if not report['failed_criteria']else'failed_preservation')
 except Exception as error:
  report.update(status='failed_preservation',passed=False,error=f'{type(error).__name__}: {error}');(target/'failure.txt').write_text(traceback.format_exc())
 finally:save(target/'report.json',report)
 return report

def main():
 stamp='preservation-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')+f'-{os.getpid()}';attempt=OUT/'attempts'/stamp;attempt.mkdir(parents=True)
 header=dict(schema='orvia.full-hybrid.independent-preservation.v1',script=dict(path=str(Path(__file__)),sha256=sha(Path(__file__))),attempt_directory=str(attempt),status='in_progress',passed=False,production_ready=False,context_created=False,force_evaluated=False)
 save(attempt/'summary.json',header);reports=[]
 for name in DEFS:
  try:reports.append(audit_leg(name,attempt))
  except Exception as error:
   target=attempt/name;target.mkdir(exist_ok=True);r=dict(leg=name,passed=False,status='failed_preservation',error=f'{type(error).__name__}: {error}');save(target/'report.json',r);(target/'failure.txt').write_text(traceback.format_exc());reports.append(r)
 header.update(passed=all(r['passed']for r in reports),status='passed_preservation'if all(r['passed']for r in reports)else'failed_preservation',legs=[dict(leg=r['leg'],passed=r['passed'],status=r['status'],report=str(attempt/r['leg']/'report.json'),sha256=sha(attempt/r['leg']/'report.json'),failed_criteria=r.get('failed_criteria',[]))for r in reports]);save(attempt/'summary.json',header);print(json.dumps(header,indent=2));return 0 if header['passed']else 1
if __name__=='__main__':raise SystemExit(main())
