#!/usr/bin/env python3
"""Install an isolated, pinned binary environment and run the bounded GPU gate.

No cloud instance is created or stopped by this program. Preserve the result archive.
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
import sys
import tarfile
import time


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive',type=Path,required=True)
    parser.add_argument('--sha256',required=True)
    parser.add_argument('--output-parent',type=Path,default=Path('/workspace'))
    args=parser.parse_args()
    if not re.fullmatch('[0-9a-f]{64}',args.sha256): parser.error('Exact lowercase archive SHA-256 required')
    start=time.monotonic(); deadline=start+900
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+str(os.getpid())
    root=args.output_parent/('orvia-qm-gate-'+stamp);root.mkdir(parents=True,exist_ok=False)
    for name in ['logs','environment','results','bundle']: (root/name).mkdir()
    status=dict(schema='orvia.qm-gpu-gate-launch.v1',passed=False,steps=[],total_work_timeout_seconds=900,automatic_pod_shutdown=False,scientific_acceptance=False,production_ready=False,billing_cost=None,archive_sha256=args.sha256)
    active=None
    def write():
        temp=root/'status.tmp';temp.write_text(json.dumps(status,indent=2,allow_nan=False)+'\n');temp.replace(root/'status.json')
    def stop():
        if active is not None and active.poll() is None:
            try:
                os.killpg(active.pid,signal.SIGTERM);active.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try: os.killpg(active.pid,signal.SIGKILL);active.wait(timeout=5)
                except Exception as error: status.setdefault('cleanup_errors',[]).append(type(error).__name__)
            except ProcessLookupError: pass
    def interrupt(signum,frame):
        stop();raise InterruptedError('Received signal '+str(signum))
    signal.signal(signal.SIGINT,interrupt);signal.signal(signal.SIGTERM,interrupt)
    def execute(name,command,seconds,cwd=None):
        nonlocal active
        remaining=deadline-time.monotonic()
        if remaining<=0: raise TimeoutError('Overall gate deadline exhausted')
        row=dict(name=name,timeout_seconds=min(seconds,remaining));status['steps'].append(row);write()
        tick=time.monotonic()
        with (root/'logs'/(name+'.log')).open('wb') as log:
            active=subprocess.Popen(command,cwd=cwd,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,env={**os.environ,'PYTHONUNBUFFERED':'1','OMP_NUM_THREADS':'8','OPENBLAS_NUM_THREADS':'8'})
            try:
                code=active.wait(timeout=min(seconds,remaining))
            except subprocess.TimeoutExpired:
                stop();code=124
            finally: active=None
        row.update(exitcode=code,elapsed_seconds=time.monotonic()-tick);write();return code
    try:
        write()
        if not 0<args.archive.stat().st_size<10*1024*1024: raise ValueError('Unexpected input archive size')
        payload=args.archive.read_bytes()
        if hashlib.sha256(payload).hexdigest()!=args.sha256: raise ValueError('Input archive hash mismatch')
        with tarfile.open(fileobj=io.BytesIO(payload),mode='r:gz') as archive:
            members=archive.getmembers()
            if len(members)>100 or sum(m.size for m in members)>20*1024*1024: raise ValueError('Archive expansion bound exceeded')
            seen=set()
            for member in members:
                rel=PurePosixPath(member.name)
                if rel.is_absolute() or '..' in rel.parts or '\\' in member.name or member.name in seen or not rel.parts or rel.parts[0]!='orvia-qm-gate' or not (member.isfile() or member.isdir()): raise ValueError('Unsafe archive member')
                seen.add(member.name);dest=root/'bundle'/Path(*rel.parts)
                if member.isdir():dest.mkdir(parents=True,exist_ok=True)
                else:
                    dest.parent.mkdir(parents=True,exist_ok=True)
                    with archive.extractfile(member) as source,dest.open('xb') as target:shutil.copyfileobj(source,target)
        bundle=root/'bundle/orvia-qm-gate';manifest=json.loads((bundle/'manifest.json').read_text());declared={'manifest.json'}
        for name,expected in manifest['files'].items():
            rel=PurePosixPath(name)
            if rel.is_absolute() or '..' in rel.parts or '\\' in name:raise ValueError('Unsafe manifest path')
            data=(bundle/Path(*rel.parts)).read_bytes()
            if len(data)!=expected['bytes'] or hashlib.sha256(data).hexdigest()!=expected['sha256']:raise ValueError('Manifest mismatch: '+name)
            declared.add(name)
        if declared!={str(p.relative_to(bundle)) for p in bundle.rglob('*') if p.is_file()}:raise ValueError('Undeclared bundle contents')
        shutil.copyfile(bundle/'manifest.json',root/'environment/manifest.json')
        status['bundle_verified']=True
        if sys.version_info[:2]!=(3,12):raise RuntimeError('This wheel lock requires CPython3.12')
        if execute('gpu-inventory',['nvidia-smi','--query-gpu=index,name,uuid,driver_version','--format=csv,noheader'],15):raise RuntimeError('GPU inventory unavailable')
        venv=root/'venv'
        if execute('create-venv',[sys.executable,'-m','venv',str(venv)],30):raise RuntimeError('Isolated venv creation failed')
        python=venv/'bin/python'
        if execute('install',[str(python),'-m','pip','install','--disable-pip-version-check','--only-binary=:all:','--require-hashes','-r',str(bundle/'requirements.lock')],240,cwd=bundle):raise RuntimeError('Pinned wheel installation failed')
        execute('freeze',[str(python),'-m','pip','freeze','--all'],15)
        code=execute('gate',[str(python),str(bundle/'gpu_gate.py'),'--bundle',str(bundle),'--output',str(root/'results/gate'),'--max-seconds','570'],600)
        gate=root/'results/gate/gpu-gate.json'
        status['passed']=code==0 and gate.exists() and json.loads(gate.read_text()).get('passed') is True
    except Exception as error:
        status['error']=dict(type=type(error).__name__,message=str(error)[:2000])
    finally:
        stop();status['elapsed_seconds_before_packaging']=time.monotonic()-start;write()
        result=args.output_parent/('orvia-qm-gate-results-'+stamp+'.tar.gz')
        with tarfile.open(result,'w:gz') as archive:
            for name in ['logs','environment','results','status.json']:archive.add(root/name,arcname=name)
        digest=hashlib.sha256(result.read_bytes()).hexdigest();Path(str(result)+'.sha256').write_text(digest+'  '+result.name+'\n')
        print(json.dumps({'passed':status['passed'],'result_archive':str(result),'sha256':digest,'automatic_pod_shutdown':False}),flush=True)
    return 0 if status['passed'] else 2


if __name__=='__main__':raise SystemExit(main())
