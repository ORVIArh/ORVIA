#!/usr/bin/env python3
"""Portable path adapter for frozen static preparation/component evidence.

No signer, network call, optimizer or integrator step. Frozen source files remain
unchanged; generated path-adapted copies and every replay live in --output.
"""
from pathlib import Path
import argparse,datetime,hashlib,inspect,json,platform,shutil,subprocess,sys,traceback

HERE=Path(__file__).resolve().parent
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def load(path):return json.loads(Path(path).read_text())
def save(path,obj):Path(path).write_text(json.dumps(obj,indent=2)+'\n')
def literal(path):return 'Path('+repr(str(path))+')'
def adapt(name,destination,replacements,records):
 source=HERE/'sources'/name;text=source.read_text()
 for old,new in replacements:
  if text.count(old)!=1:raise ValueError('Frozen path initializer missing/ambiguous:'+name+':'+old)
  text=text.replace(old,new,1)
 destination.parent.mkdir(parents=True,exist_ok=True);destination.write_text(text)
 records.append({'source':name,'originalSha256':sha(source),'adaptedPath':str(destination),'adaptedSha256':sha(destination),'scope':'Path initializers only; numerical functions/criteria unchanged'})
 return destination

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source-root',type=Path,help='Science directory containing data/prepared_candidate (or archive scientific-inputs directory).')
 p.add_argument('--output',type=Path,required=True);p.add_argument('--stage',choices=['all','assemble','verify','bonded','preserve','lrc','c4'],default='all');p.add_argument('--check-inputs',action='store_true');args=p.parse_args()
 output=args.output.resolve();science=args.source_root.resolve()if args.source_root else None
 if not science and(args.stage!='lrc'or args.check_inputs):p.error('--source-root is required for this stage')
 if science and(output==science or output.is_relative_to(science)):p.error('--output must be outside the frozen source directory')
 marker=output/'.orvia-full-hybrid-replay.json'
 if output.exists()and any(output.iterdir())and not marker.exists():p.error('--output must be empty or an existing replay directory')
 output.mkdir(parents=True,exist_ok=True)
 if marker.exists():
  previous=load(marker)
  if previous['scienceRoot']!=(str(science)if science else None):p.error('Existing replay source differs; choose a new output directory')
 else:save(marker,{'schema':'orvia.full-hybrid-portable-replay-root.v1','scienceRoot':str(science)if science else None})
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');history=output/'replay-history';history.mkdir(exist_ok=True)
 record={'schema':'orvia.full-hybrid-portable-replay.v1','status':'in_progress','stage':args.stage,'checkInputsOnly':args.check_inputs,'adapterSha256':sha(Path(__file__)),'originalSourceBundle':str(HERE),'adaptations':[],'checks':[],'executed':[],'scientificAcceptance':False,'fullHamiltonianValidated':False,'trajectoryPerformed':False,'mainnetTransactionsSent':0}
 manifest=history/(stamp+'.json');save(manifest,record)
 try:
  workspace=output/'.workspace';link=workspace/'work/scientific-preparation';link.parent.mkdir(parents=True,exist_ok=True)
  if science:
   if link.exists():assert link.is_symlink()and link.resolve()==science
   else:link.symlink_to(science,target_is_directory=True)
   inputs=load(HERE/'inputs/source-input-manifest.json');record['inputManifestSha256']=sha(HERE/'inputs/source-input-manifest.json')
   for item in inputs['files']:
    source=science/item['path'];assert source.is_file()and sha(source)==item['sha256']and source.stat().st_size==item['bytes'],str(source)
   record['checks'].append({'requiredFrozenInputFiles':len(inputs['files']),'allBytesAndHashesMatch':True})
  stages=['assemble','verify','bonded','preserve','lrc','c4']if args.stage=='all'else[args.stage]
  if not args.check_inputs and any(s in stages for s in ['assemble','bonded','preserve','lrc','c4']):
   import openmm as mm
   from openmm import version
   from openmm.app.internal import amber_file_parser
   expected=load(HERE/'policies/c4-reference-policy.json')['runtime']
   assert version.full_version==expected['full_version']and version.git_revision==expected['git_revision'],'Exact observed OpenMM dev revision required'
   assert sha(inspect.getsourcefile(amber_file_parser))==sha(HERE/'sources/amber_file_parser.py'),'Native importer source differs'
   record['runtime']={'fullVersion':version.full_version,'gitRevision':version.git_revision,'release':version.release,'python':sys.version,'machine':platform.machine(),'nativeImporterSha256':sha(inspect.getsourcefile(amber_file_parser))}
  scripts=output/'replay-scripts';scripts.mkdir(exist_ok=True);independent=output/'independent-validation';independent.mkdir(exist_ok=True);c4=output/'c4-endpoint';c4.mkdir(exist_ok=True);lrc=c4/'independent-lrc';lrc.mkdir(exist_ok=True)
  mapping={}
  mapping['assemble']=adapt('assemble_full_hybrid.py',scripts/'assemble_full_hybrid.py',[("OUT=Path(__file__).resolve().parent",'OUT='+literal(output)),('ROOT=OUT.parents[1]','ROOT='+literal(workspace))],record['adaptations'])
  mapping['verify']=adapt('verify_streams.py',scripts/'verify_streams.py',[("BASE=Path(__file__).resolve().parent",'BASE='+literal(output)),('ROOT=BASE.parents[1]','ROOT='+literal(workspace))],record['adaptations'])
  old_science="/Users/abhijith/Documents/ChatGPT/AURA/work/scientific-preparation"
  mapping['bonded']=adapt('validate_native_b_bonded.py',scripts/'validate_native_b_bonded.py',[("OUT = Path(__file__).resolve().parent",'OUT = '+literal(independent)),("SCIENCE = Path('"+old_science+"')",'SCIENCE = '+literal(link))],record['adaptations'])
  mapping['preserve']=adapt('audit_preservation.py',scripts/'audit_preservation.py',[("OUT=Path(__file__).resolve().parent;PACKAGE=OUT.parent",'OUT='+literal(independent)+';PACKAGE=OUT.parent'),("BASE=Path('"+old_science+"/data/prepared_candidate')",'BASE='+literal(link/'data/prepared_candidate'))],record['adaptations'])
  mapping['c4']=adapt('validate_native_endpoints.py',scripts/'validate_native_endpoints.py',[("HERE=Path(__file__).resolve().parent",'HERE='+literal(c4)),('ROOT=ASSEMBLY.parents[1]','ROOT='+literal(workspace))],record['adaptations'])
  mapping['lrc']=adapt('run_reference_fixtures.py',lrc/'run_reference_fixtures.py',[("OUT=Path(__file__).resolve().parent",'OUT='+literal(lrc))],record['adaptations'])
  shutil.copyfile(HERE/'sources/analytic_c4.py',lrc/'analytic_c4.py');shutil.copyfile(HERE/'policies/c4-reference-fixtures.json',lrc/'fixtures.json')
  bonded=load(HERE/'policies/bonded-validation-policy.json');bonded['frozen_source_sha256']={str(link/Path(key).relative_to(old_science)):value for key,value in bonded['frozen_source_sha256'].items()};save(independent/'bonded-validation-policy.json',bonded)
  tail=load(HERE/'policies/c4-reference-policy.json');tail['fixtures']['path']=str(lrc/'fixtures.json');tail['analytic_module']['path']=str(lrc/'analytic_c4.py')
  for item in tail['pinned_sources'].values():
   name=Path(item['path']).name;shutil.copyfile(HERE/'sources'/name,lrc/name);item['path']=str(lrc/name)
  if not args.check_inputs and'lrc'in stages:
   import openmm._openmm as binding
   import openmm.openmm as api
   prefix=Path(sys.executable).resolve().parents[1];libraries=[x for x in(prefix/'lib').glob('libOpenMM.*')if x.is_file()]
   assert libraries,'OpenMM core library not located'
   current=[Path(binding.__file__),Path(api.__file__),libraries[0]]
   original_hashes=sorted(v['sha256']for v in tail['runtime']['binaries'].values())
   tail['runtime']['binaries']={str(x):{'bytes':x.stat().st_size,'sha256':sha(x)}for x in current}
   tail['runtime']['python']=platform.python_version();tail['runtime']['machine']=platform.machine()
   record['historicalRuntimeBinariesExactMatch']=original_hashes==sorted(sha(x)for x in current)
  save(lrc/'policy.json',tail);record['rebasedPolicies']={'bondedSha256':sha(independent/'bonded-validation-policy.json'),'lrcSha256':sha(lrc/'policy.json'),'criteria':'Numeric limits unchanged; filesystem/runtime provenance rebased before any energy query'}
  for item in record['adaptations']:
   compile(Path(item['adaptedPath']).read_text(),item['adaptedPath'],'exec')
  record['checks'].append({'adaptedScriptsSyntaxParsed':len(record['adaptations'])});save(manifest,record)
  if args.check_inputs:record['status']='passed_input_paths_and_adapter_syntax_only'
  else:
   for stage in stages:
    if stage=='assemble'and(output/'legs').exists():raise ValueError('Existing assembly retained; choose a fresh --output for another assembly')
    if stage=='verify'and(output/'stream-verification.json').exists():shutil.copyfile(output/'stream-verification.json',history/(stamp+'-prior-stream-verification.json'))
    log=history/(stamp+'-'+stage+'.log')
    with log.open('w')as target:result=subprocess.run([sys.executable,str(mapping[stage])],cwd=output,stdout=target,stderr=subprocess.STDOUT)
    record['executed'].append({'stage':stage,'exitCode':result.returncode,'log':str(log),'logSha256':sha(log)});save(manifest,record)
    if result.returncode:raise RuntimeError(stage+' failed; see retained log '+str(log))
   record['status']='passed_requested_static_replay_stages'
 except Exception as error:record['status']='failed';record['failure']=str(error);record['traceback']=traceback.format_exc();raise
 finally:save(manifest,record)
 print(json.dumps({'status':record['status'],'manifest':str(manifest),'executedStages':[x['stage']for x in record['executed']],'scientificAcceptance':False}))

if __name__=='__main__':main()
