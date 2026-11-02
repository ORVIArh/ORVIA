#!/usr/bin/env python3
import unittest
import numpy as np
from model_repair_stereochemistry import proper_rotation
from structure_validation import l_beta_signs


class StereochemistryRepairTests(unittest.TestCase):
    def test_rotation_maps_reflected_bond_without_reflecting_sidechain(self):
        a=np.asarray([.3,.4,.5]);b=np.asarray([.3,.4,-.5])
        rotation=proper_rotation(a.copy(),b.copy())
        self.assertTrue(np.allclose(rotation@a,b,atol=1e-14))
        self.assertTrue(np.allclose(rotation.T@rotation,np.eye(3),atol=1e-14))
        self.assertAlmostEqual(np.linalg.det(rotation),1)

    def test_antiparallel_rotation_is_proper(self):
        a=np.asarray([0.,0.,1.]);b=-a
        rotation=proper_rotation(a.copy(),b.copy())
        self.assertTrue(np.allclose(rotation@a,b,atol=1e-14))
        self.assertAlmostEqual(np.linalg.det(rotation),1)

    def test_explicit_L_threonine_isoleucine_templates(self):
        signs=l_beta_signs()
        self.assertEqual(set(signs),{'THR','ILE'})
        self.assertTrue(all(sign in [-1,1] for sign in signs.values()))
        self.assertEqual(signs,l_beta_signs())


if __name__=='__main__':unittest.main()
