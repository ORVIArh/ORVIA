import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import run_repair_package as runner


class PackageTests(unittest.TestCase):
    def package(self, parent, *, unsafe=False, mismatch=False):
        archive = parent / 'input.tar.gz'
        content = b'diagnostic fixture'
        manifest = {'files': {'scripts/model_repair_gpu.py': {'bytes': len(content),
            'sha256': '0'*64 if mismatch else hashlib.sha256(content).hexdigest()}}}
        with tarfile.open(archive, 'w:gz') as target:
            for name, data in [('orvia-phosphate-repair/manifest.json', json.dumps(manifest).encode()),
                               ('../escape' if unsafe else 'orvia-phosphate-repair/scripts/model_repair_gpu.py', content)]:
                item = tarfile.TarInfo(name); item.size = len(data)
                target.addfile(item, io.BytesIO(data))
        return archive

    def run_package(self, parent, archive, digest, popen):
        args = ['run_repair_package.py', '--archive', str(archive), '--sha256', digest,
                '--python', sys.executable, '--output-parent', str(parent)]
        with patch.object(sys, 'argv', args), patch.object(runner.subprocess, 'Popen', popen), \
             patch.object(runner.signal, 'signal'), contextlib.redirect_stdout(io.StringIO()):
            code = runner.main()
        result = next(parent.glob('orvia-phosphate-results-*.tar.gz'))
        with tarfile.open(result) as source:
            status = json.load(source.extractfile('run-status.json'))
        return code, status

    def test_bad_archive_identity_never_executes(self):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder); archive = self.package(parent)
            with patch.object(runner.subprocess, 'Popen') as process:
                code, status = self.run_package(parent, archive, '0'*64, process)
            self.assertEqual(code, 2); process.assert_not_called()
            self.assertIn('hash mismatch', status['error']['message'])

    def test_unsafe_path_and_bad_payload_never_execute(self):
        for kwargs in ({'unsafe': True}, {'mismatch': True}):
            with self.subTest(kwargs=kwargs), tempfile.TemporaryDirectory() as folder:
                parent = Path(folder); archive = self.package(parent, **kwargs)
                with patch.object(runner.subprocess, 'Popen') as process:
                    code, status = self.run_package(parent, archive, hashlib.sha256(archive.read_bytes()).hexdigest(), process)
                self.assertEqual(code, 2); process.assert_not_called()
                self.assertFalse(status['passed'])

    def test_timeout_terminates_worker_group_and_archives_failure(self):
        processes = []
        class Process:
            def __init__(self, command, **kwargs):
                self.pid = 45678 + len(processes); self.command = command
                self.done = False; self.calls = 0; processes.append(self)
                self.should_timeout = any('/complex33' in part for part in command)
                assert kwargs['start_new_session'] is True
            def wait(self, timeout):
                self.calls += 1
                if self.should_timeout and self.calls == 1:
                    raise subprocess.TimeoutExpired(self.command, timeout)
                self.done = True; return 0
            def poll(self):
                return 0 if self.done else None
        with tempfile.TemporaryDirectory() as folder, patch.object(runner.os, 'killpg') as kill:
            parent = Path(folder); archive = self.package(parent)
            code, status = self.run_package(parent, archive, hashlib.sha256(archive.read_bytes()).hexdigest(), Process)
            self.assertEqual(code, 2); self.assertFalse(status['passed'])
            timed = next(row for row in status['steps'] if row['name'] == 'complex33')
            self.assertEqual(timed['exitcode'], 124); self.assertEqual(timed['state'], 'timed_out')
            self.assertLessEqual(timed['hard_timeout_seconds'], 240)
            kill.assert_called_once_with(processes[2].pid, runner.signal.SIGTERM)
            self.assertTrue(all(process.done for process in processes))


if __name__ == '__main__':
    unittest.main()
