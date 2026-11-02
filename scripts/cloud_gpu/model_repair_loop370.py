#!/usr/bin/env python3
"""Derive a source-bound ADPPI-v0.2 protein coordinate patch; never minimize or edit native inputs.

Reuses an existing dry protein preparation candidate. The LEaP-consumed PDB,
protein topology, native full-complex prefix and rigid translation must all match.
This is a coordinate hypothesis, not a structural or production acceptance.
"""
from pathlib import Path
import argparse, hashlib, json
import numpy as np
import parmed
H=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()

def derive(aura_root):
 root=Path(aura_root).resolve();base=root/'work/scientific-preparation/data/prepared_candidate/cardiac_ff03_m3l_33_782_v0_1';fixture=root/'output/runpod-benchmark/full-inputs/complex33';science=root/'work/scientific-preparation';prov=json.loads((fixture/'provenance.json').read_text());native_top=Path(next(p for p in prov['sourceFiles']if '.prmtop' in p));reportpath=base/'gpu_local_regularized_preparation.json';prior=json.loads(reportpath.read_text());top=base/'protein.prmtop';oldpdb=base/'protein_coordinate_candidate.pdb';newrst=base/'protein_local_regularized_candidate.rst7';selected=science/'data/prepared_candidate/selected_heavy_coordinates.json';declaration=json.loads((base/'coordinate_preparation.json').read_text())
 sources=[top,oldpdb,newrst,reportpath,selected,base/'coordinate_preparation.json',fixture/'positions.json',fixture/'provenance.json',native_top,science/'scripts/preparation/relax_protein_coordinate_candidate.py'];hashes={str(p.relative_to(root)):H(p)for p in sources}
 assert H(newrst)==prior['artifact_sha256'][newrst.name];assert H(top)==prior['artifact_sha256'][top.name];assert H(selected)==prior['source_selected_heavy_sha256'];assert prior['local_regularization_auth_residue_window']==[366,374];assert declaration['native_residue_index_to_auth_id']==list(range(33,783));assert H(native_top)==prov['sourceFiles'][str(native_top)]['sha256'];assert H(fixture/'positions.json')==prov['outputFiles']['positions.json']['sha256']
 p=parmed.load_file(str(top),xyz=str(newrst));native=parmed.load_file(str(native_top));n=len(p.atoms);assert n==12042;new=np.asarray(p.coordinates,dtype=float)/10;full=np.asarray(json.loads((fixture/'positions.json').read_text())['positions_nm'],dtype=float);rows=[line for line in oldpdb.read_text().splitlines()if line[:6].strip()in('ATOM','HETATM')];assert len(rows)==n
 old=np.array([[float(line[30:38]),float(line[38:46]),float(line[46:54])]for line in rows])/10
 for i,(a,line,b)in enumerate(zip(p.atoms,rows,native.atoms[:n])):
  assert a.idx==b.idx==i and a.name==b.name==line[12:16].strip();assert a.residue.idx==b.residue.idx==int(line[22:26])-1;assert a.residue.name==b.residue.name==line[17:20].strip();assert a.type==b.type and abs(a.mass-b.mass)<1e-10
 shift=np.median(full[:n]-old,axis=0);residual=float(np.max(np.abs(full[:n]-old-shift)));assert residual<1e-12
 observed={(int(a['auth_seq_id']),a['label_atom_id']):np.array(list(map(float,a['xyz_nm_exact_decimal'])))for a in json.loads(selected.read_text())['atoms']if a['label_asym_id']=='A'};fixed=[];moving=[]
 for a in p.atoms:
  key=(a.residue.idx+33,a.name)
  if key in observed:
   displacement=float(np.linalg.norm(new[a.idx]-observed[key]));entry={'proteinAtomIndex0':a.idx,'authResidue':key[0],'name':key[1],'sourceDisplacementNm':displacement}
   (moving if 366<=key[0]<=374 else fixed).append(entry)
 assert len(fixed)==5704 and len(moving)==69;assert max(x['sourceDisplacementNm']for x in fixed)<1e-7
 # Revalidate every protein bond and angle, including boundary geometry.
 bonds=[];angles=[]
 for b in p.bonds:
  d=float(np.linalg.norm(new[b.atom1.idx]-new[b.atom2.idx]))*10;error=abs(d-b.type.req)
  if error>.25:bonds.append({'indices0':[b.atom1.idx,b.atom2.idx],'lengthAngstrom':d,'equilibriumAngstrom':b.type.req,'errorAngstrom':error})
 for a in p.angles:
  u=new[a.atom1.idx]-new[a.atom2.idx];v=new[a.atom3.idx]-new[a.atom2.idx];theta=float(np.degrees(np.arccos(np.clip(np.dot(u,v)/(np.linalg.norm(u)*np.linalg.norm(v)),-1,1))));error=abs(theta-a.type.theteq)
  if error>30:angles.append({'indices0':[a.atom1.idx,a.atom2.idx,a.atom3.idx],'degrees':theta,'equilibriumDegrees':a.type.theteq,'errorDegrees':error})
 assert not bonds and not angles
 translated=new+shift;changes=translated-full[:n];entries=[]
 for a in p.atoms:
  i=a.idx;entries.append({'globalAtomIndex0':i,'proteinAtomIndex0':i,'nativeResidueIndex0':a.residue.idx,'authResidue':a.residue.idx+33,'residueName':a.residue.name,'atomName':a.name,'amberType':a.type,'oldPositionNm':full[i].tolist(),'newPositionNm':translated[i].tolist(),'deltaNm':changes[i].tolist()})
 result={'schema':'orvia.adppi-v0.2-full-protein-coordinate-patch.v1','status':'derived_existing_bounded_preparation_candidate_not_accepted','candidateModel':'ORVIA-ADPPI-v0.2','scientificAcceptance':False,'productionReady':False,'optimizerRun':False,'dynamicsPerformed':False,'sourceInputsModified':False,'sourceHashes':hashes,'scriptSha256':H(Path(__file__)),'proteinAtoms':n,'fullComplexNativeAtoms':len(full),'prefixIdentityVerified':True,'authRange':[33,782],'declaredObservedMobileWindow':[366,374],'completeProteinReused':True,'introducedAtomsOutsideWindowMayMove':True,'proteinToFullComplexTranslationNm':shift.tolist(),'maxSourcePdbPrefixTranslationResidualNm':residual,'sourcePdbSerializationAngstrom':.001,'observedFixedOutsideWindow':len(fixed),'observedMobileInsideWindow':len(moving),'maxFixedObservedSourceDisplacementNm':max(x['sourceDisplacementNm']for x in fixed),'maxMobileObservedSourceDisplacementNm':max(x['sourceDisplacementNm']for x in moving),'maxAnyProteinPatchDisplacementNm':float(np.linalg.norm(changes,axis=1).max()),'independentAllProteinBondOutliersAbove0_25Angstrom':bonds,'independentAllProteinAngleOutliersAbove30Degrees':angles,'priorCandidatePhysicalModel':'Dry ff03.r1/FF_PTM NoCutoff preparation; protein retained in full. No cofactor/ligand/solvent preparation acceptance follows.','requires':['Apply to a new separately named ADPPI-v0.2 coordinate artifact only.','Recheck full-solute/protein-cofactor geometry and full-system clashes after assembly.','Revalidate energies/forces and constrained preparation under the explicitly selected full model.','No force-field,atom,residue,exception,box or source-topology changes are implied.'],'atoms':entries}
 for rel,h in hashes.items():assert H(root/rel)==h
 result['sourceHashesVerifiedAfterDerivation']=True;return result

def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--aura-root',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);a=ap.parse_args()
 if a.output.exists():raise FileExistsError(a.output)
 a.output.parent.mkdir(parents=True,exist_ok=True);r=derive(a.aura_root);a.output.write_text(json.dumps(r,indent=2,sort_keys=True,allow_nan=False)+'\n');print(json.dumps({k:r[k]for k in ['status','proteinAtoms','proteinToFullComplexTranslationNm','maxSourcePdbPrefixTranslationResidualNm','maxMobileObservedSourceDisplacementNm','maxAnyProteinPatchDisplacementNm']},indent=2))
if __name__=='__main__':main()
