import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {id,AbiCoder,keccak256,encodeBytes32String} from 'ethers';
import {environment,deploy,transact,quadFromNumber as q} from './helpers.mjs';
const fixture=JSON.parse(fs.readFileSync('reference/timeseries_reference.json','utf8'));
const stable=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);
const gasLimit=28_000_000;
const configType='tuple(bytes32 protocolHash,bytes32 runHash,bytes32 replicaHash,bytes32 observableHash,uint32 state,uint32 expectedSamples,uint64 firstStep,uint64 stride,uint16 maxLag,uint32 minimumSamples)';

test('Bounded chronological observable autocorrelation diagnostics',async t=>{
 const {owner,contributor,transport}=await environment();
 const math=await deploy('FloatMath',owner),writer=await deploy('TimeSeriesWriterHarness',owner);
 const diagnostic=await deploy('TimeSeriesDiagnostics',owner,[writer.target,math.target]);let serial=0;
 const protocol=id('timeseries-protocol'),observable=id('timeseries-frozen-observable');
 const gas=[];
 const cfg=(n,lag,min=16)=>[protocol,id('run'),id('replica'),observable,3,n,100,5,lag,min];
 async function collect(values,{lag=7,min=16,chunk=64}={}){
  const series=id('timeseries-'+(++serial));await transact(writer.create(diagnostic.target,series,cfg(values.length,lag,min),{gasLimit}));
  for(let i=0;i<values.length;i+=chunk)await transact(writer.append(diagnostic.target,series,100+5*i,values.slice(i,i+chunk).map(q),{gasLimit}));
  await transact(writer.seal(diagnostic.target,series,{gasLimit}));return series;
 }
 async function finish(series,schedule=[32],record=false){
  let calls=0;while((await diagnostic.summary(series)).status!==5n){
   assert.ok(calls<500,'bounded fixture work');const receipt=await transact(diagnostic.connect(contributor).advance(series,schedule[calls++%schedule.length],{gasLimit}));
   if(record)gas.push({series,gasUsed:String(receipt.gasUsed)});
  }return await diagnostic.summary(series);
 }
 function numericView(s){return [s.mean,s.populationVariance,s.sampleVariance,s.g,s.effectiveSamples,s.usedLag,s.constantSeries,s.shortSeries,s.truncated,s.validEstimate];}
 let mainSeries,mainSummary;
 await t.test('frozen chronology and writer provenance reject malformed or partial appends atomically',async()=>{
  await assert.rejects(deploy('TimeSeriesDiagnostics',owner,[await owner.getAddress(),math.target]));
  const series=id('bad-series'),config=cfg(4,1,4);
  await assert.rejects(diagnostic.createSeries(series,config));
  await transact(writer.create(diagnostic.target,series,config));
  await assert.rejects(transact(writer.create(diagnostic.target,series,config,{gasLimit})));
  await assert.rejects(transact(writer.connect(contributor).append(diagnostic.target,series,100,[q(1)],{gasLimit})));
  await assert.rejects(transact(writer.seal(diagnostic.target,series,{gasLimit})));
  await assert.rejects(transact(diagnostic.advance(series,1,{gasLimit})));
  const before=stable(await diagnostic.summary(series));
  for(const [step,values]of [[101,[q(1)]],[100,[]],[100,[q(1),'0x7fff8000000000000000000000000000']],[100,Array(5).fill(q(1))]]){
   await assert.rejects(transact(writer.append(diagnostic.target,series,step,values,{gasLimit})));
   assert.equal(stable(await diagnostic.summary(series)),before);
  }
  await transact(writer.append(diagnostic.target,series,100,[q(1),q(2)]));
  await assert.rejects(transact(writer.append(diagnostic.target,series,100,[q(3)],{gasLimit})));
  await transact(writer.append(diagnostic.target,series,110,[q(3),q(4)]));await transact(writer.seal(diagnostic.target,series));
  await assert.rejects(transact(writer.append(diagnostic.target,series,120,[q(5)],{gasLimit})));
  for(const [n,lag,min]of [[4,2,4],[4,5,4],[4,0,4],[1,1,4],[4,1,3],[4097,1,4]])await assert.rejects(transact(writer.create(diagnostic.target,id('invalid-'+n+'-'+lag+'-'+min),cfg(n,lag,min),{gasLimit})));
 });
 await t.test('on-chain moments and autocovariances match independent 80-digit centered sums',async()=>{
  mainSeries=await collect(fixture.values,{chunk:5});mainSummary=await finish(mainSeries,[32],true);
  assert.equal(mainSummary.validEstimate,true);assert.equal(mainSummary.usedLag,3n);
  await diagnostic.assertCompleted(mainSeries);
  const actual={mean:mainSummary.mean,populationVariance:mainSummary.populationVariance,sampleVariance:mainSummary.sampleVariance,g:mainSummary.g,effectiveSamples:mainSummary.effectiveSamples,covariance:[]};
  for(let lag=0;lag<=fixture.maxLag;lag++)actual.covariance.push(await diagnostic.covarianceAt(mainSeries,lag));
  const script=`import json,sys\nfrom decimal import Decimal,getcontext\ngetcontext().prec=90\na=json.loads(sys.argv[1]);r=json.load(open('reference/timeseries_reference.json'))['expected']\ndef decode(h):\n b=int(h,16);sign=-1 if b>>127 else 1;e=(b>>112)&32767;f=b&((1<<112)-1);return Decimal(sign)*Decimal((1<<112)+f)*Decimal(2)**(e-16383-112) if e else Decimal(sign*f)*Decimal(2)**(-16382-112)\nerrors=[]\ndef check(x,y):\n if isinstance(x,list):\n  assert len(x)==len(y)\n  for u,v in zip(x,y):check(u,v)\n else:\n  err=abs(decode(x)-Decimal(y));assert err<=Decimal('1e-27')+Decimal('1e-27')*abs(Decimal(y)),(x,y,err);errors.append(err)\nfor key in a:check(a[key],r[key])\nprint(json.dumps({'scope':'Synthetic observable moments and finite-lag Geyer initial monotone estimate; not stationarity evidence','values_checked':len(errors),'maximum_absolute_error':str(max(errors)),'absolute_tolerance':'1e-27','relative_tolerance':'1e-27','passed':True},indent=2))`;
  fs.writeFileSync('reports/timeseries_validation.json',execFileSync(process.env.ORVIA_RESEARCH_PYTHON||'python3',['-c',script,JSON.stringify(actual)],{encoding:'utf8'})+'\n');
 });
 await t.test('append and calculation partitions preserve exact results and immutable commitments',async()=>{
  const second=await collect(fixture.values,{chunk:16});const result=await finish(second,[1,7,16,32]);
  assert.deepEqual(numericView(result),numericView(mainSummary));
  for(let lag=0;lag<=fixture.maxLag;lag++)assert.equal(await diagnostic.covarianceAt(second,lag),await diagnostic.covarianceAt(mainSeries,lag));
  const coder=AbiCoder.defaultAbiCoder(),config=cfg(16,7);
  let digest=keccak256(coder.encode(['bytes32','uint256','address','bytes32','address','bytes32','address','bytes32',configType],[encodeBytes32String('ORVIA-TIMESERIES-v1'),31337,diagnostic.target,mainSeries,writer.target,await diagnostic.writerCodeHash(),math.target,await diagnostic.mathCodeHash(),config]));
  for(let i=0;i<fixture.values.length;i++)digest=keccak256(coder.encode(['bytes32','uint32','uint256','bytes16'],[digest,i,100+5*i,q(fixture.values[i])]));
  assert.equal(mainSummary.inputDigest,digest);
  const resultDigest=keccak256(coder.encode(['bytes32','bytes16','bytes16','bytes16','bytes16','uint16','bool','bool','bool'],[digest,mainSummary.mean,mainSummary.populationVariance,mainSummary.g,mainSummary.effectiveSamples,mainSummary.usedLag,false,false,false]));
  assert.equal(mainSummary.resultDigest,resultDigest);
  for(const work of [0,33,1])await assert.rejects(transact(diagnostic.advance(mainSeries,work,{gasLimit})));
  await assert.rejects(transact(writer.seal(diagnostic.target,mainSeries,{gasLimit})));
 });
 await t.test('constant, short and unresolved lag windows remain explicitly invalid',async()=>{
  for(const [values,lag,min,expected]of [
   [Array(16).fill(7),7,16,{constantSeries:true,shortSeries:false,truncated:false}],
   [[7],0,16,{constantSeries:true,shortSeries:true,truncated:false}],
   [[1,-1],1,16,{constantSeries:false,shortSeries:true,truncated:true}],
   [Array.from({length:16},(_,i)=>i),1,16,{constantSeries:false,shortSeries:false,truncated:true}]
  ]){
   const series=await collect(values,{lag,min}),result=await finish(series);assert.equal(result.validEstimate,false);
   for(const [key,value]of Object.entries(expected))assert.equal(result[key],value);
   if(expected.constantSeries){assert.equal(result.g,q(0));assert.equal(result.effectiveSamples,q(0));}
   assert.equal((await diagnostic.assertCompleted(series))[1],false);
  }
  const anti=await finish(await collect(Array.from({length:16},(_,i)=>i%2?-1:1)));
  assert.equal(anti.g,q(1));assert.equal(anti.effectiveSamples,q(16));
 });
 await t.test('nonconstant numerical underflow cannot masquerade as a constant series',async()=>{
  const series=id('underflow');await transact(writer.create(diagnostic.target,series,cfg(2,1,4)));
  await transact(writer.append(diagnostic.target,series,100,[q(0),'0x00000000000000000000000000000001']));await transact(writer.seal(diagnostic.target,series));
  const before=stable(await diagnostic.summary(series));await assert.rejects(transact(diagnostic.advance(series,32,{gasLimit})));
  assert.equal(stable(await diagnostic.summary(series)),before);await assert.rejects(diagnostic.assertCompleted(series));
 });
 await t.test('changed dependencies invalidate acceptance and resumed calculation',async()=>{
  const series=await collect([0,1,2,1],{lag:1,min:4});
  await transport.request({method:'evm_setAccountCode',params:[writer.target,'0x00']});
  await assert.rejects(diagnostic.assertCompleted(mainSeries));await assert.rejects(transact(diagnostic.advance(series,1,{gasLimit})));
 });
 fs.writeFileSync('reports/timeseries_execution_gas.json',JSON.stringify({scope:'Synthetic 16-observation, maxLag 7 calculation only; excludes collection/deployment',transactions:gas.length,totalGas:gas.reduce((a,x)=>a+BigInt(x.gasUsed),0n).toString(),peakGas:gas.reduce((a,x)=>BigInt(x.gasUsed)>a?BigInt(x.gasUsed):a,0n).toString(),receipts:gas},null,2)+'\n');
 await transport.disconnect();
});
