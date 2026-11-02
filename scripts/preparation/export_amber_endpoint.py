#!/usr/bin/env python3
"""Strict Amber/OpenMM endpoint export and independent scalar-energy checks.

Reject unsupported force forms instead of silently dropping them. This checks
external prepared model inputs, not an on-chain trajectory or binding result.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import numpy as np
import openmm as mm
from openmm import app, unit

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'data/prepared_candidate/ligand_endpoints_v0_1'
COULOMB=1/(4*math.pi*(1e-6*8.8541878128e-12/(1.602176634e-19**2*6.02214076e23)))


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def scalar(value, units): return float(value.value_in_unit(units))
def finite(x):
    if not math.isfinite(x): raise ValueError('Nonfinite force-field parameter')
    return x


def export_system(system):
    if system.getNumConstraints(): raise ValueError('Export unconstrained parameters; constraints need an explicit separate declaration')
    if any(system.isVirtualSite(i) for i in range(system.getNumParticles())):
        raise ValueError('Unsupported virtual site')
    result=dict(schema='orvia.explicit-endpoint-parameters.v1',index_base=0,
        units=dict(length='nm',time='ps',mass='Da',energy='kJ/mol',angle='radian',charge='elementary_charge'),
        atom_count=system.getNumParticles(),masses_Da=[scalar(system.getParticleMass(i),unit.dalton) for i in range(system.getNumParticles())],
        harmonic_bonds=[],harmonic_angles=[],periodic_torsions=[],particles=[],exceptions=[],
        nonbonded=dict(reference_method='NoCutoff',mixing_rule='Lorentz-Berthelot',coulomb_prefactor=COULOMB,
            coulomb_prefactor_basis='OpenMM 8.6.1 SimTKOpenMMRealType.h CODATA constants; full binary64 value exported',
            production_electrostatics_method=None),
        equations=dict(bond='0.5*k*(r-r0)^2',angle='0.5*k*(theta-theta0)^2',torsion='k*(1+cos(n*phi-phase))',
            lj='4*epsilon*((sigma/r)^12-(sigma/r)^6)',coulomb='prefactor*q_product/r'),
        torsion_ordering='Exact OpenMM-imported Amber atom tuple retained, including native periodic impropers; no reordering or deduplication.',
        production_ready=False)
    seen=[]
    for force in system.getForces():
        name=type(force).__name__
        if name not in ['HarmonicBondForce','HarmonicAngleForce','PeriodicTorsionForce','NonbondedForce']:
            raise ValueError(f'Unsupported force form: {name}')
        if name in seen: raise ValueError(f'Duplicate force form requires explicit review: {name}')
        seen.append(name);force.setForceGroup(len(seen)-1)
        if name=='HarmonicBondForce':
            for i in range(force.getNumBonds()):
                a,b,r,k=force.getBondParameters(i)
                result['harmonic_bonds'].append([a,b,scalar(r,unit.nanometer),scalar(k,unit.kilojoule_per_mole/unit.nanometer**2)])
        elif name=='HarmonicAngleForce':
            for i in range(force.getNumAngles()):
                a,b,c,t,k=force.getAngleParameters(i)
                result['harmonic_angles'].append([a,b,c,scalar(t,unit.radian),scalar(k,unit.kilojoule_per_mole/unit.radian**2)])
        elif name=='PeriodicTorsionForce':
            for i in range(force.getNumTorsions()):
                a,b,c,d,n,phase,k=force.getTorsionParameters(i)
                result['periodic_torsions'].append([a,b,c,d,n,scalar(phase,unit.radian),scalar(k,unit.kilojoule_per_mole)])
        else:
            if force.getNonbondedMethod()!=mm.NonbondedForce.NoCutoff or force.getNumParticleParameterOffsets() or force.getNumExceptionParameterOffsets():
                raise ValueError('Unsupported nonbonded method/parameter offsets')
            for i in range(force.getNumParticles()):
                q,s,e=force.getParticleParameters(i)
                result['particles'].append([scalar(q,unit.elementary_charge),scalar(s,unit.nanometer),scalar(e,unit.kilojoule_per_mole)])
            for i in range(force.getNumExceptions()):
                a,b,q,s,e=force.getExceptionParameters(i)
                result['exceptions'].append([min(a,b),max(a,b),scalar(q,unit.elementary_charge**2),scalar(s,unit.nanometer),scalar(e,unit.kilojoule_per_mole)])
            result['exceptions'].sort(key=lambda x:x[:2])
    if len(result['particles'])!=system.getNumParticles(): raise ValueError('Missing nonbonded particle parameters')
    if any(m<=0 for m in result['masses_Da']): raise ValueError('Nonpositive mass')
    def check(item):
        if isinstance(item,float): finite(item)
        elif isinstance(item,list):
            for value in item: check(value)
        elif isinstance(item,dict):
            for value in item.values(): check(value)
    check(result)
    result['force_groups']=seen
    return result


def torsion_angle(x):
    b0=x[0]-x[1];b1=x[2]-x[1];b2=x[3]-x[2]
    b1=b1/np.linalg.norm(b1)
    v=b0-np.dot(b0,b1)*b1;w=b2-np.dot(b2,b1)*b1
    return math.atan2(np.dot(np.cross(b1,v),w),np.dot(v,w))


def independent_energies(parameters,positions):
    p=np.asarray(positions,dtype=float)
    sums=dict(HarmonicBondForce=0.,HarmonicAngleForce=0.,PeriodicTorsionForce=0.,NonbondedForce=0.)
    for a,b,r,k in parameters['harmonic_bonds']:
        sums['HarmonicBondForce']+=0.5*k*(np.linalg.norm(p[a]-p[b])-r)**2
    for a,b,c,theta,k in parameters['harmonic_angles']:
        u=p[a]-p[b];v=p[c]-p[b];cosine=np.dot(u,v)/(np.linalg.norm(u)*np.linalg.norm(v))
        t=math.acos(float(np.clip(cosine,-1,1)))
        sums['HarmonicAngleForce']+=0.5*k*(t-theta)**2
    for a,b,c,d,n,phase,k in parameters['periodic_torsions']:
        sums['PeriodicTorsionForce']+=k*(1+math.cos(n*torsion_angle(p[[a,b,c,d]])-phase))
    exceptions={(a,b):(q,s,e) for a,b,q,s,e in parameters['exceptions']}
    particles=parameters['particles']
    for a in range(len(p)):
        qa,sa,ea=particles[a]
        for b in range(a+1,len(p)):
            if (a,b) in exceptions: q,s,e=exceptions[a,b]
            else:
                qb,sb,eb=particles[b];q,s,e=qa*qb,(sa+sb)/2,math.sqrt(ea*eb)
            if q==0 and e==0: continue
            r=np.linalg.norm(p[a]-p[b]);s6=(s/r)**6
            sums['NonbondedForce']+=4*e*(s6*s6-s6)+parameters['nonbonded']['coulomb_prefactor']*q/r
    return sums


def independent_forces(parameters,positions,h=2e-5):
    p=np.asarray(positions,dtype=float).copy();result=np.zeros_like(p)
    for atom in range(len(p)):
        for axis in range(3):
            old=p[atom,axis];values=[]
            for offset in [-2,-1,1,2]:
                p[atom,axis]=old+offset*h;values.append(sum(independent_energies(parameters,p).values()))
            p[atom,axis]=old
            result[atom,axis]=-(values[0]-8*values[1]+8*values[2]-values[3])/(12*h)
    return result


def validate(system,parameters,positions):
    integrator=mm.VerletIntegrator(0.001)
    context=mm.Context(system,integrator,mm.Platform.getPlatformByName('Reference'))
    rng=np.random.default_rng(20261102);reports=[]
    try:
        for sample in range(3):
            xyz=np.asarray(positions)+rng.normal(0,0.0003,size=np.shape(positions))*sample
            context.setPositions(xyz*unit.nanometer)
            state=context.getState(getEnergy=True,getForces=True)
            energies=independent_energies(parameters,xyz);native={}
            for group,name in enumerate(parameters['force_groups']):
                native[name]=scalar(context.getState(getEnergy=True,groups=1<<group).getPotentialEnergy(),unit.kilojoule_per_mole)
                if abs(native[name]-energies[name])>1e-5+1e-9*abs(native[name]):
                    raise ValueError(f'Independent {name} energy differs: {native[name]} vs {energies[name]}')
            expected=np.asarray(state.getForces(asNumpy=True).value_in_unit(unit.kilojoule_per_mole/unit.nanometer))
            actual=independent_forces(parameters,xyz)
            difference=np.abs(actual-expected)
            if np.any(difference>1e-3+2e-6*np.abs(expected)):
                raise ValueError(f'Independent differentiated forces differ: maximum {difference.max()}')
            reports.append(dict(sample=sample,positions_nm=xyz.tolist(),energy_components_kJ_per_mol=native,
                native_total_energy_kJ_per_mol=scalar(state.getPotentialEnergy(),unit.kilojoule_per_mole),
                native_forces_kJ_per_mol_nm=expected.tolist(),max_absolute_force_difference=float(difference.max())))
    finally:
        del context,integrator
    return dict(passed=True,scope='Three small endpoint snapshots only; independent scalar potentials and five-point differentiation versus OpenMM Reference',
        energy_tolerance='1e-5 kJ/mol + 1e-9 relative per force group',force_tolerance='1e-3 kJ/mol/nm + 2e-6 relative per component',
        differentiation_step_nm=2e-5,snapshots=reports,production_simulation_performed=False)


def endpoint(directory):
    topology=app.AmberPrmtopFile(str(directory/'ligand.prmtop'))
    coordinates=app.AmberInpcrdFile(str(directory/'ligand.inpcrd'))
    system=topology.createSystem(nonbondedMethod=app.NoCutoff,constraints=None,rigidWater=False,removeCMMotion=False)
    parameters=export_system(system)
    positions=np.asarray(coordinates.positions.value_in_unit(unit.nanometer))
    parameters['positions_nm']=positions.tolist()
    parameters['atom_identity']=[dict(index=a.index,name=a.name,element=a.element.symbol,residue=a.residue.name) for a in topology.topology.atoms()]
    from rdkit import Chem
    source=next(iter(Chem.SDMolSupplier(str(directory/'input.sdf'),removeHs=False)))
    if source is None: raise ValueError('Missing explicit-hydrogen identity input')
    if [atom.element.atomic_number for atom in topology.topology.atoms()] != [atom.GetAtomicNum() for atom in source.GetAtoms()]:
        raise ValueError('Native atom order/elements differ from mapped SDF')
    native_bonds={tuple(sorted((a.index,b.index))) for a,b in topology.topology.bonds()}
    source_bonds={tuple(sorted((bond.GetBeginAtomIdx(),bond.GetEndAtomIdx()))) for bond in source.GetBonds()}
    if native_bonds!=source_bonds: raise ValueError('Native bonded connectivity differs from mapped SDF')
    source_positions=np.asarray(source.GetConformer().GetPositions())*0.1
    # Native Antechamber's SDF reader quantizes coordinates to 0.001 A before
    # writing MOL2; this can change newly added H coordinates by up to 0.0005 A.
    if np.max(np.abs(source_positions-positions))>5.01e-5: raise ValueError('Native initial coordinate order changed beyond declared format quantization')
    parameters['native_identity_check']=dict(passed=True,source_inchikey=Chem.MolToInchiKey(Chem.RemoveHs(source)),
        ordered_elements_match=True,bonded_connectivity_match=True,maximum_coordinate_difference_nm=float(np.max(np.abs(source_positions-positions))),
        native_sdf_reader_coordinate_quantization_angstrom='0.001',maximum_allowed_coordinate_difference_nm=5.01e-5)
    parameters['input_sha256']={name:sha(directory/name) for name in ['input.sdf','ligand.mol2','ligand.frcmod','ligand.prmtop','ligand.inpcrd']}
    parameters['net_charge_e']=sum(p[0] for p in parameters['particles'])
    if abs(parameters['net_charge_e'])>1e-6: raise ValueError('Neutral endpoint partial charges do not sum to zero')
    parameters['openmm_version']=mm.__version__
    import parmed
    native=parmed.load_file(str(directory/'ligand.prmtop'))
    parameters['native_periodic_improper_count']=sum(d.improper for d in native.dihedrals)
    if len(native.atoms)!=parameters['atom_count']: raise ValueError('Native topology atom count mismatch')
    validation=validate(system,parameters,positions)
    for filename,value in [('parameters.json',parameters),('reference_validation.json',validation)]:
        (directory/filename).write_text(json.dumps(value,indent=2,sort_keys=True)+'\n')
    (directory/'system.xml').write_text(mm.XmlSerializer.serialize(system))
    return dict(atoms=parameters['atom_count'],bonds=len(parameters['harmonic_bonds']),angles=len(parameters['harmonic_angles']),
                periodic_torsions=len(parameters['periodic_torsions']),native_periodic_impropers=parameters['native_periodic_improper_count'],
                exceptions=len(parameters['exceptions']),net_charge_e=parameters['net_charge_e'],validation_passed=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',type=Path,default=OUT)
    args=parser.parse_args();results={name:endpoint(args.root/name) for name in ['A','B']}
    (args.root/'endpoint_validation_summary.json').write_text(json.dumps(dict(schema='orvia.endpoint-validation.v1',
        status='PARAMETERIZED_NEUTRAL_LIGAND_ENDPOINTS_ONLY',force_field='GAFF2 with native AmberTools AM1-BCC charges',
        endpoints=results,prepared_cardiac_system_available=False,hybrid_hamiltonian_complete=False,production_ready=False),indent=2,sort_keys=True)+'\n')
    print(json.dumps(results))


if __name__=='__main__':main()
