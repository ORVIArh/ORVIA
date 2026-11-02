#!/usr/bin/env python3
"""Run the fresh frozen CPU campaign with at most two supervised workers.

The initial reproduction manifest and completed baseline remain unchanged.
This additive supervisor records its own hash and never retries failed results.
"""
import argparse
import datetime
import fcntl
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--quantum-python',type=Path,required=True)
    parser.add_argument('--preparation-python',type=Path,required=True)
    parser.add_argument('--workers',type=int,choices=[1,2],default=2)
    parser.add_argument('--max-wall-seconds',type=int,default=21600)
    parser.add_argument('--per-job-seconds',type=int,default=7200)
    parser.add_argument('--max-total-rss-mib',type=int,default=12288)
    args=parser.parse_args()
    if not(1<=args.max_wall_seconds<=43200 and 1<=args.per_job_seconds<=7200 and 1024<=args.max_total_rss_mib<=16384):parser.error('Invalid bounded resource limits')
    root=args.root.resolve();spec=importlib.util.spec_from_file_location('frozen_supervisor',root/'scripts/quantum_corrected/reproduce.py');helpers=importlib.util.module_from_spec(spec);spec.loader.exec_module(helpers)
    helpers.verify(root)
    out=root/'data/prepared_candidate/quantum';policy=helpers.read(out/'quality_policy.json')
    if helpers.read(out/'jobs/fragment_baseline/result.json').get('status')!='completed':raise RuntimeError('Fresh baseline must complete first')
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+str(os.getpid())
    session=root/'sessions'/stamp;session.mkdir(parents=True)
    (session/'supervisor_source.py').write_bytes(Path(__file__).read_bytes())
    status=dict(schema='orvia.corrected-qm-parallel-session.v1',status='in_progress',source_sha256=helpers.sha(__file__),workers=args.workers,pyscf_threads_per_worker=policy['quantum']['threads'],max_wall_seconds=args.max_wall_seconds,per_job_seconds=args.per_job_seconds,max_total_rss_bytes=args.max_total_rss_mib*1024**2,peak_sampled_total_rss_bytes=0,active={},finished=[],pending=[],scientific_acceptance=False,production_ready=False)
    start=time.monotonic();active={};pending=[]
    def save():
        status['elapsed_seconds']=time.monotonic()-start;status['pending']=pending.copy();status['active']={name:row['process'].pid for name,row in active.items()};helpers.save(session/'status.json',status);helpers.save(root/'parallel-progress.json',status)
    def abort(name,reason):
        row=active[name];helpers.terminate(row['process'])
        path=out/'jobs'/name/'result.json';result=helpers.read(path) if path.exists() else dict(job=name,policy_sha256=helpers.POLICY_SHA)
        result.update(status=reason,supervisor_source_sha256=status['source_sha256'],scientific_acceptance=False,production_ready=False);helpers.save(path,result)
    def interrupt(signum,frame):raise InterruptedError('Interrupted by signal '+str(signum))
    signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
    with (root/'.run.lock').open('a+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        try:
            for name in helpers.jobs(policy)[1:]:
                path=out/'jobs'/name/'result.json'
                if path.exists():
                    result=helpers.read(path)
                    if result.get('policy_sha256')!=helpers.POLICY_SHA:raise ValueError('Existing result policy mismatch')
                    status['finished'].append(dict(job=name,retained_status=result['status']))
                else:pending.append(name)
            while pending or active:
                if time.monotonic()-start>=args.max_wall_seconds:
                    for name in list(active):abort(name,'failed_session_timeout')
                    status['status']='bounded_incomplete';break
                ready=[]
                for name in pending:
                    if name.startswith('sensitivity_'):
                        dependency=out/'jobs'/('fragment_aryl_'+name.split('_')[-1])/'result.json'
                        if not dependency.exists() or helpers.read(dependency).get('status')!='completed':continue
                    ready.append(name)
                while ready and len(active)<args.workers:
                    name=ready.pop(0);pending.remove(name);helpers.verify(root)
                    directory=out/'jobs'/name;directory.mkdir(exist_ok=True);descriptor=directory/'input.json'
                    subprocess.run([str(args.preparation_python),str(root/'scripts/quantum_corrected/geometry.py'),'--root',str(root),'--job',name,'--output',str(descriptor)],check=True,timeout=30,capture_output=True)
                    log=(session/(name+'.log')).open('xb')
                    env={**os.environ,'OMP_NUM_THREADS':str(policy['quantum']['threads']),'OPENBLAS_NUM_THREADS':str(policy['quantum']['threads']),'VECLIB_MAXIMUM_THREADS':str(policy['quantum']['threads']),'PYTHONUNBUFFERED':'1'}
                    process=subprocess.Popen([str(args.quantum_python),str(root/'scripts/quantum_corrected/worker.py'),'--root',str(root),'--input',str(descriptor),'--preparation-python',str(args.preparation_python)],stdout=log,stderr=subprocess.STDOUT,start_new_session=True,env=env)
                    active[name]=dict(process=process,log=log,start=time.monotonic());save()
                total=0
                for name,row in list(active.items()):
                    if row['process'].poll() is None:
                        total+=helpers.rss_tree(row['process'].pid)
                        if time.monotonic()-row['start']>=args.per_job_seconds:abort(name,'failed_job_timeout')
                    if row['process'].poll() is not None:
                        row['log'].close();path=out/'jobs'/name/'result.json'
                        result=helpers.read(path) if path.exists() else dict(job=name,policy_sha256=helpers.POLICY_SHA,status='failed_before_record',scientific_acceptance=False,production_ready=False)
                        if result.get('status')=='in_progress':result['status']='failed_worker_exit'
                        helpers.save(path,result);status['finished'].append(dict(job=name,status=result['status'],exitcode=row['process'].returncode,elapsed_seconds=time.monotonic()-row['start']));del active[name]
                status['peak_sampled_total_rss_bytes']=max(total,status['peak_sampled_total_rss_bytes'])
                if total>args.max_total_rss_mib*1024**2 and active:
                    abort(next(reversed(active)),'failed_total_memory_limit')
                if pending and not active and not ready:
                    status['status']='blocked_by_failed_dependencies';break
                save()
                if pending or active:time.sleep(1)
            if status['status']=='in_progress':status['status']='finished_attempts'
        except Exception as error:
            status.update(status='interrupted_or_failed',error=dict(type=type(error).__name__,message=str(error)))
        finally:
            for name,row in list(active.items()):
                if row['process'].poll() is None:abort(name,'interrupted_by_supervisor')
                row['log'].close()
            active.clear();helpers.verify(root);save()
    print(str(session/'status.json'),flush=True)
    return 0 if status['status']=='finished_attempts' else 2


if __name__=='__main__':raise SystemExit(main())
