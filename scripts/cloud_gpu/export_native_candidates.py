#!/usr/bin/env python3
"""Export frozen native candidate endpoints for fixed-coordinate force timing only.

No minimization, integration, scientific admission or model substitution occurs.
"""
from __future__ import annotations
import argparse,gzip,hashlib,importlib,inspect,json,math,platform,tempfile,time,traceback
from pathlib import Path
from datetime import datetime,timezone
import numpy as np
import openmm as mm
from openmm import app,unit
from openmm.app.internal import amber_file_parser

SPECS={
 'complex33':('cardiac_adppi_ff03_m3l_33_782_solvated_v0_1','complex_1264.prmtop.gz','complex_1264.rst7.gz',132935,120519,True),
 'solvent33':('ligand_adppi_ff03_m3l_33_782_solvated_v0_1','solvent.prmtop.gz','solvent.inpcrd.gz',151505,151179,False),
}
def sha(data):return hashlib.sha256(data).hexdigest()
def write_json(path,value):path.write_text(json.dumps(value,indent=2,allow_nan=False)+'\n')
def utc():return datetime.now(timezone.utc).isoformat()
def args():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--source-root',type=Path,required=True,help='Frozen prepared_candidate directory')
 p.add_argument('--output-root',type=Path,required=True,help='New output directory; existing outputs are never overwritten')
 p.add_argument('--leg',choices=SPECS)
 return p.parse_args()
def export(name,spec,source_root,destination):
 directory,top_name,coord_name,expected_atoms,expected_constraints,requires_c4=spec
 target=destination/name;target.mkdir(parents=True,exist_ok=True)
 for filename in ['system.xml','positions.json','provenance.json']:
  if(target/filename).exists():raise FileExistsError(f'Refusing existing output: {target/filename}')
 start=time.perf_counter();sources={}
 with tempfile.TemporaryDirectory(prefix='orvia-native-force-export-')as temporary:
  paths=[]
  for original,localname in [(source_root/directory/top_name,'native.prmtop'),(source_root/directory/coord_name,'native.inpcrd')]:
   compressed=original.read_bytes();raw=gzip.decompress(compressed);local=Path(temporary)/localname;local.write_bytes(raw);paths.append(local)
   sources[str(original.resolve())]={'bytes':len(compressed),'sha256':sha(compressed),'decompressedBytes':len(raw),'decompressedSha256':sha(raw)}
  topology=app.AmberPrmtopFile(str(paths[0]));coordinates=app.AmberInpcrdFile(str(paths[1]))
  assert topology.topology.getNumAtoms()==expected_atoms
  raw_flags=topology._prmtop._raw_data;assert ('LENNARD_JONES_CCOEF'in raw_flags)==requires_c4
  system=topology.createSystem(nonbondedMethod=app.PME,nonbondedCutoff=1*unit.nanometer,
      constraints=None,rigidWater=True,removeCMMotion=False,ewaldErrorTolerance=0.0005)
  assert system.getNumParticles()==expected_atoms
  assert system.getNumConstraints()==expected_constraints,(name,system.getNumConstraints(),expected_constraints)
  assert not any(system.isVirtualSite(i)for i in range(expected_atoms))
  assert coordinates.boxVectors is not None,'PME requires the explicit native coordinate box'
  system.setDefaultPeriodicBoxVectors(*coordinates.boxVectors)
  positions=np.asarray(coordinates.positions.value_in_unit(unit.nanometer),dtype=float)
  box=np.asarray(coordinates.boxVectors.value_in_unit(unit.nanometer),dtype=float)
  assert positions.shape==(expected_atoms,3)and np.isfinite(positions).all()
  assert box.shape==(3,3)and np.isfinite(box).all()and np.linalg.det(box)>0
  forces=[system.getForce(i)for i in range(system.getNumForces())]
  nonbonded=[f for f in forces if isinstance(f,mm.NonbondedForce)];custom=[f for f in forces if isinstance(f,mm.CustomNonbondedForce)]
  assert len(nonbonded)==1;nb=nonbonded[0];assert nb.getNonbondedMethod()==mm.NonbondedForce.PME
  assert nb.getNumParticles()==expected_atoms
  c4=[]
  if requires_c4:
   assert len(custom)==1,'Expected the exact native standalone C4 force, not an omitted or merged term'
   cf=custom[0];expression=cf.getEnergyFunction();assert '-c/r^4'in expression and 'ccoef(type1, type2)'in expression
   assert cf.getNumParticles()==expected_atoms and cf.getNumExclusions()==nb.getNumExceptions()
   assert cf.getNonbondedMethod()==mm.CustomNonbondedForce.CutoffPeriodic
   assert cf.getUseLongRangeCorrection()and not cf.getUseSwitchingFunction()
   assert float(cf.getCutoffDistance().value_in_unit(unit.nanometer))==1.0
   for i in range(nb.getNumExceptions()):
    a,b,*_=nb.getExceptionParameters(i);x,y=cf.getExclusionParticles(i);assert(int(a),int(b))==(int(x),int(y))
   names=[cf.getTabulatedFunctionName(i)for i in range(cf.getNumTabulatedFunctions())];assert names==['ccoef']
   nx,ny,values=cf.getTabulatedFunction(0).getFunctionParameters();assert any(v>0 for v in values)and all(v>=0 and math.isfinite(v)for v in values)
   c4=[{'expression':expression,'particles':cf.getNumParticles(),'exclusions':cf.getNumExclusions(),'allNonbondedExceptionsExcluded':True,'method':'CutoffPeriodic','cutoffNm':1.0,'switching':False,'longRangeCorrection':True,'tableShape':[nx,ny],'nonzeroMatrixValues':sum(v>0 for v in values)}]
  else:assert len(custom)==0,'Unexpected custom nonbonded term in solvent source'
  xml=mm.XmlSerializer.serialize(system);restored=mm.XmlSerializer.deserialize(xml)
  assert restored.getNumParticles()==expected_atoms and restored.getNumConstraints()==expected_constraints
  assert mm.XmlSerializer.serialize(restored)==xml,'Serialized System roundtrip changed bytes'
  payload={'positions_nm':positions.tolist(),'box_vectors_nm':box.tolist(),'position_source':'Exact supplied native coordinate file; no minimization, translation or integration','system_box_matches_positions_box':True}
  system_path=target/'system.xml';system_path.write_text(xml);position_path=target/'positions.json';position_path.write_text(json.dumps(payload,separators=(',',':'),allow_nan=False)+'\n')
  ver=importlib.import_module('openmm.version');parser_path=Path(inspect.getfile(amber_file_parser));source_hashes={str(parser_path):sha(parser_path.read_bytes()),str(Path(inspect.getfile(app.AmberPrmtopFile))):sha(Path(inspect.getfile(app.AmberPrmtopFile)).read_bytes())}
  provenance={'schema':'orvia.native-full-size-fixed-coordinate-force-fixture.v1','status':'exported_source_bound_candidate_not_scientifically_accepted','exportedAtUtc':utc(),'leg':name,'nativeEndpoint':'B:44atom ligand; no45atom hybrid ghost','atoms':expected_atoms,'constraints':expected_constraints,'constraintPolicy':'constraints=None,rigidWater=True: native rigidwater only; no inferred soluteHBonds','virtualSites':0,'forceTypes':[type(f).__name__ for f in forces],'c4':c4,'nonbonded':{'method':'PME','cutoffNm':1.0,'ewaldErrorTolerance':0.0005,'useSwitchingFunction':nb.getUseSwitchingFunction(),'useDispersionCorrection':nb.getUseDispersionCorrection(),'particles':nb.getNumParticles(),'exceptions':nb.getNumExceptions()},'constructor':{'nonbondedMethod':'PME','nonbondedCutoffNm':1.0,'constraints':None,'rigidWater':True,'removeCMMotion':False,'ewaldErrorTolerance':0.0005,'box':'native coordinate box explicitly installed in serialized System'},'openmm':{'version':mm.__version__,'fullVersion':getattr(ver,'full_version',None),'gitRevision':getattr(ver,'git_revision',None),'release':getattr(ver,'release',None)},'host':{'python':platform.python_version(),'platform':platform.platform()},'importerSourceHashes':source_hashes,'sourceFiles':sources,'sourceHashesVerifiedAfterExport':False,'scriptSha256':sha(Path(__file__).read_bytes()),'outputFiles':{f.name:{'bytes':f.stat().st_size,'sha256':sha(f.read_bytes())}for f in [system_path,position_path]},'boxVectorsNm':box.tolist(),'xmlSerializationRoundtripVerified':True,'scope':'Fixed-coordinate complete native force evaluation hardware timing only; no minimization, MD, full hybrid or free-energy calculation.','fixedCoordinatesOnly':True,'integrationAllowed':False,'minimizationPerformed':False,'dynamicsPerformed':False,'scientificAcceptance':False,'productionReady':False,'originalVanadateModelReplaced':False,'knownLimitations':['ADP/phosphate candidate, not the selected original vanadate protocol.','The complex source retains a failed structural/coordination gate; fixed-coordinate performance does not validate geometry.','PME1nm/error0.0005 are explicit diagnostic benchmark settings, not adopted production settings.','Native C4 retained; staged alchemical C4/activity/charge policy is not implemented by this native endpoint export.','No energy/force or GPU context was evaluated by this exporter; numerical/hardware checks are separate.'],'elapsedSeconds':time.perf_counter()-start}
 for path,record in sources.items():assert sha(Path(path).read_bytes())==record['sha256']
 provenance['sourceHashesVerifiedAfterExport']=True;write_json(target/'provenance.json',provenance)
 return {'leg':name,'atoms':expected_atoms,'constraints':expected_constraints,'files':provenance['outputFiles'],'provenanceSha256':sha((target/'provenance.json').read_bytes()),'elapsedSeconds':provenance['elapsedSeconds']}
def main():
 a=args();source=a.source_root.resolve();out=a.output_root.resolve();out.mkdir(parents=True,exist_ok=True);summary=out/'export-summary.json'
 if summary.exists():raise FileExistsError(f'Refusing existing export summary: {summary}')
 report={'schema':'orvia.native-force-fixture-export-summary.v1','status':'in_progress','passed':False,'sourceRoot':str(source),'scriptSha256':sha(Path(__file__).read_bytes()),'legs':[],'scientificAcceptance':False,'productionReady':False,'publicTransactionsSent':0};write_json(summary,report)
 try:
  for name in([a.leg]if a.leg else SPECS):
   row=export(name,SPECS[name],source,out);report['legs'].append(row);write_json(summary,report);print(json.dumps(row),flush=True)
  report.update(status='passed_source_bound_fixed_coordinate_force_fixture_export',passed=True)
 except Exception as e:report.update(status='failed',error={'message':str(e),'traceback':traceback.format_exc()});raise
 finally:write_json(summary,report)
if __name__=='__main__':main()
