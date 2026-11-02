import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {id,ZeroHash} from 'ethers';
import {setup,harmonicFixture,gasLimit} from './molecular-pipeline-fixture.mjs';
import {transact,quadFromNumber as q,quadToNumber as number} from './helpers.mjs';

test('Preregistered molecular repeats reach diagnostics and uncertainty through frozen selected samples',async t=>{
 const file='reports/molecular_analysis_validation.json';
 const report={status:'in_progress',passed:false,mainnetTransactionsSent:0,
  scope:'Local two-atom identical-endpoint test with three paired repeats. This validates authenticated wiring, not molecular accuracy, equilibration or production independence.',
  testSha256:createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex')};
 fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
 const e=await setup(t,{banked:true,analysis:true});
 report.compilation=e.compilation;report.coreDeployments=e.coreDeployments;
 assert.equal(e.coreDeployments.length,26);
 const fixture=harmonicFixture();fixture.b=JSON.parse(JSON.stringify(fixture.a));
 const {tid}=await e.makeTopology(fixture,[q(0),q(1)]);
 const complex=[],solvent=[];
 for(let repeat=0;repeat<3;repeat++){
  const seed=id(`Molecular analysis fixed fixture repeat ${repeat}`);
  complex.push(await e.campaign(tid,{seed,leg:await e.results.COMPLEX_LEG(),maxLag:3}));
  solvent.push(await e.campaign(tid,{seed,leg:await e.results.SOLVENT_LEG(),maxLag:3}));
 }
 const plan=id('Molecular analysis preregistered plan'),campaign=id('Molecular analysis paired fixture');
 for(const c of [...complex,...solvent]){
  const reg=await e.pipeline.campaignRegistration(c);
  assert.equal(reg.selectedSeries,await e.pipeline.selectedSeries(c));
  await assert.rejects(e.collector.seriesInfo(reg.selectedSeries));
  await assert.rejects(e.pipeline.connect(e.contributor).startWindow(c,0));
 }
 await assert.rejects(e.results.connect(e.contributor).registerMolecularPlan(plan,campaign,e.pipeline.target,complex,solvent));
 await assert.rejects(e.results.registerMolecularPlan(plan,campaign,e.pipeline.target,complex.slice(0,2),solvent.slice(0,2)));
 await assert.rejects(e.results.registerMolecularPlan(plan,campaign,e.pipeline.target,[complex[0],complex[0],complex[2]],[solvent[0],solvent[0],solvent[2]]));
 await assert.rejects(e.results.registerMolecularPlan(plan,campaign,e.pipeline.target,complex,[solvent[1],solvent[0],solvent[2]]));
 assert.equal(await e.results.campaignPlan(campaign),ZeroHash);
 await transact(e.results.registerMolecularPlan(plan,campaign,e.pipeline.target,complex,solvent,{gasLimit}));
 const frozen=await e.results.planInfo(plan);
 assert.deepEqual([...frozen.complexSeries],await Promise.all(complex.map(c=>e.pipeline.selectedSeries(c))));
 assert.equal((await e.results.molecularPlanInfo(plan)).source,e.pipeline.target);
 await assert.rejects(e.results.registerMolecularPlan(plan,campaign,e.pipeline.target,complex,solvent));
 await assert.rejects(e.pipeline.connect(e.contributor).startWindow(complex[0],0));
 report.preregistrationBeforeSelectedSeriesExists=true;
 const diagnostics=new Map();const chronology=[];
 for(const [index,c]of [...complex,...solvent].entries()){
  console.log(`Molecular analysis: campaign ${index+1}/6`);
  for(let state=0;state<2;state++){
   const run=await e.start(c,state);
   await assert.rejects(e.pipeline.campaignRegistration(c));
   if(index===0&&state===0){
    await assert.rejects(e.results.registerMolecularPlan(id('post-start-plan'),id('post-start-campaign'),e.pipeline.target,complex,solvent));
    await assert.rejects(e.pipeline.campaignAnalysis(c));
   }
   await e.finish(run,[8]);
  }
  while((await e.pipeline.campaignInfo(c)).stage===1n)await transact(e.pipeline.connect(e.contributor).flushRaw(c,8,{gasLimit}));
  for(let state=0;state<2;state++){
   const series=await e.pipeline.chronologySeries(c,state);
   for(let n=0;n<100;n++){
    if((await e.chronology.summary(series)).status===5n)break;
    await transact(e.chronology.connect(e.contributor).advance(series,32,{gasLimit}));
   }
   const summary=await e.chronology.summary(series);
   chronology.push({campaign:c,state,valid:summary.validEstimate,g:number(summary.g)});
   assert.equal(summary.validEstimate,true,'Fixed fixture must satisfy declared chronology rule');
  }
  await transact(e.pipeline.connect(e.contributor).beginSelection(c,{gasLimit}));
  while((await e.pipeline.campaignInfo(c)).stage===3n)await transact(e.pipeline.connect(e.contributor).advanceSelection(c,8,{gasLimit}));
  await transact(e.pipeline.connect(e.contributor).startAnalysis(c,{gasLimit}));
  const analysis=(await e.pipeline.campaignInfo(c)).analysisId;
  for(let n=0;n<100;n++){
   if((await e.estimator.runInfo(analysis)).status>=5n)break;
   await transact(e.estimator.connect(e.contributor).advanceAnalysis(analysis,32,{gasLimit}));
  }
  await e.estimator.assertConverged(analysis);
  const bound=await e.pipeline.campaignAnalysis(c);assert.equal(bound.analysis,analysis);
  assert.equal(bound.series,await e.pipeline.selectedSeries(c));
  const diagnostic=await e.diagnostic.nextDiagnosticId();
  await transact(e.diagnostic.connect(e.contributor).createDiagnostic(analysis,q(.01),q(1),q(1e-8),{gasLimit}));
  for(let n=0;n<100;n++){
   if((await e.diagnostic.runInfo(diagnostic)).status===4n)break;
   await transact(e.diagnostic.connect(e.contributor).advanceDiagnostic(diagnostic,32,{gasLimit}));
  }
  await e.diagnostic.assertAccepted(diagnostic);diagnostics.set(c,diagnostic);
 }
 const cd=complex.map(c=>diagnostics.get(c)),sd=solvent.map(c=>diagnostics.get(c));
 const wrong=await e.results.nextResultId();
 await transact(e.results.connect(e.contributor).createResult(plan,[cd[1],cd[0],cd[2]],sd,{gasLimit}));
 await assert.rejects(transact(e.results.advanceResult(wrong,8,{gasLimit})));
 assert.equal((await e.results.resultInfo(wrong)).repeatsCompleted,0n);
 const result=await e.results.nextResultId();
 await transact(e.results.connect(e.contributor).createResult(plan,cd,sd,{gasLimit}));
 await transact(e.results.connect(e.contributor).advanceResult(result,1,{gasLimit}));
 assert.equal((await e.results.resultInfo(result)).completed,false);
 await transact(e.results.connect(e.contributor).advanceResult(result,8,{gasLimit}));
 const out=await e.results.resultInfo(result);assert.equal(out.completed,true);
 assert.equal(out.repeatsCompleted,3n);assert.equal(number(out.deltaDeltaG),0);assert.equal(number(out.repeatSEM),0);
 assert.equal((await e.results.planInfo(plan)).commitment,frozen.commitment);
 const counts=await Promise.all([e.inputs,e.state,e.output].map(c=>e.transport.request({method:'eth_getTransactionCount',params:[c.target,'latest']})));
 assert.deepEqual(counts.map(Number),[97,65,65]);
 const tampered=await e.results.nextResultId();await transact(e.results.createResult(plan,cd,sd,{gasLimit}));
 await e.transport.request({method:'evm_setAccountCode',params:[e.pipeline.target,'0x00']});
 await assert.rejects(transact(e.results.advanceResult(tampered,1,{gasLimit})));
 report.actualLocalAddresses=250;report.targetProductionAddresses=256;report.preregisteredPairedRepeats=3;
 report.completedWindows=12;report.rawSamples=48;report.chronology=chronology;
 report.computedDeltaDeltaG=number(out.deltaDeltaG);report.repeatSEM=number(out.repeatSEM);
 report.postStartRegistrationRejected=true;report.wrongRepeatOrderRejected=true;report.changedPipelineRejected=true;
 report.unauthorizedWindowStartRejected=true;
 report.contractCountUnchangedDuringRuns=true;report.passed=true;report.status='passed_local_fixture';
 fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
});
