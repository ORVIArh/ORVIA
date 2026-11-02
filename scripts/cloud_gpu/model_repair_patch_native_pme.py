#!/usr/bin/env python3
"""Experimental pinned-source native CUDA-double PME parameter preservation.
Narrow validation build: reject non-PME, non-double, CPU PME and parameter offsets.
This changes storage precision, not user Force parameters or physical equations.
"""
from pathlib import Path
import argparse,hashlib,json,re,subprocess,difflib
if not __debug__:
 raise RuntimeError('Optimized Python is forbidden: source integrity checks must execute')
PIN='b399af4725573963b46d6c1083fdcf7a37615857'
FILES=['platforms/common/src/CommonCalcNonbondedForce.cpp','platforms/common/src/kernels/nonbondedParameters.cc','platforms/common/src/kernels/nonbondedExceptions.cc','platforms/common/src/kernels/pmeExclusions.cc']
KNOWN={'platforms/common/src/CommonCalcNonbondedForce.cpp': '357440902c36ed131da64cdea5de3a41c1b7b589022984e7d52fe98e191f4d4d', 'platforms/common/src/kernels/nonbondedParameters.cc': '742b72c4ddfb18d622fe625e69d1f54b9e4aa172460da4472ca3a931945aedda', 'platforms/common/src/kernels/nonbondedExceptions.cc': 'da501112bb905a8190408a65b460918cdf1580a98ea7a326586ff49b53472d0c'}
def sha(b):return hashlib.sha256(b).hexdigest()
def change_once(text,old,new):
 if text.count(old)!=1:raise ValueError('Expected one source anchor: '+old[:100])
 return text.replace(old,new,1)
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,required=True);p.add_argument('--report',type=Path,required=True);p.add_argument('--fixture-source',action='store_true',help='Only test replacements against archived source files; never build from this incomplete tree');a=p.parse_args();root=a.source.resolve();report={'schema':'orvia.experimental-native-double-pme-source-patch.v1','upstreamCommit':PIN,'sourceRoot':str(root),'passedPatchApplication':False,'buildVerified':False,'runtimeNumericalVerified':False,'scientificAcceptance':False,'files':{},'limits':['CUDA/OpenCL common backend use is limited to double nativePME with GPU PME, no global/particle/exception offsets.','Single/mixed/native nonPME initializations reject explicitly in this validation build.','CPU Reference backend source is not patched.','Any build must preserve upstream LICENSE and allcopyright headers.']}
 a.report.parent.mkdir(parents=True,exist_ok=True)
 if a.report.exists():raise FileExistsError(a.report)
 a.report.write_text(json.dumps(report,indent=2)+'\n')
 if not a.fixture_source:
  head=subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip();assert head==PIN
  assert not subprocess.check_output(['git','-C',str(root),'status','--porcelain'],text=True).strip(),'Source checkout must be clean'
 for rel in FILES:
  target=root/rel
  if not target.exists():
   if a.fixture_source and rel.endswith('pmeExclusions.cc'):report['missingArchivedKernel']=rel;continue
   raise FileNotFoundError(target)
  old=target.read_text();new=old
  if rel in KNOWN:assert sha(old.encode())==KNOWN[rel], 'Pinned upstream source hash mismatch: '+rel
  if rel.endswith('CommonCalcNonbondedForce.cpp'):
   marker='''    this->usePmeQueue = false;'''
   guard='''    // ORVIA_EXACT_NATIVE_DOUBLE_PME_v1: intentionally narrow validation build.
    if (!cc.getUseDoublePrecision() || deviceIsCpu || useCpuPme ||
            force.getNonbondedMethod() != NonbondedForce::PME ||
            force.getNumGlobalParameters() != 0 || force.getNumParticleParameterOffsets() != 0 ||
            force.getNumExceptionParameterOffsets() != 0)
        throw OpenMMException("ORVIA exact-native-PME build requires GPU double PME and no parameter offsets");
'''
   new=change_once(new,marker,guard+marker)
   # PmeIO abovecommonInitialize remains unchanged and is rejected by the guard.
   cut=new.index('void CommonCalcNonbondedForceKernel::commonInitialize(');prefix=new[:cut];tail=new[cut:]
   assert 'baseParticleParamVec' in tail and 'baseExceptionParamsVec' in tail
   tail=tail.replace('mm_float4','mm_double4').replace('mm_float2','mm_double2')
   tail=tail.replace('addArgument(exclusionParams, "float4")','addArgument(exclusionParams, "double4")')
   tail=tail.replace('addArgument(exceptionParams, "float4")','addArgument(exceptionParams, "double4")')
   tail=change_once(tail,'ComputeParameterInfo(sigmaEpsilon, prefix+"sigmaEpsilon", "float", 2)','ComputeParameterInfo(sigmaEpsilon, prefix+"sigmaEpsilon", "double", 2)')
   assert 'baseParticleParams.initialize<mm_double4>'in tail and 'sigmaEpsilon.initialize<mm_double2>'in tail
   # Parameter updates remain source-preserving, but reject adding unsupported offsets.
   token='void CommonCalcNonbondedForceKernel::copyParametersToContext('
   pos=tail.index(token);brace=tail.index('{',pos)
   update='''
    if (!cc.getUseDoublePrecision() || force.getNonbondedMethod() != NonbondedForce::PME ||
            force.getNumGlobalParameters() != 0 || force.getNumParticleParameterOffsets() != 0 ||
            force.getNumExceptionParameterOffsets() != 0)
        throw OpenMMException("ORVIA exact-native-PME update requires unchanged supported parameter policy");
'''
   tail=tail[:brace+1]+update+tail[brace+1:];new=prefix+tail
  else:
   assert 'float4' in old
   new=re.sub(r'\bfloat4\b','real4',new);new=re.sub(r'\bfloat2\b','real2',new)
   new=new.replace('make_float4','make_real4').replace('make_float2','make_real2')
   new=re.sub(r'\(float\)','(real)',new)
   if rel.endswith('nonbondedParameters.cc'):
    new=re.sub(r'\bfloat sigma\b','real sigma',new);new=re.sub(r'\bfloat epsilon\b','real epsilon',new)
   assert 'float4'not in new and 'float2'not in new
  assert new!=old
  target.write_text(new);report['files'][rel]={'upstreamSha256':sha(old.encode()),'patchedSha256':sha(new.encode()),'originalBytes':len(old.encode()),'patchedBytes':len(new.encode())}
  a.report.write_text(json.dumps(report,indent=2)+'\n')
  diff=''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+rel,tofile='b/'+rel));(a.report.parent/(target.name+'.patch')).write_text(diff)
 report['passedPatchApplication']=True;report['fixtureOnly']=a.fixture_source;a.report.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
if __name__=='__main__':main()
