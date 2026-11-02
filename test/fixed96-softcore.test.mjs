import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import solc from 'solc';
import { AbiCoder, ContractFactory, keccak256, ZeroHash } from 'ethers';
import { environment, qvec, quadFromNumber as q } from './helpers.mjs';

// Captured from the actual atom-mapped GAFF2/AM1-BCC hybrid, not invented LJ parameters.
// The source model remains a research candidate, not an accepted production model.
const CAPTURED_HYBRID_SHA256 = '830e5a121243c038619e16455ce68b33239122537a2ad2d0c5efb40772c4e9c6';
const ACTUAL_PAIRS = [
  { pair:[0,10],d:[.31260000000000154,-.33890000000000003,.8563000000000001],a:[.33338320932972676,.4706901442331894],b:[.33338320932972676,.4706901442331894] },
  { pair:[2,18],d:[.3421999999999983,-.4166,.5609999999999999],a:[.3216144372011781,.49091765524718317],b:[.3216144372011781,.49091765524718317] },
  { pair:[10,41],d:[-.3948000000000018,.21550000000000002,-.8834],a:[.33338320932972676,0],b:[.33338320932972676,.4706901442331894] },
  { pair:[1,42],d:[-.18900000000000006,-.1819,-.05880000000000063],a:[.2957694654055748,0],b:[.2957694655030579,.09483569229080002] },
  { pair:[2,24],d:[-.18599999999999994,.15750000000000003,-.2032999999999996],a:[.2992172435326901,.09255250087862094],b:[.2992172435326901,.09255250087862094] },
  { pair:[0,3],d:[.17210000000000036,-.005399999999999988,.3121999999999998],a:[.33564609206634516,.21589845421361173],b:[.33564609206634516,.21589845421361173] }
];
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const INPUT_FILES = ['contracts/math/Fixed96Math.sol', 'contracts/kernels/Fixed96SoftcoreLennardJonesKernel.sol',
  'contracts/math/FloatMath.sol', 'contracts/math/vendor/ABDKMathQuad.sol', 'contracts/kernels/SoftcoreLennardJonesKernel.sol'];
const METER_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
interface ISoftcoreMeasured {
 struct Endpoint { bytes16 sigma; bytes16 epsilon; }
 struct Configuration { Endpoint a; Endpoint b; bytes16 lambda; bytes16 alpha; }
 function evaluate(bytes16[3] calldata d, Configuration calldata c) external view returns(bytes16,bytes16[3] memory,bytes16);
}
contract Fixed96SoftcoreGasMeter {
 ISoftcoreMeasured public immutable kernel;
 constructor(address target) { kernel=ISoftcoreMeasured(target); }
 event Measured(bytes32 digest,uint256[] callGas);
 function measure(uint256 count,bytes16[3] calldata d,ISoftcoreMeasured.Configuration calldata c) external {
  require(count<=8);bytes32 digest;uint256[] memory costs=new uint256[](count);
  for(uint256 i;i<count;++i){
   uint256 beforeGas=gasleft();
   (bytes16 e,bytes16[3] memory f,bytes16 dl)=kernel.evaluate(d,c);
   costs[i]=beforeGas-gasleft();
   digest=keccak256(abi.encode(digest,e,f,dl));
  }
  emit Measured(digest,costs);
 }
}`;

function compileIsolated() {
  const sources=Object.fromEntries(INPUT_FILES.map(name=>[name,{content:fs.readFileSync(name,'utf8')}]));
  sources['test/Fixed96SoftcoreGasMeter.sol']={content:METER_SOURCE};
  const settings={optimizer:{enabled:true,runs:200},evmVersion:'shanghai',
    outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}};
  const compiled=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources,settings})));
  assert.ok(!(compiled.errors||[]).some(e=>e.severity==='error'),JSON.stringify(compiled.errors));
  const artifacts={};
  for(const [file,contracts] of Object.entries(compiled.contracts))for(const [name,a] of Object.entries(contracts))
    artifacts[name]={...a,file};
  return {artifacts,settings,compiler:solc.version(),sourceSha256:Object.fromEntries(Object.entries(sources).map(([n,s])=>[n,sha256(s.content)]))};
}
const CASE = (name,d,a,b,lambda,alpha=.5)=>({name,d:qvec(d),a:qvec(a),b:qvec(b),lambda:q(lambda),alpha:q(alpha)});
const cfg = v => [v.a,v.b,v.lambda,v.alpha];
const outputWords = v => [v[0],...v[1],v[2]];

test('Fixed96 softcore: independent110-digit gradients, actual hybrid pairs, failure domains and measured binary128 comparison',async t=>{
  const compilation=compileIsolated();
  const env=await environment();t.after(()=>env.transport.disconnect());
  const deploy=async(name,args=[])=>{
    const a=compilation.artifacts[name];
    const c=await new ContractFactory(a.abi,'0x'+a.evm.bytecode.object,env.owner).deploy(...args);
    await c.waitForDeployment();return c;
  };
  const math=await deploy('FloatMath');
  const reference=await deploy('SoftcoreLennardJonesKernel',[await math.getAddress()]);
  const kernel=await deploy('Fixed96SoftcoreLennardJonesKernel');
  assert.notEqual(await kernel.IMPLEMENTATION_ID(),await reference.KERNEL_ID());
  const lambdas=[0,.125,.25,.5,.75,.875,1],cases=[];
  for(const [index,d,a,b] of [
    [0,[.75,.125,-.25],[.35,.3],[.5,.25]],
    [1,[.375,-.125,.0625],[.35,.45],[.32,.85]],
    [2,[1.25,.25,-.5],[.75,.5],[1,.25]]
  ])for(const lambda of lambdas)cases.push(CASE(`synthetic-${index}-lambda-${lambda}`,d,a,b,lambda));
  for(const lambda of [.25,.5,.75])cases.push(CASE(`finite-overlap-${lambda}`,[0,0,0],[.75,.5],[1,.25],lambda));
  for(const p of ACTUAL_PAIRS)for(const lambda of lambdas)cases.push(CASE(`actual-hybrid-${p.pair.join('-')}-lambda-${lambda}`,p.d,p.a,p.b,lambda));
  cases.push(CASE('zero-strength-overlap-endpoint',[0,0,0],[1,0],[.33338320932972676,.4706901442331894],0));
  cases.push(CASE('both-zero-strength-overlap',[0,0,0],[1,0],[1,0],.5));
  for(const r of [0,.000001,.001])cases.push(CASE(`factored-actual-born-contact-${r}`,[r,0,0],ACTUAL_PAIRS[2].a,ACTUAL_PAIRS[2].b,.875));
  const captured=[];

  await t.test('all accepted energy,force and lambda derivatives match an independent physical scalar-energy oracle',async()=>{
    for(const v of cases){
      const fixed=await kernel.evaluate(v.d,cfg(v));
      const binary128=await reference.evaluate(v.d,cfg(v));
      captured.push({...v,fixed:outputWords(fixed),binary128:outputWords(binary128)});
    }
    const python=String.raw`
import json,sys,mpmath as mp
mp.mp.dps=110
def decode(h):
 b=int(h,16);e=(b>>112)&32767;f=b&((1<<112)-1)
 if e==32767:raise ValueError('nonfinite oracle input')
 v=mp.mpf(f if e==0 else (1<<112)+f)*mp.power(2,(-16382 if e==0 else e-16383)-112)
 return -v if b>>127 else v
records=[];max_abs=mp.mpf(0);strict_failures=[]
for c in json.load(sys.stdin):
 d=list(map(decode,c['d']));a=list(map(decode,c['a']));b=list(map(decode,c['b']));lam=decode(c['lambda']);alpha=decode(c['alpha'])
 def energy(v,l):
  radial=sum(x*x for x in v)**3
  def endpoint(p,soft):
   sigma,epsilon=p
   if epsilon==0:return mp.mpf(0)
   s6=sigma**6;rho=radial+alpha*s6*soft**2
   return 4*epsilon*((s6/rho)**2-s6/rho)
  return (1-l)*endpoint(a,l)+l*endpoint(b,1-l)
 expected=[energy(d,lam)]
 for axis in range(3):
  expected.append(mp.diff(lambda x:energy(d[:axis]+[x]+d[axis+1:],lam),d[axis]))
 expected.append(mp.diff(lambda x:energy(d,x),lam))
 errors=[];reference_errors=[];strict=True
 for index,(h,ref,y) in enumerate(zip(c['fixed'],c['binary128'],expected)):
  err=abs(decode(h)-y);tol=mp.mpf('1e-18')+mp.mpf('1e-16')*abs(y)
  if err>tol:raise AssertionError((c['name'],index,str(err),str(tol),str(y)))
  reference_error=abs(decode(ref)-y)
  if reference_error>mp.mpf('1e-26')+mp.mpf('1e-25')*abs(y):raise AssertionError(('binary128-reference',c['name'],index,str(reference_error)))
  if err>mp.mpf('1e-20')+mp.mpf('1e-18')*abs(y):strict=False
  errors.append(mp.nstr(err,50));reference_errors.append(mp.nstr(reference_error,50));max_abs=max(max_abs,err)
 if not strict:strict_failures.append(c['name'])
 records.append({'name':c['name'],'fixedAbsoluteErrors':errors,'binary128ReferenceAbsoluteErrors':reference_errors,'stricterPairBudgetPassed':strict,'passed':True})
print(json.dumps({'reference':'Independent unfactored softcore scalar potential differentiated by mpmath1.3.0 at110digits',
 'absoluteTolerance':'1e-18','relativeTolerance':'1e-16','stricterPairAbsoluteTolerance':'1e-20','stricterPairRelativeTolerance':'1e-18',
 'maximumObservedAbsoluteError':mp.nstr(max_abs,60),'stricterPairBudgetFailures':strict_failures,'cases':records},indent=2))
`;
    const oracle=JSON.parse(execFileSync(process.env.ORVIA_RESEARCH_PYTHON||'python3',['-c',python],{input:JSON.stringify(captured),encoding:'utf8'}));
    fs.writeFileSync('reports/fixed96_softcore_validation.json',JSON.stringify({schemaVersion:1,
      scope:'Unswitched two-endpoint LJ component under an explicit NEW numerical policy; not full Ewald, full hybrid force field, ensemble or prepared cardiac-system acceptance.',
      policyId:await kernel.IMPLEMENTATION_ID(),compiler:compilation.compiler,compilerSettings:compilation.settings,sourceSha256:compilation.sourceSha256,
      actualHybridSourceSha256:CAPTURED_HYBRID_SHA256,actualHybridPairs:ACTUAL_PAIRS,...oracle},null,2)+'\n');
    assert.equal(oracle.cases.length,cases.length);
  });

  await t.test('endpoint symmetry and ghost sigma normalization preserve the exact declared zero-strength term',async()=>{
    const v=CASE('symmetry',[.375,-.125,.0625],[.35,.45],[.32,.85],.25);
    const a=await kernel.evaluate(v.d,cfg(v)),b=await kernel.evaluate(v.d,[v.b,v.a,q(.75),v.alpha]);
    assert.equal(a[0],b[0]);assert.deepEqual([...a[1]],[...b[1]]);
    assert.equal(await math.neg(a[2]),b[2]);
    const d=qvec([.25,.125,-.0625]),active=qvec([.33338320932972676,.4706901442331894]);
    for(const lambda of [0,.25,.5,.75,1]){
      const x=await kernel.evaluate(d,[qvec([.1,0]),active,q(lambda),q(.5)]);
      const y=await kernel.evaluate(d,[qvec([1,0]),active,q(lambda),q(.5)]);
      assert.deepEqual(outputWords(x),outputWords(y));
    }
    // Zero sigma is rejected by this ABI even when epsilon is zero. A topology
    // exporter must record its exact-zero-strength normalization rule explicitly.
    await assert.rejects(kernel.evaluate(d,[qvec([0,0]),active,q(.5),q(.5)]));
  });

  await t.test('nonfinite, close-contact and lower/upper intermediate domains fail closed without clipping',async()=>{
    const normal=CASE('normal',[.5,.125,.0625],[.35,.45],[.32,.85],.5);
    const rejects=[];
    const reject=async(name,d,c)=>{await assert.rejects(kernel.evaluate(d,c));rejects.push({name,status:'rejected'});};
    for(const lambda of [-.01,1.01])await reject(`invalid-lambda-${lambda}`,normal.d,[normal.a,normal.b,q(lambda),normal.alpha]);
    await reject('zero-alpha',normal.d,[normal.a,normal.b,normal.lambda,q(0)]);
    await reject('negative-epsilon',normal.d,[qvec([.35,-.1]),normal.b,normal.lambda,normal.alpha]);
    await reject('unrepresentable-sigma',normal.d,[qvec([1e-60,.45]),normal.b,normal.lambda,normal.alpha]);
    await reject('displacement-upper-range',qvec([2**31,0,0]),cfg(normal));
    await reject('r6-intermediate-upper-range',qvec([64,0,0]),cfg(normal));
    await reject('sigma6-underflow',normal.d,[qvec([1e-6,.1]),normal.b,normal.lambda,normal.alpha]);
    for(const h of ['0x7fff0000000000000000000000000000','0xffff0000000000000000000000000000','0x7fff8000000000000000000000000000']){
      await reject(`nonfinite-coordinate-${h}`,[h,q(0),q(0)],cfg(normal));
      await reject(`nonfinite-lambda-${h}`,normal.d,[normal.a,normal.b,h,normal.alpha]);
    }
    for(const lambda of [0,1])await reject(`active-singular-endpoint-${lambda}`,qvec([0,0,0]),[normal.a,normal.b,q(lambda),normal.alpha]);
    // The factored v2 implementation accepts the lambda=.875 contact (included
    // in the independent oracle above). At .999 the physical energy/dlambda
    // themselves leave the declared numeric range; this remains rejected.
    const boundedContact=CASE('finite-born-pair-outside-fixed96-physical-output-range',[0,0,0],ACTUAL_PAIRS[2].a,ACTUAL_PAIRS[2].b,.999);
    const binary=await reference.evaluate(boundedContact.d,cfg(boundedContact));
    await reject(boundedContact.name,boundedContact.d,cfg(boundedContact));
    fs.writeFileSync('reports/fixed96_softcore_domains.json',JSON.stringify({schemaVersion:1,sourceSha256:compilation.sourceSha256,
      scope:'Explicit fixed-point domain rejection, including physically finite softened contacts outside supported output/intermediate ranges; no universal trajectory-domain guarantee.',
      finiteRejectedContact:{...boundedContact,binary128Result:outputWords(binary)},rejections:rejects},null,2)+'\n');
  });

  await t.test('actual receipt gas and independently reconstructed output digests quantify the new-policy speed change',async()=>{
    const abi=AbiCoder.defaultAbiCoder(),rows=[];
    const scenarios=[CASE('nonzero-interior',[.375,-.125,.0625],[.35,.45],[.32,.85],.5),
      CASE('actual-hybrid-born-pair',ACTUAL_PAIRS[2].d,ACTUAL_PAIRS[2].a,ACTUAL_PAIRS[2].b,.5)];
    for(const [implementation,target] of [['binary128',reference],['fixed96',kernel]]){
      const meter=await deploy('Fixed96SoftcoreGasMeter',[await target.getAddress()]);
      for(const scenario of scenarios)for(const count of [0,1,2,4,8]){
        const receipt=await(await meter.measure(count,scenario.d,cfg(scenario),{gasLimit:15_000_000})).wait();
        const event=receipt.logs.map(l=>{try{return meter.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='Measured');
        assert.ok(event);let digest=ZeroHash;const result=await target.evaluate(scenario.d,cfg(scenario));
        for(let i=0;i<count;i++)digest=keccak256(abi.encode(['bytes32','bytes16','bytes16[3]','bytes16'],[digest,result[0],[...result[1]],result[2]]));
        assert.equal(event.args.digest,digest);
        rows.push({implementation,scenario:scenario.name,count,receiptGas:String(receipt.gasUsed),callGas:[...event.args.callGas].map(String)});
      }
    }
    const comparisons=scenarios.map(s=>{
      const warm=implementation=>{
        const r=rows.find(r=>r.implementation===implementation&&r.scenario===s.name&&r.count===8);
        return r.callGas.slice(1).map(BigInt).reduce((a,b)=>a<b?a:b);
      };
      const fixed=warm('fixed96'),binary=warm('binary128');assert.ok(fixed<binary);
      return {scenario:s.name,fixed96WarmMinimum:String(fixed),binary128WarmMinimum:String(binary),ratio:Number(binary)/Number(fixed)};
    });
    fs.writeFileSync('reports/fixed96_softcore_gas.json',JSON.stringify({schemaVersion:1,localChainId:31337,
      scope:'Actual standalone local calls under different declared numerical policies, not full Ewald-backed sampling, total gas/fees or chain throughput.',
      sourceSha256:compilation.sourceSha256,rows,comparisons},null,2)+'\n');
  });
  for(const file of INPUT_FILES)assert.equal(sha256(fs.readFileSync(file)),compilation.sourceSha256[file],`Source changed during isolated validation: ${file}`);
});
