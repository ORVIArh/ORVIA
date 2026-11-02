import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {setup,harmonicFixture,gasLimit} from './molecular-pipeline-fixture.mjs';
import {transact,quadFromNumber as q,qvec,quadToNumber as num} from './helpers.mjs';
const require=createRequire(new URL('../package.json',import.meta.url));
const {id,ZeroHash,AbiCoder,keccak256,encodeBytes32String}=require('ethers');
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const out=new URL('../reports/complete-256/',import.meta.url),plain=x=>Array.isArray(x)?Array.from(x,plain):x;
const abi=AbiCoder.defaultAbiCoder();

test('Actual256 addresses connect bounded storage, constraints, spatial H and analysis',async t=>{
 const report={schemaVersion:1,status:'in_progress',passed:false,mainnetTransactionsSent:0,
  scope:'32 actual local core contracts plus224 fixed banks; constrained on-chain step/sample and separate two-state selected analysis; raw C4 remains standalone, no full-model/ensemble acceptance.',
  sourceSha256:{test:hash(new URL(import.meta.url)),fixture:hash('test/molecular-pipeline-fixture.mjs'),pipeline:hash('contracts/core/MolecularSimulationPipeline.sol'),hamiltonian:hash('contracts/core/AlchemicalHamiltonianEvaluator.sol')},checks:[]};
 fs.mkdirSync(out,{recursive:true});const save=()=>fs.writeFileSync(new URL('connected-validation.json',out),JSON.stringify(report,null,2)+'\n');save();
 try{
  const e=await setup(t,{full256:true,bindSpatial:false});report.compilation=e.compilation;
  const inventory=JSON.parse(fs.readFileSync(new URL('deployment-runtime-input.json',out)));
  assert.equal(inventory.core.length,32);assert.equal(inventory.banks.length,224);assert.equal(inventory.actualLocalAddresses,256);
  const addresses=[...inventory.core,...inventory.banks].map(x=>x.address);assert.equal(new Set(addresses).size,256);
  const nonce=async()=>Promise.all([e.inputs,e.state,e.output].map(c=>e.transport.request({method:'eth_getTransactionCount',params:[c.target,'latest']})));
  const initialNonces=await nonce();assert.deepEqual(initialNonces.map(Number),[97,65,65]);
  report.actualLocalAddresses=256;report.deploymentInventorySha256=hash(new URL('deployment-runtime-input.json',out));report.coreDeploymentGas=inventory.coreDeploymentGas;report.bankCreationGas=inventory.bankCreationGas;save();
  console.log('256 integration: owner/rebind/pre-campaign freeze checks');
  await assert.rejects(e.pipeline.connect(e.contributor).bindSpatial.staticCall(e.spatialIndex.target,e.spatialPairs.target));
  await assert.rejects(e.pipeline.bindSpatial.staticCall(e.spatialPairs.target,e.spatialIndex.target));
  await assert.rejects(e.hamiltonian.bindSpatial.staticCall(e.spatialIndex.target,e.spatialPairs.target));
  const unbound=await e.transport.request({method:'evm_snapshot',params:[]});
  const f=harmonicFixture();f.b=JSON.parse(JSON.stringify(f.a));
  const pre=await e.makeTopology(f,[q(0),q(1)]),preCampaign=await e.campaign(pre.tid);
  assert.equal(await e.pipeline.campaignCount(),1n);assert.equal(await e.pipeline.nextRun(),1n);
  await assert.rejects(e.pipeline.bindSpatial.staticCall(e.spatialIndex.target,e.spatialPairs.target));
  assert.equal(await e.hamiltonian.spatialIndex(),'0x0000000000000000000000000000000000000000');
  assert.equal(await e.transport.request({method:'evm_revert',params:[unbound]}),true);
  assert.equal(await e.pipeline.campaignCount(),0n);
  await transact(e.pipeline.bindSpatial(e.spatialIndex.target,e.spatialPairs.target,{gasLimit}));
  await assert.rejects(e.pipeline.bindSpatial.staticCall(e.spatialIndex.target,e.spatialPairs.target));
  assert.equal(await e.hamiltonian.spatialIndex(),e.spatialIndex.target);assert.equal(await e.hamiltonian.spatialPairs(),e.spatialPairs.target);
  report.checks.push('Owner-only, wrong modules, direct EOA H binding, rebinding, and binding after a campaign but before a run rejected');save();
  console.log('256 integration: raw C4 exact known case (standalone only)');
  const c4=await e.c4.evaluate(qvec([2,0,0]),q(8));assert.equal(c4.energy,q(-.5));assert.deepEqual([...c4.forceOnA],qvec([1,0,0]));
  report.rawC4={energy:c4.energy,forceOnA:[...c4.forceOnA],standaloneOnly:true,integratedAlchemicalC4:false};save();
  console.log('256 integration: three paired repeat preregistration');
  const {tid,d}=await e.makeTopology(f,[q(0),q(1)]),complex=[],solvent=[];
  for(let r=0;r<3;r++){
   const seed=id('256 declared repeat '+r);complex.push(await e.campaign(tid,{seed,leg:await e.results.COMPLEX_LEG(),maxLag:3}));solvent.push(await e.campaign(tid,{seed,leg:await e.results.SOLVENT_LEG(),maxLag:3}));
  }
  assert.equal(await e.pipeline.campaignCount(),6n);
  const reg=await e.pipeline.campaignRegistration(complex[0]);
  const p={...e.policy(tid),seed:id('256 declared repeat 0'),leg:await e.results.COMPLEX_LEG(),maxLag:3};
  const ptype=e.pipeline.interface.getFunction('createCampaign').inputs[1];
  const bounds=await Promise.all(Array.from({length:5},(_,i)=>e.pipeline.boundHashes(i)));
  const base=keccak256(abi.encode(['bytes32','uint256','address','bytes32','bytes32','bytes32','bytes32[5]',ptype,'bytes32'],[encodeBytes32String('ORVIA-MOLECULAR-CAMPAIGN-v1'),31337,e.pipeline.target,complex[0],await e.registry.assertProtocol(e.protocol),await e.pipeline.coreConfigurationHash(),bounds,p,await e.topology.assertTopology(tid)]));
  const spatialConfig=keccak256(abi.encode(['bytes32','address','bytes32','address','bytes32'],[await e.hamiltonian.SPATIAL_POLICY_ID(),e.spatialIndex.target,await e.hamiltonian.spatialIndexCodeHash(),e.spatialPairs.target,await e.hamiltonian.spatialPairsCodeHash()]));
  assert.equal(reg.commitment,keccak256(abi.encode(['bytes32','bytes32','bytes32'],[base,encodeBytes32String('ORVIA-SPATIAL-CONFIG-v1'),spatialConfig])));
  const plan=id('256 preregistered plan'),campaignHash=id('256 paired research fixtures');
  await assert.rejects(e.results.connect(e.contributor).registerMolecularPlan.staticCall(plan,campaignHash,e.pipeline.target,complex,solvent));
  await assert.rejects(e.results.registerMolecularPlan.staticCall(plan,campaignHash,e.pipeline.target,[complex[0],complex[0],complex[2]],solvent));
  await transact(e.results.registerMolecularPlan(plan,campaignHash,e.pipeline.target,complex,solvent,{gasLimit}));
  assert.equal((await e.results.molecularPlanInfo(plan)).source,e.pipeline.target);
  for(const c of [...complex,...solvent]){const r=await e.pipeline.campaignRegistration(c);await assert.rejects(e.collector.seriesInfo(r.selectedSeries));}
  report.preregisteredPairedRepeats=3;report.campaignCommitmentBindsExactSpatialIdentity=true;report.checks.push('All six repeat campaigns preregistered before windows or selected sample series exist');save();
  console.log('256 integration: constrained step and sampled snapshot via spatial H');
  const endpoint={particles:[[1,0,1,0],[2,0,-.5,0]].map(qvec),nonbonded:[[.5,0,0],[.5,0,0]].map(qvec),bonds:[[0,1,q(1),q(1)]],angles:[],torsions:[],exceptions:[]};
  const constrained={positions:[[0,0,0],[1,0,0]].map(qvec),a:endpoint,b:JSON.parse(JSON.stringify(endpoint)),box:qvec([8,8,8]),switchDistance:q(2),cutoff:q(3),prefactor:q(1),alpha:q(.75),extent:1,softcoreAlpha:q(.5)};
  const ct=await e.makeTopology(constrained,[q(0),q(1)]),stream=await e.stream('ORVIA.FullModelConstraintTriples.v1',[0,1,q(1)]),set=id('256 exact dimer constraint');
  await transact(e.constraintCatalog.createSet(set,ct.tid,stream,1,id('same fixed dimer distance in each state'),{gasLimit}));await transact(e.constraintCatalog.advance(set,8,{gasLimit}));
  const cc=id('256 constrained sampled campaign'),cp={setId:set,positionTolerance:q(1e-24),velocityTolerance:q(1e-24),maxSweeps:32};
  await transact(e.pipeline.createConstrainedCampaign(cc,{...e.policy(ct.tid),dt:q(1/64),friction:q(0),equilibrationSteps:0},cp,{gasLimit}));
  const cr=await e.start(cc,0);await e.initialize(cr);const old=(await e.pipeline.runInfo(cr)).checkpoint,oldWords=plain(await e.state.readWords(old,0,19));
  let constrainedSample;
  for(let n=0;n<1000;n++){
   const r=await e.pipeline.runInfo(cr);assert.notEqual(r.stage,17n,'Constraint failure is not successful integration');
   try{constrainedSample=await e.pipeline.sampleInfo(cc,0);break;}catch{}
   await e.advance(cr,[8,3,1][n%3]);
  }
  assert(constrainedSample,'Constrained sample must be recorded');assert.equal(constrainedSample.step,1n);assert.notEqual(await e.pipeline.sampleConstraintTranscript(cc,0),ZeroHash);
  assert.deepEqual(plain(await e.state.readWords(old,0,19)),oldWords);
  const state=await e.stateAt(cr,2),pos=state.map(x=>x[0].map(num)),vel=state.map(x=>x[1].map(num)),delta=pos[1].map((x,k)=>x-pos[0][k]),dv=vel[1].map((x,k)=>x-vel[0][k]);
  assert(Math.abs(delta.reduce((s,x)=>s+x*x,0)-1)<1e-14);assert(Math.abs(delta.reduce((s,x,k)=>s+x*dv[k],0))<1e-14);
  const constraintEvaluations=3n;let spatialEvaluations=0;
  for(let i=0n;i<constraintEvaluations;i++){const h=await e.pipeline.evaluationHistory(cr,i);if((await e.hamiltonian.spatialInfo(h)).used)++spatialEvaluations;}
  assert(spatialEvaluations>=3);await assert.rejects(e.pipeline.evaluationHistory(cr,3));report.constrained={run:String(cr),sampleStep:'1',spatialEvaluations,immutableInitialCheckpointRetained:true,snapshot:constrainedSample.snapshot,transcript:await e.pipeline.sampleConstraintTranscript(cc,0)};save();
  console.log('256 integration: two windows and eight authenticated samples');
  const c=complex[0],runs=[];
  for(let s=0;s<2;s++){
   console.log('256 integration: analysis state '+s);const run=await e.start(c,s);await e.finish(run,[8]);runs.push(String(run));
   for(let i=0;i<4;i++){const sample=await e.pipeline.sampleInfo(c,s*4+i);assert.equal(sample.run,run);assert.notEqual(sample.snapshotCommitment,ZeroHash);assert.equal(await e.pipeline.sampleEnergy(c,s*4+i,0),await e.pipeline.sampleEnergy(c,s*4+i,1));}
  }
  while((await e.pipeline.campaignInfo(c)).stage===1n)await transact(e.pipeline.flushRaw(c,8,{gasLimit}));
  const chronology=[];
  for(let s=0;s<2;s++){const series=await e.pipeline.chronologySeries(c,s);for(let n=0;n<100;n++){if((await e.chronology.summary(series)).status===5n)break;await transact(e.chronology.advance(series,32,{gasLimit}));}const summary=await e.chronology.summary(series);chronology.push({state:s,valid:summary.validEstimate,g:num(summary.g)});assert.equal(summary.validEstimate,true);}
  await transact(e.pipeline.beginSelection(c,{gasLimit}));while((await e.pipeline.campaignInfo(c)).stage===3n)await transact(e.pipeline.advanceSelection(c,8,{gasLimit}));
  await transact(e.pipeline.startAnalysis(c,{gasLimit}));const analysis=(await e.pipeline.campaignInfo(c)).analysisId;
  for(let n=0;n<100;n++){if((await e.estimator.runInfo(analysis)).status>=5n)break;await transact(e.estimator.advanceAnalysis(analysis,32,{gasLimit}));}
  await e.estimator.assertConverged(analysis);assert.equal((await e.pipeline.campaignAnalysis(c)).analysis,analysis);
  const diagnostic=await e.diagnostic.nextDiagnosticId();await transact(e.diagnostic.createDiagnostic(analysis,q(.01),q(1),q(1e-8),{gasLimit}));
  for(let n=0;n<100;n++){if((await e.diagnostic.runInfo(diagnostic)).status===4n)break;await transact(e.diagnostic.advanceDiagnostic(diagnostic,32,{gasLimit}));}await e.diagnostic.assertAccepted(diagnostic);
  report.analysis={campaign:c,runs,completedWindows:2,rawSamples:8,chronology,analysisId:String(analysis),diagnosticId:String(diagnostic),identicalEndpointsDeltaF:num(await e.estimator.fAt(analysis,1)),completeThreeRepeatAggregation:false};
  assert.deepEqual(await nonce(),initialNonces);report.noChildContractsCreatedDuringRuns=true;report.pipelineAdvanceGas=e.gas.reduce((s,x)=>s+BigInt(x.gas),0n).toString();report.advancements=e.gas;
  for(const [file,expected]of Object.entries(e.compilation.sourceSha256)){assert.equal(hash(file),expected);}
  assert.equal(hash(new URL(import.meta.url)),report.sourceSha256.test);assert.equal(hash('test/molecular-pipeline-fixture.mjs'),report.sourceSha256.fixture);
  report.passed=true;report.status='passed_local_fixture';
 }finally{save();}
});
