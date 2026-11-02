import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { AbiCoder, keccak256 } from 'ethers';
import { environment, deploy, qvec, quadFromNumber as q } from './helpers.mjs';

test('Declared Q96.96 pair policy: independent physical gradient, domains and measured local gas', async t => {
  const env = await environment();t.after(()=>env.transport.disconnect());
  const kernel = await deploy('FixedPointNonbondedKernel',env.owner);
  const inline = await deploy('InlineNonbondedKernel',env.owner);
  const ordinary = await deploy('Fixed96LennardJonesKernel',env.owner);
  const cases=[];
  const params=[q(.5),q(.125),q(-.25),q(138.93545764438198),q(2),q(3)];
  for(const exception of [false,true]) for(let n=0;n<64;n++) {
    const d=[(3+(n*17)%22)/8,((n*7)%9-4)/16,((n*11)%13-6)/32];
    cases.push({name:`dyadic-${exception}-${n}`,d:qvec(d),p:params,exception});
  }
  for(const distance of [q(2),q(3),...[-1n,1n].map(delta=>'0x'+(BigInt(q(3))+delta).toString(16).padStart(32,'0'))])
    cases.push({name:`boundary-${distance}`,d:[distance,q(0),q(0)],p:params,exception:false});
  await t.test('complete energy and all force components match a 110-digit independently differentiated potential',async()=>{
    const rows=[];
    for(const v of cases){const o=await kernel.evaluate(v.d,...v.p,v.exception);rows.push({...v,energy:o[0],force:[...o[1]]});}
    for(const v of cases.filter(c=>c.exception)){
      const p=[...v.p];p[2]=q(0);
      const o=await ordinary.evaluate(qvec([0,0,0]),v.d,p[0],p[1]);
      rows.push({...v,name:`ordinary-${v.name}`,p,energy:o[0],force:[...o[1]]});
      const direct=await kernel.evaluate(v.d,...p,true);
      assert.deepEqual([o[0],[...o[1]]],[direct[0],[...direct[1]]]);
    }
    const oracle=String.raw`
import json,sys,mpmath as mp
mp.mp.dps=110
def decode(h):
 n=int(h,16);e=(n>>112)&32767;f=n&((1<<112)-1)
 if e==32767:raise ValueError('nonfinite')
 return (-1 if n>>127 else 1)*(mp.mpf(f)*mp.power(2,-16494) if e==0 else (1+mp.mpf(f)/2**112)*mp.power(2,e-16383))
records=[]
for row in json.load(sys.stdin):
 d=list(map(decode,row['d']));sigma,eps,charge,pref,rs,rc=map(decode,row['p'])
 def energy(v):
  r=mp.sqrt(sum(x*x for x in v))
  if not row['exception'] and r>=rc:return mp.mpf(0)
  u=4*eps*((sigma/r)**12-(sigma/r)**6)
  if row['exception']:return u+pref*charge/r
  if r>rs:
   x=(r-rs)/(rc-rs);u*=1-10*x**3+15*x**4-6*x**5
  return u+pref*charge*(1/r+r*r/(2*rc**3)-3/(2*rc))
 expected=[energy(d)]+[mp.diff(lambda x:energy(d[:i]+[x]+d[i+1:]),d[i]) for i in range(3)]
 errors=[]
 for h,y in zip([row['energy']]+row['force'],expected):
  error=abs(decode(h)-y);tol=mp.mpf('1e-20')+mp.mpf('1e-18')*abs(y)
  if error>tol:raise AssertionError((row['name'],str(error),str(tol),h,str(y)))
  errors.append(str(error))
 records.append({'name':row['name'],'absoluteErrors':errors,'passed':True})
print(json.dumps({'scope':'Sampled fixed-point switched LJ/reaction-field/direct-exception kernel only; not full molecular or Ewald validation','reference':'mpmath1.3.0 110digits; independent unfactored energy differentiation','absoluteTolerance':'1e-20','relativeTolerance':'1e-18','cases':records},indent=2))
`;
    const report=execFileSync(process.env.ORVIA_RESEARCH_PYTHON||'python3',['-c',oracle],{input:JSON.stringify(rows),encoding:'utf8'});
    fs.writeFileSync('reports/fixedpoint_pair_validation.json',report+'\n');
    assert.equal(JSON.parse(report).cases.length,cases.length+64);
  });
  await t.test('rejects unsupported numerical domains without clipping or softening',async()=>{
    const origin=qvec([0,0,0]),normal=qvec([1,.25,.125]);
    await assert.rejects(kernel.evaluate(origin,...params,false));
    await assert.rejects(kernel.evaluate(qvec([2**31,0,0]),...params,false));
    await assert.rejects(kernel.evaluate(qvec([1e-20,0,0]),...params,false));
    for(const [index,value] of [[0,q(0)],[0,q(1e-60)],[1,q(-1)],[3,q(-1)],[4,q(0)],[5,q(1)]]){
      const p=[...params];p[index]=value;await assert.rejects(kernel.evaluate(normal,...p,false));
    }
    for(const invalid of ['0x7fff0000000000000000000000000000','0x7fff8000000000000000000000000000']){
      await assert.rejects(kernel.evaluate([invalid,q(0),q(0)],...params,false));
      const p=[...params];p[2]=invalid;await assert.rejects(kernel.evaluate(normal,...p,true));
    }
    const output=await kernel.evaluate(qvec([1,0,0]),q(1),q(1),q(0),q(1),q(2),q(3),true);
    assert.equal(output[0],q(0));assert.deepEqual([...output[1]],qvec([-24,0,0]));
  });
  await t.test('actual same-input warm pair gas improves versus inlined binary128 with independently consumed digests',async()=>{
    const abi=AbiCoder.defaultAbiCoder(),rows=[];
    for(const [name,k] of [['binary128',inline],['fixed96',kernel]]){
      const meter=await deploy('PairWorkMeter',env.owner,[await k.getAddress()]);
      for(const branch of [false,true]){
        const receipt=await(await meter.measure(8,branch)).wait();
        const event=receipt.logs.map(l=>{try{return meter.interface.parseLog(l);}catch{return null;}}).find(x=>x?.name==='Measured');
        const result=await k.evaluate(qvec([branch?2.5:1,.25,.125]),q(.5),q(.125),q(-.25),q(1),q(2),q(3),false);
        let digest='0x'+'00'.repeat(32);
        for(let n=0;n<8;n++)digest=keccak256(abi.encode(['bytes32','bytes16','bytes16[3]'],[digest,result[0],[...result[1]]]));
        assert.equal(event.args.digest,digest);
        rows.push({implementation:name,insideSwitch:branch,receiptGas:String(receipt.gasUsed),callGas:[...event.args.callGas].map(String),warmMinimum:String(event.args.callGas.slice(1).reduce((a,b)=>a<b?a:b))});
      }
    }
    for(const branch of [false,true]) assert.ok(BigInt(rows.find(r=>r.implementation==='fixed96'&&r.insideSwitch===branch).warmMinimum)<BigInt(rows.find(r=>r.implementation==='binary128'&&r.insideSwitch===branch).warmMinimum));
    fs.writeFileSync('reports/fixedpoint_pair_gas.json',JSON.stringify({scope:'New numerical policy, standalone repeated local pair calls; no full-trajectory/production gas claim',localChainId:31337,rows},null,2)+'\n');
  });
});
