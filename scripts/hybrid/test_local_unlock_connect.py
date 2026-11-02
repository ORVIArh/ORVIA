#!/usr/bin/env python3
"""Local fixture tests; no production wallet, RPC or transactions."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('connect_bridge', Path(__file__).with_name('local_unlock_connect.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class ConnectionBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.progress = self.root / 'progress.json'
        self.manifest = {'planSha256': 'a' * 64, 'runId': '0x' + 'b' * 64}
        self.data = {**self.manifest, 'coordinator': bridge.COORDINATOR, 'diagnosticOnly': True,
                     'confirmedTransactions': 1, 'totalTransactions': 3, 'stage': 'registered',
                     'totalActualFeeEth': '0.00001', 'complete': False}

    def write(self):
        self.progress.write_text(json.dumps(self.data))

    def test_only_public_fields_are_returned(self):
        self.data.update(password='synthetic only', rawTransaction='synthetic raw', signature='synthetic signature')
        self.write()
        public = bridge.public_progress(self.progress, self.manifest)
        self.assertEqual(public['confirmedTransactions'], 1)
        self.assertNotIn('synthetic', json.dumps(public))

    def test_wrong_plan_run_coordinator_or_diagnostic_is_rejected(self):
        for key, value in [('planSha256', 'c' * 64), ('runId', '0x' + 'd' * 64),
                           ('coordinator', '0x' + '0' * 40), ('diagnosticOnly', False)]:
            original = self.data[key]
            self.data[key] = value
            self.write()
            with self.assertRaises(ValueError):
                bridge.public_progress(self.progress, self.manifest)
            self.data[key] = original

    def test_invalid_counts_and_raw_errors_are_rejected(self):
        for key, value in [('confirmedTransactions', True), ('confirmedTransactions', 4),
                           ('totalTransactions', -1), ('totalTransactions', 2),
                           ('errorCode', 'private error details: synthetic')]:
            original = self.data.get(key)
            self.data[key] = value
            self.write()
            with self.assertRaises(ValueError):
                bridge.public_progress(self.progress, self.manifest)
            if original is None:
                self.data.pop(key)
            else:
                self.data[key] = original

    def test_invalid_public_amounts_are_rejected(self):
        for value in ['1e-5', '-1', '0.1234567890123456789', 'NaN', '١']:
            self.data['totalActualFeeEth'] = value
            self.write()
            with self.assertRaises(ValueError):
                bridge.public_progress(self.progress, self.manifest)

    def test_cumulative_amount_uses_exact_wei(self):
        self.assertEqual(bridge.including_deployment('0.000000000000000001'), '0.004612876889674001')
        self.assertEqual(bridge.including_deployment('0'), '0.004612876889674')

    def test_contradictory_completion_is_rejected(self):
        for changes in [dict(complete=True), dict(stage='complete'),
                        dict(complete=True, stage='complete', confirmedTransactions=2),
                        dict(complete=True, stage='complete', confirmedTransactions=3, errorCode='failed')]:
            original = self.data.copy()
            self.data.update(changes)
            self.write()
            with self.assertRaises(ValueError):
                bridge.public_progress(self.progress, self.manifest)
            self.data = original
        self.data.update(complete=True, stage='complete', confirmedTransactions=3)
        self.write()
        self.assertTrue(bridge.public_progress(self.progress, self.manifest)['complete'])

    def test_symlink_and_oversized_input_are_rejected(self):
        self.write()
        alias = self.root / 'alias.json'
        alias.symlink_to(self.progress)
        with self.assertRaises(ValueError):
            bridge.read_checked(alias)
        with self.assertRaises(ValueError):
            bridge.read_checked(self.progress, 2)

    def test_changed_manifest_is_rejected_before_sources_are_opened(self):
        self.progress.write_text('{}')
        with self.assertRaises(ValueError):
            bridge.verify_manifest(self.progress, '0' * 64)


if __name__ == '__main__':
    unittest.main(verbosity=2)
