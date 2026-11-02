import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {id,ZeroHash} from 'ethers';
import {setup,gasLimit} from './molecular-pipeline-fixture.mjs';
import {transact,quadFromNumber as q,quadToNumber as num,qvec} from './helpers.mjs';
const reportPath='reports/constrained_molecular_pipeline_validation.json';
test('Constrained substeps commit only after authenticated SHAKE/RATTLE convergence',async t=>{
 const report={passed:false,status:'in_progress',testSha256:createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'),scope:'Two-atom constrained dynamics prototype, not production molecular acceptance.',mainnetTransactionsSent:0};
 const save=()=>fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');save();
 const e=await setup(t,{banked:true,constraints:true});report.compilation=e.compilation;
 const endpoint={particles:[[1,0,1,0],[2,0,-.5,0]].map(qvec),nonbonded:[[.5,0,0],[.5,0,0]].map(qvec),bonds:[[0,1,q(1),q(1)]],angles:[],torsions:[],exceptions:[]};
 const source={positions:[[0,0,0],[1,0,0]].map(qvec),a:endpoint,b:JSON.parse(JSON.stringify(endpoint)),box:qvec([8,8,8]),switchDistance:q(2),cutoff:q(3),prefactor:q(1),alpha:q(.75),extent:1,softcoreAlpha:q(.5)};
 const {tid}=await e.makeTopology(source,[q(0),q(1)]);
 const stream=await e.stream('ORVIA.FullModelConstraintTriples.v1',[0,1,q(1)]),set=id('constrained dimer set');
 await transact(e.constraintCatalog.createSet(set,tid,stream,1,id('one distance fixed for every lambda'),{gasLimit}));
 await transact(e.constraintCatalog.advance(set,8,{gasLimit}));
 const constraints={setId:set,positionTolerance:q(1e-24),velocityTolerance:q(1e-24),maxSweeps:32};
 const observations=[];let serial=0;
 async function campaign(dt=1/64){const cid=id(`constrained pipeline campaign ${++serial}`);await transact(e.pipeline.createConstrainedCampaign(cid,{...e.policy(tid),dt:q(dt),friction:q(0),equilibrationSteps:0},constraints,{gasLimit}));return cid;}
 async function step(run,work,outsider=false){
  let handoff=false;const before=await e.stateAt(run,2);
  for(let n=0;n<1000;n++){
   const info=await e.pipeline.runInfo(run);if(info.step>=1n){assert.equal(info.step,1n);return handoff;}
   assert.notEqual(info.stage,17n);
   if(info.step===0n)assert.deepEqual(await e.stateAt(run,2),before,'Partial substeps must not replace committed state');
   if(outsider&&info.stage===15n&&!handoff){
    const projection=(await e.pipeline.constraintRunInfo(run)).problem;
    for(let k=0;k<100;k++){const p=await e.constraintSolver.problemInfo(projection);if(p.status>=3n)break;await transact(e.constraintSolver.connect(e.contributor).advance(projection,8,{gasLimit}));}
    handoff=true;
   }
   await e.advance(run,outsider&&!handoff?1:work);
  }assert.fail('bounded constrained step did not finish');
 }
 for(const work of [8,1]){
  console.log(`Constraint pipeline partition ${work}`);const cid=await campaign(),run=await e.start(cid,0);
  await e.initialize(run);const initial=await e.stateAt(run,2);
  assert.deepEqual(initial.map(s=>s[0]),source.positions);
  assert.equal(await step(run,work,work===8),work===8);
  const final=await e.stateAt(run,2);observations.push(final);
  const p=final.map(s=>s[0].map(num)),v=final.map(s=>s[1].map(num));
  const d=p[1].map((x,k)=>x-p[0][k]),dv=v[1].map((x,k)=>x-v[0][k]);
  assert.ok(Math.abs(d.reduce((s,x)=>s+x*x,0)-1)<1e-14);
  assert.ok(Math.abs(d.reduce((s,x,k)=>s+x*dv[k],0))<1e-14);
  assert.notEqual((await e.pipeline.constraintRunInfo(run)).transcript,ZeroHash);
  for(let n=0;n<100;n++){
   try{await e.pipeline.sampleInfo(cid,0);break;}catch{}
   await e.advance(run,1);
  }
  assert.notEqual(await e.pipeline.sampleConstraintTranscript(cid,0),ZeroHash);
 }
 assert.deepEqual(observations[0],observations[1]);
 const reference=execFileSync(process.env.ORVIA_REFERENCE_PYTHON||process.env.ORVIA_RESEARCH_PYTHON||process.env.CODEX_PRIMARY_RUNTIME_PYTHON||'python3',['reference/constrained_pipeline_reference.py'],{input:JSON.stringify(observations[0]),encoding:'utf8'});
 report.reference=JSON.parse(reference);assert.equal(report.reference.passed,true);
 const bad=await campaign(2),badRun=await e.start(bad,0);await e.initialize(badRun);
 const checkpoint=(await e.pipeline.runInfo(badRun)).checkpoint;const old=await e.stateAt(badRun,2);
 for(let n=0;n<500;n++){if((await e.pipeline.runInfo(badRun)).stage===17n)break;await e.advance(badRun,8);}
 const failed=await e.pipeline.runInfo(badRun);assert.equal(failed.stage,17n);assert.equal(failed.step,0n);assert.equal(failed.checkpoint,checkpoint);
 assert.deepEqual(await e.stateAt(badRun,2),old);await assert.rejects(e.pipeline.sampleInfo(bad,0));
 await assert.rejects(e.pipeline.advance(badRun,8));
 const off=JSON.parse(JSON.stringify(source));off.positions[1][0]=q(1.125);
 const offTopology=await e.makeTopology(off,[q(0),q(1)]),offSet=id('off manifold set'),offCampaign=id('off manifold campaign');
 await transact(e.constraintCatalog.createSet(offSet,offTopology.tid,stream,1,id('initial positions must already satisfy constraints'),{gasLimit}));
 await transact(e.constraintCatalog.advance(offSet,8,{gasLimit}));
 await transact(e.pipeline.createConstrainedCampaign(offCampaign,{...e.policy(offTopology.tid),friction:q(0)}, {...constraints,setId:offSet},{gasLimit}));
 const offRun=await e.start(offCampaign,0);
 for(let n=0;n<100;n++){if((await e.pipeline.runInfo(offRun)).stage===17n)break;await e.advance(offRun,8);}
 assert.equal((await e.pipeline.runInfo(offRun)).stage,17n);assert.equal((await e.pipeline.runInfo(offRun)).checkpoint,ZeroHash);
 await assert.rejects(e.pipeline.sampleInfo(offCampaign,0));report.offManifoldInitialPositionsRejected=true;
 report.failedStepKeepsCommittedCheckpoint=true;report.outsiderCompletionHandoff=true;report.partitionBitwiseEqual=true;
 report.actualLocalAddresses=e.coreDeployments.length+224;report.oneStep=observations[0];report.passed=true;report.status='passed_local_fixture';
 report.candidateSha256=createHash('sha256').update(fs.readFileSync('contracts/core/MolecularSimulationPipeline.sol')).digest('hex');save();
});
