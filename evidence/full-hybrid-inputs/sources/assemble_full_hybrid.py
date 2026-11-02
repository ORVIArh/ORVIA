#!/usr/bin/env python3
"""Assemble source-bound candidate streams. No dynamics or physical admission."""
from __future__ import annotations
from pathlib import Path
import argparse,copy,gc,gzip,hashlib,json,math,struct,tempfile,traceback
import numpy as np
import openmm as mm
from openmm import app,unit

OUT=Path(__file__).resolve().parent
ROOT=OUT.parents[1]
SCI=ROOT/'work/scientific-preparation'
PREP=SCI/'data/prepared_candidate'
LIG=PREP/'ligand_endpoints_v0_1'
ROLE_WIDTHS={'particles':4,'nonbonded':3,'bonds':4,'angles':5,'torsions':7,'exceptions':6}
INDEX_WIDTHS={'particles':0,'nonbonded':0,'bonds':2,'angles':3,'torsions':5,'exceptions':3}
SPECS={
 'complex33':('cardiac_adppi_ff03_m3l_33_782_solvated_v0_1','complex',12042,132935,(132936,132787,22187,46357,186910)),
 'solvent33':('ligand_adppi_ff03_m3l_33_782_solvated_v0_1','solvent',0,151505,(151506,151230,91,160,151418))}

def sha_bytes(b):return hashlib.sha256(b).hexdigest()
def sha(p):return sha_bytes(Path(p).read_bytes())
def encoded(x):return (json.dumps(x,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode()
def read_json(p):
 p=Path(p);return json.loads(gzip.decompress(p.read_bytes()) if p.suffix=='.gz' else p.read_bytes())
def gz_write(p,data):
 p.parent.mkdir(parents=True,exist_ok=True)
 with p.open('wb')as f:
  with gzip.GzipFile(fileobj=f,mode='wb',filename='',mtime=0,compresslevel=6)as g:g.write(data)
 return {'path':str(p.relative_to(OUT)),'bytes':p.stat().st_size,'sha256':sha(p),'uncompressedBytes':len(data),'uncompressedSha256':sha_bytes(data)}
def save_json(p,value):p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(encoded(value))
def scalar(x,u):return float(x.value_in_unit(u))
def quad_bits(value):
 value=float(value)
 if not math.isfinite(value):raise ValueError('Nonfinite source scalar')
 bits=struct.unpack('>Q',struct.pack('>d',value))[0];s=bits>>63;e=(bits>>52)&2047;f=bits&((1<<52)-1)
 if not e:
  if not f:return 0
  top=f.bit_length()-1;return(s<<127)|((top-1074+16383)<<112)|((f-(1<<top))<<(112-top))
 return(s<<127)|((e-1023+16383)<<112)|(f<<60)
def word(x,index=False):
 v=int(x)if index else quad_bits(x)
 if index and(int(x)!=x or v<0):raise ValueError('Invalid index')
 return v.to_bytes(32,'big')
def q16(x):return '0x'+quad_bits(x).to_bytes(16,'big').hex()
def map_native(i,insert):return int(i)+(int(i)>=insert)
def source_record(path):return {'path':str(path.relative_to(ROOT)),'bytes':path.stat().st_size,'sha256':sha(path)}

def export_native(topology):
 system=topology.createSystem(nonbondedMethod=app.NoCutoff,constraints=None,rigidWater=False,removeCMMotion=False)
 if system.getNumConstraints()or any(system.isVirtualSite(i)for i in range(system.getNumParticles())):raise ValueError('Unexpected native constraints/virtual sites')
 result={'atom_count':system.getNumParticles(),'masses_Da':[scalar(system.getParticleMass(i),unit.dalton)for i in range(system.getNumParticles())],
  'particles':[],'harmonic_bonds':[],'harmonic_angles':[],'periodic_torsions':[],'exceptions':[]}
 seen=[]
 for force in system.getForces():
  name=type(force).__name__
  if name in seen or name not in ['HarmonicBondForce','HarmonicAngleForce','PeriodicTorsionForce','NonbondedForce']:raise ValueError('Unsupported native force form:'+name)
  seen.append(name)
  if name=='HarmonicBondForce':
   for i in range(force.getNumBonds()):
    a,b,r,k=force.getBondParameters(i);result['harmonic_bonds'].append([a,b,scalar(r,unit.nanometer),scalar(k,unit.kilojoule_per_mole/unit.nanometer**2)])
  elif name=='HarmonicAngleForce':
   for i in range(force.getNumAngles()):
    a,b,c,t,k=force.getAngleParameters(i);result['harmonic_angles'].append([a,b,c,scalar(t,unit.radian),scalar(k,unit.kilojoule_per_mole/unit.radian**2)])
  elif name=='PeriodicTorsionForce':
   for i in range(force.getNumTorsions()):
    a,b,c,d,n,t,k=force.getTorsionParameters(i);result['periodic_torsions'].append([a,b,c,d,n,scalar(t,unit.radian),scalar(k,unit.kilojoule_per_mole)])
  else:
   if force.getNumParticleParameterOffsets()or force.getNumExceptionParameterOffsets():raise ValueError('Unsupported offsets')
   for i in range(force.getNumParticles()):
    q,s,e=force.getParticleParameters(i);result['particles'].append([scalar(q,unit.elementary_charge),scalar(s,unit.nanometer),scalar(e,unit.kilojoule_per_mole)])
   for i in range(force.getNumExceptions()):
    a,b,q,s,e=force.getExceptionParameters(i);result['exceptions'].append([min(a,b),max(a,b),scalar(q,unit.elementary_charge**2),scalar(s,unit.nanometer),scalar(e,unit.kilojoule_per_mole)])
 result['exceptions'].sort(key=lambda r:r[:2]);del system
 return result

def role_rows(p,role):
 if role=='particles':return [[m,0.,0.,0.]for m in p['masses_Da']]
 if role=='nonbonded':return [[s,e,q]for q,s,e in p['particles']]
 if role=='bonds':return [[a,b,k,r]for a,b,r,k in p['harmonic_bonds']]
 if role=='angles':return [[a,b,c,k,t]for a,b,c,t,k in p['harmonic_angles']]
 if role=='torsions':return [[a,b,c,d,n,k,t]for a,b,c,d,n,t,k in p['periodic_torsions']]
 if role=='exceptions':return [[a,b,p['exception_kinds'][i],s,e,q]for i,(a,b,q,s,e)in enumerate(p['exceptions'])]
 raise KeyError(role)

def write_stream(directory,name,role,rows,index_width):
 destination=directory/(name+'.words.bin.gz');h=hashlib.sha256();content=hashlib.sha256(b'ORVIA-FULL-HYBRID-STREAM-v1\0'+role.encode()+b'\0');count=0
 destination.parent.mkdir(parents=True,exist_ok=True)
 with destination.open('wb')as f:
  with gzip.GzipFile(fileobj=f,mode='wb',filename='',mtime=0,compresslevel=6)as g:
   for row in rows:
    data=b''.join(word(x,k<index_width)for k,x in enumerate(row));g.write(data);h.update(data);content.update(data);count+=len(row)
 return {'path':str(destination.relative_to(OUT)),'wordCount':count,'rawBytes':count*32,'rawSha256':h.hexdigest(),'gzipBytes':destination.stat().st_size,'gzipSha256':sha(destination),
  'proposedStreamId':'0x'+content.hexdigest(),'idPolicy':'SHA256(domain\\0role\\0concatenated bytes32 words); proposed ID only, not an on-chain sealed stream commitment','onChainUploaded':False}

def build(name,summary):
 dirname,prefix,L,N,expected=SPECS[name];directory=PREP/dirname;leg=OUT/'legs'/name;leg.mkdir(parents=True,exist_ok=True)
 files=[directory/(prefix+'.prmtop.gz'),directory/(prefix+'.inpcrd.gz'),directory/'particle_cost_inputs.json.gz',directory/'water_constraints.json.gz',directory/'force_inventory.json']
 if name=='complex33':files.extend([directory/'complex_1264.prmtop.gz',directory/'c4_type_pairs.json'])
 files.extend([LIG/'hybrid_model.json',LIG/'hybrid_streams.json',LIG/'explicit_hydrogen_map.json',LIG/'A/parameters.json',LIG/'B/parameters.json'])
 inputs=[source_record(p)for p in files]
 hybrid=read_json(LIG/'hybrid_model.json');B=read_json(LIG/'B/parameters.json');cost=read_json(directory/'particle_cost_inputs.json.gz');inv=read_json(directory/'force_inventory.json')
 assert hybrid['atom_count']==45 and B['atom_count']==44 and N==inv['physical_atoms']
 insertion=L+44;bm=hybrid['endpoint_maps']['B'];assert len(set(bm))==44 and set(range(45))-set(bm)=={25}
 G={h:L+i for i,h in enumerate(bm)};G[25]=insertion
 F=lambda i:map_native(i,insertion)
 with tempfile.TemporaryDirectory(prefix='native-',dir=OUT)as temporary:
  t=Path(temporary);topfile=t/'native.prmtop';coordfile=t/'native.inpcrd';topfile.write_bytes(gzip.decompress(files[0].read_bytes()));coordfile.write_bytes(gzip.decompress(files[1].read_bytes()))
  topology=app.AmberPrmtopFile(str(topfile));coords=app.AmberInpcrdFile(str(coordfile));native=export_native(topology);raw=topology._prmtop._raw_data
  xyz=np.asarray(coords.positions.value_in_unit(unit.nanometer));assert xyz.shape==(N,3) and np.array_equal(xyz,np.asarray(cost['positions_nm']))
  assert native['atom_count']==N
  residue=[a for a in topology.topology.atoms()if a.residue.name=='LGB'];assert [a.index for a in residue]==list(range(L,L+44))
  assert [a.name for a in residue]==[r['name']for r in B['atom_identity']]
  delta=xyz[L]-np.asarray(B['positions_nm'][0]);residual=float(np.max(np.abs(xyz[L:L+44]-np.asarray(B['positions_nm'])-delta)))
  assert residual<=2e-12,'Ligand requires undeclared nonrigid alignment'
  added=np.asarray(hybrid['endpoint_parameters']['B']['positions_nm'][25])+delta
  positions=np.insert(xyz,insertion,added,axis=0).tolist();masses=native['masses_Da'][:insertion]+[hybrid['endpoint_parameters']['B']['masses_Da'][25]]+native['masses_Da'][insertion:]
  endpoints={};coverage={};term_fields=[('harmonic_bonds',2),('harmonic_angles',3),('periodic_torsions',4),('exceptions',2)]
  record_sources={};raw_sources={k:v for k,v in raw.items()if k in ['BONDS_INC_HYDROGEN','BONDS_WITHOUT_HYDROGEN','ANGLES_INC_HYDROGEN','ANGLES_WITHOUT_HYDROGEN','DIHEDRALS_INC_HYDROGEN','DIHEDRALS_WITHOUT_HYDROGEN','NUMBER_EXCLUDED_ATOMS','EXCLUDED_ATOMS_LIST','SCEE_SCALE_FACTOR','SCNB_SCALE_FACTOR']}
  sidecar={'schema':'orvia.native-record-preservation.v1','nativeRecordArrays':raw_sources,'sourceCompressedPrmtopSha256':sha(files[0]),'sourceDecompressedPrmtopSha256':sha(topfile),'atomMap':'F(g)=g if g<insertion else g+1','insertion':insertion,
   'torsionSemantics':'All imported periodic proper/improper tuples retain atom order, Fourier multiplicity and phase. Native raw signed third/fourth fields remain above; stream fields do not erase provenance.', 'mappedRecords':{}}
  for endpoint in ['A','B']:
   hp=hybrid['endpoint_parameters'][endpoint];p={'schema':'orvia.full-aligned-endpoint-parameters.v1','atom_count':N+1,'masses_Da':masses,'positions_nm':positions,'particles':native['particles'][:insertion]+[[0.,1.,0.]]+native['particles'][insertion:],
    'production_ready':False,'scientific_acceptance':False,'units':{'length':'nm','energy':'kJ/mol','mass':'Da','charge':'e','angle':'radian'},'initialVelocities':'Explicit zero input; no accepted initialization/equilibration protocol selected'}
   p['particles']=copy.deepcopy(p['particles'])
   for h,g in G.items():
    assert masses[g]==hp['masses_Da'][h],'Mass policy changes native masses';p['particles'][g]=hp['particles'][h]
   for field,width in term_fields:
    rows=[];origin=[];local=0;cross=0
    for i,row in enumerate(native[field]):
     local_flags=[L<=int(x)<L+44 for x in row[:width]]
     if all(local_flags):local+=1;continue
     if any(local_flags):cross+=1
     rows.append([F(x)for x in row[:width]]+row[width:]);origin.append({'kind':'native','record':i,'crossLigandEnvironment':any(local_flags)})
    for i,row in enumerate(hp[field]):
     mapped=[G[int(x)]for x in row[:width]]+row[width:]
     if field=='exceptions':mapped[:2]=sorted(mapped[:2])
     rows.append(mapped);origin.append({'kind':'hybridLigand','record':i})
    order=sorted(range(len(rows)),key=lambda i:tuple(rows[i][:width]+(rows[i][4:6]if field=='periodic_torsions'else[])))
    p[field]=[rows[i]for i in order]
    if endpoint=='A':
     sidecar['mappedRecords'][field]=[origin[i]for i in order];coverage[field]={'native':len(native[field]),'nativeLigandLocalReplaced':local,'nativeEnvironmentOrCrossRetained':len(native[field])-local,'crossLigandEnvironmentRetained':cross,'hybridLigandInserted':len(hp[field]),'assembled':len(rows)}
    assert cross==0,'Unexpected covalent/exclusion cross terms require explicit endpoint policy'
   endpoints[endpoint]=p
  for field in ['harmonic_bonds','harmonic_angles','periodic_torsions','exceptions']:
   width=dict(term_fields)[field]
   assert len(endpoints['A'][field])==len(endpoints['B'][field])
   assert [r[:width]+(r[4:6]if field=='periodic_torsions'else[])for r in endpoints['A'][field]]==[r[:width]+(r[4:6]if field=='periodic_torsions'else[])for r in endpoints['B'][field]]
  # Periodicity and phase are explicit Fourier identities. The phase may be
  # endpoint-specific in the ABI, but this frozen ligand policy aligns it.
  A,Bp=endpoints['A'],endpoints['B'];assert len(set(tuple(r[:2])for r in A['exceptions']))==len(A['exceptions'])
  kinds=[]
  for i,(a,b)in enumerate(zip(A['exceptions'],Bp['exceptions'])):
   kind=1 if a[2]==a[4]==b[2]==b[4]==0 else 2;kinds.append(kind)
   for p in endpoints.values():
    row=p['exceptions'][i]
    if kind==1:row[2:]=[0.,0.,0.]
    elif row[3]<=0:row[3]=(p['particles'][row[0]][1]+p['particles'][row[1]][1])/2
  normalization={}
  for endpoint,p in endpoints.items():
   changed=[]
   for i,row in enumerate(p['particles']):
    if row[1]<=0:
     if row[2]!=0:raise ValueError('Nonpositive active LJ sigma')
     changed.append({'atom':i,'originalSigmaNm':row[1]});row[1]=1.
   normalization[endpoint]={'policy':'Exactly zero-epsilon nonpositive sigma replaced by inert1nm for catalog positive-sigma ABI; q/epsilon untouched. Canonical excluded records have q=sigma=epsilon=0.','atoms':changed}
   p['exception_kinds']=kinds
   assert all(m>0 and math.isfinite(m)for m in p['masses_Da'])
   assert all(s>0 and e>=0 and all(math.isfinite(v)for v in [q,s,e])for q,s,e in p['particles'])
  actual=(N+1,len(A['harmonic_bonds']),len(A['harmonic_angles']),len(A['periodic_torsions']),len(A['exceptions']));assert actual==expected,(actual,expected)
  sidecar['canonicalOrder']='Lexicographic atom tuple, then torsion periodicity and phase; never reorder atoms within improper tuples or deduplicate native multiplicity. Exceptions strictly global a<b.'
  sidecar['coverage']=coverage;source_artifact=gz_write(leg/'native-records.json.gz',encoded(sidecar))
  constraints=read_json(directory/'water_constraints.json.gz');constraints['nativeConstraintsSha256']=sha(directory/'water_constraints.json.gz');constraints['constraints']=[[F(a),F(b),r]for a,b,r in constraints['constraints']];constraints['hybrid_atoms']=N+1;constraints['policyStatus']='SOURCE_BOUND_UNACCEPTED_NO_ADDITIONAL_SOLUTE_H_POLICY';constraints['production_ready']=False
  assert len(constraints['constraints'])==inv['rigid_water_distance_constraints']
  constraint_artifact=gz_write(leg/'constraints.unresolved.json.gz',encoded(constraints))
  c4={'schema':'orvia.full-hybrid-c4-unresolved.v1','status':'NOT_APPLICABLE_NO_C4_ION'if name!='complex33'else'UNRESOLVED_ALCHEMICAL_C4_ACTIVITY_AND_SOFTENING_POLICY','mandatoryCoverage':True,'production_ready':False,'lambdaPolicy':None,'inactiveGhostC4Policy':None}
  if name=='complex33':
   c4file=t/'native1264.prmtop';c4file.write_bytes(gzip.decompress((directory/'complex_1264.prmtop.gz').read_bytes()));c4top=app.AmberPrmtopFile(str(c4file));c4raw=c4top._prmtop._raw_data
   common=set(raw)&set(c4raw);differences=[k for k in common if raw[k]!=c4raw[k]];assert not differences,differences
   c4.update({'sourceCompressedPrmtopSha256':sha(directory/'complex_1264.prmtop.gz'),'sourceDecompressedPrmtopSha256':sha(c4file),'nativeBaseCommonFlagsExactlyEqual':True,'nativeWrittenCoefficientUnits':'kcal*angstrom^4/mol','signConvention':'potential=-C4/r^4','coefficientConversionExactDecimal':'multiply by0.0004184 for kJ*nm^4/mol; numerical encoding policy remains unaccepted',
    'nativeWrittenTables':{k:c4raw[k]for k in ['LENNARD_JONES_CCOEF','NONBONDED_PARM_INDEX','ATOM_TYPE_INDEX','AMBER_ATOM_TYPE']},'nativeAtomMap':{'insertion':insertion,'map':'F(g)=g if g<insertion else g+1'},'unionOnlyPhysicalTypeAssignmentCandidate':{'hybridAtom':25,'globalAtom':insertion,'amberType':'hc','nativeTypeIndex':22,'admitted':False},
    'uniqueAtomsRequirePolicy':{'A':[G[25]],'B':[G[h]for h in hybrid['unique_atoms']['B']]},'nativeMatrixJsonIsNotAuthority':'Written1264prmtopcoefficients retain serialization precision. c4_type_pairs JSON was produced before native writing.'})
  c4_artifact=gz_write(leg/'c4.unresolved.json.gz',encoded(c4))
  normalization_artifact=gz_write(leg/'normalizations.json.gz',encoded(normalization));mapping={'schema':'orvia.full-hybrid-global-map.v1','nativeAtoms':N,'hybridAtoms':N+1,'ligandNativeStart':L,'ligandNativeCount':44,'insertion':insertion,'nativeGlobalMap':[F(i)for i in range(N)],'ligandHybridToGlobal':[G[i]for i in range(45)],'frozenHybridBToLocalNative':bm,'addedHybridAtom':25,'addedGlobalAtom':insertion,'addedPositionNm':added.tolist(),'translationNm':delta.tolist(),'maximumCommonCoordinateTranslationResidualNm':residual,'nativeCoordinatesExactlyRetained':True,'noCoordinateOptimizationPerformed':True}
  map_artifact=gz_write(leg/'global-map.json.gz',encoded(mapping))
  streams={};param_artifacts={}
  for endpoint,p in endpoints.items():
   param_artifacts[endpoint]=gz_write(leg/(endpoint+'.parameters.json.gz'),encoded(p))
   for role in ROLE_WIDTHS:
    record=write_stream(leg/'streams',endpoint+'.'+role,role,role_rows(p,role),INDEX_WIDTHS[role]);assert record['wordCount']==len(role_rows(p,role))*ROLE_WIDTHS[role];streams[endpoint+'.'+role]=record
  pa=streams['A.particles'];pb=streams['B.particles'];a_data=gzip.decompress((OUT/pa['path']).read_bytes());b_data=gzip.decompress((OUT/pb['path']).read_bytes());assert a_data==b_data
  (OUT/pb['path']).unlink();streams['B.particles']=copy.deepcopy(pa);streams['B.particles']['aliasOf']='A.particles'
  streams['positions']=write_stream(leg/'streams','positions','positions',positions,0);assert streams['positions']['wordCount']==3*(N+1)
  # Role-specific scalar/index restrictions mirror the currently owning catalog.
  for endpoint,p in endpoints.items():
   assert all(len(set(r[:2]))==2 and r[2]>=0 and r[3]>=0 for r in role_rows(p,'bonds'))
   assert all(len(set(r[:3]))==3 and r[3]>=0 and 0<=r[4]<=math.pi for r in role_rows(p,'angles'))
   assert all(len(set(r[:4]))==4 and isinstance(r[4],int)and 1<=r[4]<=64 and r[5]>=0 for r in role_rows(p,'torsions'))
  policy={'schema':'orvia.full-hybrid-candidate-policy.v1','status':'UNACCEPTED_SOURCE_BOUND_ASSEMBLY','nativeSourceFiles':inputs,'globalMapSha256':map_artifact['sha256'],'nativeRecordProvenanceSha256':source_artifact['sha256'],'mandatoryConstraintDataSha256':constraint_artifact['sha256'],'mandatoryC4DataSha256':c4_artifact['sha256'],'normalizationsSha256':normalization_artifact['sha256'],'dummyPolicySha256':hybrid['model_policy_sha256'],'fullCompositionExecutable':False,'physicalModelAccepted':False,'alchemicalC4Policy':None,'productionProtocol':None}
  modelhash=sha_bytes(encoded(policy));save_json(leg/'model-policy.json',policy)
  endpoint_def=lambda e:{role:streams[e+'.'+role]['proposedStreamId']for role in ROLE_WIDTHS}
  definition={'modelPolicy':'0x'+modelhash,'dummyPolicy':'0x'+hybrid['model_policy_sha256'],'positions':streams['positions']['proposedStreamId'],'a':endpoint_def('A'),'b':endpoint_def('B'),'atoms':N+1,'bonds':actual[1],'angles':actual[2],'torsions':actual[3],'exceptions':actual[4],'box':[q16(x)for x in cost['box_nm']],'switchDistance':None,'cutoff':None,'prefactor':None,'ewaldAlpha':None,'ewaldExtent':None,'softcoreAlpha':None}
  result={'schema':'orvia.full-hybrid-catalog-candidate.v1','status':'ASSEMBLED_CANDIDATE_PROTOCOL_AND_C4_GATES_FALSE','definition':definition,'definitionAbi':'AlchemicalTopologyCatalog.Definition fields; null production choices deliberately block create','lambdas':None,'modelPolicyHashAlgorithm':'SHA256(canonical model-policy JSON)','streams':streams,'parameters':param_artifacts,'globalMap':map_artifact,'nativeRecordProvenance':source_artifact,'mandatoryConstraints':constraint_artifact,'mandatoryC4':c4_artifact,'normalizations':normalization_artifact,'counts':{'native':N,'hybrid':N+1,'bonds':actual[1],'angles':actual[2],'torsions':actual[3],'exceptions':actual[4],'constraints':len(constraints['constraints'])},'endpointNetChargesE':{e:math.fsum(r[0]for r in p['particles'])for e,p in endpoints.items()},'sharedParticleStreamByteEqualityVerified':True,'streamsUploaded':False,'catalogSealedOnChain':False,'fullCompositionExecutable':False,'scientificAcceptance':False,'productionReady':False,'sourceFiles':inputs,'sourceHashesVerifiedAfterAssembly':False}
  for item in inputs:assert sha(ROOT/item['path'])==item['sha256']
  result['sourceHashesVerifiedAfterAssembly']=True;save_json(leg/'catalog-candidate.json',result)
  summary['legs'][name]={'status':result['status'],'counts':result['counts'],'manifest':str((leg/'catalog-candidate.json').relative_to(OUT)),'manifestSha256':sha(leg/'catalog-candidate.json'),'uniqueStreamWords':sum(v['wordCount']for v in streams.values()if not v.get('aliasOf')),'endpointNetChargesE':result['endpointNetChargesE']}
 del topology,native,raw,endpoints;gc.collect()

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--leg',choices=SPECS);args=parser.parse_args();summary={'schema':'orvia.full-hybrid-assembly-summary.v1','status':'in_progress','passedAssemblyChecks':False,'legs':{},'failures':[],'scientificAcceptance':False,'productionReady':False,'optimizerRestarted':False,'dynamicsPerformed':False,'mainnetTransactionsSent':0,'scriptSha256':sha(Path(__file__))}
 save_json(OUT/'assembly-summary.json',summary)
 try:
  for leg in ([args.leg]if args.leg else SPECS):build(leg,summary);save_json(OUT/'assembly-summary.json',summary);print(json.dumps(summary['legs'][leg]),flush=True)
  summary['status']='assembled_unaccepted';summary['passedAssemblyChecks']=True
 except Exception as e:summary['status']='failed';summary['failures'].append({'message':str(e),'traceback':traceback.format_exc()});raise
 finally:save_json(OUT/'assembly-summary.json',summary)

if __name__=='__main__':main()
