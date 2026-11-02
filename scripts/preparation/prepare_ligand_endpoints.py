#!/usr/bin/env python3
"""Build explicit neutral endpoint inputs, then optionally run native AmberTools.

No production trajectory, equilibration or binding result is calculated here.
Quantum charge assignment is declared external force-field preparation.
"""
from __future__ import annotations

import argparse
from collections import Counter
from decimal import Decimal, localcontext
import hashlib
import itertools
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from rdkit import Chem, rdBase
from rdkit.Chem import rdMolDescriptors

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/prepared_candidate/ligand_endpoints_v0_1'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def load_heavy(path):
    molecule = next(iter(Chem.SDMolSupplier(str(path), removeHs=False)))
    if molecule is None or any(a.GetAtomicNum() == 1 for a in molecule.GetAtoms()):
        raise ValueError('Expected an intact heavy-atom SDF')
    return molecule


def identity(molecule):
    return dict(inchikey=Chem.MolToInchiKey(Chem.RemoveHs(molecule)),
                formula=rdMolDescriptors.CalcMolFormula(molecule),
                formal_charge=Chem.GetFormalCharge(molecule), atoms=molecule.GetNumAtoms(),
                hydrogen_atoms=sum(a.GetAtomicNum() == 1 for a in molecule.GetAtoms()),
                stereocenters=[list(value) for value in Chem.FindMolChiralCenters(molecule, includeUnassigned=True)])


def candidates(output=OUT):
    old = ROOT / 'data/prepared_candidate'
    mapping = json.loads((old/'ligand_atom_map.json').read_text())
    a = Chem.AddHs(load_heavy(old/'compound17_heavy_pose_candidate.sdf'), addCoords=True)
    b = Chem.AddHs(load_heavy(old/'aficamten_heavy_source_pose.sdf'), addCoords=True)
    common = [(row['a_source_index'], row['b_source_index']) for row in mapping['common_heavy_atoms']]
    ac, bc = a.GetConformer(), b.GetConformer()
    # Explicit hydrogens are paired only when attached to a mapped heavy atom.
    # Small local permutations minimize coordinate displacement with an index tie break.
    for ai, bi in list(common):
        ah = sorted(x.GetIdx() for x in a.GetAtomWithIdx(ai).GetNeighbors() if x.GetAtomicNum() == 1)
        bh = sorted(x.GetIdx() for x in b.GetAtomWithIdx(bi).GetNeighbors() if x.GetAtomicNum() == 1)
        n = min(len(ah), len(bh))
        if not n:
            continue
        choices = []
        for aset in itertools.combinations(ah, n):
            for bset in itertools.permutations(bh, n):
                cost = sum((ac.GetAtomPosition(x)-bc.GetAtomPosition(y)).LengthSq() for x,y in zip(aset,bset))
                choices.append((cost, aset, bset))
        _, aset, bset = min(choices)
        common.extend(zip(aset, bset))
    common.sort()
    a_only = sorted(set(range(a.GetNumAtoms())) - {x for x,_ in common})
    b_only = sorted(set(range(b.GetNumAtoms())) - {y for _,y in common})
    if (a.GetNumAtoms(), b.GetNumAtoms(), len(common), len(a_only), len(b_only)) != (41,44,40,1,4):
        raise ValueError('Unexpected explicit-hydrogen graph correspondence')
    # Common initial coordinates are identical. The disappearing methyl hydrogen
    # lies along the removed ethyl-carbon bond, with a declared 1.09 A C-H length.
    for ai, bi in common:
        ac.SetAtomPosition(ai, bc.GetAtomPosition(bi))
    ai = a_only[0]
    parent_a = a.GetAtomWithIdx(ai).GetNeighbors()[0].GetIdx()
    parent_b = dict(common)[parent_a]
    carbon_b = mapping['B_only_heavy_atom']['b_source_index']
    direction = bc.GetAtomPosition(carbon_b) - bc.GetAtomPosition(parent_b)
    direction.Normalize()
    ac.SetAtomPosition(ai, bc.GetAtomPosition(parent_b) + direction*1.09)
    expected = {'A': ('VTXZRNAUVAGCBA-OAHLLOKOSA-N', 'C17H17N5O2',17),
                'B': ('IOVAZWDIRCRMTM-OAHLLOKOSA-N', 'C18H19N5O2',19)}
    for name, molecule in [('A',a),('B',b)]:
        value = identity(molecule)
        key, formula, hydrogens = expected[name]
        if (value['inchikey'],value['formula'],value['hydrogen_atoms'],value['formal_charge']) != (key,formula,hydrogens,0):
            raise ValueError('Endpoint identity or microstate changed')
        if [state for _,state in value['stereocenters']] != ['R']:
            raise ValueError('Endpoint stereochemistry changed')
        molecule.SetProp('_Name', f'ORVIA neutral endpoint {name}')
        molecule.SetProp('ORVIA_STATUS','EXTERNAL_MODEL_INPUT_UNRELAXED_COORDINATES_NOT_A_TRAJECTORY')
        molecule.SetProp('MICROSTATE','Published neutral chemical graph; not a pH population assertion')
        with Chem.SDWriter(str(output/f'{name}_explicit_hydrogens.sdf')) as writer:
            writer.write(molecule)
    b_to_hybrid = {bi:ai for ai,bi in common}
    b_to_hybrid.update({bi:a.GetNumAtoms()+j for j,bi in enumerate(b_only)})
    atoms=[]
    for ai,atom in enumerate(a.GetAtoms()):
        b_index = next((bi for aj,bi in common if aj==ai),None)
        atoms.append(dict(hybrid_index=ai,a_index=ai,b_index=b_index,element=atom.GetSymbol()))
    for bi in b_only:
        atoms.append(dict(hybrid_index=b_to_hybrid[bi],a_index=None,b_index=bi,element=b.GetAtomWithIdx(bi).GetSymbol()))
    result = dict(schema='orvia.explicit-endpoint-map.v1',status='EXTERNAL_ENDPOINT_INPUTS_HYBRID_HAMILTONIAN_NOT_DEFINED',
                  rdkit_version=rdBase.rdkitVersion,endpoint_identity={'A':identity(a),'B':identity(b)},
                  source_sha256={str(p.relative_to(ROOT)):digest(p) for p in [old/'ligand_atom_map.json',old/'compound17_heavy_pose_candidate.sdf',old/'aficamten_heavy_source_pose.sdf']},
                  common_atom_pairs=[dict(a_index=ai,b_index=bi) for ai,bi in common],a_only_indices=a_only,b_only_indices=b_only,
                  hybrid_atoms=atoms,hybrid_atom_count=len(atoms),endpoint_a_to_hybrid=list(range(41)),
                  endpoint_b_to_hybrid=[b_to_hybrid[i] for i in range(44)],
                  coordinate_preparation='RDKit AddHs(addCoords=True); no force-based minimization. Common coordinates copied from B; disappearing methyl H placed 1.09 A along removed terminal-carbon bond.',
                  dummy_mass_bonded_restraint_policy=None,production_simulation_performed=False,
                  warning='A union atom map does not define a valid alchemical Hamiltonian; free-ghost partition factors must be resolved explicitly.')
    write_json(output/'explicit_hydrogen_map.json',result)
    return result


def native_parameters(output, prefix):
    env = dict(os.environ, AMBERHOME=str(prefix), PATH=str(prefix/'bin')+os.pathsep+os.environ.get('PATH',''), OMP_NUM_THREADS='1')
    def run(args, directory, name):
        executable=prefix/'bin'/args[0]
        if not executable.is_file(): raise ValueError(f'Missing native tool: {args[0]}')
        command=[str(executable),*args[1:]]
        completed=subprocess.run(command,cwd=directory,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=600)
        (directory/name).write_text(completed.stdout)
        if completed.returncode: raise ValueError(f'{args[0]} failed; inspect {name}')
    for endpoint in ['A','B']:
        directory=output/endpoint;directory.mkdir(exist_ok=True)
        shutil.copyfile(output/f'{endpoint}_explicit_hydrogens.sdf',directory/'input.sdf')
        run(['antechamber','-i','input.sdf','-fi','sdf','-o','ligand_am1bcc_raw.mol2','-fo','mol2','-c','bcc','-nc','0','-at','gaff2','-rn',f'LG{endpoint}','-s','2'],directory,'antechamber.log')
        normalize_mol2_charges(directory)
        run(['parmchk2','-i','ligand.mol2','-f','mol2','-o','ligand.frcmod','-s','gaff2'],directory,'parmchk2.log')
        leap='source leaprc.gaff2\nloadamberparams ligand.frcmod\nlig = loadmol2 ligand.mol2\ncheck lig\nsaveamberparm lig ligand.prmtop ligand.inpcrd\nsavepdb lig ligand.pdb\nquit\n'
        (directory/'prepare.leap').write_text(leap)
        run(['tleap','-f','prepare.leap'],directory,'tleap.log')
        if not (directory/'ligand.prmtop').is_file(): raise ValueError('Native topology was not written')
        # Keep final inputs/results, quantum input/output and readable logs; remove bulky scratch files.
        keep={'input.sdf','ligand.mol2','ligand_am1bcc_raw.mol2','charge_normalization.json','ligand.frcmod','ligand.prmtop','ligand.inpcrd','ligand.pdb','prepare.leap',
              'antechamber.log','parmchk2.log','tleap.log','sqm.in','sqm.out'}
        for file in directory.iterdir():
            if file.is_file() and file.name not in keep: file.unlink()
    parameter_source=output/'forcefield_source';parameter_source.mkdir(exist_ok=True)
    for relative in ['dat/leap/parm/gaff2.dat','dat/leap/cmd/leaprc.gaff2','LICENSE']:
        shutil.copyfile(prefix/relative,parameter_source/Path(relative).name)
    packages=[]
    for file in sorted((prefix/'conda-meta').glob('*.json')):
        value=json.loads(file.read_text());packages.append({k:value.get(k) for k in ['name','version','build','url','sha256','license']})
    write_json(output/'toolchain.json',dict(schema='orvia.preparation-toolchain.v1',platform='osx-arm64',packages=packages,
                binaries={name:digest(prefix/'bin'/name) for name in ['antechamber','sqm','parmchk2','tleap']},
                forcefield_source={file.name:digest(file) for file in parameter_source.iterdir()},
                forcefield_license='AmberTools LICENSE explicitly places dat/leap force-field parameter files in the public domain; binary/source tooling has separate licenses retained in LICENSE.'))


def normalize_mol2_charges(directory):
    """Explicitly close native finite-text net charge; retain unmodified raw output."""
    source=directory/'ligand_am1bcc_raw.mol2';lines=source.read_text().splitlines()
    start=lines.index('@<TRIPOS>ATOM')+1
    end=next(i for i in range(start,len(lines)) if lines[i].startswith('@<TRIPOS>'))
    rows=[line.split() for line in lines[start:end]]
    raw=[Decimal(row[8]) for row in rows];total=sum(raw,Decimal(0))
    if abs(total)>Decimal('0.01'): raise ValueError('Unexpectedly large native net-charge residual; refuse normalization')
    with localcontext() as context:
        context.prec=40
        correction=-total/Decimal(len(raw))
        normalized=[(q+correction).quantize(Decimal('0.000000000001')) for q in raw]
        normalized[-1]-=sum(normalized,Decimal(0))
    for i,(row,q) in enumerate(zip(rows,normalized)):
        row[8]=format(q,'.12f');lines[start+i]=' '.join(row)
    (directory/'ligand.mol2').write_text('\n'.join(lines)+'\n')
    write_json(directory/'charge_normalization.json',dict(schema='orvia.explicit-charge-normalization.v1',
        input_sha256=digest(source),raw_charge_sum_e=str(total),target_charge_e=0,
        policy='Uniform correction to native finite-text AM1-BCC charges; round to 12 decimals then close exact residual on final atom. No empirical refit.',
        uniform_correction_e=str(correction),maximum_atom_adjustment_e=str(max(abs(q-r) for q,r in zip(normalized,raw))),
        raw_charges_e=list(map(str,raw)),normalized_charges_e=list(map(str,normalized)),
        normalized_charge_sum_e=str(sum(normalized,Decimal(0))),
        warning='This explicitly modifies the raw charge vector and is part of the declared candidate model, not a claim that native output already summed to zero.'))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=OUT)
    parser.add_argument('--amber-prefix',type=Path)
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    result=candidates(args.output)
    if args.amber_prefix: native_parameters(args.output,args.amber_prefix.resolve())
    print(json.dumps(dict(passed=True,endpoint_atoms=[41,44],common_atoms=40,hybrid_atoms=45,
                         native_parameters_generated=bool(args.amber_prefix),production_ready=False)))


if __name__=='__main__': main()
