#!/usr/bin/env python3
"""Deterministic same-composition rigid-solvent clash relief for ADPPI v0.2.
Geometry preparation only: source topology, atoms, parameters and box are fixed.
"""
from pathlib import Path
import argparse,gzip,hashlib,json,time,traceback
import numpy as np
from scipy.spatial import cKDTree
import parmed

TRIGGER=0.60;TARGET=0.70;MAX_ITER=250;MAX_INCREMENT_NM=0.02;MAX_TOTAL_MOVE_NM=1.0

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(p,x):p.write_text(json.dumps(x,indent=2,allow_nan=False)+'\n')
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--aura-root',type=Path,required=True);p.add_argument('--output-root',type=Path,required=True);p.add_argument('--protein-patch',type=Path,required=True);a=p.parse_args();root=a.aura_root.resolve();out=a.output_root.resolve();out.mkdir(parents=True,exist_ok=True)
 if(out/'repair-summary.json').exists():raise FileExistsError('Refusing existing repair summary')
 report={'schema':'orvia.adppi-v0.2-rigid-solvent-geometry-preparation.v1','status':'in_progress','passedGeometricPreparation':False,'scientificAcceptance':False,'productionReady':False,'sourceInputsModified':False,'modelChoice':'Separately named ADPPI-v0.2; originalvanadate preserved','settings':{'triggerRatioToNativeLJMinimum':TRIGGER,'pushTargetRatio':TARGET,'maxIterations':MAX_ITER,'maxPerIterationEntityTranslationNm':MAX_INCREMENT_NM,'maxTotalEntityTranslationNm':MAX_TOTAL_MOVE_NM,'mobileEntities':'Whole WAT/HOH residues and K+/Cl- ions only; Mg and other solutes fixed after explicit protein patch','method':'Deterministic simultaneous minimum-image pair-separation projections; not energy minimization or equilibrated dynamics'},'scriptSha256':sha(Path(__file__)),'legs':{}}
 save(out/'repair-summary.json',report)
 try:
  for leg,directory,topname in [('complex33','cardiac_adppi_ff03_m3l_33_782_solvated_v0_1','complex_1264.prmtop.gz'),('solvent33','ligand_adppi_ff03_m3l_33_782_solvated_v0_1','solvent.prmtop.gz')]:
   started=time.perf_counter();dest=out/leg;dest.mkdir(parents=True,exist_ok=True);fixture=root/'output/runpod-benchmark/full-inputs'/leg;source=root/'work/scientific-preparation/data/prepared_candidate'/directory/topname
   source_hashes={str(x):sha(x)for x in[source,fixture/'positions.json',fixture/'system.xml',a.protein_patch]};obj=json.loads((fixture/'positions.json').read_text());original=np.asarray(obj['positions_nm']);xyz=original.copy();box=np.diag(np.asarray(obj['box_vectors_nm']));n=len(xyz);top=parmed.load_file(str(source));assert len(top.atoms)==n
   patch_used=False
   if leg=='complex33':
    patch=json.loads(a.protein_patch.read_text());assert patch['prefixIdentityVerified']and not patch['sourceInputsModified']
    for row in patch['atoms']:
     index=row['globalAtomIndex0'];assert top.atoms[index].name==row['atomName'];assert np.max(np.abs(xyz[index]-row['oldPositionNm']))<1e-12;xyz[index]=row['newPositionNm']
    patch_used=True
   post_patch=xyz.copy();types=np.array(top.parm_data['ATOM_TYPE_INDEX'],dtype=int)-1;ntypes=int(top.parm_data['POINTERS'][1]);indices=np.asarray(top.parm_data['NONBONDED_PARM_INDEX'],dtype=int).reshape(ntypes,ntypes)-1;av=np.array(top.parm_data['LENNARD_JONES_ACOEF']);bv=np.array(top.parm_data['LENNARD_JONES_BCOEF']);amat=np.where(indices>=0,av[np.maximum(indices,0)],0);bmat=np.where(indices>=0,bv[np.maximum(indices,0)],0);rmin=np.zeros_like(amat);positive=(amat>0)&(bmat>0);rmin[positive]=np.power(2*amat[positive]/bmat[positive],1/6)*.1
   active=np.flatnonzero(np.diag(amat)[types]>0);max_radius=TRIGGER*float(rmin.max());num=np.array(top.parm_data['NUMBER_EXCLUDED_ATOMS'],dtype=np.int64);lst=np.array(top.parm_data['EXCLUDED_ATOMS_LIST'],dtype=np.int64);assert num.sum()==len(lst);ea=np.repeat(np.arange(n,dtype=np.int64),num);keep=lst>0;eb=lst[keep]-1;ea=ea[keep];excluded=np.unique(np.minimum(ea,eb)*n+np.maximum(ea,eb))
   entities=[];atom_entity=np.full(n,-1,dtype=np.int64)
   for residue in top.residues:
    if residue.name not in ['WAT','HOH','K+','Cl-']:continue
    atomids=np.array([x.idx for x in residue.atoms],dtype=np.int64);entity=len(entities);entities.append(atomids);atom_entity[atomids]=entity
   mobile=atom_entity>=0;total_shift=np.zeros((len(entities),3));steps=[]
   def find():
    wrapped=np.mod(xyz[active],box);pairs=cKDTree(wrapped,boxsize=box).query_pairs(max_radius,output_type='ndarray');aa=active[pairs[:,0]];bb=active[pairs[:,1]];order=np.lexsort((bb,aa));aa=aa[order];bb=bb[order];delta=xyz[bb]-xyz[aa];delta-=box*np.rint(delta/box);distance=np.linalg.norm(delta,axis=1);minimum=rmin[types[aa],types[bb]];key=np.minimum(aa,bb)*n+np.maximum(aa,bb);pos=np.searchsorted(excluded,key);is_excluded=np.zeros(len(key),dtype=bool);valid=pos<len(excluded);is_excluded[valid]=excluded[pos[valid]]==key[valid];mask=(minimum>0)&(distance<TRIGGER*minimum)&~is_excluded
    return aa[mask],bb[mask],delta[mask],distance[mask],minimum[mask]
   initial=find();initial_count=len(initial[0]);fixed_issues=[]
   for iteration in range(MAX_ITER):
    aa,bb,delta,distance,minimum=find()
    if not len(aa):break
    shifts=np.zeros_like(total_shift);max_deficit=0.;fixed_issues=[]
    for i,j,d,r,rm in zip(aa,bb,delta,distance,minimum):
     x,y=atom_entity[i],atom_entity[j]
     if x<0 and y<0:fixed_issues.append({'a':int(i),'b':int(j),'distanceNm':float(r),'ratio':float(r/rm)});continue
     if x==y:raise RuntimeError('Unexcluded intra-entity pair cannot be moved independently')
     if r==0:
      direction=np.zeros(3);direction[(int(i)+int(j))%3]=1
     else:direction=d/r
     correction=(TARGET*rm-r)*direction;max_deficit=max(max_deficit,float(TARGET*rm-r))
     if x>=0 and y>=0:shifts[x]-=.5*correction;shifts[y]+=.5*correction
     elif x>=0:shifts[x]-=correction
     else:shifts[y]+=correction
    if fixed_issues:break
    norms=np.linalg.norm(shifts,axis=1);large=norms>MAX_INCREMENT_NM;shifts[large]*=(MAX_INCREMENT_NM/norms[large])[:,None];total_shift+=shifts
    if np.max(np.linalg.norm(total_shift,axis=1))>MAX_TOTAL_MOVE_NM:raise RuntimeError('Declared solvent movement bound exceeded')
    xyz[mobile]+=shifts[atom_entity[mobile]];steps.append({'iteration':iteration,'violatingPairs':len(aa),'maxTargetDeficitNm':max_deficit,'maxAppliedEntityTranslationNm':float(np.max(np.linalg.norm(shifts,axis=1)))})
   final=find();assert len(final[0])==0,f'Unresolved hard contacts: {len(final[0])}, fixedsolute issues:{fixed_issues[:5]}'
   assert np.array_equal(xyz[~mobile],post_patch[~mobile]);max_internal=0.
   for atomids in entities:
    if len(atomids)>1:max_internal=max(max_internal,float(np.max(np.abs((xyz[atomids]-xyz[atomids[0]])-(post_patch[atomids]-post_patch[atomids[0]])))))
   assert max_internal<1e-12
   payload={'positions_nm':xyz.tolist(),'box_vectors_nm':obj['box_vectors_nm'],'candidateModel':'ORVIA-ADPPI-v0.2-GEOMETRY-PREPARATION-CANDIDATE','stage':'rigid-solvent-clash-relief-plus-existing-regularized-protein','notEquilibrated':True,'scientificAcceptance':False};data=dest/'positions.json';data.write_text(json.dumps(payload,separators=(',',':'),allow_nan=False)+'\n')
   item={'atoms':n,'constraints':120519 if leg=='complex33' else 151179,'sourceSystemXml':str(fixture/'system.xml'),'sourceSystemSha256':sha(fixture/'system.xml'),'positionsFile':str(data),'positionsSha256':sha(data),'proteinPatchUsed':patch_used,'initialPositiveLJViolationsBelowTrigger':initial_count,'finalPositiveLJViolationsBelowTrigger':len(final[0]),'iterations':len(steps),'steps':steps,'mobileEntities':len(entities),'movedEntities':int(np.sum(np.linalg.norm(total_shift,axis=1)>1e-12)),'maxEntityTranslationNm':float(np.max(np.linalg.norm(total_shift,axis=1))),'maximumRigidWaterInternalVectorDifferenceNm':max_internal,'nonmobileCoordinatesExactlyRetainedAfterDeclaredProteinPatch':True,'allAtomsParametersBoxRetained':True,'sourceHashes':source_hashes,'sourceHashesVerifiedAfterPreparation':False,'elapsedSeconds':time.perf_counter()-started,'scope':'Geometric clash relief only; full force-range/oracle and minimization/equilibration acceptance remain required.'}
   for path,digest in source_hashes.items():assert sha(path)==digest
   item['sourceHashesVerifiedAfterPreparation']=True;save(dest/'preparation.json',item);report['legs'][leg]=item;save(out/'repair-summary.json',report);print(json.dumps({k:item[k]for k in ['atoms','initialPositiveLJViolationsBelowTrigger','finalPositiveLJViolationsBelowTrigger','iterations','movedEntities','maxEntityTranslationNm','elapsedSeconds']}),flush=True)
  report.update(status='passed_same-composition_geometric_clash_relief_not_physical_acceptance',passedGeometricPreparation=True)
 except Exception as e:report.update(status='failed',error={'message':str(e),'traceback':traceback.format_exc()});raise
 finally:save(out/'repair-summary.json',report)
if __name__=='__main__':main()
