#!/usr/bin/env python3
"""Prepare or run a separate, bounded reproduction of the failed QM campaign.

Only copied inputs are consumed. The stopped original campaign is never written.
One CPU worker runs at a time; timeout/resource failures are retained, not retried.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import subprocess
import sys
import time

POLICY_SHA = 'dbea002e2ae847b10d7b65db37f1e877039b99b2c10a6443cc7046cc54121668'
HERE = Path(__file__).resolve().parent


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def save(path, obj):
    path = Path(path); temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(obj, indent=2, sort_keys=True, allow_nan=False) + '\n'); temp.replace(path)


def jobs(policy):
    return ['fragment_baseline'] + [f'fragment_{kind}_{angle:+04d}' for kind in ['aryl', 'ring'] for angle in policy['scans'][kind]['angles_degrees']] + [f'sensitivity_aryl_{angle:+04d}' for angle in policy['second_method_sensitivity']['fragment_aryl_angles_degrees']] + [f'heldout_{ep}_{angle:+04d}' for ep in policy['held_out_full_molecule']['endpoints'] for angle in policy['held_out_full_molecule']['aryl_angles_degrees']]


def prepare(source, root):
    source = source.resolve(); root = root.resolve()
    original = source / 'data/prepared_candidate/quantum'
    if root == source or source in root.parents or root in source.parents:
        raise ValueError('The reproduction must be outside the original source tree')
    if sha(original / 'quality_policy.json') != POLICY_SHA:
        raise ValueError('Unexpected original frozen policy')
    if read(original / 'blas_probe/diagnostic_result.json').get('diagnostic_passed') is not True:
        raise ValueError('Expected independent runtime diagnostic has not passed')
    root.mkdir(parents=True, exist_ok=False)
    def copy(path, relative):
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(path, destination)
    for name in ['quality_policy.json', 'fragment_map.json', 'native_fourier_terms.json']:
        copy(original / name, 'data/prepared_candidate/quantum/' + name)
    for name in ['input.sdf', 'system.xml']:
        copy(original / 'fragment' / name, 'data/prepared_candidate/quantum/fragment/' + name)
    for item in read(original / 'heldout_source_freeze.json')['files']:
        path = source / item['path']
        if sha(path) != item['sha256'] or path.stat().st_size != item['bytes']:
            raise ValueError('Original held-out input changed')
        copy(path, item['path'])
    for name in ['quality_analysis.json', 'optimization_stop_event.json', 'README.md', 'heldout_source_freeze.json']:
        copy(original / name, 'lineage/original_' + name)
    for name in ['runtime_openblas.json', 'diagnostic_result.json', 'diagnostic_completion.json', 'probe_policy.json', 'frozen_geometry.json']:
        copy(original / 'blas_probe' / name, 'lineage/' + name)
    for name in ['analyze_scans.py', 'mm_reference.py']:
        copy(source / 'scripts/quantum' / name, 'scripts/quantum/' + name)
    copy(source / 'scripts/quantum/run_scans.py', 'lineage/original_run_scans.py')
    for name in ['reproduce.py', 'geometry.py', 'worker.py']:
        copy(HERE / name, 'scripts/quantum_corrected/' + name)
    policy = read(original / 'quality_policy.json')
    save(root / 'reproduction.json', dict(schema='orvia.corrected-qm-reproduction.v1', prepared_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(), original_source=str(source), original_policy_sha256=POLICY_SHA, acceptance_limits_unchanged=True, original_failed_campaign_preserved=True, original_observations_reused=False, required_calculations=jobs(policy), purpose='Fresh same-method reproduction on the independently diagnosed local OpenBLAS runtime. No assumption that rank or method-sensitivity failures will disappear.', scientific_acceptance=False, production_ready=False, cpu_only=True))
    files = {str(p.relative_to(root)): dict(bytes=p.stat().st_size, sha256=sha(p)) for p in root.rglob('*') if p.is_file()}
    save(root / 'input-manifest.json', dict(schema='orvia.corrected-qm-inputs.v1', files=files))
    print(json.dumps({'prepared': str(root), 'required_calculations': 27, 'manifest_sha256': sha(root / 'input-manifest.json')}))


def verify(root):
    manifest = read(root / 'input-manifest.json')
    for relative, expected in manifest['files'].items():
        rel = PurePosixPath(relative)
        if rel.is_absolute() or '..' in rel.parts or '\\' in relative:
            raise ValueError('Unsafe manifest path')
        path = root / relative
        if path.is_symlink() or path.stat().st_size != expected['bytes'] or sha(path) != expected['sha256']:
            raise ValueError('Changed frozen reproduction input: ' + relative)
    if sha(root / 'data/prepared_candidate/quantum/quality_policy.json') != POLICY_SHA:
        raise ValueError('Frozen thresholds changed')


def rss_tree(pid):
    # ps works on the supported macOS CPU host and Linux, without psutil changes.
    lines = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss='], text=True, timeout=5).splitlines()
    rows = [tuple(map(int, row.split())) for row in lines if len(row.split()) == 3]
    selected = {pid}
    while True:
        expanded = selected | {child for child, parent, _ in rows if parent in selected}
        if expanded == selected:
            return sum(kib * 1024 for child, _, kib in rows if child in selected)
        selected = expanded


def terminate(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)


def bounded(command, log, seconds, rss_limit):
    start = time.monotonic(); peak = 0; reason = None
    environment = {**os.environ, 'OMP_NUM_THREADS': '4', 'OPENBLAS_NUM_THREADS': '4', 'VECLIB_MAXIMUM_THREADS': '4', 'PYTHONUNBUFFERED': '1'}
    with log.open('xb') as stream:
        process = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True, env=environment)
        previous = {}
        def interrupted(signum, frame):
            raise InterruptedError('Supervisor interrupted by signal ' + str(signum))
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, interrupted)
        try:
            while process.poll() is None:
                if time.monotonic() - start >= seconds:
                    reason = 'failed_timeout'; break
                peak = max(peak, rss_tree(process.pid))
                if peak > rss_limit:
                    reason = 'failed_resource_limit'; break
                time.sleep(0.25)
        finally:
            try:
                if process.poll() is None:
                    terminate(process)
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
    return dict(exitcode=process.returncode, reason=reason, elapsed_seconds=time.monotonic()-start, peak_sampled_rss_bytes=peak)


def run(args):
    root = args.root.resolve(); verify(root)
    out = root / 'data/prepared_candidate/quantum'; (out / 'jobs').mkdir(exist_ok=True)
    runtime = json.loads(subprocess.check_output([str(args.quantum_python), str(root / 'scripts/quantum_corrected/worker.py'), '--root', str(root), '--runtime-only'], text=True, timeout=30))
    save(root / 'runtime-verified.json', runtime)
    policy = read(out / 'quality_policy.json')
    inventory = jobs(policy)
    if args.stage == 'baseline':
        selected = inventory[:1]
    elif args.stage == 'fragment':
        selected = [name for name in inventory if name.startswith('fragment_')]
    elif args.stage == 'secondary':
        selected = [name for name in inventory if name.startswith('sensitivity_')]
    elif args.stage == 'heldout':
        selected = [name for name in inventory if name.startswith('heldout_')]
    else:
        selected = inventory
    started = time.monotonic(); rows = []; launched = 0
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + str(os.getpid())
    session = root / 'sessions' / stamp; session.mkdir(parents=True)
    status = dict(schema='orvia.corrected-qm-session.v1', stage=args.stage, wall_budget_seconds=args.max_wall_seconds, per_job_budget_seconds=args.per_job_seconds, max_rss_bytes=args.max_rss_mib*1024**2, results=rows, scientific_acceptance=False, production_ready=False)
    with (root / '.run.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name in selected:
            result_path = out / 'jobs' / name / 'result.json'
            if result_path.exists():
                old = read(result_path)
                if old.get('policy_sha256') != POLICY_SHA:
                    raise ValueError('Existing result has changed policy')
                rows.append(dict(job=name, retained_status=old['status'])); continue
            if launched >= args.max_jobs or time.monotonic()-started >= args.max_wall_seconds:
                break
            verify(root)
            directory = result_path.parent; directory.mkdir(exist_ok=True)
            descriptor = directory / 'input.json'
            geometry = [str(args.preparation_python), str(root / 'scripts/quantum_corrected/geometry.py'), '--root', str(root), '--job', name, '--output', str(descriptor)]
            try:
                subprocess.run(geometry, check=True, timeout=min(30, max(0.1, args.max_wall_seconds-(time.monotonic()-started))), capture_output=True)
            except subprocess.CalledProcessError as error:
                rows.append(dict(job=name, status='dependency_not_complete', error=error.stderr.decode()[-1000:])); continue
            remaining = args.max_wall_seconds - (time.monotonic()-started)
            if remaining <= 0:
                break
            command = [str(args.quantum_python), str(root / 'scripts/quantum_corrected/worker.py'), '--root', str(root), '--input', str(descriptor), '--preparation-python', str(args.preparation_python)]
            execution = bounded(command, session / (name+'.log'), min(args.per_job_seconds, remaining), args.max_rss_mib*1024**2)
            launched += 1
            if execution['reason'] or not result_path.exists():
                record = read(result_path) if result_path.exists() else dict(job=name, policy_sha256=POLICY_SHA)
                record.update(status=execution['reason'] or 'failed_before_record', supervisor=execution, scientific_acceptance=False, production_ready=False)
                save(result_path, record)
            rows.append(dict(job=name, status=read(result_path)['status'], **execution)); save(session / 'status.json', status)
            if execution['reason'] or execution['exitcode'] != 0:
                break
        status.update(elapsed_seconds=time.monotonic()-started, jobs_launched=launched, original_observations_reused=False, all_27_completed=all((out/'jobs'/name/'result.json').exists() and read(out/'jobs'/name/'result.json').get('status')=='completed' for name in inventory))
        save(session / 'status.json', status)
    print(json.dumps(status, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare'); p.add_argument('--source-root', type=Path, required=True); p.add_argument('--root', type=Path, required=True)
    p = sub.add_parser('verify'); p.add_argument('--root', type=Path, required=True)
    p = sub.add_parser('run'); p.add_argument('--root', type=Path, required=True); p.add_argument('--quantum-python', type=Path, required=True); p.add_argument('--preparation-python', type=Path, required=True)
    p.add_argument('--stage', choices=['baseline','fragment','secondary','heldout','all'], default='baseline')
    p.add_argument('--max-wall-seconds', type=int, default=900); p.add_argument('--per-job-seconds', type=int, default=900); p.add_argument('--max-jobs', type=int, default=1); p.add_argument('--max-rss-mib', type=int, default=6500)
    args = parser.parse_args()
    if args.command == 'prepare': prepare(args.source_root,args.root)
    elif args.command == 'verify': verify(args.root.resolve()); print('Frozen input hashes verified')
    else:
        if not (1 <= args.max_wall_seconds <= 43200 and 1 <= args.per_job_seconds <= 7200 and 1 <= args.max_jobs <= 27 and 128 <= args.max_rss_mib <= 32768):
            parser.error('Resource bounds outside the explicit supported limits')
        run(args)
