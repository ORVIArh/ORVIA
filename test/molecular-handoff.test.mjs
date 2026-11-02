import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {transact,quadFromNumber as q} from './helpers.mjs';
import {setup,harmonicFixture,gasLimit} from './molecular-pipeline-fixture.mjs';

test('Permissionless force-job completion cannot strand its authenticated molecular pipeline',async t=>{
 const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const report={scope:'Adversarial local molecular-job handoff, not mainnet or ensemble acceptance.',status:'in_progress',passed:false,
  testSourceSha256:sha(new URL(import.meta.url)),fixtureSourceSha256:sha(new URL('./molecular-pipeline-fixture.mjs',import.meta.url))};
 fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/molecular_handoff_validation.json',JSON.stringify(report,null,2)+'\n');
 const e=await setup(t),{tid}=await e.makeTopology(harmonicFixture(),[q(0),q(1)]),campaign=await e.campaign(tid),run=await e.start(campaign,0);
 report.compilation=e.compilation;
 let passed=0;let evaluation;
 await t.test('an outsider may finish the initial force calculation and the pipeline consumes it idempotently',async()=>{
  while((await e.pipeline.runInfo(run)).stage===1n)await e.advance(run,1);
  evaluation=await e.pipeline.evaluationHistory(run,0);
  for(let n=0;n<20;++n){if((await e.hamiltonian.runInfo(evaluation)).stage===11n)break;await transact(e.hamiltonian.connect(e.contributor).advance(evaluation,8,{gasLimit}));}
  assert.equal((await e.hamiltonian.runInfo(evaluation)).stage,11n);
  assert.deepEqual([...await e.hamiltonian.advance.staticCall(evaluation,8)],[0n,true]);
  await e.initialize(run);const info=await e.pipeline.runInfo(run);assert.equal(info.stage,4n);assert.equal(info.step,0n);
  const source=(await e.hamiltonian.runInfo(evaluation)).input.sourceNamespace;
  for(let atom=0;atom<2;++atom)for(let axis=0;axis<3;++axis)assert.equal(await e.state.readWord(source,atom*9+axis),await e.state.readWord(info.checkpoint,atom*9+axis));
  report.initialForceExternalCompletion=true;report.positionPreservingForceCommit=true;++passed;
 });
 await t.test('completed-job idempotency still enforces immutable dependencies and work bounds',async()=>{
  for(const work of[0,9])await assert.rejects(e.hamiltonian.advance.staticCall(evaluation,work));
  const address=await e.math.getAddress(),original=await e.provider.getCode(address);
  await e.transport.request({method:'evm_setAccountCode',params:[address,'0x60006000fd']});
  try{await assert.rejects(e.hamiltonian.advance.staticCall(evaluation,1));}
  finally{await e.transport.request({method:'evm_setAccountCode',params:[address,original]});}
  assert.deepEqual([...await e.hamiltonian.advance.staticCall(evaluation,1)],[0n,true]);
  report.completedResultDependenciesRetained=true;++passed;
 });
 await t.test('an outsider may also finish a cross-state evaluation without losing the molecular sample',async()=>{
  let cross;
  for(let n=0;n<500;++n){
   const info=await e.pipeline.runInfo(run);
   if(info.stage===9n){
    for(let index=0;index<100;++index){try{cross=await e.pipeline.evaluationHistory(run,index);}catch{break;}}
    break;
   }
   await e.advance(run,1);
  }
  assert.ok(cross);assert.equal((await e.pipeline.runInfo(run)).stage,9n);
  const crossSource=(await e.hamiltonian.runInfo(cross)).input.sourceNamespace;
  for(let n=0;n<20;++n){if((await e.hamiltonian.runInfo(cross)).stage===11n)break;await transact(e.hamiltonian.connect(e.contributor).advance(cross,8,{gasLimit}));}
  assert.equal((await e.hamiltonian.runInfo(cross)).stage,11n);
  for(let n=0;n<20;++n){if((await e.pipeline.runInfo(run)).stage===10n)break;await e.advance(run,1);}
  assert.equal((await e.pipeline.runInfo(run)).stage,10n);await e.advance(run,1);
  const sample=await e.pipeline.sampleInfo(campaign,0);assert.equal(sample.step,2n);assert.equal(sample.run,run);
  assert.equal(sample.snapshot,crossSource);
  assert.equal(await e.pipeline.sampleEnergy(campaign,0,1),(await e.hamiltonian.result(cross)).energy);
  assert.equal(await e.pipeline.sampleEnergy(campaign,0,0),(await e.hamiltonian.result(await e.pipeline.evaluationHistory(run,2))).energy);
  report.crossStateExternalCompletion=true;++passed;
 });
 report.passed=passed===3;report.status=report.passed?'passed':'failed';fs.writeFileSync('reports/molecular_handoff_validation.json',JSON.stringify(report,null,2)+'\n');
});
