#!/usr/bin/env python3
"""Run a hash-pinned full-model diagnostic package with hard process deadlines.

This controls worker processes, not cloud billing. Download results then stop the pod.
"""
import argparse
import datetime
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import tarfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--python', type=Path, required=True)
    parser.add_argument('--output-parent', type=Path, default=Path('/workspace'))
    args = parser.parse_args()
    if not re.fullmatch('[0-9a-f]{64}', args.sha256):
        parser.error('Expected an exact lowercase SHA-256')
    started = time.monotonic()
    deadline = started + 540
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + str(os.getpid())
    root = args.output_parent / ('orvia-phosphate-run-' + stamp)
    root.mkdir(parents=True, exist_ok=False)
    for folder in ('environment', 'results', 'logs', 'bundle'):
        (root / folder).mkdir()
    result_archive = args.output_parent / ('orvia-phosphate-results-' + stamp + '.tar.gz')
    status = {'schema': 'orvia.phosphate-repair-package-run.v1',
              'started_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'archive_sha256': args.sha256, 'work_deadline_seconds': 540,
              'per_model_hard_timeout_seconds': 240, 'steps': [], 'passed': False,
              'scientific_acceptance': False, 'production_ready': False,
              'automatic_pod_shutdown': False, 'billing_cost': None}
    active = None

    def write_status():
        temporary = root / 'run-status.tmp'
        temporary.write_text(json.dumps(status, indent=2, allow_nan=False) + '\n')
        temporary.replace(root / 'run-status.json')

    def stop():
        if active is not None and active.poll() is None:
            try:
                os.killpg(active.pid, signal.SIGTERM)
                active.wait(timeout=5)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(active.pid, signal.SIGKILL)
                    active.wait(timeout=5)
                except Exception as error:
                    status.setdefault('cleanup_errors', []).append(type(error).__name__)
                    status['worker_exit_confirmed'] = False
            except Exception as error:
                status.setdefault('cleanup_errors', []).append(type(error).__name__)
                status['worker_exit_confirmed'] = False

    def interrupt(signum, frame):
        stop()
        raise RuntimeError('Package interrupted by signal ' + str(signum))

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)

    def execute(name, command, seconds):
        nonlocal active
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Package work deadline exhausted')
        row = {'name': name, 'state': 'running', 'hard_timeout_seconds': min(seconds, remaining)}
        status['steps'].append(row)
        write_status()
        tick = time.monotonic()
        with (root / 'logs' / (name + '.stdout.log')).open('wb') as stdout, (root / 'logs' / (name + '.stderr.log')).open('wb') as stderr:
            active = subprocess.Popen(command, stdout=stdout, stderr=stderr, start_new_session=True,
                                      env={**os.environ, 'PYTHONUNBUFFERED': '1'})
            try:
                code = active.wait(timeout=min(seconds, remaining))
                row['state'] = 'completed'
            except subprocess.TimeoutExpired:
                stop()
                code = 124
                row['state'] = 'timed_out'
            finally:
                active = None
        row.update(exitcode=code, elapsed_seconds=time.monotonic() - tick)
        write_status()
        return code

    try:
        write_status()
        size = args.archive.stat().st_size
        if not 0 < size <= 32 * 1024 * 1024:
            raise ValueError('Unexpected package size')
        archive_bytes = args.archive.read_bytes()
        if hashlib.sha256(archive_bytes).hexdigest() != args.sha256:
            raise ValueError('Package archive hash mismatch')
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as archive:
            members = archive.getmembers()
            if len(members) > 128 or sum(m.size for m in members) > 300 * 1024 * 1024:
                raise ValueError('Package expansion bound exceeded')
            seen = set()
            for member in members:
                relative = PurePosixPath(member.name)
                if (relative.is_absolute() or '..' in relative.parts or '\\' in member.name
                        or not relative.parts or relative.parts[0] != 'orvia-phosphate-repair'
                        or member.name in seen or not (member.isfile() or member.isdir())):
                    raise ValueError('Unsafe package member')
                seen.add(member.name)
                destination = root / 'bundle' / Path(*relative.parts)
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as source, destination.open('xb') as target:
                        shutil.copyfileobj(source, target)
        bundle = root / 'bundle' / 'orvia-phosphate-repair'
        manifest_bytes = (bundle / 'manifest.json').read_bytes()
        manifest = json.loads(manifest_bytes)
        declared = {'manifest.json'}
        for name, expected in manifest['files'].items():
            relative = PurePosixPath(name)
            if relative.is_absolute() or '..' in relative.parts or '\\' in name:
                raise ValueError('Unsafe manifest path')
            payload = (bundle / Path(*relative.parts)).read_bytes()
            if len(payload) != expected['bytes'] or hashlib.sha256(payload).hexdigest() != expected['sha256']:
                raise ValueError('Manifest payload mismatch: ' + name)
            declared.add(name)
        actual = {str(p.relative_to(bundle)) for p in bundle.rglob('*') if p.is_file()}
        if actual != declared:
            raise ValueError('Undeclared or missing package payload')
        (root / 'environment' / 'bundle-manifest.json').write_bytes(manifest_bytes)
        status['bundle_verified'] = True
        if execute('nvidia-smi', ['nvidia-smi', '--query-gpu=index,name,uuid,memory.total,driver_version', '--format=csv,noheader'], 15):
            raise RuntimeError('GPU inventory failed')
        if execute('python-preflight', [str(args.python), '-c',
            'import openmm,numpy,json; p=[openmm.Platform.getPlatform(i).getName() for i in range(openmm.Platform.getNumPlatforms())]; print(json.dumps(dict(openmm=openmm.version.full_version,numpy=numpy.__version__,platforms=p))); assert openmm.__version__=="8.6.1" and numpy.__version__=="2.5.4" and "CUDA" in p'], 20):
            raise RuntimeError('Pinned GPU environment unavailable')
        codes = []
        for model in ('complex33', 'solvent33'):
            codes.append(execute(model, [str(args.python), str(bundle / 'scripts' / 'model_repair_gpu.py'),
                '--system', str(bundle / 'inputs' / model / 'system.xml'),
                '--positions', str(bundle / 'inputs' / model / 'positions.json'),
                '--output-dir', str(root / 'results' / model), '--platform', 'CUDA',
                '--precision', 'double', '--precheck-platform', 'Reference', '--max-seconds', '220'], 240))
        status['passed'] = all(code == 0 for code in codes)
    except Exception as error:
        status['error'] = {'type': type(error).__name__, 'message': str(error)[:2000]}
    finally:
        stop()
        status['completed_at_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        status['elapsed_seconds_before_packaging'] = time.monotonic() - started
        write_status()
        with tarfile.open(result_archive, 'w:gz') as archive:
            for name in ('environment', 'results', 'logs', 'run-status.json'):
                archive.add(root / name, arcname=name)
        digest = hashlib.sha256(result_archive.read_bytes()).hexdigest()
        Path(str(result_archive) + '.sha256').write_text(digest + '  ' + result_archive.name + '\n')
        print(json.dumps({'passed': status['passed'], 'result_archive': str(result_archive),
                          'sha256': digest, 'elapsed_seconds': time.monotonic() - started,
                          'automatic_pod_shutdown': False}), flush=True)
    return 0 if status['passed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
