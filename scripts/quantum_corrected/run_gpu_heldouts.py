#!/usr/bin/env python3
"""Run six native held-out jobs with two CUDA processes after the exact pilot passes.

The existing validated environment is reused. Every result, failure, and timeout
is preserved. The launcher does not manage cloud billing or stop a cloud pod.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path,PurePosixPath
import signal
import subprocess
import tarfile
import time


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_bundle(bundle):
    m=json.loads((bundle/'manifest.json').read_text());expected={'manifest.json'}
    for name,row in m['files'].items():
        rel=PurePosixPath(name)
        if rel.is_absolute() or '..' in rel.parts or '\\' in name:raise ValueError('Unsafe bundle path')
        path=bundle/name
        if path.is_symlink() or path.stat().st_size!=row['bytes'] or sha(path)!=row['sha256']:raise ValueError('Frozen bundle changed: '+name)
        expected.add(name)
    if {str(p.relative_to(bundle)) for p in bundle.rglob('*') if p.is_file()}!=expected:raise ValueError('Unexpected bundle contents')


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--bundle-root',type=Path,required=True);parser.add_argument('--python',type=Path,required=True);parser.add_argument('--mm-python',type=Path,required=True);parser.add_argument('--pilot-report',type=Path,required=True);parser.add_argument('--pilot-sha256',required=True);parser.add_argument('--output-parent',type=Path,default=Path('/workspace'));parser.add_argument('--workers',type=int,choices=[1,2],default=2);parser.add_argument('--max-wall-seconds',type=int,default=3600);parser.add_argument('--per-job-seconds',type=int,default=900);args=parser.parse_args()
    if not(60<=args.max_wall_seconds<=10800 and 60<=args.per_job_seconds<=3600):parser.error('Unsupported explicit resource bounds')
    bundle=args.bundle_root.resolve();verify_bundle(bundle)
    if sha(args.pilot_report)!=args.pilot_sha256:raise ValueError('Pilot report hash mismatch')
    pilot=json.loads(args.pilot_report.read_text())
    if pilot.get('status')!='passed_gpu_optimization_pilot' or pilot.get('passed') is not True or pilot.get('hardware_execution_verified') is not True or pilot.get('pilot_finite_difference',{}).get('passed') is not True or pilot.get('runner_sha256')!=sha(bundle/'gpu_heldout.py'):raise ValueError('Exact current worker has no accepted numerical pilot')
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+str(os.getpid());root=args.output_parent/('orvia-qm-heldouts-'+stamp);root.mkdir(parents=True,exist_ok=False);(root/'logs').mkdir();(root/'jobs').mkdir()
    status=dict(schema='orvia.six-native-gpu-heldout-jobs.v1',status='in_progress',passed=False,workers=args.workers,max_wall_seconds=args.max_wall_seconds,per_job_seconds=args.per_job_seconds,pilot_sha256=args.pilot_sha256,gate_sha256=sha(bundle/'gpu-gate.json'),worker_sha256=sha(bundle/'gpu_heldout.py'),launcher_sha256=sha(__file__),scientific_acceptance=False,production_ready=False,automatic_pod_shutdown=False,billing_cost=None,finished=[])
    pending=[f'heldout_{ep}_{angle:+04d}' for ep in ['A','B'] for angle in [30,90,150]];active={};started=time.monotonic()
    def save():
        status.update(elapsed_seconds=time.monotonic()-started,pending=pending.copy(),active={name:row['process'].pid for name,row in active.items()});temp=root/'status.tmp';temp.write_text(json.dumps(status,indent=2,allow_nan=False)+'\n');temp.replace(root/'status.json')
    def stop(row):
        p=row['process']
        if p.poll() is None:
            try:os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
                except Exception as error:status.setdefault('cleanup_errors',[]).append(type(error).__name__)
            except ProcessLookupError:pass
    def interrupt(signum,frame):raise InterruptedError('Interrupted by signal '+str(signum))
    signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
    try:
        (root/'input-manifest.json').write_bytes((bundle/'manifest.json').read_bytes());(root/'pilot.json').write_bytes(args.pilot_report.read_bytes());(root/'launcher-source.py').write_bytes(Path(__file__).read_bytes());save()
        while pending or active:
            if time.monotonic()-started>=args.max_wall_seconds:raise TimeoutError('Six-job session deadline reached')
            while pending and len(active)<args.workers:
                name=pending.pop(0);endpoint=name.split('_')[1];verify_bundle(bundle);log=(root/'logs'/(name+'.log')).open('xb')
                command=[str(args.python),str(bundle/'gpu_heldout.py'),'--job-input',str(bundle/'jobs'/(name+'.json')),'--policy',str(bundle/'quality_policy.json'),'--output-dir',str(root/'jobs'/name),'--mode','optimize','--max-seconds',str(max(1,args.per_job_seconds-20)),'--gate-report',str(bundle/'gpu-gate.json'),'--gate-sha256',status['gate_sha256'],'--pilot-report',str(args.pilot_report),'--pilot-sha256',args.pilot_sha256,'--mm-python',str(args.mm_python),'--mm-reference-script',str(bundle/'mm_reference.py'),'--system',str(bundle/'inputs'/endpoint/'system.xml')]
                p=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,env={**os.environ,'OMP_NUM_THREADS':'4','OPENBLAS_NUM_THREADS':'4','PYTHONUNBUFFERED':'1'});active[name]=dict(process=p,log=log,started=time.monotonic(),timeout=False);save()
            for name,row in list(active.items()):
                if row['process'].poll() is None and time.monotonic()-row['started']>=args.per_job_seconds:row['timeout']=True;stop(row)
                if row['process'].poll() is not None:
                    row['log'].close();path=root/'jobs'/name/'result.json';record=json.loads(path.read_text()) if path.exists() else {};status['finished'].append(dict(job=name,exitcode=row['process'].returncode,timed_out=row['timeout'],status=record.get('status','failed_before_record'),elapsed_seconds=time.monotonic()-row['started'],result_sha256=sha(path) if path.exists() else None));del active[name]
            save()
            if pending or active:time.sleep(.5)
        verify_bundle(bundle);status['passed']=len(status['finished'])==6 and all(r['exitcode']==0 and not r['timed_out'] and r['status']=='completed' for r in status['finished']);status['status']='completed_all_six' if status['passed'] else 'completed_attempts_with_failures'
    except Exception as error:status.update(status='interrupted_or_failed',error=dict(type=type(error).__name__,message=str(error)))
    finally:
        for name,row in active.items():stop(row);row['log'].close()
        active.clear();save();archive=args.output_parent/('orvia-qm-heldout-results-'+stamp+'.tar.gz')
        with tarfile.open(archive,'w:gz') as tar:tar.add(root,arcname='heldouts')
        digest=sha(archive);Path(str(archive)+'.sha256').write_text(digest+'  '+archive.name+'\n');print(json.dumps({'passed':status['passed'],'archive':str(archive),'sha256':digest,'automatic_pod_shutdown':False}),flush=True)
    return 0 if status['passed'] else 2


if __name__=='__main__':raise SystemExit(main())
