import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {id,ZeroHash} from 'ethers';
import {setup,gasLimit} from './molecular-pipeline-fixture.mjs';
import {transact,quadFromNumber as q,quadToNumber as num,qvec} from './helpers.mjs';
const reportPath='reports/constrained_molecular_extra_validation.json';
const referencePath='reference/constrained_pipeline_extra_reference.py';
const candidate='contracts/core/MolecularSimulationPipeline.sol';
const fixture='test/molecular-pipeline-fixture.mjs';
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
test('nonzero-force stochastic constrained step, continued lineage and preregistration policy binding', {timeout:900000},async t=>{
 const report={passed:false,status:'incomplete',scope:'Synthetic 3-atom constrained stochastic pipeline candidate; no production ensemble acceptance.',publicTransactionsSent:0,historicalIsolatedPass:{reportSha256:'3a17601026573a4977065190625c6417dc06018895acdeec5449c6bb24f4f069',testSha256:'a7b22cff1fafa62fa125f6511fb088856b93dac9587c116e3fd1491ac35a2c1e',referenceSha256:'6335a0a4b08561a1f01cd75102c15d93a88096d17ce13c3d81635e3688981e7c',preservedAt:'../output/256-constraint-extra-validation/historical-passed'},checks:[]};
 const save=()=>fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');save();
 try{
 report.files={candidate:sha(candidate),fixture:sha(fixture),test:sha(import.meta.filename),reference:sha(referencePath)};
 const e=await setup(t,{banked:true,analysis:true,constraints:true});report.compilation=e.compilation;save();
 const endpoint={particles:[[1,0,1,0],[2,0,-.5,0],[3,.125,.25,-.125]].map(qvec),nonbonded:[[.5,0,0],[.5,0,0],[.5,0,0]].map(qvec),
  bonds:[[1,2,q(2),q(1)]],angles:[],torsions:[],exceptions:[]};
 const source={positions:[[0,0,0],[1,0,0],[1,1.25,0]].map(qvec),a:endpoint,b:JSON.parse(JSON.stringify(endpoint)),box:qvec([8,8,8]),
  switchDistance:q(2),cutoff:q(3),prefactor:q(0),alpha:q(.75),extent:1,softcoreAlpha:q(.5)};
 const {tid}=await e.makeTopology(source,[q(0),q(1)]);
 const stream=await e.stream('ORVIA.FullModelConstraintTriples.v1',[0,1,q(1)]),set=id('extra constrained edge 0-1');
 await transact(e.constraintCatalog.createSet(set,tid,stream,1,id('synthetic one-edge selection'),{gasLimit}));
 await transact(e.constraintCatalog.advance(set,8,{gasLimit}));
 const constraints={setId:set,positionTolerance:q(1e-24),velocityTolerance:q(1e-24),maxSweeps:32};
 let serial=0;
 async function create(leg,seed,changes={},cp=constraints,constrained=true){
  const cid=id('extra campaign '+ ++serial),policy={...e.policy(tid),dt:q(1/64),friction:q(.5),kT:q(.25),equilibrationSteps:0,leg,seed,...changes};
  await transact(constrained?e.pipeline.createConstrainedCampaign(cid,policy,cp,{gasLimit}):e.pipeline.createCampaign(cid,policy,{gasLimit}));
  return{cid,policy};
 }
 const complex=[],solvent=[];
 for(let i=0;i<3;i++){const seed=id('extra repeat '+i);complex.push(await create(id('ORVIA.COMPLEX.v1'),seed));solvent.push(await create(id('ORVIA.SOLVENT.v1'),seed));}
 const cx=complex.map(x=>x.cid),sv=solvent.map(x=>x.cid);
 for(const changes of [{positionTolerance:q(2e-24)},{velocityTolerance:q(2e-24)},{maxSweeps:31}]){
  const bad=await create(id('ORVIA.SOLVENT.v1'),complex[0].policy.seed,{}, {...constraints,...changes});
  const reg=(await e.pipeline.campaignRegistration(bad.cid)),good=(await e.pipeline.campaignRegistration(solvent[0].cid));
  assert.notEqual(reg.samplingPolicyHash,good.samplingPolicyHash);
  await assert.rejects(e.results.registerMolecularPlan.staticCall(id('bad-'+serial),id('bad-campaign-'+serial),e.pipeline.target,cx,[bad.cid,...sv.slice(1)]));
 }
 const unconstrained=await create(id('ORVIA.SOLVENT.v1'),complex[0].policy.seed,{},constraints,false);
 await assert.rejects(e.results.registerMolecularPlan.staticCall(id('wrong-method'),id('wrong-method-campaign'),e.pipeline.target,cx,[unconstrained.cid,...sv.slice(1)]));
 const otherSet=id('alternate same targets different declared policy');
 await transact(e.constraintCatalog.createSet(otherSet,tid,stream,1,id('distinct scientific policy'),{gasLimit}));
 await transact(e.constraintCatalog.advance(otherSet,8,{gasLimit}));
 const other=await create(id('ORVIA.COMPLEX.v1'),complex[2].policy.seed,{}, {...constraints,setId:otherSet});
 await assert.rejects(e.results.registerMolecularPlan.staticCall(id('model-mismatch'),id('model-mismatch-campaign'),e.pipeline.target,[...cx.slice(0,2),other.cid],sv));
 await transact(e.results.registerMolecularPlan(id('valid plan'),id('valid registered campaign'),e.pipeline.target,cx,sv,{gasLimit}));
 report.checks.push('constraint tolerances, sweep cap, method and per-leg model are preregistration-bound');save();
 const run=await e.start(complex[0].cid,0);await e.initialize(run);
 await assert.rejects(e.results.registerMolecularPlan.staticCall(id('late plan'),id('late campaign'),e.pipeline.target,cx,sv));
 report.checks.push('registration succeeds before windows and rejects after a window starts');save();
 const policy=complex[0].policy;
 async function normals(step){const out=[];for(let atom=0;atom<3;atom++){
  const one=await e.random.normalPair(policy.seed,policy.stream,Number(policy.replica)<<8,step,atom*2);
  const two=await e.random.normalPair(policy.seed,policy.stream,Number(policy.replica)<<8,step,atom*2+1);out.push([one[0],one[1],two[0]]);
 }return out;}
 async function toStep(run,target,work){for(let n=0;n<700;n++){
  const info=await e.pipeline.runInfo(run);if(info.step===BigInt(target))return;
  assert(info.step<BigInt(target));assert.notEqual(info.stage,17n);await e.advance(run,work);
 }assert.fail('step failed to finish');}
 async function toReady(run){for(let n=0;n<300;n++){if((await e.pipeline.runInfo(run)).stage===4n)return;await e.advance(run,1);}assert.fail('sample did not return to Ready');}
 const rows=[];
 let initial=await e.stateAt(run,3);
 assert.equal(num(initial[1][2][1]),.5);assert.equal(num(initial[2][2][1]),-.5,'nonzero tangential force must exercise B kicks');
 const normal0=await normals(0);assert(normal0.flat().some(x=>num(x)!==0));
 await toStep(run,1,1);const first=await e.stateAt(run,3);rows.push({step:1,initial,actual:first,normal:normal0});
 await toReady(run);const transcript=(await e.pipeline.constraintRunInfo(run)).transcript;
 assert.equal(await e.pipeline.sampleConstraintTranscript(complex[0].cid,0),transcript);
 report.checks.push('nonzero tangential forces and nonzero-friction OU step completed with authenticated sample transcript');report.observations=rows;save();
 const checkpoint=await e.transport.request({method:'evm_snapshot',params:[]});
 initial=await e.stateAt(run,3);const normal1=await normals(1);
 await toStep(run,2,8);const uninterrupted=await e.stateAt(run,3);rows.push({step:2,initial,actual:uninterrupted,normal:normal1});
 await e.transport.request({method:'evm_revert',params:[checkpoint]});
 const child=await e.pipeline.nextRun();await transact(e.pipeline.continueWindow(run,{gasLimit}));
 assert.equal((await e.pipeline.constraintRunInfo(child)).transcript,transcript);
 assert.equal((await e.pipeline.runInfo(run)).stage,12n);
 await assert.rejects(e.pipeline.advance.staticCall(run,1));
 await e.initialize(child);assert.deepEqual(await e.stateAt(child,3),first);
 await toStep(child,2,8);assert.deepEqual(await e.stateAt(child,3),uninterrupted);
 await toReady(child);
 const childTranscript=(await e.pipeline.constraintRunInfo(child)).transcript;
 assert.notEqual(childTranscript,transcript);assert.equal(await e.pipeline.sampleConstraintTranscript(complex[0].cid,1),childTranscript);
 assert.equal((await e.pipeline.sampleInfo(complex[0].cid,1)).run,child);
 report.checks.push('continued child preserves prior transcript/checkpoint and reproduces next stochastic step bit-for-bit');save();
 report.reference=JSON.parse(execFileSync(process.env.ORVIA_RESEARCH_PYTHON||process.env.CODEX_PRIMARY_RUNTIME_PYTHON||'python3',[referencePath],{input:JSON.stringify(rows),encoding:'utf8'}));
 assert.equal(report.reference.passed,true);report.checks.push('independent 110-digit two-step B/A/O/A/B forces and constrained positions/velocities');
 for(const[file,hash]of Object.entries(report.compilation.sourceSha256))assert.equal(sha(file),hash,'Compiled source changed: '+file);
 assert.equal(sha(candidate),report.files.candidate);assert.equal(sha(fixture),report.files.fixture);
 assert.equal(sha(import.meta.filename),report.files.test);assert.equal(sha(referencePath),report.files.reference);
 report.passed=true;report.status='passed_local_fixture';report.completedAt=new Date().toISOString();save();
 }catch(error){report.status='failed';report.error=error.message;save();throw error;}
});
