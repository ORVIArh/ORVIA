#!/usr/bin/env python3
"""Separate bounded official-source build for experimental native double PME.
Must itself run under an external process-group watchdog (suggest900seconds).
Never changes an existing OpenMM environment or rounds physicalparameters.
"""
from pathlib import Path
import argparse,hashlib,json,os,shutil,subprocess,time,traceback,sys
from datetime import datetime,timezone
if not __debug__:
 raise RuntimeError('Optimized Python is forbidden: source integrity checks must execute')
PIN='b399af4725573963b46d6c1083fdcf7a37615857';ORIGIN='https://github.com/openmm/openmm.git'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
 os.environ.pop('PYTHONOPTIMIZE',None)
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output-root',type=Path,required=True);p.add_argument('--resume-configure',action='store_true',help='Reuse verified already-patched source/venv; preserve prior report/logs');p.add_argument('--patch-script',type=Path,default=Path(__file__).with_name('model_repair_patch_native_pme.py'));p.add_argument('--jobs',type=int,default=12);p.add_argument('--max-seconds',type=int,default=840);a=p.parse_args();out=a.output_root.resolve()
 stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
 prior_sha=None
 if out.exists():
  if not a.resume_configure:raise FileExistsError('Use a new separate build directory or explicit verified resume')
  prior=out/'build-report.json';prior_sha=sha(prior)
  history=out/'attempts'/stamp;history.mkdir(parents=True)
  shutil.copyfile(prior,history/'build-report.json')
  for log in out.glob('command-*.log'):shutil.copyfile(log,history/log.name)
  if (out/'patch-report.json').exists():shutil.copyfile(out/'patch-report.json',history/'patch-report.json')
 else:
  if a.resume_configure:raise FileNotFoundError('Resume output root does not exist')
  out.mkdir(parents=True)
 started=time.monotonic();report={'schema':'orvia.experimental-native-double-pme-isolated-build.v1','status':'in_progress','buildPassed':False,'numericalValidationPassed':False,'scientificAcceptance':False,'upstreamOrigin':ORIGIN,'upstreamCommit':PIN,'sourcePatchScriptSha256':sha(a.patch_script),'buildScriptSha256':sha(__file__),'commands':[],'existingEnvironmentModified':False,'resumeConfigure':a.resume_configure,'priorBuildReportSha256':prior_sha,'warning':'External process-group watchdog is mandatory; command deadlines alone may not kill compiler grandchildren.'};dest=out/'build-report.json'
 def save():dest.write_text(json.dumps(report,indent=2)+'\n')
 save()
 def run(argv,cwd=None,env=None):
  remaining=a.max_seconds-(time.monotonic()-started)
  if remaining<=0:raise TimeoutError('Build budget exhausted')
  record={'argv':list(map(str,argv)),'cwd':str(cwd)if cwd else None,'startedSeconds':time.monotonic()-started};report['commands'].append(record);save()
  with(out/(('resume-'+stamp+'-'if a.resume_configure else'')+'command-'+str(len(report['commands'])).zfill(2)+'.log')).open('wb')as log:
   r=subprocess.run(list(map(str,argv)),cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=remaining)
  record.update(exitCode=r.returncode,endedSeconds=time.monotonic()-started);save()
  if r.returncode:raise RuntimeError('Build command failed; see log: '+str(record['argv']))
 try:
  for tool in ['git','cmake','g++','swig']:
   report.setdefault('tools',{})[tool]=shutil.which(tool)
   if not shutil.which(tool):raise RuntimeError('Required build tool unavailable: '+tool)
  report['cudaHome']=os.environ.get('CUDA_HOME')or os.environ.get('CUDA_PATH')or'/usr/local/cuda'
  source=out/'source';python=out/'venv/bin/python'
  if not a.resume_configure:
   run([sys.executable,'-m','venv',out/'venv'])
   run([python,'-m','pip','install','numpy==2.5.4','setuptools','wheel','packaging','Cython'])
   run(['git','init',source]);run(['git','remote','add','origin',ORIGIN],source);run(['git','fetch','--depth=1','origin',PIN],source);run(['git','checkout','--detach','FETCH_HEAD'],source)
   assert subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()==PIN
   run([python,a.patch_script,'--source',source,'--report',out/'patch-report.json'])
  else:
   assert python.exists() and source.is_dir()
   assert subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()==PIN
   applied=json.loads((out/'patch-report.json').read_text());assert applied['passedPatchApplication']and not applied.get('fixtureOnly')
   for relative,record in applied['files'].items():assert sha(source/relative)==record['patchedSha256']
   changed=set(subprocess.check_output(['git','-C',str(source),'diff','--name-only'],text=True).splitlines())
   assert changed==set(applied['files']), 'Unreviewed source changes in resumed checkout'
  build=out/'build';prefix=out/'prefix';env=dict(os.environ);env['PATH']=str(out/'venv/bin')+os.pathsep+env.get('PATH','')
  options=['-DCMAKE_BUILD_TYPE=Release','-DCMAKE_INSTALL_PREFIX='+str(prefix),'-DPYTHON_EXECUTABLE='+str(python),'-DPython_EXECUTABLE='+str(python),'-DPython3_EXECUTABLE='+str(python),'-DOPENMM_BUILD_PYTHON_WRAPPERS=ON','-DOPENMM_BUILD_CUDA_LIB=ON','-DOPENMM_BUILD_OPENCL_LIB=OFF','-DOPENMM_BUILD_CPU_LIB=OFF','-DOPENMM_BUILD_AMOEBA_PLUGIN=ON','-DOPENMM_BUILD_DRUDE_PLUGIN=ON','-DOPENMM_BUILD_RPMD_PLUGIN=ON','-DOPENMM_BUILD_TESTS=OFF','-DOPENMM_BUILD_EXAMPLES=OFF']
  run(['cmake','-S',source,'-B',build,*options],env=env);run(['cmake','--build',build,'--parallel',a.jobs],env=env);run(['cmake','--install',build],env=env)
  env['LD_LIBRARY_PATH']=str(prefix/'lib')+os.pathsep+env.get('LD_LIBRARY_PATH','');env['OPENMM_PLUGIN_DIR']=str(prefix/'lib/plugins')
  run(['cmake','--build',build,'--target','PythonInstall','--parallel',a.jobs],env=env)
  smoke="import openmm,json;from pathlib import Path;p=[openmm.Platform.getPlatform(i).getName()for i in range(openmm.Platform.getNumPlatforms())];assert 'CUDA'in p and 'Reference'in p;print(json.dumps({'version':openmm.__version__,'platforms':p,'module':openmm.__file__}))"
  run([python,'-c',smoke],env=env)
  artifacts={str(f.relative_to(out)):{'bytes':f.stat().st_size,'sha256':sha(f)}for f in prefix.rglob('*')if f.is_file()and(f.suffix in['.so','.dll','.dylib']or'.so.'in f.name)}
  assert artifacts,'No installed shared libraries'
  report.update(status='built_experimental_engine_numerical_validation_required',buildPassed=True,python=str(python),libraryPrefix=str(prefix),pluginDirectory=str(prefix/'lib/plugins'),artifacts=artifacts,patchReportSha256=sha(out/'patch-report.json'),requiredRuntimeEnvironment={'LD_LIBRARY_PATH':str(prefix/'lib'),'OPENMM_PLUGIN_DIR':str(prefix/'lib/plugins')})
  with(out/'requirements-freeze.txt').open('w')as f:subprocess.run([str(python),'-m','pip','freeze'],env=env,stdout=f,check=True)
 except Exception as e:report.update(status='failed_or_incomplete',error={'message':str(e),'traceback':traceback.format_exc()});raise
 finally:report['elapsedSeconds']=time.monotonic()-started;save()
if __name__=='__main__':main()
