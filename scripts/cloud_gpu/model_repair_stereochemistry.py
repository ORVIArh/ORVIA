#!/usr/bin/env python3
"""Create a separate v0.3 coordinate candidate correcting five modeled stereocenters.

Native parameters and identities are unchanged. The temporary dry-protein
preparation system fixes everything except the two originally absent loops and
adds one-sided chirality walls; it is never used as the production Hamiltonian.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
import traceback
import numpy as np
import openmm as mm
from openmm import app,unit
import parmed
from structure_validation import normalized_volume,l_alpha_sign,l_beta_signs

TARGETS={629:'THR',631:'ILE',637:'LYS',735:'PHE'}
MOBILE_WINDOWS=[(626,644),(732,735)]


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def proper_rotation(a,b):
    a=np.asarray(a,dtype=float);b=np.asarray(b,dtype=float);a/=np.linalg.norm(a);b/=np.linalg.norm(b)
    cross=np.cross(a,b);cosine=float(np.dot(a,b));sine=np.linalg.norm(cross)
    if sine<1e-12:
        if cosine>0:return np.eye(3)
        axis=np.eye(3)[int(np.argmin(np.abs(a)))];axis-=np.dot(axis,a)*a;axis/=np.linalg.norm(axis)
        return 2*np.outer(axis,axis)-np.eye(3)
    k=np.array([[0,-cross[2],cross[1]],[cross[2],0,-cross[0]],[-cross[1],cross[0],0]])
    return np.eye(3)+k+k@k/(1+cosine)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--aura-root',type=Path,required=True);parser.add_argument('--output-root',type=Path,required=True);parser.add_argument('--platform',choices=['OpenCL','Reference'],default='OpenCL');args=parser.parse_args()
    root=args.aura_root.resolve();out=args.output_root.resolve();out.mkdir(parents=True,exist_ok=False);start=time.monotonic()
    report=dict(schema='orvia.protein-stereochemistry-repair.v1',candidateModel='ORVIA-ADP-PHOSPHATE-v0.3',status='in_progress',scientificAcceptance=False,productionReady=False,sourceInputsModified=False,scriptSha256=sha(__file__),targets=TARGETS,mobileAuthWindows=MOBILE_WINDOWS,temporaryPreparationRestraints={'all_other_atoms':'fixed exactly at v0.2 positions','chirality_wall_k_kJ_mol':100000,'soft_wall_target_normalized_positive_volume':.4,'minimum_accepted_normalized_positive_volume':.25,'OpenCL_max_iterations':1000,'Reference_cleanup_max_iterations':100,'minimizer_rms_tolerance_kJ_mol_nm':10},stages=[])
    def save():
        temp=out/'repair.tmp';temp.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n');temp.replace(out/'repair.json')
    save()
    try:
        source=root/'work/scientific-preparation/data/prepared_candidate/cardiac_ff03_m3l_33_782_v0_1'
        nativefile=source/'protein.prmtop';declaration=source/'coordinate_preparation.json';selected=root/'work/scientific-preparation/data/prepared_candidate/selected_heavy_coordinates.json'
        v2=root/'output/full-model-repair/adppi-v0.2-clash-relief/complex33/positions.json';original=root/'output/runpod-benchmark/full-inputs/complex33/positions.json'
        files=[nativefile,declaration,selected,v2,original,root/'ORVIA/scripts/cloud_gpu/structure_validation.py'];hashes={str(path):sha(path) for path in files}
        mapping=json.loads(declaration.read_text())['native_residue_index_to_auth_id']
        if mapping!=list(range(33,783)):raise ValueError('Unexpected author-residue mapping')
        observed={(int(row['auth_seq_id']),row['label_atom_id']) for row in json.loads(selected.read_text())['atoms'] if row['label_asym_id']=='A'}
        top=parmed.load_file(str(nativefile));amber=app.AmberPrmtopFile(str(nativefile));n=len(top.atoms)
        if n!=12042:raise ValueError('Unexpected native protein atom count')
        payload=json.loads(v2.read_text());full=np.asarray(payload['positions_nm'],dtype=float);before=full[:n].copy();xyz=before.copy();source_original=np.asarray(json.loads(original.read_text())['positions_nm'])
        residues={residue.idx+33:residue for residue in top.residues}
        mobile=np.asarray([atom.idx for atom in top.atoms if any(a<=atom.residue.idx+33<=b for a,b in MOBILE_WINDOWS)],dtype=int)
        if any((top.atoms[int(i)].residue.idx+33,top.atoms[int(i)].name) in observed for i in mobile):raise ValueError('A proposed mobile atom is experimentally observed')
        fixed=np.ones(n,dtype=bool);fixed[mobile]=False
        changes=[]
        for auth,name in TARGETS.items():
            residue=residues[auth]
            if residue.name!=name:raise ValueError('Unexpected target residue identity')
            atoms={atom.name:atom for atom in residue.atoms};ca=atoms['CA'].idx;normal=np.cross(xyz[atoms['N'].idx]-xyz[ca],xyz[atoms['C'].idx]-xyz[ca]);normal/=np.linalg.norm(normal)
            reflection=np.eye(3)-2*np.outer(normal,normal);vector=xyz[atoms['CB'].idx]-xyz[ca]
            transform=proper_rotation(vector,reflection@vector) if name=='ILE' else reflection
            members=set();queue=[atoms['CB']]
            while queue:
                atom=queue.pop()
                if atom.idx in members or atom.idx==ca:continue
                if atom.residue is not residue:raise ValueError('Sidechain crosses a residue boundary')
                members.add(atom.idx);queue.extend(atom.bond_partners)
            for i in members:xyz[i]=xyz[ca]+transform@(xyz[i]-xyz[ca])
            alpha_h=[atom.idx for atom in atoms['CA'].bond_partners if atom.atomic_number==1]
            if len(alpha_h)!=1:raise ValueError('Expected one alpha hydrogen')
            xyz[alpha_h[0]]=xyz[ca]+reflection@(xyz[alpha_h[0]]-xyz[ca])
            changes.append(dict(authResidue=auth,residue=name,sidechainAtoms=sorted(members),alphaHydrogen=alpha_h[0],transformDeterminant=float(np.linalg.det(transform)),reason='Correct alpha while preserving beta' if name=='ILE' else 'Correct alpha and, forThr, the independently detected beta inversion'))
        np.save(out/'seed-protein-nm.npy',xyz)
        system=amber.createSystem(nonbondedMethod=app.NoCutoff,constraints=None,rigidWater=False,removeCMMotion=False)
        for i in np.flatnonzero(fixed):system.setParticleMass(int(i),0)
        expression='0.5*stereo_k*min(0,v-stereo_min)^2;v=sign*det/(distance(p1,p2)*distance(p1,p3)*distance(p1,p4));det=(x2-x1)*((y3-y1)*(z4-z1)-(z3-z1)*(y4-y1))-(y2-y1)*((x3-x1)*(z4-z1)-(z3-z1)*(x4-x1))+(z2-z1)*((x3-x1)*(y4-y1)-(y3-y1)*(x4-x1))'
        wall=mm.CustomCompoundBondForce(4,expression);wall.addGlobalParameter('stereo_k',100000);wall.addGlobalParameter('stereo_min',.4);wall.addPerBondParameter('sign');wall.setForceGroup(31)
        centers=[];alpha_sign=l_alpha_sign();beta_signs=l_beta_signs()
        for residue in top.residues:
            if not any(a<=residue.idx+33<=b for a,b in MOBILE_WINDOWS):continue
            atoms={atom.name:atom for atom in residue.atoms}
            if all(name in atoms for name in ['CA','N','C','CB']):
                indices=[atoms[name].idx for name in ['CA','N','C','CB']];centers.append((indices,alpha_sign))
                hydrogens=[atom.idx for atom in atoms['CA'].bond_partners if atom.atomic_number==1]
                if len(hydrogens)!=1:raise ValueError('Expected one alpha stereocenter hydrogen')
                centers.append(([hydrogens[0],*indices[1:]],alpha_sign))
            if residue.name in beta_signs:
                names=['CB','CA','OG1','CG2'] if residue.name=='THR' else ['CB','CA','CG1','CG2'];indices=[atoms[name].idx for name in names];centers.append((indices,beta_signs[residue.name]))
                hydrogens=[atom.idx for atom in atoms['CB'].bond_partners if atom.atomic_number==1]
                if len(hydrogens)!=1:raise ValueError('Expected one beta stereocenter hydrogen')
                centers.append(([hydrogens[0],*indices[1:]],beta_signs[residue.name]))
        for indices,sign in centers:
            if sign*normalized_volume(*(xyz[i] for i in indices))<.25:raise ValueError('Seed has unresolved chirality')
            wall.addBond(indices,[sign])
        system.addForce(wall);report.update(sourceHashes=hashes,seedCorrections=changes,mobileAtoms=len(mobile),fixedAtoms=int(fixed.sum()),chiralityWallCenters=len(centers));save()
        for label,platform_name,iterations in [('local_gpu_preparation',args.platform,1000),('independent_Reference_cleanup','Reference',100)]:
            integrator=mm.VerletIntegrator(.0005);platform=mm.Platform.getPlatformByName(platform_name)
            context=mm.Context(system,integrator,platform,{'Precision':'single'} if platform_name=='OpenCL' else {})
            context.setPositions(xyz*unit.nanometer);tick=time.monotonic();initial=float(context.getState(getEnergy=True).getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole))
            mm.LocalEnergyMinimizer.minimize(context,tolerance=10,maxIterations=iterations)
            state=context.getState(getPositions=True,getEnergy=True);xyz=np.asarray(state.getPositions(asNumpy=True).value_in_unit(unit.nanometer));xyz[fixed]=before[fixed]
            context.setPositions(xyz*unit.nanometer)
            properties={key:platform.getPropertyValue(context,key) for key in platform.getPropertyNames()}
            report['stages'].append(dict(name=label,platform=platform.getName(),properties=properties,elapsedSeconds=time.monotonic()-tick,initialPreparationEnergyKJMol=initial,finalPreparationEnergyKJMol=float(context.getState(getEnergy=True).getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole)),chiralityWallEnergyKJMol=float(context.getState(getEnergy=True,groups=1<<31).getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole))))
            save();del context,integrator
        np.save(out/'last-protein-nm.npy',xyz)
        report['finalNormalizedChiralityVolumes']=[dict(atomIndices0=indices,value=sign*normalized_volume(*(xyz[i] for i in indices))) for indices,sign in centers]
        if not np.isfinite(xyz).all() or not np.array_equal(xyz[fixed],before[fixed]):raise ValueError('Invalid coordinates or fixed atom movement')
        if any(sign*normalized_volume(*(xyz[i] for i in indices))<.25 for indices,sign in centers):raise ValueError('Chirality wall not satisfied after minimization')
        full[:n]=xyz;payload.update(positions_nm=full.tolist(),candidateModel='ORVIA-ADP-PHOSPHATE-v0.3-STEREOCHEMISTRY-CANDIDATE',scientificAcceptance=False,notEquilibrated=True)
        (out/'complex33').mkdir();(out/'complex33/positions.json').write_text(json.dumps(payload,separators=(',',':'),allow_nan=False)+'\n')
        top.coordinates=xyz*10;top.save(str(out/'protein-stereochemistry-candidate.rst7'),overwrite=False)
        entries=[dict(globalAtomIndex0=atom.idx,proteinAtomIndex0=atom.idx,authResidue=atom.residue.idx+33,residueName=atom.residue.name,atomName=atom.name,oldPositionNm=source_original[atom.idx].tolist(),newPositionNm=xyz[atom.idx].tolist()) for atom in top.atoms]
        patch=dict(schema='orvia.adppi-v0.3-full-protein-coordinate-patch.v1',candidateModel='ORVIA-ADP-PHOSPHATE-v0.3',prefixIdentityVerified=True,sourceInputsModified=False,sourceHashes=hashes,scientificAcceptance=False,productionReady=False,atoms=entries)
        (out/'protein-coordinate-patch.json').write_text(json.dumps(patch,separators=(',',':'),allow_nan=False)+'\n')
        for path,digest in hashes.items():
            if sha(path)!=digest:raise ValueError('Source changed during preparation')
        report.update(status='prepared_stereochemistry_candidate_not_accepted',fixedCoordinatesBitEqual=True,sourceHashesVerifiedAfter=True,maxMobileDisplacementNm=float(np.linalg.norm(xyz[mobile]-before[mobile],axis=1).max()),coordinateSha256=sha(out/'complex33/positions.json'),patchSha256=sha(out/'protein-coordinate-patch.json'))
    except Exception as error:report.update(status='failed',error=dict(type=type(error).__name__,message=str(error),traceback=traceback.format_exc()))
    report['elapsedSeconds']=time.monotonic()-start;save();print(json.dumps({key:report.get(key) for key in ['status','elapsedSeconds','mobileAtoms','maxMobileDisplacementNm','error']}),flush=True)
    return 0 if report['status']=='prepared_stereochemistry_candidate_not_accepted' else 2


if __name__=='__main__':raise SystemExit(main())
