"""Meaningful input/translation checks; run in the separately pinned prep environment."""
import copy
from decimal import Decimal
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import openmm as mm
from openmm import unit
from rdkit import Chem

ROOT=Path(__file__).resolve().parents[2]
DATA=ROOT/'data/prepared_candidate/ligand_endpoints_v0_1'


def module(name):
    path=ROOT/'scripts/preparation'/f'{name}.py'
    spec=importlib.util.spec_from_file_location(name,path);result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result


PREP=module('prepare_ligand_endpoints');EXPORT=module('export_amber_endpoint');HYBRID=module('build_ligand_hybrid')


def context(system):
    integrator=mm.VerletIntegrator(0.001)
    return mm.Context(system,integrator,mm.Platform.getPlatformByName('Reference')),integrator


def hybrid_system(parameters):
    s=mm.System()
    for mass in parameters['masses_Da']:s.addParticle(mass)
    bonds=mm.HarmonicBondForce();angles=mm.HarmonicAngleForce();torsions=mm.PeriodicTorsionForce();nb=mm.NonbondedForce()
    for a,b,r,k in parameters['harmonic_bonds']:
        if k:bonds.addBond(a,b,r,k)
    for a,b,c,t,k in parameters['harmonic_angles']:
        if k:angles.addAngle(a,b,c,t,k)
    for a,b,c,d,n,phase,k in parameters['periodic_torsions']:
        if k:torsions.addTorsion(a,b,c,d,n,phase,k)
    for q,sigma,epsilon in parameters['particles']:nb.addParticle(q,sigma,epsilon)
    for a,b,q,sigma,epsilon in parameters['exceptions']:nb.addException(a,b,q,sigma,epsilon)
    for force in [bonds,angles,torsions,nb]:s.addForce(force)
    return s


class PreparedInputs(unittest.TestCase):
    def test_explicit_hydrogen_identity_and_reproduction(self):
        mapping=json.loads((DATA/'explicit_hydrogen_map.json').read_text())
        self.assertEqual([mapping['endpoint_identity'][x]['atoms'] for x in ['A','B']],[41,44])
        self.assertEqual(len(mapping['common_atom_pairs']),40)
        self.assertEqual(len(set(mapping['endpoint_b_to_hybrid'])),44)
        with tempfile.TemporaryDirectory() as temporary:
            regenerated=PREP.candidates(Path(temporary))
            self.assertEqual(regenerated,mapping)
            for name in ['A','B']:
                molecule=next(iter(Chem.SDMolSupplier(str(Path(temporary)/f'{name}_explicit_hydrogens.sdf'),removeHs=False)))
                self.assertEqual(PREP.identity(molecule)['inchikey'],mapping['endpoint_identity'][name]['inchikey'])

    def test_raw_charge_correction_is_explicit_bounded_and_exact_in_text(self):
        for name in ['A','B']:
            r=json.loads((DATA/name/'charge_normalization.json').read_text())
            self.assertEqual(sum(map(Decimal,r['raw_charges_e'])),Decimal(r['raw_charge_sum_e']))
            self.assertEqual(sum(map(Decimal,r['normalized_charges_e'])),Decimal(0))
            self.assertLess(Decimal(r['maximum_atom_adjustment_e']),Decimal('0.0001'))
            self.assertEqual(PREP.digest(DATA/name/'ligand_am1bcc_raw.mol2'),r['input_sha256'])

    def test_native_parameter_files_and_reference_snapshots_are_bound(self):
        for name in ['A','B']:
            p=json.loads((DATA/name/'parameters.json').read_text());r=json.loads((DATA/name/'reference_validation.json').read_text())
            for file,digest in p['input_sha256'].items():self.assertEqual(PREP.digest(DATA/name/file),digest)
            self.assertTrue(p['native_identity_check']['passed']);self.assertEqual(p['native_periodic_improper_count'],14)
            self.assertTrue(r['passed']);self.assertEqual(len(r['snapshots']),3)
            for snap in r['snapshots']:
                actual=EXPORT.independent_energies(p,snap['positions_nm'])
                for kind,value in snap['energy_components_kJ_per_mol'].items():
                    self.assertLess(abs(actual[kind]-value),1e-5+1e-9*abs(value))

    def test_importer_rejects_unsupported_forms_constraints_and_virtual_sites(self):
        s=mm.System();[s.addParticle(1) for _ in range(3)];s.addForce(mm.CustomBondForce('r'))
        with self.assertRaisesRegex(ValueError,'Unsupported force'):EXPORT.export_system(s)
        s=mm.System();[s.addParticle(1) for _ in range(3)];s.addConstraint(0,1,0.1)
        with self.assertRaisesRegex(ValueError,'constraints'):EXPORT.export_system(s)
        s=mm.System();[s.addParticle(1) for _ in range(3)];s.setVirtualSite(2,mm.TwoParticleAverageSite(0,1,.5,.5))
        with self.assertRaisesRegex(ValueError,'virtual'):EXPORT.export_system(s)

    def test_nonzero_torsion_phase_order_matches_reference(self):
        s=mm.System();[s.addParticle(12) for _ in range(4)]
        force=mm.PeriodicTorsionForce();force.addTorsion(0,1,2,3,3,0.37,2.1);s.addForce(force)
        xyz=np.array([[0,0,0],[.12,.03,0],[.2,.15,.02],[.24,.17,.15]])
        ctx,integrator=context(s)
        try:
            ctx.setPositions(xyz*unit.nanometer)
            expected=ctx.getState(getEnergy=True).getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole)
            actual=2.1*(1+np.cos(3*EXPORT.torsion_angle(xyz)-.37))
            self.assertAlmostEqual(expected,actual,places=12)
        finally:del ctx,integrator

    def test_dummy_tree_rejects_multiple_anchors_or_unconfined_atoms(self):
        with self.assertRaisesRegex(ValueError,'singly anchored'):
            HYBRID.ghost_tree({'harmonic_bonds':[[0,1,.1,100],[1,2,.1,100]]},[0,1,2],[1])
        with self.assertRaisesRegex(ValueError,'Unconfined'):
            HYBRID.ghost_tree({'harmonic_bonds':[]},[0,1],[1])

    def test_binary64_to_binary128_embedding(self):
        self.assertEqual(HYBRID.word(1), '0x'+'0'*32+'3fff0000000000000000000000000000')
        self.assertEqual(HYBRID.word(-24), '0x'+'0'*32+'c0038000000000000000000000000000')
        self.assertEqual(HYBRID.word(-0.),'0x'+'0'*64)
        with self.assertRaises(ValueError):HYBRID.word(float('nan'))

    def test_aligned_hybrid_endpoint_energy_and_force_equal_native_plus_ghost_tree(self):
        model=json.loads((DATA/'hybrid_model.json').read_text());rng=np.random.default_rng(20261102)
        for name,other in [('A','B'),('B','A')]:
            parameters=model['endpoint_parameters'][name]
            s=hybrid_system(parameters);native=mm.XmlSerializer.deserialize((DATA/name/'system.xml').read_text())
            ctx,integrator=context(s);ref,ref_integrator=context(native)
            try:
                for sample in range(3):
                    xyz=np.asarray(parameters['positions_nm'])+sample*rng.normal(0,.0002,(45,3))
                    ctx.setPositions(xyz*unit.nanometer);ref.setPositions(xyz[model['endpoint_maps'][name]]*unit.nanometer)
                    joint=ctx.getState(getEnergy=True,getForces=True);physical=ref.getState(getEnergy=True,getForces=True)
                    expected_energy=physical.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole)
                    expected_force=np.zeros((45,3));expected_force[model['endpoint_maps'][name]]=physical.getForces(asNumpy=True).value_in_unit(unit.kilojoule_per_mole/unit.nanometer)
                    for component in model['model_policy']['trees'][other]:
                        for a,b,r0,k in component['bonds']:
                            delta=xyz[a]-xyz[b];r=np.linalg.norm(delta);expected_energy+=.5*k*(r-r0)**2
                            force=-k*(r-r0)*delta/r;expected_force[a]+=force;expected_force[b]-=force
                    actual_energy=joint.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole)
                    actual_force=joint.getForces(asNumpy=True).value_in_unit(unit.kilojoule_per_mole/unit.nanometer)
                    self.assertLess(abs(actual_energy-expected_energy),1e-7)
                    self.assertLess(np.max(np.abs(actual_force-expected_force)),1e-6)
            finally:del ctx,integrator,ref,ref_integrator


if __name__=='__main__':unittest.main()
