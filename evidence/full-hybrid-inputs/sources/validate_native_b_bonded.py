#!/usr/bin/env python3
"""Static native-B bonded equivalence plus explicit frozen A-only-H confinement.

Never constructs a Context for native nonbonded forces, and never steps an
integrator. All output, scratch files and retained attempts stay beside this file.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse, gzip, hashlib, json, math, os, tempfile, traceback

OUT = Path(__file__).resolve().parent
PACKAGE = OUT.parent
SCIENCE = Path('/Users/abhijith/Documents/ChatGPT/AURA/work/scientific-preparation')
BASE = SCIENCE / 'data/prepared_candidate'
POLICY_FILE = OUT / 'bonded-validation-policy.json'
LEGS = {
    'complex33': dict(directory=BASE/'cardiac_adppi_ff03_m3l_33_782_solvated_v0_1', topology='complex.prmtop.gz', coordinates='complex.inpcrd.gz', ligand_start=12042),
    'solvent33': dict(directory=BASE/'ligand_adppi_ff03_m3l_33_782_solvated_v0_1', topology='solvent.prmtop.gz', coordinates='solvent.inpcrd.gz', ligand_start=0),
}
GROUPS = ['harmonic_bonds','harmonic_angles','periodic_torsions']


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    def clean(item):
        if isinstance(item,float) and not math.isfinite(item):return str(item)
        if isinstance(item,dict):return {k:clean(v) for k,v in item.items()}
        if isinstance(item,list):return [clean(v) for v in item]
        return item
    Path(path).write_text(json.dumps(clean(value),indent=2,sort_keys=True,allow_nan=False)+'\n')


def source(path):
    return dict(path=str(path),bytes=path.stat().st_size,sha256=digest(path))


def need(condition, message):
    if not condition:
        raise ValueError(message)


def unpack(path):
    return gzip.decompress(path.read_bytes()) if path.suffix == '.gz' else path.read_bytes()


def native_bonded(mm, native):
    """Clone ONLY three bonded forces; no context ever owns native nonbonded."""
    result=mm.System()
    for i in range(native.getNumParticles()):
        result.addParticle(native.getParticleMass(i))
    found={}
    classes={'HarmonicBondForce':0,'HarmonicAngleForce':1,'PeriodicTorsionForce':2}
    for force in native.getForces():
        name=type(force).__name__
        if name not in classes:
            continue
        need(name not in found,f'Duplicate native force class: {name}')
        copied=mm.XmlSerializer.deserialize(mm.XmlSerializer.serialize(force))
        copied.setForceGroup(classes[name]);result.addForce(copied);found[name]=copied
    need(set(found)==set(classes),'Native topology lacks one of the three expected bonded force classes')
    need(result.getNumForces()==3 and result.getNumConstraints()==0,'Bonded-only native system was not isolated')
    return result,found


def assembled_bonded(mm, unit, parameters):
    result=mm.System()
    for mass in parameters['masses_Da']:
        result.addParticle(float(mass)*unit.dalton)
    forces=[mm.HarmonicBondForce(),mm.HarmonicAngleForce(),mm.PeriodicTorsionForce()]
    active={key:0 for key in GROUPS}
    for a,b,r0,k in parameters['harmonic_bonds']:
        if float(k)==0:
            continue
        forces[0].addBond(int(a),int(b),float(r0),float(k));active['harmonic_bonds']+=1
    for a,b,c,theta,k in parameters['harmonic_angles']:
        if float(k)==0:
            continue
        forces[1].addAngle(int(a),int(b),int(c),float(theta),float(k));active['harmonic_angles']+=1
    for a,b,c,d,n,phase,k in parameters['periodic_torsions']:
        if float(k)==0:
            continue
        forces[2].addTorsion(int(a),int(b),int(c),int(d),int(n),float(phase),float(k));active['periodic_torsions']+=1
    for group,force in enumerate(forces):
        force.setForceGroup(group);result.addForce(force)
    need(result.getNumForces()==3 and result.getNumConstraints()==0,'Assembled comparison must contain exactly three bonded force groups')
    return result,active


def snapshot(mm, unit, np, system, positions):
    """One static Reference evaluation per bonded group, with every force component."""
    need(system.getNumForces()==3,'Refuse nonbonded/all-pairs context')
    need(all(type(f).__name__ in ['HarmonicBondForce','HarmonicAngleForce','PeriodicTorsionForce'] for f in system.getForces()),'Refuse unsupported force in context')
    integrator=mm.VerletIntegrator(0.001*unit.picoseconds)
    context=mm.Context(system,integrator,mm.Platform.getPlatformByName('Reference'))
    try:
        context.setPositions(positions*unit.nanometer)
        values=[]
        for group in range(3):
            state=context.getState(getEnergy=True,getForces=True,groups=1<<group)
            energy=float(state.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole))
            forces=np.asarray(state.getForces(asNumpy=True).value_in_unit(unit.kilojoule_per_mole/unit.nanometer),dtype=float).copy()
            values.append((energy,forces))
        return values
    finally:
        del context,integrator


def validate_leg(name, package, attempt, policy):
    import numpy as np
    import openmm as mm
    from openmm import app,unit
    definition=LEGS[name];native_topology=definition['directory']/definition['topology'];native_coordinates=definition['directory']/definition['coordinates']
    parameter_path=package/'legs'/name/'B.parameters.json.gz'
    frozen_path=BASE/'ligand_endpoints_v0_1/hybrid_model.json'
    catalog_path=package/'legs'/name/'catalog-candidate.json';map_path=package/'legs'/name/'global-map.json.gz'
    catalog=json.loads(catalog_path.read_text());global_map=json.loads(unpack(map_path))
    need(catalog.get('sourceHashesVerifiedAfterAssembly') is True,'Assembly source hashes are not finalized')
    need(digest(parameter_path)==catalog['parameters']['B']['sha256'],'B parameters differ from finalized catalog')
    need(digest(map_path)==catalog['globalMap']['sha256'],'Global map differs from finalized catalog')
    parameters=json.loads(unpack(parameter_path));frozen=json.loads(frozen_path.read_text())
    report=dict(leg=name,status='in_progress',passed=False,platform='Reference',scope=policy['scope'],source_files={key:source(path) for key,path in [('native_base_topology',native_topology),('native_base_coordinates',native_coordinates),('assembled_B_parameters',parameter_path),('frozen_ligand_union',frozen_path),('assembly_catalog',catalog_path),('global_map',map_path)]},openmm_version=mm.__version__)
    target=attempt/name;target.mkdir()
    save(target/'report.json',report)
    try:
        for path in [native_topology,native_coordinates,frozen_path]:
            need(digest(path)==policy['frozen_source_sha256'][str(path)],f'Frozen source changed: {path}')
        with tempfile.TemporaryDirectory(prefix=name+'-',dir=attempt) as temp:
            temp=Path(temp);tp=temp/'native.prmtop';cp=temp/'native.inpcrd';tp.write_bytes(unpack(native_topology));cp.write_bytes(unpack(native_coordinates))
            native_file=app.AmberPrmtopFile(str(tp));native_coordinates_file=app.AmberInpcrdFile(str(cp))
            original=native_file.createSystem(nonbondedMethod=app.NoCutoff,constraints=None,rigidWater=False,removeCMMotion=False)
            need(original.getNumConstraints()==0,'Native base unexpectedly contains constraints')
            native_system,native_forces=native_bonded(mm,original)
            # The original System is never given to a Context.
            del original
            positions_native=np.asarray(native_coordinates_file.positions.value_in_unit(unit.nanometer),dtype=float)
        native_count=native_system.getNumParticles();assembled_count=int(parameters['atom_count']);L=definition['ligand_start'];insertion=L+44
        need(assembled_count==native_count+1,'Expected exactly one inserted A-only hydrogen')
        need(len(parameters['masses_Da'])==len(parameters['positions_nm'])==assembled_count,'Assembled atom-array lengths differ')
        positions_assembled=np.asarray(parameters['positions_nm'],dtype=float)
        need(positions_assembled.shape==(assembled_count,3) and np.all(np.isfinite(positions_assembled)),'Invalid assembled coordinates')
        native_to_global=np.arange(native_count,dtype=np.int64);native_to_global[insertion:]+=1
        need(global_map['nativeGlobalMap']==native_to_global.tolist() and global_map['insertion']==insertion,'Assembled global map differs from independently derived insertion map')
        difference=np.abs(positions_assembled[native_to_global]-positions_native)
        preservation_limit=policy['native_coordinate_preservation_absolute_tolerance_nm']
        report['native_coordinate_preservation']=dict(maximum_absolute_difference_nm=float(difference.max()),tolerance_nm=preservation_limit,passed=bool(np.all(difference<=preservation_limit)),components_checked=int(difference.size))
        need(report['native_coordinate_preservation']['passed'],'Native positions changed beyond unit-conversion roundoff allowance')
        native_masses=np.array([native_system.getParticleMass(i).value_in_unit(unit.dalton) for i in range(native_count)])
        need(np.array_equal(native_masses,np.asarray(parameters['masses_Da'])[native_to_global]),'Mapped native masses changed')
        inverse_b={int(h):i for i,h in enumerate(frozen['endpoint_maps']['B'])}
        need(set(range(45))-set(inverse_b)=={25},'Unexpected frozen hybrid atom map')
        need(parameters['masses_Da'][insertion]==frozen['endpoint_parameters']['B']['masses_Da'][25],'Inserted ghost mass differs from frozen union')
        def global_hybrid(h):
            return insertion if h==25 else L+inverse_b[h]
        correction_energy=0.;correction_force=np.zeros((assembled_count,3),dtype=float);correction_records=[]
        trees=frozen['model_policy']['trees']['A']
        need(len(trees)==1 and trees[0]['unique_atoms']==[25],'Unexpected extra inactive-A confinement network')
        for ha,hb,r0,k in trees[0]['bonds']:
            a,b=global_hybrid(ha),global_hybrid(hb);delta=positions_assembled[b]-positions_assembled[a];distance=float(np.linalg.norm(delta))
            need(distance>0 and np.isfinite(distance),'Singular inserted confinement bond')
            energy=.5*float(k)*(distance-float(r0))**2
            force=float(k)*(distance-float(r0))*delta/distance
            correction_energy+=energy;correction_force[a]+=force;correction_force[b]-=force
            correction_records.append(dict(hybrid_atoms=[ha,hb],global_atoms=[a,b],r0_nm=r0,k_kJ_mol_nm2=k,distance_nm=distance,energy_kJ_mol=energy,force_on_first_kJ_mol_nm=force.tolist(),force_on_second_kJ_mol_nm=(-force).tolist()))
        report['explicit_added_A_only_H_confinement']=dict(energy_kJ_mol=correction_energy,bonds=correction_records,instantaneous_forces_retained=True,note='This extra positive harmonic bond remains at endpointB; native physicalB alone is not the assembledB Hamiltonian.')
        assembled_system,active_counts=assembled_bonded(mm,unit,parameters)
        native_values=snapshot(mm,unit,np,native_system,positions_native)
        assembled_values=snapshot(mm,unit,np,assembled_system,positions_assembled)
        native_counts=dict(harmonic_bonds=native_forces['HarmonicBondForce'].getNumBonds(),harmonic_angles=native_forces['HarmonicAngleForce'].getNumAngles(),periodic_torsions=native_forces['PeriodicTorsionForce'].getNumTorsions())
        report['counts']=dict(native_atoms=native_count,assembled_atoms=assembled_count,insertion_global_index=insertion,native_bonded=native_counts,assembled_record_counts={k:len(parameters[k]) for k in GROUPS},assembled_active_counts=active_counts)
        arrays=dict(native_to_global=native_to_global,native_positions_nm=positions_native,assembled_positions_nm=positions_assembled,ghost_bond_force_correction=correction_force)
        groups=[];all_pass=True
        for index,key in enumerate(GROUPS):
            native_energy,native_force=native_values[index];actual_energy,actual_force=assembled_values[index]
            expected_energy=native_energy+(correction_energy if index==0 else 0.)
            expected_force=np.zeros((assembled_count,3));expected_force[native_to_global]=native_force
            if index==0:expected_force+=correction_force
            energy_error=abs(actual_energy-expected_energy);energy_limit=policy['energy_absolute_tolerance_kJ_mol']+policy['energy_relative_tolerance']*abs(expected_energy)
            force_error=np.abs(actual_force-expected_force);force_limit=policy['force_absolute_tolerance_kJ_mol_nm']+policy['force_relative_tolerance']*np.abs(expected_force)
            finite=bool(np.isfinite(actual_energy) and np.isfinite(expected_energy) and np.all(np.isfinite(actual_force)) and np.all(np.isfinite(expected_force)))
            failed=np.argwhere(~np.isfinite(force_error)|(force_error>force_limit));passed=finite and energy_error<=energy_limit and len(failed)==0;all_pass=all_pass and passed
            worst=np.unravel_index(int(np.nanargmax(force_error)),force_error.shape) if np.any(np.isfinite(force_error)) else (0,0)
            groups.append(dict(group=key,passed=passed,native_energy_kJ_mol=native_energy,explicit_correction_energy_kJ_mol=correction_energy if index==0 else 0.,expected_energy_kJ_mol=expected_energy,actual_energy_kJ_mol=actual_energy,energy_absolute_error_kJ_mol=energy_error,energy_tolerance_kJ_mol=energy_limit,force_components_checked=int(actual_force.size),failed_force_components=len(failed),maximum_absolute_force_error_kJ_mol_nm=float(np.nanmax(force_error)),worst_force_component=dict(atom=int(worst[0]),axis=int(worst[1]),actual=float(actual_force[worst]),expected=float(expected_force[worst]),error=float(force_error[worst]),tolerance=float(force_limit[worst])),first_failed_components=[dict(atom=int(a),axis=int(axis),actual=float(actual_force[a,axis]),expected=float(expected_force[a,axis]),error=float(force_error[a,axis]),tolerance=float(force_limit[a,axis])) for a,axis in failed[:100]]))
            arrays[key+'_native_force']=native_force;arrays[key+'_expected_force']=expected_force;arrays[key+'_actual_force']=actual_force;arrays[key+'_absolute_error']=force_error;arrays[key+'_tolerance']=force_limit
        need(all(digest(Path(record['path']))==record['sha256'] for record in report['source_files'].values()),'Source bytes changed during validation')
        arrays_path=target/'all-bonded-force-components.npz';np.savez_compressed(arrays_path,**arrays)
        report.update(groups=groups,all_force_components_checked=sum(g['force_components_checked'] for g in groups),force_component_artifact=source(arrays_path),passed=bool(all_pass),status='passed_bonded_only' if all_pass else 'failed_bonded_comparison',production_ready=False,nonbonded_evaluated=False,C4_evaluated=False,constraint_dynamics_evaluated=False,integrator_steps=0)
    except Exception as error:
        report.update(status='failed_validation',passed=False,error=f'{type(error).__name__}: {error}',production_ready=False)
        (target/'failure.txt').write_text(traceback.format_exc())
    finally:
        save(target/'report.json',report)
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--package-root',type=Path,default=PACKAGE);parser.add_argument('--leg',choices=['all',*LEGS],default='all');args=parser.parse_args()
    policy=json.loads(POLICY_FILE.read_text());names=list(LEGS) if args.leg=='all' else [args.leg]
    results=OUT/'attempts';results.mkdir(exist_ok=True)
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')+f'-{os.getpid()}'
    attempt=results/stamp;attempt.mkdir()
    missing=[]
    for name in names:
        for filename in ['B.parameters.json.gz','global-map.json.gz','catalog-candidate.json']:
            path=args.package_root/'legs'/name/filename
            if not path.is_file():missing.append(str(path))
        path=args.package_root/'legs'/name/'catalog-candidate.json'
        if path.is_file():
            try:
                if json.loads(path.read_text()).get('sourceHashesVerifiedAfterAssembly') is not True:missing.append(str(path)+' requires sourceHashesVerifiedAfterAssembly=true')
            except Exception as error:
                missing.append(str(path)+' not yet valid finalized JSON: '+str(error))
    header=dict(schema='orvia.full-hybrid.native-B-bonded-validation.v1',status='blocked_incomplete' if missing else 'in_progress',passed=False,missing_assembled_inputs=missing,script=source(Path(__file__)),policy=source(POLICY_FILE),scope=policy['scope'],attempt_directory=str(attempt),production_ready=False,nonbonded_evaluated=False,optimizer_run=False,integrator_steps=0)
    save(attempt/'summary.json',header)
    if missing:
        print(json.dumps(header,indent=2));return 2
    reports=[]
    for name in names:
        try:
            reports.append(validate_leg(name,args.package_root,attempt,policy))
        except Exception as error:
            target=attempt/name;target.mkdir(exist_ok=True)
            failure=dict(leg=name,status='failed_validation',passed=False,error=f'{type(error).__name__}: {error}',production_ready=False)
            save(target/'report.json',failure);(target/'failure.txt').write_text(traceback.format_exc());reports.append(failure)
    header.update(status='passed_bonded_only' if all(r['passed'] for r in reports) else 'failed_validation',passed=all(r['passed'] for r in reports),legs=[dict(leg=r['leg'],status=r['status'],passed=r['passed'],report=str(attempt/r['leg']/'report.json')) for r in reports])
    save(attempt/'summary.json',header);print(json.dumps(header,indent=2));return 0 if header['passed'] else 1


if __name__=='__main__':
    raise SystemExit(main())
