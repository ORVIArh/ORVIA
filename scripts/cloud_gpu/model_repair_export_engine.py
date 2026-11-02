#!/usr/bin/env python3
"""Archive only an isolated successful engine's runtime and reproducible source evidence.
No cloud API, credentials, full compiler tree, or user environment is collected.
"""
from pathlib import Path
import argparse,datetime,gzip,hashlib,io,json,os,platform,re,subprocess,tarfile,sys
if not __debug__:raise RuntimeError('Optimized Python forbidden for artifact integrity')
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb')as f:
  while b:=f.read(4*1024*1024):h.update(b)
 return h.hexdigest()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--build-report',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--patch-script',type=Path,required=True);p.add_argument('--build-script',type=Path,required=True);p.add_argument('--failed-attempt',type=Path,action='append',default=[]);a=p.parse_args();root=a.build_report.resolve().parent;report=json.loads(a.build_report.read_text())
 if report.get('buildPassed')is not True:raise ValueError('Successful source build required')
 if a.output.exists()or Path(str(a.output)+'.sha256').exists():raise FileExistsError('Refusing existing archive')
 payload={};manifest={};external_allowed={a.patch_script.resolve(),a.build_script.resolve(),Path(__file__).resolve()}
 def add(f,rel,check=None):
  f=Path(f);resolved=f.resolve()
  if resolved not in external_allowed and not resolved.is_relative_to(root)and not any(resolved.is_relative_to(x.resolve())for x in a.failed_attempt):raise ValueError('Unexpected external artifact path: '+str(f))
  if rel in payload:raise ValueError('Duplicate archive path')
  if not f.is_file():raise FileNotFoundError(f)
  size=f.stat().st_size;digest=sha(f)
  if check and digest!=check:raise ValueError('Frozen artifact changed: '+rel)
  if f.suffix in['.json','.txt','.log','.patch','.py','.cpp','.cc','.h','.yaml']:
   text=f.read_text(errors='replace')
   if re.search(r'(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}|Authorization\s*:\s*Bearer\s+\S+|https?://[^\s/:@]+:[^\s/@]+@',text):raise ValueError('Potential credential in text artifact; refusing archive: '+rel)
  payload[rel]=f;manifest[rel]={'bytes':size,'sha256':digest}
 add(a.patch_script,'tooling/model_repair_patch_native_pme.py',report['sourcePatchScriptSha256'])
 add(a.build_script,'tooling/model_repair_build_openmm.py',report['buildScriptSha256'])
 add(Path(__file__),'tooling/model_repair_export_engine.py')
 for rel,record in report['artifacts'].items():add(root/rel,'runtime/'+rel,record['sha256'])
 venv=Path(report['python']).parent.parent
 sites=list((venv/'lib').glob('python*/site-packages'));assert len(sites)==1
 site=sites[0];module=site/'openmm';assert module.is_dir()
 for f in sorted(module.rglob('*')):
  if f.is_file()and'__pycache__'not in f.parts and f.suffix!='.pyc':add(f,'python-site/openmm/'+str(f.relative_to(module)))
 for item in sorted(site.iterdir()):
  if item.is_dir()and 'openmm'in item.name.lower()and(item.name.endswith('.dist-info')or item.name.endswith('.egg-info')):
   for f in sorted(item.rglob('*')):
    if f.is_file():add(f,'python-site/'+str(f.relative_to(site)))
 for name in ['build-report.json','patch-report.json','requirements-freeze.txt']:
  f=root/name
  if f.exists():add(f,'evidence/'+name)
 patch=json.loads((root/'patch-report.json').read_text());assert patch['passedPatchApplication']and not patch.get('fixtureOnly')
 for rel,record in patch['files'].items():add(root/'source'/rel,'source-patched/'+rel,record['patchedSha256'])
 for f in sorted(root.glob('*.patch')):add(f,'source-patches/'+f.name)
 for f in sorted(root.glob('*command-*.log')):add(f,'build-logs/'+f.name)
 for f in sorted((root/'attempts').rglob('*'))if(root/'attempts').is_dir()else[]:
  if f.is_file()and f.suffix in['.json','.log','.txt','.patch']:add(f,'failed-attempts/'+str(f.relative_to(root/'attempts')))
 for index,attempt in enumerate(a.failed_attempt):
  for pattern in ['*report.json','*command-*.log','*.patch']:
   for f in sorted(attempt.glob(pattern)):
    if f.is_file():add(f,'earlier-build-'+str(index)+'/'+f.name)
 for f in sorted((root/'source').glob('LICENSE*')):
  if f.is_file():add(f,'upstream-license/'+f.name)
 for folder in ['licenses','LICENSES']:
  for f in sorted((root/'source'/folder).rglob('*'))if(root/'source'/folder).is_dir()else[]:
   if f.is_file():add(f,'upstream-license/'+folder+'/'+str(f.relative_to(root/'source'/folder)))
 for rel in ['build/CMakeCache.txt','build/install_manifest.txt','source/README.md']:
  f=root/rel
  if f.exists():add(f,'evidence/'+rel.replace('/','-'))
 if sum(v['bytes']for v in manifest.values())>2*1024**3:raise ValueError('Unexpected engine artifact size')
 metadata={'schema':'orvia.experimental-native-double-pme-engine-export.v1','files':manifest,'sourceBuildReportSha256':sha(a.build_report),'upstreamOrigin':report['upstreamOrigin'],'upstreamCommit':report['upstreamCommit'],'sourcePatchScriptSha256':report['sourcePatchScriptSha256'],'host':{'system':platform.system(),'machine':platform.machine(),'python':platform.python_version()},'scope':'Pinned experimental native-double PME runtime plus exact source patch/build evidence; no scientific acceptance or physical parameter rounding.','existingEnvironmentModified':False,'privateCredentialsCollected':False,'scientificAcceptance':False,'portability':'Linux x86_64/compatible CPython3.12 and NVIDIA CUDA driver/runtime only; no macOS portability claim. Old absolute prefixes in original reports are historical; relocation needs explicit new environment binding.','reuseRecipe':'Create new Linux CPython3.12 venv with frozen dependencies, place python-site on its import path or install wrappers properly; LD_LIBRARY_PATH=<extracted>/runtime/prefix/lib; OPENMM_PLUGIN_DIR=<extracted>/runtime/prefix/lib/plugins. Verify all hashes and produce a new explicit relocation binding before running matched validation.'}
 data=(json.dumps(metadata,indent=2)+'\n').encode();a.output.parent.mkdir(parents=True,exist_ok=True)
 with a.output.open('wb')as raw:
  with gzip.GzipFile(fileobj=raw,filename='',mode='wb',mtime=0,compresslevel=6)as gz:
   with tarfile.open(fileobj=gz,mode='w')as tar:
    for rel,f in sorted(payload.items()):
     assert sha(f)==manifest[rel]['sha256'];info=tarfile.TarInfo('orvia-native-double-pme-engine/'+rel);info.size=manifest[rel]['bytes'];info.mode=0o644;info.mtime=0
     with f.open('rb')as stream:tar.addfile(info,stream)
    info=tarfile.TarInfo('orvia-native-double-pme-engine/manifest.json');info.size=len(data);info.mode=0o644;info.mtime=0;tar.addfile(info,io.BytesIO(data))
 digest=sha(a.output);Path(str(a.output)+'.sha256').write_text(digest+'  '+a.output.name+'\n');print(json.dumps({'archive':str(a.output),'bytes':a.output.stat().st_size,'sha256':digest,'payloadFiles':len(payload)+1,'scientificAcceptance':False}))
if __name__=='__main__':main()
