import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { AbiCoder,keccak256 } from 'ethers';
import { environment,deploy,qvec,quadFromNumber as q } from './helpers.mjs';

test('Candidate Q96 finite Ewald components: independent oracle, domains and consumed local gas',async t=>{
  const env=await environment();t.after(()=>env.transport.disconnect());
  const real=await deploy('Fixed96EwaldRealSpaceKernel',env.owner);
  const recip=await deploy('Fixed96EwaldReciprocalKernel',env.owner);
  const rows=[];
  await t.test('110-digit screened pair and reciprocal operations across declared domains',async()=>{
    for(const x of [0.0001,.1,.5,1,1.999,2,2.001,3,4,6,8,12,15.99]){
      const d=qvec([x,.03125,-.015625]),p=[q(-.25),q(138.93545764438198),q(1),q(16)];
      const o=await real.evaluate(d,...p);rows.push({kind:'real',d,p,actual:[o[0],...o[1]]});
    }
    for(let n=0;n<48;n++){
      const position=qvec([((n*17)%37-18)/8,((n*11)%23-11)/16,((n*7)%19-9)/32]);
      const charge=q((n%7-3)/8),mode=[1+(n%4),n%3-1,n%5-2],box=qvec([4,5,6]);
      const o=await recip.structureFactorTerm(position,charge,mode,box);
      rows.push({kind:'structure',position,charge,mode,box,actual:[...o]});
    }
    for(const mode of [[1,0,0],[1,-2,3],[0,1,-2],[0,0,32]]){
      const box=qvec([4,5,6]),alpha=q(3),prefactor=q(138.93545764438198);
      const w=await recip.waveVector(mode,box,alpha,prefactor);
      rows.push({kind:'wave',mode,box,alpha,prefactor,actual:[...w[0],w[1]]});
      const p=[q(.125),q(-.25),q(1.25),q(-.75)];
      const f=await recip.forceContribution([...w[0]],w[1],...p);
      const e=await recip.modeEnergy(w[1],p[2],p[3]);
      rows.push({kind:'mode',k:[...w[0]],coefficient:w[1],p,actual:[e,...f]});
    }
    const oracle=String.raw`
import json,sys,mpmath as m
m.mp.dps=110
def dec(h):
 n=int(h,16);e=(n>>112)&32767;f=n&((1<<112)-1)
 if e==32767:raise ValueError('nonfinite')
 return (-1 if n>>127 else 1)*(m.mpf(f)*m.power(2,-16494) if e==0 else (1+m.mpf(f)/2**112)*m.power(2,e-16383))
records=[]
for row in json.load(sys.stdin):
 k=row['kind']
 if k=='real':
  d=list(map(dec,row['d']));charge,pref,a,rc=map(dec,row['p'])
  def energy(v):
   r=m.sqrt(sum(x*x for x in v))
   return m.mpf(0) if r>=rc else charge*pref*m.erfc(a*r)/r
  expected=[energy(d)]+[m.diff(lambda x:energy(d[:i]+[x]+d[i+1:]),d[i]) for i in range(3)]
 elif k=='structure':
  position=list(map(dec,row['position']));box=list(map(dec,row['box']));charge=dec(row['charge'])
  angle=2*m.pi*sum(n*x/l for n,x,l in zip(row['mode'],position,box))
  expected=[charge*m.cos(angle),charge*m.sin(angle)]
 elif k=='wave':
  box=list(map(dec,row['box']));a=dec(row['alpha']);pref=dec(row['prefactor'])
  wave=[2*m.pi*n/l for n,l in zip(row['mode'],box)];k2=sum(x*x for x in wave)
  expected=wave+[4*m.pi*pref/m.fprod(box)*m.exp(-k2/(4*a*a))/k2]
 else:
  wave=list(map(dec,row['k']));a=dec(row['coefficient']);c,s,C,S=map(dec,row['p'])
  expected=[a*(C*C+S*S)]+[2*a*x*(C*s-S*c) for x in wave]
 errors=[]
 for h,y in zip(row['actual'],expected):
  error=abs(dec(h)-y);tol=m.mpf('1e-20')+m.mpf('1e-18')*abs(y)
  if error>tol:raise AssertionError((k,str(error),str(tol),str(y)))
  errors.append(str(error))
 records.append({'kind':k,'absoluteErrors':errors,'passed':True})
print(json.dumps({'scope':'Sampled candidate Q96 finite-Ewald components, not a full Ewald/ensemble acceptance','oracle':'mpmath 1.3.0, 110digits, direct scalar potential and analytic reciprocal operations','absoluteTolerance':'1e-20','relativeTolerance':'1e-18','cases':records},indent=2))
`;
    const report=execFileSync(process.env.ORVIA_RESEARCH_PYTHON||'python3',['-c',oracle],{input:JSON.stringify(rows),encoding:'utf8'});
    fs.writeFileSync('reports/fixed96_ewald_validation.json',report+'\n');
  });
  await t.test('periodic translations, excluded modes and unsupported arithmetic fail closed',async()=>{
    const box=qvec([4,5,6]),mode=[1,-2,3],charge=q(-.5);
    const a=await recip.structureFactorTerm(qvec([.25,-.5,.125]),charge,mode,box);
    const b=await recip.structureFactorTerm(qvec([8.25,-15.5,24.125]),charge,mode,box);
    assert.deepEqual([...a],[...b]);
    for(const invalid of [[0,0,0],[-1,0,0],[33,0,0]])await assert.rejects(recip.structureFactorTerm(qvec([0,0,0]),charge,invalid,box));
    await assert.rejects(real.evaluate(qvec([0,0,0]),q(1),q(1),q(1),q(2)));
    await assert.rejects(real.evaluate(qvec([1,0,0]),q(1),q(1),q(17),q(1)));
    await assert.rejects(recip.structureFactorTerm(qvec([1,0,0]),q(1),mode,qvec([0,1,1])));
    await assert.rejects(recip.modeEnergy('0x7fff0000000000000000000000000000',q(1),q(1)));
  });
  await t.test('same-input repeated output-consumed gas versus binary128 references',async()=>{
    const math=await deploy('FloatMath',env.owner);
    const scalar=await deploy('ScalarMath',env.owner,[await math.getAddress()]);
    const elementary=await deploy('ElementaryMath',env.owner,[await math.getAddress()]);
    const oldReal=await deploy('EwaldRealSpaceKernel',env.owner,[await math.getAddress(),await scalar.getAddress()]);
    const oldRecip=await deploy('EwaldReciprocalKernel',env.owner,[await math.getAddress(),await scalar.getAddress(),await elementary.getAddress()]);
    const meter=await deploy('StaticCallWorkMeter',env.owner),abi=AbiCoder.defaultAbiCoder(),measurements=[];
    for(const [operation,method,args,ref,candidate] of [
      ['real-small','evaluate',[qvec([.5,.25,.125]),q(-.25),q(138.93545764438198),q(2),q(3)],oldReal,real],
      ['real-tail','evaluate',[qvec([1,.25,.125]),q(-.25),q(138.93545764438198),q(2),q(3)],oldReal,real],
      ['structure','structureFactorTerm',[qvec([.25,-.5,.125]),q(-.5),[1,-2,3],qvec([4,5,6])],oldRecip,recip]
    ]){
      for(const [implementation,kernel] of [['binary128',ref],['fixed96',candidate]]){
        const input=kernel.interface.encodeFunctionData(method,args),result=await env.provider.call({to:await kernel.getAddress(),data:input});
        const receipt=await(await meter.measure(await kernel.getAddress(),input,3,{gasLimit:29_000_000})).wait();
        const event=receipt.logs.map(x=>{try{return meter.interface.parseLog(x);}catch{return null;}}).find(x=>x?.name==='Measured');
        let digest='0x'+'00'.repeat(32);for(let i=0;i<3;i++)digest=keccak256(abi.encode(['bytes32','bytes'],[digest,result]));
        assert.equal(event.args.digest,digest);
        measurements.push({operation,implementation,receiptGas:String(receipt.gasUsed),callGas:[...event.args.callGas].slice(0,3).map(String)});
      }
    }
    fs.writeFileSync('reports/fixed96_ewald_gas.json',JSON.stringify({scope:'Standalone components on local Shanghai EVM, repeated warm locality; no target/full-trajectory claim',measurements},null,2)+'\n');
  });
});
