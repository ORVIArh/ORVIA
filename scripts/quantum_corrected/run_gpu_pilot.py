#!/usr/bin/env python3
"""Run one bounded scanner pilot in an existing validated QM environment."""
import argparse
import datetime
import hashlib
import io
import json
import os
from pathlib import Path,PurePosixPath
import re
import shutil
import signal
import subprocess
import tarfile
import time


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--archive',type=Path,required=True);p.add_argument('--sha256',required=True);p.add_argument('--python',type=Path,required=True);p.add_argument('--output-parent',type=Path,default=Path('/workspace'));a=p.parse_args()
    if not re.fullmatch('[0-9a-f]{64}',a.sha256):p.error('Exact SHA-256 required')
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+str(os.getpid());root=a.output_parent/('orvia-qm-pilot-'+stamp);root.mkdir(parents=True,exist_ok=False)
    for name in ['bundle','results','logs']:(root/name).mkdir()
    start=time.monotonic();status=dict(schema='orvia.qm-gpu-scanner-pilot-launch.v1',passed=False,hard_timeout_seconds=600,scientific_acceptance=False,production_ready=False,automatic_pod_shutdown=False,archive_sha256=a.sha256);active=None
    def stop():
        if active is not None and active.poll() is None:
            try:os.killpg(active.pid,signal.SIGTERM);active.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:os.killpg(active.pid,signal.SIGKILL);active.wait(timeout=5)
                except Exception as error:status.setdefault('cleanup_errors',[]).append(type(error).__name__)
            except ProcessLookupError:pass
    def interrupt(signum,frame):stop();raise InterruptedError('Interrupted by signal '+str(signum))
    signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
    try:
        payload=a.archive.read_bytes()
        if not 0<len(payload)<10*1024*1024 or hashlib.sha256(payload).hexdigest()!=a.sha256:raise ValueError('Archive size/hash mismatch')
        with tarfile.open(fileobj=io.BytesIO(payload),mode='r:gz') as archive:
            members=archive.getmembers()
            if len(members)>100 or sum(m.size for m in members)>30*1024*1024:raise ValueError('Archive expansion bound exceeded')
            seen=set()
            for m in members:
                rel=PurePosixPath(m.name)
                if rel.is_absolute() or '..' in rel.parts or '\\' in m.name or not rel.parts or rel.parts[0]!='orvia-qm-heldout' or m.name in seen or not(m.isfile() or m.isdir()):raise ValueError('Unsafe archive member')
                seen.add(m.name);dest=root/'bundle'/Path(*rel.parts)
                if m.isdir():dest.mkdir(parents=True,exist_ok=True)
                else:
                    dest.parent.mkdir(parents=True,exist_ok=True)
                    with archive.extractfile(m) as source,dest.open('xb') as target:shutil.copyfileobj(source,target)
        bundle=root/'bundle/orvia-qm-heldout';manifest=json.loads((bundle/'manifest.json').read_text());declared={'manifest.json'}
        for name,expected in manifest['files'].items():
            rel=PurePosixPath(name)
            if rel.is_absolute() or '..' in rel.parts or '\\' in name:raise ValueError('Unsafe manifest path')
            data=(bundle/Path(*rel.parts)).read_bytes()
            if len(data)!=expected['bytes'] or hashlib.sha256(data).hexdigest()!=expected['sha256']:raise ValueError('Manifest file mismatch')
            declared.add(name)
        if declared!={str(path.relative_to(bundle)) for path in bundle.rglob('*') if path.is_file()}:raise ValueError('Undeclared bundle file')
        status['manifest_verified']=True;shutil.copyfile(bundle/'manifest.json',root/'manifest.json')
        gate=bundle/'gpu-gate.json';gate_sha=hashlib.sha256(gate.read_bytes()).hexdigest();status['gate_sha256']=gate_sha
        with (root/'logs/pilot.log').open('wb') as log:
            active=subprocess.Popen([str(a.python),str(bundle/'gpu_heldout.py'),'--job-input',str(bundle/'jobs/heldout_A_+030.json'),'--policy',str(bundle/'quality_policy.json'),'--output-dir',str(root/'results/heldout_A_+030_pilot'),'--mode','pilot','--pilot-steps','3','--max-seconds','570','--gate-report',str(gate),'--gate-sha256',gate_sha],stdout=log,stderr=subprocess.STDOUT,start_new_session=True,env={**os.environ,'OMP_NUM_THREADS':'4','OPENBLAS_NUM_THREADS':'4','PYTHONUNBUFFERED':'1'})
            try:code=active.wait(timeout=max(.1,600-(time.monotonic()-start)))
            except subprocess.TimeoutExpired:stop();code=124
            active=None
        status['exitcode']=code
        result=root/'results/heldout_A_+030_pilot/result.json'
        status['passed']=code==0 and result.exists() and json.loads(result.read_text()).get('status')=='passed_gpu_optimization_pilot'
    except Exception as error:status['error']=dict(type=type(error).__name__,message=str(error))
    finally:
        stop();status['elapsed_seconds']=time.monotonic()-start;(root/'status.json').write_text(json.dumps(status,indent=2)+'\n')
        result_archive=a.output_parent/('orvia-qm-pilot-results-'+stamp+'.tar.gz')
        with tarfile.open(result_archive,'w:gz') as archive:
            for name in ['results','logs','status.json','manifest.json']:
                if(root/name).exists():archive.add(root/name,arcname=name)
        digest=hashlib.sha256(result_archive.read_bytes()).hexdigest();Path(str(result_archive)+'.sha256').write_text(digest+'  '+result_archive.name+'\n')
        print(json.dumps({'passed':status['passed'],'archive':str(result_archive),'sha256':digest,'automatic_pod_shutdown':False}),flush=True)
    return 0 if status['passed'] else 2


if __name__=='__main__':raise SystemExit(main())
