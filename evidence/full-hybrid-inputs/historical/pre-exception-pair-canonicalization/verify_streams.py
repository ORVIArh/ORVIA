#!/usr/bin/env python3
"""Independent raw-word shape/encoding checks against the owning catalog ABI."""
from pathlib import Path
import gzip,hashlib,json,math,traceback
import numpy as np

BASE=Path(__file__).resolve().parent
ROOT=BASE.parents[1]
WIDTH={'positions':3,'particles':4,'nonbonded':3,'bonds':4,'angles':5,'torsions':7,'exceptions':6}
INDICES={'positions':0,'particles':0,'nonbonded':0,'bonds':2,'angles':3,'torsions':5,'exceptions':3}
def sha(data):return hashlib.sha256(data).hexdigest()
def load(p):return json.loads(Path(p).read_bytes())
def finite(words):return np.all(((words[...,2]>>np.uint64(48))&np.uint64(0x7fff))!=0x7fff)
def positive(words):return np.all((words[...,2]>>np.uint64(63))==0)and np.all((words[...,2]|words[...,3])!=0)
def nonnegative(words):return np.all((words[...,2]>>np.uint64(63))==0)
report={'schema':'orvia.full-hybrid-raw-word-verification.v1','status':'in_progress','passed':False,'legs':{},'failures':[],'scientificAcceptance':False,'onChainRegistrationVerified':False,'scriptSha256':sha(Path(__file__).read_bytes())}
destination=BASE/'stream-verification.json'
def save():destination.write_text(json.dumps(report,indent=2)+'\n')
save()
try:
 for leg in ['complex33','solvent33']:
  manifest_path=BASE/'legs'/leg/'catalog-candidate.json';m=load(manifest_path);n=m['counts']['hybrid'];seen={};details=[];unique_words=0
  assert m['sourceHashesVerifiedAfterAssembly']and not m['scientificAcceptance']and not m['fullCompositionExecutable']
  for key,record in m['streams'].items():
   role=key.split('.')[-1];p=BASE/record['path'];compressed=p.read_bytes();assert sha(compressed)==record['gzipSha256'];raw=gzip.decompress(compressed)
   assert len(raw)==record['rawBytes']==record['wordCount']*32 and sha(raw)==record['rawSha256']
   assert '0x'+sha(b'ORVIA-FULL-HYBRID-STREAM-v1\0'+role.encode()+b'\0'+raw)==record['proposedStreamId']
   if record.get('aliasOf'):
    assert record['aliasOf']in seen and seen[record['aliasOf']]==raw,'Alias requires exact bytes'
   else:unique_words+=record['wordCount']
   seen[key]=raw
   width=WIDTH[role];assert record['wordCount']%width==0
   words=np.frombuffer(raw,dtype='>u8').astype(np.uint64).reshape(-1,width,4);count=len(words);k=INDICES[role]
   assert not np.any(words[:,:,0:2])and finite(words),'Upper128bits/finite scalar encoding'
   if k:
    assert not np.any(words[:,:k,:3]);idx=words[:,:k,3]
    atom_fields=4 if role=='torsions'else 2 if role=='exceptions'else k
    assert np.all(idx[:,:atom_fields]<n)
    for a in range(atom_fields):
     for b in range(a):assert np.all(idx[:,a]!=idx[:,b])
   if role=='positions':assert count==n
   elif role=='particles':assert count==n and positive(words[:,0])
   elif role=='nonbonded':assert count==n and positive(words[:,0])and nonnegative(words[:,1])
   elif role=='bonds':assert count==m['counts']['bonds']and nonnegative(words[:,2])and nonnegative(words[:,3])
   elif role=='angles':
    assert count==m['counts']['angles']and nonnegative(words[:,3])and nonnegative(words[:,4])
    pi_hi=np.uint64(0x4000921fb54442d1);pi_lo=np.uint64(0x8469898cc51701b8)
    assert np.all((words[:,4,2]<pi_hi)|((words[:,4,2]==pi_hi)&(words[:,4,3]<=pi_lo)))
   elif role=='torsions':assert count==m['counts']['torsions']and np.all((idx[:,4]>=1)&(idx[:,4]<=64))and nonnegative(words[:,5])
   elif role=='exceptions':
    assert count==m['counts']['exceptions'];a,b,kind=idx.T;assert np.all(a<b)and np.all((kind==1)|(kind==2));keys=a*np.uint64(n)+b;assert np.all(keys[1:]>keys[:-1])
    excluded=kind==1;direct=kind==2;assert not np.any(words[excluded,3:,:]);assert positive(words[direct,3])and nonnegative(words[direct,4])
   details.append({'role':key,'records':count,'words':record['wordCount'],'rawSha256':record['rawSha256'],'passed':True})
  assert seen['A.particles']==seen['B.particles']
  sources=0
  for item in m['sourceFiles']:assert sha((ROOT/item['path']).read_bytes())==item['sha256'];sources+=1
  for key in ['globalMap','nativeRecordProvenance','mandatoryConstraints','mandatoryC4','normalizations']:
   item=m[key];data=(BASE/item['path']).read_bytes();assert sha(data)==item['sha256'];assert sha(gzip.decompress(data))==item['uncompressedSha256']
  for item in m['parameters'].values():
   data=(BASE/item['path']).read_bytes();assert sha(data)==item['sha256']and sha(gzip.decompress(data))==item['uncompressedSha256']
  model=(manifest_path.parent/'model-policy.json').read_bytes();assert '0x'+sha(model)==m['definition']['modelPolicy']
  report['legs'][leg]={'passed':True,'manifestSha256':sha(manifest_path.read_bytes()),'uniqueWordCount':unique_words,'sourceFilesVerified':sources,'streams':details,'proposedProtocolFieldsUnselected':[k for k,v in m['definition'].items()if v is None]}
  save()
 report['status']='passed_raw_file_and_catalog_shape_checks';report['passed']=True
except Exception as e:report['status']='failed';report['failures'].append({'message':str(e),'traceback':traceback.format_exc()});raise
finally:save()
print(json.dumps({'status':report['status'],'uniqueWords':sum(x['uniqueWordCount']for x in report['legs'].values()),'reportSha256':sha(destination.read_bytes())}))
