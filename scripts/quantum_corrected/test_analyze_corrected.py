#!/usr/bin/env python3
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from analyze_corrected import POLICY_SHA, completed_record, strict_read


class RecordGate(unittest.TestCase):
    def setUp(self):
        self.raw = json.dumps({'optimize': True, 'symbols': ['C', 'C', 'C']}).encode()
        self.descriptor = json.loads(self.raw)
        self.descriptor['_source_bytes'] = self.raw
        self.record = dict(job='example', policy_sha256=POLICY_SHA, status='completed',
            runner_sha256='worker', runtime={'backend': 'CPU OpenBLAS'},
            initial_scf_converged=True, final_scf_converged=True, geometry_converged=True,
            input_sha256=hashlib.sha256(self.raw).hexdigest(), ring_bonds=[{'passed': True}],
            positions_angstrom=[[0, 0, 0], [1, 0, 0], [0, 1, 0]],
            energy_hartree=-1.0, energy_kJ_per_mol=-2625.5,
            mm_reference={'energy_kJ_per_mol': 2.0})

    def test_valid_completed_record(self):
        completed_record(self.record, self.descriptor, 'example', 'worker')

    def test_false_completion_rejected(self):
        for field, value in [('geometry_converged', False), ('initial_scf_converged', False),
                             ('runner_sha256', 'changed'), ('input_sha256', 'changed'),
                             ('ring_bonds', []), ('energy_hartree', float('nan')),
                             ('positions_angstrom', [[0, 0, 0]])]:
            with self.subTest(field=field):
                bad = copy.deepcopy(self.record); bad[field] = value
                with self.assertRaises(ValueError):
                    completed_record(bad, self.descriptor, 'example', 'worker')

    def test_incomplete_and_failed_retained_without_promoting(self):
        for status in ['in_progress', 'failed', 'failed_timeout']:
            record = dict(job='example', policy_sha256=POLICY_SHA, status=status)
            completed_record(record, {}, 'example', 'worker')
            self.assertEqual(record['status'], status)

    def test_wrong_identity_rejected_even_if_failed(self):
        with self.assertRaises(ValueError):
            completed_record(dict(job='other', policy_sha256=POLICY_SHA, status='failed'), {}, 'example', 'worker')

    def test_nonfinite_json_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'invalid.json'; path.write_text('{"value": NaN}')
            with self.assertRaises(ValueError):
                strict_read(path)


if __name__ == '__main__':
    unittest.main()
