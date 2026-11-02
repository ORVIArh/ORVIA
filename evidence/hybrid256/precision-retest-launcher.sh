#!/usr/bin/env bash
# Usage: bash remote-retest.sh BUNDLE_LOCAL_PATH_OR_HTTPS_URL [OUTPUT_PARENT]
# No cloud resource creation/deletion. Caller stops the billed pod after download.
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo 'Usage: bash remote-retest.sh BUNDLE_LOCAL_PATH_OR_HTTPS_URL [OUTPUT_PARENT]' >&2
  exit 64
fi
ORVIA_RETEST_PYTHON="$(command -v python3.12 || command -v python3)"
exec "$ORVIA_RETEST_PYTHON" - "$1" "${2:-/workspace}" <<'PY'
import datetime, hashlib, json, os
from pathlib import Path, PurePosixPath
import shutil, signal, subprocess, sys, tarfile, time, urllib.request

EXPECTED_ARCHIVE_SHA256 = 'bf8240d2f00009184c107299e08eddfa5530ba4369320a48d6f48681d3a0e69f'
EXPECTED_MANIFEST_SHA256 = 'aabee10fdfe23a58b4b7795a27cda4607537c7dcc179e8f189f4869dbbd0d443'
started = time.monotonic()
# At most 540 seconds for downloading, installing, and testing; reserve one
# minute for process termination and packaging even on the failure paths.
deadline = started + 540
run_id = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + str(os.getpid())
parent = Path(sys.argv[2]).resolve()
run_root = parent / ('orvia-precision-retest-' + run_id)
archive = parent / ('orvia-precision-results-' + run_id + '.tar.gz')
for name in ('logs','environment','results','bundle'):
    (run_root/name).mkdir(parents=True, exist_ok=False)
status = {'schema':'orvia.endpoint-precision-remote-run.v1', 'started_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'work_deadline_seconds':540, 'wall_budget_seconds':600, 'expected_archive_sha256':EXPECTED_ARCHIVE_SHA256,
          'expected_manifest_sha256':EXPECTED_MANIFEST_SHA256, 'steps':[], 'exitcode':1,
          'automatic_pod_shutdown':False, 'scientific_acceptance':False, 'production_ready':False,
          'full_simulation_cost':None, 'billing_cost':None}
active = None

def stop_active():
    global active
    if active is not None and active.poll() is None:
        try: os.killpg(active.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: active.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try: os.killpg(active.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            active.wait(timeout=2)

def signal_handler(signum, frame):
    stop_active()
    raise RuntimeError('Launcher interrupted by signal ' + str(signum))

signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)

def execute(name, argv, limit, must_pass=True):
    global active
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('Overall work deadline exhausted')
    begin = time.monotonic()
    with (run_root/'logs'/(name+'.stdout.log')).open('wb') as out, (run_root/'logs'/(name+'.stderr.log')).open('wb') as err:
        active = subprocess.Popen(argv, stdout=out, stderr=err, start_new_session=True,
                                  env={**os.environ, 'PYTHONUNBUFFERED':'1', 'PIP_NO_INPUT':'1'})
        timed_out = False
        try: code = active.wait(timeout=min(limit,remaining))
        except subprocess.TimeoutExpired:
            timed_out = True
            stop_active()
            code = 124
        finally: active = None
    status['steps'].append({'name':name,'exitcode':code,'timed_out':timed_out,
                            'elapsed_seconds':time.monotonic()-begin})
    if must_pass and code:
        raise RuntimeError(name + ' failed with exitcode ' + str(code))
    return code

try:
    bundle_path = run_root/'bundle-input.tar.gz'
    source = sys.argv[1]
    if source.startswith('https://'):
        # The archive is tiny. A strict byte cap and an overall read deadline
        # prevent accidental download of unrelated large content.
        with urllib.request.urlopen(source, timeout=20) as response, bundle_path.open('wb') as f:
            count = 0
            download_deadline = min(deadline,time.monotonic()+60)
            while True:
                if time.monotonic() >= download_deadline: raise TimeoutError('Bundle download timed out')
                chunk = response.read(65536)
                if not chunk: break
                count += len(chunk)
                if count > 2_000_000: raise ValueError('Unexpected bundle size')
                f.write(chunk)
    elif '://' in source:
        raise ValueError('Only local files or HTTPS bundle URLs are accepted')
    else:
        if Path(source).stat().st_size > 2_000_000: raise ValueError('Unexpected bundle size')
        shutil.copyfile(source,bundle_path)
    digest = hashlib.sha256(bundle_path.read_bytes()).hexdigest()
    if digest != EXPECTED_ARCHIVE_SHA256: raise ValueError('Bundle archive SHA256 mismatch')
    with tarfile.open(bundle_path,'r:gz') as t:
        members=t.getmembers()
        seen=set()
        if len(members)!=10: raise ValueError('Unexpected bundle member count')
        for m in members:
            p=PurePosixPath(m.name)
            if (not m.isfile() or p.is_absolute() or '..' in p.parts or len(p.parts)<2
                    or p.parts[0]!='orvia-precision-retest' or m.name in seen or m.size>1_000_000):
                raise ValueError('Unsafe or unexpected archive member')
            seen.add(m.name)
            dest=run_root/'bundle'/Path(*p.parts)
            dest.parent.mkdir(parents=True,exist_ok=True)
            with t.extractfile(m) as r, dest.open('wb') as f: shutil.copyfileobj(r,f)
    bundle_root=run_root/'bundle/orvia-precision-retest'
    manifest_bytes=(bundle_root/'manifest.json').read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest()!=EXPECTED_MANIFEST_SHA256:
        raise ValueError('Manifest SHA256 mismatch')
    manifest=json.loads(manifest_bytes)
    expected_files={'manifest.json'}
    for name,meta in manifest['files'].items():
        p=PurePosixPath(name)
        if p.is_absolute() or '..' in p.parts: raise ValueError('Unsafe manifest file')
        b=(bundle_root/Path(*p.parts)).read_bytes()
        if len(b)!=meta['bytes'] or hashlib.sha256(b).hexdigest()!=meta['sha256']:
            raise ValueError('Bundled file verification failed: '+name)
        expected_files.add(name)
    actual_files={str(p.relative_to(bundle_root)) for p in bundle_root.rglob('*') if p.is_file()}
    if expected_files!=actual_files: raise ValueError('Undeclared bundle file')
    (run_root/'environment/bundle-manifest.json').write_bytes(manifest_bytes)
    shutil.copyfile(bundle_root/'scripts/requirements-cuda.txt',run_root/'environment/requirements-cuda.txt')
    status['bundle_verified']=True
    execute('nvidia-smi',['nvidia-smi','--query-gpu=index,name,uuid,memory.total,driver_version','--format=csv,noheader'],15)
    execute('venv',[sys.executable,'-m','venv',str(run_root/'venv')],45)
    python=str(run_root/'venv/bin/python')
    execute('install',[python,'-m','pip','--isolated','install','--disable-pip-version-check','--no-input',
                       '--only-binary=:all:','--index-url','https://pypi.org/simple','--retries','1','--timeout','30',
                       '-r',str(bundle_root/'scripts/requirements-cuda.txt')],360)
    execute('pip-freeze',[python,'-m','pip','freeze','--all'],15)
    execute('cuda-preflight',[python,'-c',
        'import json,openmm,numpy; p=[openmm.Platform.getPlatform(i).getName() for i in range(openmm.Platform.getNumPlatforms())]; print(json.dumps({"openmm":openmm.version.full_version,"numpy":numpy.__version__,"platforms":p})); assert openmm.__version__=="8.6.1"; assert numpy.__version__=="2.5.4"; assert "CUDA" in p'],20)
    status['exitcode']=execute('precision-diagnostics',[python,str(bundle_root/'scripts/precision_diagnostics.py'),
        '--endpoint-root',str(bundle_root/'inputs/endpoints'),'--output',str(run_root/'results/precision-diagnostics.json'),
        '--platform','CUDA','--precision','double','--device-index','0',
        '--prior-cuda-report',str(bundle_root/'inputs/prior-a100-endpoints.json')],180,must_pass=False)
except Exception as exc:
    status['error']={'type':type(exc).__name__,'message':str(exc)[:2000]}
    status['exitcode']=1
finally:
    stop_active()
    status['elapsed_seconds_before_packaging']=time.monotonic()-started
    status['completed_at_utc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    (run_root/'run-status.json').write_text(json.dumps(status,indent=2,allow_nan=False)+'\n')
    # Includes diagnostic exitcode 2/tolerance failures. No venv, secrets,
    # billing assumptions, or automatic cloud resource deletion.
    with tarfile.open(archive,'w:gz') as t:
        for name in ('logs','environment','results','run-status.json'):
            t.add(run_root/name,arcname=name)
    digest=hashlib.sha256(archive.read_bytes()).hexdigest()
    Path(str(archive)+'.sha256').write_text(digest+'  '+archive.name+'\n')
    print(json.dumps({'exitcode':status['exitcode'],'result_archive':str(archive),'sha256':digest,
                      'elapsed_seconds':time.monotonic()-started,'automatic_pod_shutdown':False}),flush=True)
sys.exit(status['exitcode'])
PY
