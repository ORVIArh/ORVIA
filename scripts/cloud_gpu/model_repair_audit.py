#!/usr/bin/env python3
"""Audit existing native/export coordinate identity without changing inputs."""
from pathlib import Path
import argparse,gzip,hashlib,json,tempfile,time,traceback
import numpy as np
from openmm import app,unit,XmlSerializer

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--aura-root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();root=a.aura_root.resolve();out=a.output.resolve();out.parent.mkdir(parents=True,exist_ok=True)
 if out.exists():raise FileExistsError(out)
 report={'schema':'orvia.native-export-coordinate-identity-audit.v1','status':'in_progress','passed':False,'scriptSha256':sha(Path(__file__)),'sourceInputsModified':False,'scientificAcceptance':False,'legs':{}}
 def save():out.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
 save()
 try:
  for leg,directory,coordinate,original in [('complex33','cardiac_adppi_ff03_m3l_33_782_solvated_v0_1','complex_1264.rst7.gz','complex.inpcrd.gz'),('solvent33','ligand_adppi_ff03_m3l_33_782_solvated_v0_1','solvent.inpcrd.gz','solvent.inpcrd.gz')]:
   source=root/'work/scientific-preparation/data/prepared_candidate'/directory;export=root/'output/runpod-benchmark/full-inputs'/leg
   provenance=json.loads((export/'provenance.json').read_text());positions=json.loads((export/'positions.json').read_text());actual=np.array(positions['positions_nm']);box=np.array(positions['box_vectors_nm']);sources={str(p):sha(p)for p in [source/coordinate,source/original,source/'particle_cost_inputs.json.gz',export/'system.xml',export/'positions.json',export/'provenance.json']}
   for path,rec in provenance['sourceFiles'].items():assert sha(path)==rec['sha256']
   with tempfile.TemporaryDirectory(prefix='orvia-native-identity-')as tmp:
    all_arrays=[]
    for index,name in enumerate([coordinate,original]):
     f=Path(tmp)/(str(index)+'.rst7');f.write_bytes(gzip.decompress((source/name).read_bytes()));obj=app.AmberInpcrdFile(str(f));all_arrays.append(np.array(obj.positions.value_in_unit(unit.nanometer)));assert np.array_equal(np.array(obj.boxVectors.value_in_unit(unit.nanometer)),box)
   data=json.loads(gzip.decompress((source/'particle_cost_inputs.json.gz').read_bytes()));cost=np.array(data['positions_nm']);sourcebox=np.diag(np.array(data['box_nm']));system=XmlSerializer.deserialize((export/'system.xml').read_text());xmlbox=np.array([[v.value_in_unit(unit.nanometer)for v in row]for row in system.getDefaultPeriodicBoxVectors()]);assert np.array_equal(actual,all_arrays[0]);assert np.array_equal(actual,all_arrays[1]);assert np.array_equal(box,xmlbox);assert np.allclose(sourcebox,box,rtol=0,atol=1e-14)
   r={'atoms':len(actual),'constraints':system.getNumConstraints(),'positionsExactlyMatchSuppliedNativeCoordinates':True,'positionsExactlyMatchPreC4Original':True,'maxAbsExportVsParticleCostInputNm':float(np.max(np.abs(actual-cost))),'particleCostCoordinatesBitEqual':bool(np.array_equal(actual,cost)),'xmlAndNativeBoxBitEqual':True,'sourceAndExportCoordinateUnits':'nanometer','coordinateMinNm':actual.min(axis=0).tolist(),'coordinateMaxNm':actual.max(axis=0).tolist(),'boxDiagonalNm':np.diag(box).tolist(),'coordinatesOutsidePrimaryBox':int(np.any((actual<0)|(actual>=np.diag(box)),axis=1).sum()),'sourceHashes':sources,'conclusion':'No coordinate unit/order/box corruption introduced by native exporter; periodic imaging and structural source quality need separate audits.'}
   for path,digest in sources.items():assert sha(path)==digest
   report['legs'][leg]=r;save()
  report['status']='passed_export_identity_not_structure_acceptance';report['passed']=True
 except Exception as e:report.update(status='failed',error={'message':str(e),'traceback':traceback.format_exc()});raise
 finally:save()
 print(json.dumps({'passed':report['passed'],'legs':report['legs']},indent=2))
if __name__=='__main__':main()
