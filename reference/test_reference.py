"""Checks on the independent oracle, not substitutes for EVM tests."""
import unittest
from decimal import Decimal, localcontext
from generate_bond_vectors import binary128_nearest, evaluate, CASES


class ReferenceTests(unittest.TestCase):
    def test_known_encodings(self):
        for d, h in [('0', '00000000000000000000000000000000'),
                     ('1', '3fff0000000000000000000000000000'),
                     ('-1', 'bfff0000000000000000000000000000'),
                     ('0.5', '3ffe0000000000000000000000000000'),
                     ('2', '40000000000000000000000000000000')]:
            self.assertEqual(binary128_nearest(d), '0x'+h)

    def test_axis_exact(self):
        e,f=evaluate(['0','0','0'],['2','0','0'],'3','1')
        self.assertEqual(Decimal(e),Decimal('1.5'))
        self.assertEqual([Decimal(x) for x in f],[Decimal(3),Decimal(0),Decimal(0)])

    def test_equilibrium_exact(self):
        e,f=evaluate(['-2','3','-1'],['1','7','11'],'10','13')
        self.assertEqual(Decimal(e),Decimal(0))
        self.assertTrue(all(Decimal(x)==0 for x in f))

    def test_exchange_and_translation(self):
        with localcontext() as c:
            c.prec=100
            for name,a,b,k,r0 in CASES:
                e,f=evaluate(a,b,k,r0)
                er,fr=evaluate(b,a,k,r0)
                self.assertEqual(Decimal(e),Decimal(er),name)
                self.assertEqual([Decimal(x) for x in f],[-Decimal(x) for x in fr],name)
                trans=[Decimal('1.25'),Decimal('-0.5'),Decimal('2')]
                at=[str(Decimal(x)+t) for x,t in zip(a,trans)]
                bt=[str(Decimal(x)+t) for x,t in zip(b,trans)]
                et,ft=evaluate(at,bt,k,r0)
                self.assertEqual(Decimal(e),Decimal(et),name)
                self.assertEqual([Decimal(x) for x in f],[Decimal(x) for x in ft],name)

    def test_force_is_negative_energy_gradient(self):
        with localcontext() as c:
            c.prec=100
            h=Decimal('1e-25')
            for name,a,b,k,r0 in CASES:
                _,forces=evaluate(a,b,k,r0)
                for axis in range(3):
                    minus=list(a); plus=list(a)
                    minus[axis]=str(Decimal(a[axis])-h)
                    plus[axis]=str(Decimal(a[axis])+h)
                    em,_=evaluate(minus,b,k,r0)
                    ep,_=evaluate(plus,b,k,r0)
                    derivative=-(Decimal(ep)-Decimal(em))/(2*h)
                    self.assertLess(abs(derivative-Decimal(forces[axis])),Decimal('1e-45'),(name,axis))

if __name__=='__main__':
    unittest.main()
