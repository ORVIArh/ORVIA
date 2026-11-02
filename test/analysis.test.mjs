import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {id,AbiCoder,keccak256,encodeBytes32String} from 'ethers';
import {environment,deploy,transact,quadFromNumber as q,quadToNumber as number} from './helpers.mjs';
const fixture=JSON.parse(fs.readFileSync('reference/mbar_reference.json','utf8'));
const gasLimit=28_000_000;
const stable=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);

test('On-chain reduced-potential collection, general MBAR, diagnostics and paired-repeat uncertainty',async t=>{
 const env=await environment();const {owner,contributor,transport}=env;
 const math=await deploy('FloatMath',owner),scalar=await deploy('ScalarMath',owner,[math.target]);
 const writer=await deploy('AnalysisWriterHarness',owner);
 const collector=await deploy('ReducedPotentialCollector',owner,[writer.target,math.target]);
 const estimator=await deploy('MBARFreeEnergyEstimator',owner,[collector.target,math.target,scalar.target]);
 const diagnostic=await deploy('SamplingDiagnostics',owner,[estimator.target]);
 const results=await deploy('UncertaintyAndResults',owner,[diagnostic.target,await owner.getAddress()]);
 const complexLeg=await results.COMPLEX_LEG(),solventLeg=await results.SOLVENT_LEG();
 const protocol=id('analysis-test-protocol'),campaign=id('analysis-test-campaign');let serial=0;
 const gas=[];
 async function collect(rows,origins,{leg=complexLeg,seed=id('main-seed'),shift=false,kT=1,minESS=1,empty=false}={}){
  const series=id('series-'+(++serial));const config=[protocol,id('run-'+serial),leg,seed,rows[0].length,rows.length,q(kT),5,0,q(1e-18),q(.001),q(minESS),q(1e-12)];
  await transact(writer.create(collector.target,series,config,{gasLimit}));
  if(!empty)await fill(series,rows,origins,{shift,kT});return series;
 }
 async function fill(series,rows,origins,{shift=false,kT=1}={}){
  const steps=Array(16).fill(0);
  for(let n=0;n<rows.length;n++){
   const state=origins[n];steps[state]+=5;
   const energies=rows[n].map(v=>q(Number(v)*kT+(shift?(n+1)*16:0)));
   await transact(writer.append(collector.target,series,state,steps[state],energies,{gasLimit}));
  }
  await transact(writer.seal(collector.target,series,{gasLimit}));
 }
 async function solve(series,{schedule=[32],iterations=200,tolerance=1e-18}={}){
  const analysisId=await estimator.nextAnalysisId();await transact(estimator.createAnalysis(series,q(tolerance),iterations,{gasLimit}));
  let calls=0;
  while(Number((await estimator.runInfo(analysisId)).status)<5){
   assert.ok(calls<500,'MBAR bounded test budget');const receipt=await transact(estimator.connect(contributor).advanceAnalysis(analysisId,schedule[calls%schedule.length],{gasLimit}));
   gas.push({analysisId:String(analysisId),gasUsed:String(receipt.gasUsed)});calls++;
  }return analysisId;
 }
 async function diagnose(analysisId,{edge=.001,minESS=1,schedule=[32]}={}){
  const diagnosticId=await diagnostic.nextDiagnosticId();await transact(diagnostic.createDiagnostic(analysisId,q(edge),q(minESS),q(1e-12),{gasLimit}));
  let calls=0;while((await diagnostic.runInfo(diagnosticId)).status!==4n){assert.ok(calls<500);await transact(diagnostic.advanceDiagnostic(diagnosticId,schedule[calls++%schedule.length],{gasLimit}));}return diagnosticId;
 }
 let mainSeries,mainAnalysis,mainDiagnostic;
 await t.test('writer-only complete samples convert energy units and reject incomplete, duplicate or malformed records atomically',async()=>{
  await assert.rejects(deploy('ReducedPotentialCollector',owner,[await owner.getAddress(),math.target]));
  const series=id('bad-series');const config=[protocol,id('bad-run'),complexLeg,id('bad-seed'),2,2,q(2),5,10,q(1e-18),q(.001),q(1),q(1e-12)];
  await assert.rejects(collector.createSeries(series,config));
  await transact(writer.create(collector.target,series,config));
  await assert.rejects(transact(writer.seal(collector.target,series)));
  const before=stable(await collector.seriesInfo(series));
  for(const [state,step,row] of [[0,10,[0,1]],[0,11,[0,66]],[2,11,[0,1]],[0,11,[0]]])await assert.rejects(transact(writer.append(collector.target,series,state,step,row.map(q),{gasLimit})));
  assert.equal(stable(await collector.seriesInfo(series)),before);
  await transact(writer.append(collector.target,series,0,11,[q(10),q(12)]));
  assert.equal(await collector.potential(series,0,0),q(0));assert.equal(await collector.potential(series,0,1),q(1));
  await assert.rejects(transact(writer.append(collector.target,series,0,15,[q(10),q(12)],{gasLimit})));
  await transact(writer.append(collector.target,series,1,11,[q(-8),q(-6)]));await transact(writer.seal(collector.target,series));
  await assert.rejects(transact(writer.append(collector.target,series,1,16,[q(0),q(1)],{gasLimit})));
  await assert.rejects(transact(writer.seal(collector.target,series)));
 });
 await t.test('three-state MBAR and diagnostic weights match independent 90-digit Newton roots',async()=>{
  mainSeries=await collect(fixture.rows,fixture.origins,{minESS:2});mainAnalysis=await solve(mainSeries);mainDiagnostic=await diagnose(mainAnalysis,{minESS:2});
  assert.equal((await estimator.runInfo(mainAnalysis)).status,5n);await diagnostic.assertAccepted(mainDiagnostic);
  const actual={f:[],log_denominators:[],ess:[],overlap:[],weight_sums:[]};
  for(let k=0;k<3;k++){
   actual.f.push(await estimator.fAt(mainAnalysis,k));const [sum,ess]=await diagnostic.stateDiagnostics(mainDiagnostic,k);actual.weight_sums.push(sum);actual.ess.push(ess);actual.overlap.push([]);
   for(let j=0;j<3;j++)actual.overlap[k].push(await diagnostic.overlap(mainDiagnostic,k,j));
  }
  for(let n=0;n<6;n++)actual.log_denominators.push(await estimator.logDenominatorAt(mainAnalysis,n));
  const script=`import json,sys\nfrom decimal import Decimal,getcontext\ngetcontext().prec=90\na=json.loads(sys.argv[1]);r=json.load(open('reference/mbar_reference.json'))['expected']\ndef decode(h):\n b=int(h,16);sign=-1 if b>>127 else 1;e=(b>>112)&32767;f=b&((1<<112)-1);return Decimal(sign)*Decimal((1<<112)+f)*Decimal(2)**(e-16383-112) if e else Decimal(sign*f)*Decimal(2)**(-16382-112)\nerrors=[]\ndef check(x,y):\n if isinstance(x,list):\n  for u,v in zip(x,y):check(u,v)\n else:\n  err=abs(decode(x)-Decimal(y));assert err<=Decimal('1e-16')+Decimal('1e-16')*abs(Decimal(y)),(x,y,err);errors.append(err)\nfor key in a:check(a[key],r[key])\nprint(json.dumps({'scope':'Synthetic three-state MBAR and weights, not molecular free energies','values_checked':len(errors),'maximum_absolute_error':str(max(errors)),'absolute_tolerance':'1e-16','relative_tolerance':'1e-16','passed':True},indent=2))`;
  const report=execFileSync(process.env.ORVIA_RESEARCH_PYTHON||'python3',['-c',script,JSON.stringify(actual)],{encoding:'utf8'});fs.writeFileSync('reports/mbar_validation.json',report+'\n');
 });
 await t.test('work partition and per-configuration energy offsets preserve final MBAR bytes',async()=>{
  const second=await solve(mainSeries,{schedule:[1,7,16,32]});
  for(let k=0;k<3;k++)assert.equal(await estimator.fAt(mainAnalysis,k),await estimator.fAt(second,k));
  const shiftedSeries=await collect(fixture.rows,fixture.origins,{shift:true});
  for(let n=0;n<6;n++)for(let k=0;k<3;k++)assert.equal(await collector.potential(mainSeries,n,k),await collector.potential(shiftedSeries,n,k));
  const shifted=await solve(shiftedSeries);for(let k=0;k<3;k++)assert.equal(await estimator.fAt(mainAnalysis,k),await estimator.fAt(shifted,k));
  const alternate=await diagnose(second,{minESS:2,schedule:[1,7,32]});for(let i=0;i<3;i++)for(let j=0;j<3;j++)assert.equal(await diagnostic.overlap(mainDiagnostic,i,j),await diagnostic.overlap(alternate,i,j));
 });
 await t.test('convergence is separate from poor overlap and exhausted iterations',async()=>{
  const poor=await solve(await collect([[0,20],[0,-20]],[0,1]));assert.equal((await estimator.runInfo(poor)).status,5n);
  const poorDiag=await diagnose(poor);assert.equal((await diagnostic.runInfo(poorDiag)).connected,false);await assert.rejects(diagnostic.assertAccepted(poorDiag));
  const exhausted=await solve(mainSeries,{iterations:1});assert.equal((await estimator.runInfo(exhausted)).status,6n);
  await assert.rejects(estimator.assertConverged(exhausted));await assert.rejects(diagnostic.createDiagnostic(exhausted,q(.001),q(1),q(1e-12)));
  await assert.rejects(transact(estimator.advanceAnalysis(exhausted,1,{gasLimit})));
 });
 await t.test('commitments bind the sealed samples, numerical configuration and solver settings',async()=>{
  const coder=AbiCoder.defaultAbiCoder();const info=await estimator.runInfo(mainAnalysis);const digest=await collector.assertSealed(mainSeries);
  const expected=keccak256(coder.encode(['bytes32','uint256','address','uint256','bytes32','bytes32','bytes32','bytes16','uint32'],[encodeBytes32String('ORVIA-MBAR-v1'),31337,estimator.target,mainAnalysis,mainSeries,digest,await estimator.configurationHash(),q(1e-18),200]));
  assert.equal(info.commitment,expected);
  await assert.rejects(estimator.createAnalysis(mainSeries,q(1e-5),200));
  await assert.rejects(diagnostic.createDiagnostic(mainAnalysis,q(.0001),q(2),q(1e-12)));
  await assert.rejects(estimator.createAnalysis(mainSeries,q(0),10));await assert.rejects(estimator.createAnalysis(mainSeries,q(1e-18),0));
  await assert.rejects(transact(estimator.advanceAnalysis(mainAnalysis,1,{gasLimit})));await assert.rejects(transact(diagnostic.advanceDiagnostic(mainDiagnostic,0,{gasLimit})));
 });
 await t.test('paired independent-repeat differences produce mean and SEM without accepting submitted free energies',async()=>{
  const complex=[],solvent=[],complexSeries=[],solventSeries=[];
  for(let i=0;i<3;i++){
   const seed=id('repeat-'+i),cg=[2,3,5][i];
   complexSeries.push(await collect([[0,cg],[0,cg]],[0,1],{leg:complexLeg,seed,empty:true}));
   solventSeries.push(await collect([[0,1],[0,1]],[0,1],{leg:solventLeg,seed,empty:true}));
  }
  const plan=id('registered-repeat-plan');
  await assert.rejects(results.connect(contributor).registerPlan(plan,campaign,complexSeries,solventSeries));
  await assert.rejects(results.registerPlan(plan,campaign,[complexSeries[0],complexSeries[0],complexSeries[2]],[solventSeries[0],solventSeries[0],solventSeries[2]]));
  await transact(results.registerPlan(plan,campaign,complexSeries,solventSeries,{gasLimit}));
  await assert.rejects(results.registerPlan(plan,campaign,complexSeries,solventSeries));
  for(let i=0;i<3;i++){
   const cg=[2,3,5][i];await fill(complexSeries[i],[[0,cg],[0,cg]],[0,1]);await fill(solventSeries[i],[[0,1],[0,1]],[0,1]);
   complex.push(await diagnose(await solve(complexSeries[i])));solvent.push(await diagnose(await solve(solventSeries[i])));
  }
  await assert.rejects(results.registerPlan(id('post-hoc-plan'),id('post-hoc-campaign'),complexSeries,solventSeries));
  const rid=await results.nextResultId();await transact(results.createResult(plan,complex,solvent));await transact(results.advanceResult(rid,1,{gasLimit}));assert.equal((await results.resultInfo(rid)).completed,false);
  await transact(results.advanceResult(rid,8,{gasLimit}));const out=await results.resultInfo(rid);assert.equal(out.completed,true);assert.ok(Math.abs(number(out.deltaDeltaG)-7/3)<1e-14);assert.ok(Math.abs(number(out.repeatSEM)-Math.sqrt(7)/3)<1e-14);
  await assert.rejects(transact(results.advanceResult(rid,1,{gasLimit})));
  await assert.rejects(results.createResult(plan,complex.slice(0,2),solvent.slice(0,2)));
  const duplicate=await results.nextResultId();await transact(results.createResult(plan,[complex[0],complex[0],complex[2]],[solvent[0],solvent[0],solvent[2]]));
  const before=stable(await results.resultInfo(duplicate));await assert.rejects(transact(results.advanceResult(duplicate,2,{gasLimit})));assert.equal(stable(await results.resultInfo(duplicate)),before);
 });
 await t.test('modified executable dependencies invalidate existing analysis rather than changing results',async()=>{
  await transport.request({method:'evm_setAccountCode',params:[scalar.target,'0x00']});await assert.rejects(estimator.assertConverged(mainAnalysis));await assert.rejects(diagnostic.assertAccepted(mainDiagnostic));
 });
 fs.writeFileSync('reports/mbar_execution_gas.json',JSON.stringify({scope:'Local fixture MBAR advancement only; excludes input collection, deployment, diagnostics and repeat summaries',chainId:31337,transactions:gas},null,2)+'\n');
 await transport.disconnect();
});
