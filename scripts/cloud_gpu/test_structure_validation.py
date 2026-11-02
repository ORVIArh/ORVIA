#!/usr/bin/env python3
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
from rdkit import Chem
from rdkit.Chem import AllChem
from structure_validation import cip_labels, l_alpha_sign, normalized_volume, read_positions


class StructureValidationTests(unittest.TestCase):
    def test_orientation_detects_reflection_but_not_translation(self):
        points=np.asarray([[0.,0,0],[1.,0,0],[0,1.,0],[0,0,1.]])
        baseline=normalized_volume(*points)
        self.assertAlmostEqual(normalized_volume(*(points+17)),baseline)
        points[:,0]*=-1
        self.assertAlmostEqual(normalized_volume(*points),-baseline)

    def test_planar_center_is_degenerate(self):
        self.assertEqual(normalized_volume(np.zeros(3),np.asarray([1,0,0]),np.asarray([0,1,0]),np.asarray([-1,0,0])),0)

    def test_real_chiral_molecule_reflection_changes_cip(self):
        molecule=Chem.AddHs(Chem.MolFromSmiles('N[C@@H](C)C(=O)O'))
        self.assertEqual(AllChem.EmbedMolecule(molecule,randomSeed=20261102),0)
        xyz=np.asarray(molecule.GetConformer().GetPositions())
        original=cip_labels(molecule,xyz)
        self.assertTrue(original)
        shifted=cip_labels(molecule,xyz+3)
        self.assertEqual(original,shifted)
        xyz[:,0]*=-1
        reflected=cip_labels(molecule,xyz)
        self.assertEqual(set(original),set(reflected))
        self.assertTrue(all(original[key]!=reflected[key] for key in original))

    def test_invalid_box_and_nonfinite_positions_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'positions.json'
            path.write_text(json.dumps(dict(positions_nm=[[0,0,0]],box_vectors_nm=[[1,1,0],[0,1,0],[0,0,1]])))
            with self.assertRaises(ValueError):read_positions(path,1)
            path.write_text(json.dumps(dict(positions_nm=[[float('nan'),0,0]],box_vectors_nm=np.eye(3).tolist())))
            with self.assertRaises(ValueError):read_positions(path,1)

    def test_L_reference_deterministic(self):
        first=l_alpha_sign()
        self.assertIn(first,[-1,1]);self.assertEqual(first,l_alpha_sign())


if __name__=='__main__':unittest.main()
