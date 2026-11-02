import json
from copy import deepcopy
from pathlib import Path
import unittest
import mpmath as mp
import generate_ewald_dynamics_reference as ref

class EwaldDynamicsReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        mp.mp.dps=ref.PRECISION

    def test_regeneration(self):
        stored=json.loads(Path(__file__).with_name('ewald_dynamics_reference.json').read_text())
        self.assertEqual(stored,ref.generate())

    def test_independent_total_energy_gradient_and_force_cancellation(self):
        p=[list(map(mp.mpf,x)) for x in ref.FIXTURE['positions']];h=mp.mpf('1e-20')
        for exception in (False,True):
            force=ref.forces(p,exception)
            for axis in range(3):
                plus=deepcopy(p);minus=deepcopy(p);plus[0][axis]+=h;minus[0][axis]-=h
                fd=-(ref.total_energy(plus,exception)-ref.total_energy(minus,exception))/(2*h)
                self.assertLess(abs(fd-force[0][axis]),mp.mpf('1e-37'))
                self.assertLess(abs(force[0][axis]+force[1][axis]),mp.mpf('1e-75'))

    def test_linear_momentum_is_preserved_by_two_step_oracle(self):
        masses=list(map(mp.mpf,ref.MASSES))
        initial=[sum(m*mp.mpf(v[d]) for m,v in zip(masses,ref.VELOCITIES)) for d in range(3)]
        for exception in (False,True):
            for frame in ref.trajectory(exception,2):
                for axis in range(3):
                    momentum=sum(m*mp.mpf(v[axis]) for m,v in zip(masses,frame['velocities']))
                    self.assertLess(abs(momentum-initial[axis]),mp.mpf('1e-80'))

    def test_nonzero_lj_and_bond_prevent_a_pure_electrostatics_false_positive(self):
        p=[list(map(mp.mpf,x)) for x in ref.FIXTURE['positions']]
        for exception in (False,True):
            bare=ref.electrostatic_energy(p,exception='-.25' if exception else None)
            self.assertGreater(abs(ref.total_energy(p,exception)-bare),mp.mpf('1e-4'))

if __name__=='__main__':unittest.main()
