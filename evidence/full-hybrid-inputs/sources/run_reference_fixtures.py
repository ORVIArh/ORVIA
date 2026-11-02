#!/usr/bin/env python3
"""Small static Reference tests; preserves every attempt, no optimizer/dynamics."""
from pathlib import Path
from datetime import datetime,timezone
from collections import Counter
import hashlib,json,os,traceback
OUT=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(p,r):p.write_text(json.dumps(r,indent=2,sort_keys=True,allow_nan=False)+'\n')
def observe(mm,unit,np,case,lrc,directory):
    system=mm.System()
    for _ in case['types']:system.addParticle(1.*unit.dalton)
    box=case['box_nm'];system.setDefaultPeriodicBoxVectors(mm.Vec3(box[0],0,0),mm.Vec3(0,box[1],0),mm.Vec3(0,0,box[2]))
    force=mm.CustomNonbondedForce('-c/r^4; c=C(type1,type2)');force.addPerParticleParameter('type')
    matrix=case['C4_matrix_kJ_nm4_mol'];n=len(matrix);force.addTabulatedFunction('C',mm.Discrete2DFunction(n,n,[matrix[i][j]for j in range(n)for i in range(n)]))
    for t in case['types']:force.addParticle([float(t)])
    for a,b in case['exclusions']:force.addExclusion(a,b)
    force.setNonbondedMethod(mm.CustomNonbondedForce.CutoffPeriodic);force.setCutoffDistance(case['cutoff_nm']*unit.nanometer);force.setUseSwitchingFunction(False);force.setUseLongRangeCorrection(lrc);system.addForce(force)
    assert force.getNumInteractionGroups()==0 and not force.getUseSwitchingFunction()
    xml=directory/('system-lrc-'+str(lrc).lower()+'.xml');xml.write_text(mm.XmlSerializer.serialize(system))
    integrator=mm.VerletIntegrator(.001*unit.picoseconds);context=mm.Context(system,integrator,mm.Platform.getPlatformByName('Reference'))
    try:
        context.setPositions(np.asarray(case['positions_nm'])*unit.nanometer);state=context.getState(getEnergy=True,getForces=True)
        return dict(energy_kJ_mol=float(state.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole)),forces_kJ_mol_nm=np.asarray(state.getForces(asNumpy=True).value_in_unit(unit.kilojoule_per_mole/unit.nanometer)).tolist(),system_xml=dict(path=str(xml),sha256=sha(xml)))
    finally:del context,integrator

def main():
    import numpy as np
    import openmm as mm
    import openmm.version
    from openmm import unit
    import mpmath as mp
    from analytic_c4 import analytic_direct,analytic_lrc_energy
    policy= json.loads((OUT/'policy.json').read_text());document=json.loads((OUT/'fixtures.json').read_text())
    attempt=OUT/'attempts'/(datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')+f'-{os.getpid()}');attempt.mkdir(parents=True)
    for name in ['run_reference_fixtures.py','analytic_c4.py','policy.json','fixtures.json']:(attempt/name).write_bytes((OUT/name).read_bytes())
    report=dict(schema='orvia.independent-c4-direct-lrc-reference.v1',passed=False,status='in_progress',attempt_directory=str(attempt),policy_sha256=sha(OUT/'policy.json'),runner_sha256=sha(Path(__file__)),analytic_module_sha256=sha(OUT/'analytic_c4.py'),mpmath_version=mp.__version__,runtime=policy['runtime'],fixtures=[],relations=[],failed_criteria=[],platform='Reference',integrator_steps=0,optimizer_run=False,full_native_model=False,alchemical_activity_policy_admitted=False,production_ready=False)
    save(attempt/'report.json',report)
    try:
        assert sha(OUT/'fixtures.json')==policy['fixtures']['sha256'];assert sha(OUT/'analytic_c4.py')==policy['analytic_module']['sha256']
        assert mm.version.full_version==policy['runtime']['full_version'] and mm.version.git_revision==policy['runtime']['git_revision']
        assert all(sha(Path(path))==item['sha256']for path,item in policy['runtime']['binaries'].items())
        assert all(sha(Path(item['path']))==item['sha256']for item in policy['pinned_sources'].values())
        for case in document['cases']:
            target=attempt/case['name'];target.mkdir();result=dict(name=case['name'],passed=False,status='in_progress',case=case)
            try:
                matrix={(i,j):v for i,row in enumerate(case['C4_matrix_kJ_nm4_mol'])for j,v in enumerate(row)}
                oracle=analytic_direct(case['positions_nm'],case['types'],matrix,case['box_nm'],case['cutoff_nm'],case['exclusions']);expected_E=float(oracle['energy']);expected_F=np.asarray([[float(v)for v in row]for row in oracle['forces']])
                expected_LRC=analytic_lrc_energy(Counter(case['types']),matrix,case['box_nm'],case['cutoff_nm']);expected_LRC_float=float(expected_LRC)
                off=observe(mm,unit,np,case,False,target);on=observe(mm,unit,np,case,True,target)
                observed_LRC=on['energy_kJ_mol']-off['energy_kJ_mol'];direct_error=abs(off['energy_kJ_mol']-expected_E);tail_error=abs(observed_LRC-expected_LRC_float)
                direct_tolerance=policy['direct_energy_absolute_tolerance_kJ_mol']+policy['direct_energy_relative_tolerance']*abs(expected_E)
                tail_tolerance=policy['LRC_energy_absolute_tolerance_kJ_mol']+policy['LRC_energy_relative_tolerance']*abs(expected_LRC_float)
                force_limit=policy['direct_force_absolute_tolerance_kJ_mol_nm']+policy['direct_force_relative_tolerance']*np.abs(expected_F)
                off_error=np.abs(np.asarray(off['forces_kJ_mol_nm'])-expected_F);on_error=np.abs(np.asarray(on['forces_kJ_mol_nm'])-expected_F)
                finite=np.isfinite(off['energy_kJ_mol'])and np.isfinite(on['energy_kJ_mol'])and np.all(np.isfinite(off_error))and np.all(np.isfinite(on_error))
                passed=bool(finite and direct_error<=direct_tolerance and tail_error<=tail_tolerance and np.all(off_error<=force_limit)and np.all(on_error<=force_limit))
                result.update(passed=passed,status='passed_small_reference_fixture'if passed else'failed_numerical_comparison',oracle=dict(direct_energy_exact_fraction=str(oracle['energy']),direct_forces_exact_fraction=[[str(v)for v in row]for row in oracle['forces']],LRC_energy_100_digits=mp.nstr(expected_LRC,100),class_counts=oracle['class_counts'],N_factor=str(__import__('fractions').Fraction(len(case['types']),len(case['types'])+1)),pair_details=oracle['pairs']),reference_tails_off=off,reference_tails_on=on,comparison=dict(direct_energy_absolute_error_kJ_mol=direct_error,direct_energy_tolerance_kJ_mol=direct_tolerance,observed_LRC_energy_kJ_mol=observed_LRC,analytic_LRC_energy_kJ_mol=expected_LRC_float,LRC_energy_absolute_error_kJ_mol=tail_error,LRC_energy_tolerance_kJ_mol=tail_tolerance,force_components_per_state=int(expected_F.size),force_components_compared=int(expected_F.size)*2,maximum_direct_force_error=float(off_error.max()),maximum_tails_on_force_error=float(on_error.max()),LRC_changes_forces_bitwise=not np.array_equal(off['forces_kJ_mol_nm'],on['forces_kJ_mol_nm']),force_component_tolerances=force_limit.tolist()))
            except Exception as error:
                result.update(status='failed_fixture',passed=False,error=f'{type(error).__name__}: {error}');(target/'failure.txt').write_text(traceback.format_exc())
            save(target/'report.json',result);report['fixtures'].append(result)
            if not result['passed']:report['failed_criteria'].append(case['name'])
            save(attempt/'report.json',report)
        by_name={r['name']:r for r in report['fixtures']}
        for label,left,right,ratio in [('excluded_nonzero_pair_does_not_change_LRC','n2_excluded_inside','n2_inside',1.),('zero_type_ghost_N3_over_N2','n3_zero_ghost','n2_inside',9/8),('zero_type_ghost_N8_over_N2','n8_zero_ghosts','n2_inside',4/3)]:
            a,b=by_name[left],by_name[right]
            if a.get('comparison')is None or b.get('comparison')is None:report['failed_criteria'].append(label);continue
            ca,cb=a['comparison'],b['comparison'];error=abs(ca['observed_LRC_energy_kJ_mol']-ratio*cb['observed_LRC_energy_kJ_mol']);limit=ca['LRC_energy_tolerance_kJ_mol']+abs(ratio)*cb['LRC_energy_tolerance_kJ_mol'];ok=error<=limit
            report['relations'].append(dict(name=label,passed=ok,left=left,right=right,expected_ratio=ratio,observed_ratio=ca['observed_LRC_energy_kJ_mol']/cb['observed_LRC_energy_kJ_mol'],absolute_combined_energy_error=error,propagated_predeclared_tolerance=limit))
            if not ok:report['failed_criteria'].append(label)
        assert all(sha(Path(path))==item['sha256']for path,item in policy['runtime']['binaries'].items())
        report.update(passed=not report['failed_criteria'],status='passed_small_reference_fixtures'if not report['failed_criteria']else'failed_small_reference_fixtures',force_components_checked=sum(r.get('comparison',{}).get('force_components_compared',0)for r in report['fixtures']))
    except Exception as error:
        report.update(status='failed_validation',passed=False,error=f'{type(error).__name__}: {error}');(attempt/'failure.txt').write_text(traceback.format_exc())
    finally:save(attempt/'report.json',report)
    print(json.dumps({k:v for k,v in report.items()if k not in ['fixtures','runtime']},indent=2));return 0 if report['passed']else 1
if __name__=='__main__':raise SystemExit(main())
