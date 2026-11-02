#!/usr/bin/env python3
"""Read-only stereochemistry, bonded geometry and Mg-shell audit of native B legs.

No coordinate, topology or parameter file is changed. Geometric agreement is not
force-field acceptance, equilibration, or an affinity prediction.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
import traceback
import numpy as np
from rdkit import Chem
from rdkit.Chem import AllChem

PROTEIN = set('ALA ARG ASN ASP ASH CYS CYM CYX GLN GLU GLH GLY HIS HID HIE HIP ILE LEU LYS LYN M3L MET PHE PRO SER THR TRP TYR VAL'.split())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def normalized_volume(center, a, b, c):
    vectors=np.asarray([a-center,b-center,c-center],dtype=float)
    lengths=np.linalg.norm(vectors,axis=1)
    if not np.isfinite(vectors).all() or np.any(lengths==0):return 0.0
    return float(np.linalg.det(vectors/lengths[:,None]))


def l_alpha_sign():
    # Generate an explicit S alanine reference, then use N/carbonyl-C/CB order.
    # This geometric order is identical for L cysteine although its CIP label is R.
    molecule=Chem.MolFromSmiles('N[C@@H](C)C(=O)O')
    Chem.AssignStereochemistry(molecule,cleanIt=True,force=True)
    center=next(atom for atom in molecule.GetAtoms() if atom.HasProp('_CIPCode'))
    if center.GetProp('_CIPCode')!='S':
        center.InvertChirality();Chem.AssignStereochemistry(molecule,cleanIt=True,force=True)
    if center.GetProp('_CIPCode')!='S':raise ValueError('Could not build S alanine reference')
    molecule=Chem.AddHs(molecule)
    if AllChem.EmbedMolecule(molecule,randomSeed=20261102)!=0:raise ValueError('Alanine reference embedding failed')
    center=molecule.GetAtomWithIdx(center.GetIdx());neighbors=list(center.GetNeighbors())
    nitrogen=next(atom.GetIdx() for atom in neighbors if atom.GetAtomicNum()==7)
    carbonyl=next(atom.GetIdx() for atom in neighbors if atom.GetAtomicNum()==6 and any(n.GetAtomicNum()==8 for n in atom.GetNeighbors()))
    beta=next(atom.GetIdx() for atom in neighbors if atom.GetAtomicNum()==6 and atom.GetIdx()!=carbonyl)
    xyz=np.asarray(molecule.GetConformer().GetPositions())
    return int(np.sign(normalized_volume(xyz[center.GetIdx()],xyz[nitrogen],xyz[carbonyl],xyz[beta])))


def l_beta_signs():
    signs={}
    for residue,smiles,beta_cip,indices in [('THR','N[C@@H]([C@@H](O)C)C(=O)O','R',[2,1,3,4]),('ILE','N[C@@H]([C@@H](CC)C)C(=O)O','S',[2,1,3,5])]:
        molecule=Chem.MolFromSmiles(smiles)
        Chem.AssignStereochemistry(molecule,cleanIt=True,force=True)
        for index,label in [(1,'S'),(2,beta_cip)]:
            if molecule.GetAtomWithIdx(index).GetProp('_CIPCode')!=label:
                molecule.GetAtomWithIdx(index).InvertChirality()
                Chem.AssignStereochemistry(molecule,cleanIt=True,force=True)
        if any(molecule.GetAtomWithIdx(index).GetProp('_CIPCode')!=label for index,label in [(1,'S'),(2,beta_cip)]):raise ValueError('Explicit amino-acid stereochemistry template failed')
        molecule=Chem.AddHs(molecule)
        if AllChem.EmbedMolecule(molecule,randomSeed=20261102)!=0:raise ValueError('Beta reference embedding failed')
        xyz=np.asarray(molecule.GetConformer().GetPositions())
        signs[residue]=int(np.sign(normalized_volume(*(xyz[index] for index in indices))))
    return signs


def read_positions(path, count):
    data=json.loads(Path(path).read_text());xyz=np.asarray(data['positions_nm'],dtype=float)
    box=np.asarray(data['box_vectors_nm'],dtype=float)
    if xyz.shape!=(count,3) or not np.isfinite(xyz).all() or box.shape!=(3,3) or not np.isfinite(box).all():raise ValueError('Invalid coordinate or box shape/finiteness')
    if not np.array_equal(box,np.diag(np.diag(box))) or np.any(np.diag(box)<=0):raise ValueError('This audit requires the explicit positive orthorhombic box')
    return xyz,box


def cip_labels(template, coordinates):
    molecule=Chem.Mol(template);molecule.RemoveAllConformers();conformer=Chem.Conformer(molecule.GetNumAtoms())
    for index,point in enumerate(coordinates):conformer.SetAtomPosition(index,point)
    molecule.AddConformer(conformer)
    for atom in molecule.GetAtoms():
        atom.SetChiralTag(Chem.ChiralType.CHI_UNSPECIFIED)
        if atom.HasProp('_CIPCode'):atom.ClearProp('_CIPCode')
    Chem.AssignAtomChiralTagsFromStructure(molecule,replaceExistingTags=True)
    Chem.AssignStereochemistry(molecule,cleanIt=True,force=True)
    return {str(atom.GetIdx()):atom.GetProp('_CIPCode') for atom in molecule.GetAtoms() if atom.HasProp('_CIPCode')}


def atom_record(atom):
    return dict(index0=atom.idx,name=atom.name,element_number=atom.atomic_number,residue=atom.residue.name,residue_index1=atom.residue.idx+1)


def audit_leg(top, before, after, box, ligand_template, ligand_identity):
    reference_sign=l_alpha_sign();beta_signs=l_beta_signs();protein=[];beta=[];tetra=[];corrected=set()
    for residue in top.residues:
        names={atom.name:atom for atom in residue.atoms}
        if residue.name in PROTEIN and all(name in names for name in ['CA','N','C','CB']):
            indices=[names[name].idx for name in ['CA','N','C','CB']]
            pre=normalized_volume(*(before[index] for index in indices));post=normalized_volume(*(after[index] for index in indices))
            protein.append(dict(residue=residue.name,residue_index1=residue.idx+1,ca_index0=indices[0],before_normalized_volume=pre,after_normalized_volume=post,before_L=int(np.sign(pre))==reference_sign,after_L=int(np.sign(post))==reference_sign,after_degenerate=abs(post)<0.10))
            if int(np.sign(pre))!=reference_sign and int(np.sign(post))==reference_sign and abs(post)>=.10:corrected.add(indices[0])
        if residue.name in beta_signs:
            labels=['CB','CA','OG1','CG2'] if residue.name=='THR' else ['CB','CA','CG1','CG2']
            if not all(name in names for name in labels):raise ValueError('Incomplete beta stereocenter')
            indices=[names[name].idx for name in labels]
            pre=normalized_volume(*(before[index] for index in indices));post=normalized_volume(*(after[index] for index in indices));expected=beta_signs[residue.name]
            beta.append(dict(residue=residue.name,residue_index1=residue.idx+1,cb_index0=indices[0],before_normalized_volume=pre,after_normalized_volume=post,before_correct=int(np.sign(pre))==expected,after_correct=int(np.sign(post))==expected,after_degenerate=abs(post)<.10))
            if int(np.sign(pre))!=expected and int(np.sign(post))==expected and abs(post)>=.10:corrected.add(indices[0])
    for atom in top.atoms:
        neighbors=sorted(atom.bond_partners,key=lambda neighbor:neighbor.idx)
        if atom.atomic_number!=6 or len(neighbors)!=4:continue
        # A CH2/CH3 center has indistinguishable hydrogen substituents, so a
        # reflected labeled hydrogen arrangement is not a stereochemical change.
        if sum(neighbor.atomic_number==1 for neighbor in neighbors)>=2:continue
        indices=[neighbor.idx for neighbor in neighbors]
        pre=normalized_volume(before[indices[3]],*(before[index] for index in indices[:3]));post=normalized_volume(after[indices[3]],*(after[index] for index in indices[:3]))
        if pre*post<=0 or abs(post)<0.10:
            tetra.append(dict(atom=atom_record(atom),neighbors=indices,before_normalized_volume=pre,after_normalized_volume=post,orientation_inverted=pre*post<0,degenerate=abs(post)<0.10,verified_correction_to_known_L_amino_acid=atom.idx in corrected))
    ligand_residues=[residue for residue in top.residues if residue.name=='LGB']
    if len(ligand_residues)!=1:raise ValueError('Expected exactly one native B ligand')
    by_name={atom.name:atom for atom in ligand_residues[0].atoms}
    if len(by_name)!=len(ligand_identity) or ligand_template.GetNumAtoms()!=len(ligand_identity):raise ValueError('Ligand atom identity size mismatch')
    indices=[]
    for entry in ligand_identity:
        atom=by_name[entry['name']]
        if atom.atomic_number!=Chem.GetPeriodicTable().GetAtomicNumber(entry['element']):raise ValueError('Ligand element/name mismatch')
        indices.append(atom.idx)
    Chem.AssignStereochemistry(ligand_template,cleanIt=True,force=True)
    expected={str(atom.GetIdx()):atom.GetProp('_CIPCode') for atom in ligand_template.GetAtoms() if atom.HasProp('_CIPCode')}
    pre_cip=cip_labels(ligand_template,before[indices]*10);post_cip=cip_labels(ligand_template,after[indices]*10)
    ligand=dict(expected_from_SDF=expected,before=pre_cip,after=post_cip,expected_preserved=all(post_cip.get(index)==label for index,label in expected.items()),before_to_after_preserved=pre_cip==post_cip,source_atom_mapping_by_exact_name=True)
    bonds=[];angles=[]
    for bond in top.bonds:
        if bond.type is None:continue
        i,j=bond.atom1.idx,bond.atom2.idx;equilibrium=bond.type.req*.1
        pre=float(np.linalg.norm(before[i]-before[j]));post=float(np.linalg.norm(after[i]-after[j]))
        if abs(pre-equilibrium)>0.03 or abs(post-equilibrium)>0.03:
            bonds.append(dict(atoms=[i,j],before_nm=pre,after_nm=post,equilibrium_nm=equilibrium,after_outlier=abs(post-equilibrium)>.03,new_outlier=abs(pre-equilibrium)<=0.03<abs(post-equilibrium)))
    def angle(xyz,i,j,k):
        left=xyz[i]-xyz[j];right=xyz[k]-xyz[j];denom=np.linalg.norm(left)*np.linalg.norm(right)
        if denom==0:return None
        return float(np.degrees(np.arccos(np.clip(np.dot(left,right)/denom,-1,1))))
    for term in top.angles:
        if term.type is None:continue
        ids=[term.atom1.idx,term.atom2.idx,term.atom3.idx];pre=angle(before,*ids);post=angle(after,*ids);eq=term.type.theteq
        if pre is None or post is None or abs(pre-eq)>30 or abs(post-eq)>30:
            angles.append(dict(atoms=ids,before_degrees=pre,after_degrees=post,equilibrium_degrees=eq,after_outlier=post is None or abs(post-eq)>30,new_outlier=post is None or (pre is not None and abs(pre-eq)<=30<abs(post-eq))))
    magnesium=[];lengths=np.diag(box);heavy=np.asarray([atom.idx for atom in top.atoms if atom.atomic_number>1])
    for metal in [atom for atom in top.atoms if atom.atomic_number==12]:
        item=dict(magnesium=atom_record(metal),shell_cutoff_nm=0.35,stages={})
        for label,xyz in [('before',before),('after',after)]:
            diff=xyz[heavy]-xyz[metal.idx];diff-=lengths*np.rint(diff/lengths);dist=np.linalg.norm(diff,axis=1);order=np.argsort(dist)
            near=[position for position in order if heavy[position]!=metal.idx][:12]
            item['stages'][label]=dict(nearest_heavy=[{**atom_record(top.atoms[int(heavy[p])]),'distance_nm':float(dist[p]),'within_0_35_nm':bool(dist[p]<=.35)} for p in near],oxygen_nitrogen_sulfur_count_within_0_35_nm=sum(1 for p in range(len(heavy)) if 0<dist[p]<=.35 and top.atoms[int(heavy[p])].atomic_number in [7,8,16]))
        magnesium.append(item)
    unexpected=[row for row in protein if not row['after_L'] or row['after_degenerate']]
    beta_issues=[row for row in beta if not row['after_correct'] or row['after_degenerate']]
    return dict(protein_alpha_centers=len(protein),L_alpha_reference_sign=reference_sign,protein_before_nonL_count=sum(not row['before_L'] for row in protein),protein_after_nonL_count=sum(not row['after_L'] for row in protein),protein_after_degenerate_count=sum(row['after_degenerate'] for row in protein),protein_issues=unexpected,protein_new_inversions=[row for row in protein if row['before_normalized_volume']*row['after_normalized_volume']<0],protein_beta_centers=len(beta),protein_beta_issues=beta_issues,known_L_corrections_atom_indices0=sorted(corrected),all_tetrahedral_carbon_orientation_issues=tetra,ligand_cip=ligand,bond_outlier_threshold_nm=.03,bond_outliers=bonds,angle_outlier_threshold_degrees=30,angle_outliers=angles,magnesium_coordination=magnesium,geometry_checks_passed=not unexpected and not beta_issues and all(row['verified_correction_to_known_L_amino_acid'] and not row['degenerate'] for row in tetra) and ligand['expected_preserved'] and ligand['before_to_after_preserved'] and not any(row['after_outlier'] for row in bonds+angles),scope='Stereochemistry and bonded geometry audit. Mg distance shells are diagnostic only; they do not validate coordination energetics, C4 parameters, density or equilibration.')


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--aura-root',type=Path,required=True);parser.add_argument('--candidate-root',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    if args.output.exists():raise FileExistsError(args.output)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.with_suffix('.source.py').write_bytes(Path(__file__).read_bytes())
    report=dict(schema='orvia.nativeB-structure-validation.v1',status='in_progress',passed=False,scientific_acceptance=False,production_ready=False,source_files_modified=False,source_sha256=sha(__file__),legs={})
    def save():args.output.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    save();start=time.monotonic()
    try:
        import parmed
        base=args.aura_root.resolve();ligand=base/'work/scientific-preparation/data/prepared_candidate/ligand_endpoints_v0_1/B'
        template=Chem.SDMolSupplier(str(ligand/'input.sdf'),removeHs=False)[0];identity=json.loads((ligand/'parameters.json').read_text())['atom_identity']
        for leg,directory,filename in [('complex33','cardiac_adppi_ff03_m3l_33_782_solvated_v0_1','complex_1264.prmtop.gz'),('solvent33','ligand_adppi_ff03_m3l_33_782_solvated_v0_1','solvent.prmtop.gz')]:
            topfile=base/'work/scientific-preparation/data/prepared_candidate'/directory/filename;beforefile=base/'output/runpod-benchmark/full-inputs'/leg/'positions.json';afterfile=args.candidate_root/leg/'positions.json'
            files=[topfile,beforefile,afterfile,ligand/'input.sdf',ligand/'parameters.json'];hashes={str(path):sha(path) for path in files}
            top=parmed.load_file(str(topfile));before,box=read_positions(beforefile,len(top.atoms));after,afterbox=read_positions(afterfile,len(top.atoms))
            if not np.array_equal(box,afterbox):raise ValueError('Candidate box changed')
            row=audit_leg(top,before,after,box,template,identity);row.update(atoms=len(top.atoms),input_hashes=hashes,box_exactly_preserved=True)
            if any(sha(path)!=digest for path,digest in hashes.items()):raise ValueError('An input changed during validation')
            report['legs'][leg]=row;save()
        report['passed']=all(row['geometry_checks_passed'] for row in report['legs'].values());report['status']='passed_geometry_only' if report['passed'] else 'geometry_issues_require_repair'
    except Exception as error:
        report.update(status='failed',error=dict(type=type(error).__name__,message=str(error),traceback=traceback.format_exc()))
    report['elapsed_seconds']=time.monotonic()-start;save();print(json.dumps({'status':report['status'],'passed':report['passed'],'output':str(args.output)}))
    return 0 if report['passed'] else 2


if __name__=='__main__':raise SystemExit(main())
