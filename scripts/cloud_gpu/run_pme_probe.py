#!/usr/bin/env python3
"""Bounded per-component probe of a previously verified repair bundle."""
import argparse, datetime, hashlib, json, os, signal, subprocess, tarfile, time
from pathlib import Path

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--bundle',type=Path,required=True)
    p.add_argument('--probe',type=Path,required=True)
    p.add_argument('--probe-sha256',required=True)
    p.add_argument('--python',type=Path,required=True)
    p.add_argument('--output-parent',type=Path,default=Path('/workspace'))
    a=p.parse_args(); start=time.monotonic()
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+str(os.getpid())
    root=a.output_parent/('orvia-pme-probe-'+stamp);root.mkdir(exist_ok=False)
    report={'schema':'orvia.pme-probe-launch.v1','completed':False,'scientificAcceptance':False,'automaticPodShutdown':False,'steps':[]}
    active=None
    def stop():
        if active is not None and active.poll() is None:
            try:
                os.killpg(active.pid,signal.SIGTERM);active.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(active.pid,signal.SIGKILL);active.wait(timeout=5)
            except ProcessLookupError: pass
    def interrupt(signum,frame):
        stop();raise InterruptedError('Interrupted '+str(signum))
    signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
    def save():
        (root/'status.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    try:
        assert hashlib.sha256(a.probe.read_bytes()).hexdigest()==a.probe_sha256,'Probe hash mismatch'
        manifest=json.loads((a.bundle/'manifest.json').read_text())
        for leg in ['complex33','solvent33']:
            paths=[a.bundle/'inputs'/leg/name for name in ['system.xml','positions.json']]
            for path in paths:
                declared=manifest['files'][str(path.relative_to(a.bundle))]
                payload=path.read_bytes()
                assert len(payload)==declared['bytes'] and hashlib.sha256(payload).hexdigest()==declared['sha256'],'Input hash mismatch'
            row={'leg':leg,'hardTimeoutSeconds':240};report['steps'].append(row);save();tick=time.monotonic()
            with (root/(leg+'.log')).open('wb') as log:
                active=subprocess.Popen([str(a.python),str(a.probe),'--system',str(paths[0]),'--positions',str(paths[1]),'--output',str(root/(leg+'.json')),'--align-grid','--max-wall-seconds','220'],stdout=log,stderr=subprocess.STDOUT,start_new_session=True,env={**os.environ,'PYTHONUNBUFFERED':'1'})
                try: row['exitCode']=active.wait(timeout=240)
                except subprocess.TimeoutExpired: stop();row['exitCode']=124
                finally: active=None
            row['elapsedSeconds']=time.monotonic()-tick;save()
        report['completed']=all(row['exitCode']==0 for row in report['steps'])
    except Exception as error: report['error']={'type':type(error).__name__,'message':str(error)}
    finally:
        stop();report['elapsedSeconds']=time.monotonic()-start;save()
        archive=a.output_parent/('orvia-pme-results-'+stamp+'.tar.gz')
        with tarfile.open(archive,'w:gz') as t:
            for item in root.iterdir(): t.add(item,arcname=item.name)
        digest=hashlib.sha256(archive.read_bytes()).hexdigest()
        Path(str(archive)+'.sha256').write_text(digest+'  '+archive.name+'\n')
        print(json.dumps({'archive':str(archive),'sha256':digest,'completed':report['completed'],'automaticPodShutdown':False}),flush=True)
    return 0 if report['completed'] else 2

if __name__=='__main__':raise SystemExit(main())
