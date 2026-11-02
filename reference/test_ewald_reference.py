import json
from copy import deepcopy
from pathlib import Path
import unittest
import mpmath as mp
import generate_ewald_reference as ref

class EwaldReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        mp.mp.dps=ref.PRECISION
        cls.p=[list(map(mp.mpf,x)) for x in ref.FIXTURE['positions']]

    def test_regeneration(self):
        stored=json.loads(Path(__file__).with_name('ewald_reference.json').read_text())
        self.assertEqual(stored,ref.generate())

    def test_canonical_halfspace_is_complete_without_sign_duplicates(self):
        for n in (1,2,4):
            modes=ref.half_modes(n);self.assertEqual(len(modes),((2*n+1)**3-1)//2)
            self.assertEqual(len(set(modes)),len(modes))
            self.assertTrue(all(tuple(-x for x in m) not in modes for m in modes))

    def test_force_gradient_and_internal_cancellation(self):
        f=ref.forces(self.p);h=mp.mpf('1e-20')
        for axis in range(3):
            plus=deepcopy(self.p);minus=deepcopy(self.p);plus[0][axis]+=h;minus[0][axis]-=h
            fd=-(ref.energy(plus)-ref.energy(minus))/(2*h)
            self.assertLess(abs(fd-f[0][axis]),mp.mpf('1e-37'))
            self.assertLess(abs(sum(v[axis] for v in f)),mp.mpf('1e-75'))

    def test_independent_integer_cell_shifts_preserve_energy_and_forces(self):
        shifted=deepcopy(self.p)
        for axis,L in enumerate(map(mp.mpf,ref.FIXTURE['box'])):shifted[1][axis]+=L*(axis+2)
        self.assertLess(abs(ref.energy(self.p)-ref.energy(shifted)),mp.mpf('1e-80'))
        for a,b in zip(sum(ref.forces(self.p),[]),sum(ref.forces(shifted),[])):
            self.assertLess(abs(a-b),mp.mpf('1e-75'))

    def test_exception_replaces_only_intracell_coulomb_pair(self):
        normal=ref.energy(self.p);replaced=ref.energy(self.p,exception='-.25')
        r=ref.norm(ref.mic(self.p[0],self.p[1],list(map(mp.mpf,ref.FIXTURE['box']))))
        # The fixture pair is inside real cutoff: erfc+erf=1.
        self.assertLess(abs((replaced-normal)-mp.mpf('.75')/r),mp.mpf('1e-80'))
        f=ref.forces(self.p,exception='-.25')
        self.assertTrue(all(abs(f[0][i]+f[1][i])<mp.mpf('1e-75') for i in range(3)))

    def test_exclusion_coincidence_limit_is_finite(self):
        a=mp.mpf('.75');expected=2*a/mp.sqrt(mp.pi)
        self.assertEqual(ref.exception_energy([mp.mpf(0)]*3,-1,0,1,a),expected)
        for radius in ['1e-8','1e-16','1e-24']:
            e=ref.exception_energy([mp.mpf(radius),mp.mpf(0),mp.mpf(0)],-1,0,1,a)
            self.assertLess(abs(e-expected),mp.mpf(radius)**2)

    def test_full_lattice_reference_is_alpha_independent(self):
        a=deepcopy(ref.FIXTURE);b=deepcopy(ref.FIXTURE);a['alpha']='.5';b['alpha']='.75'
        ea=ref.energy(self.p,a,max_mode=6,real_images=3)
        eb=ref.energy(self.p,b,max_mode=6,real_images=3)
        self.assertLess(abs(ea-eb),mp.mpf('1e-20'))

    def test_reciprocal_truncation_converges_and_real_cutoff_error_remains_visible(self):
        # Same real-space sum isolates omitted positive reciprocal-mode energies.
        values=[ref.energy(self.p,max_mode=n) for n in (1,2,3,6)]
        self.assertTrue(all(a<b for a,b in zip(values,values[1:])))
        self.assertLess(abs(values[2]-values[3]),abs(values[0]-values[3]))
        full=ref.energy(self.p,max_mode=6,real_images=3)
        self.assertGreater(abs(full-values[-1]),mp.mpf('1e-6'))

    def test_cutoff_is_explicit_unshifted_truncation(self):
        a=mp.mpf('.75');rc=mp.mpf('1.75');eps=mp.mpf('1e-10')
        self.assertGreater(ref.real_energy([rc-eps,0,0],1,1,a,rc),0)
        self.assertEqual(ref.real_energy([rc,0,0],1,1,a,rc),0)
        self.assertEqual(ref.real_energy([rc+eps,0,0],1,1,a,rc),0)

if __name__=='__main__':unittest.main()
