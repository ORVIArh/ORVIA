import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import ganache from 'ganache';
import {BrowserProvider,Contract,id,keccak256,toBeHex,zeroPadValue,ZeroHash} from 'ethers';
import {artifacts,deploy,transact,quadFromNumber as q,qvec} from './helpers.mjs';

const python=process.env.ORVIA_RESEARCH_PYTHON||process.env.CODEX_PRIMARY_RUNTIME_PYTHON||'python3';
const word=x=>typeof x==='number'?toBeHex(x,32):zeroPadValue(x,32);
const gasLimit=28_000_000;
const copy=x=>JSON.parse(JSON.stringify(x));

async function setup(t){
 const transport=ganache.provider({logging:{quiet:true},chain:{chainId:31337,hardfork:'shanghai',allowUnlimitedContractSize:true},miner:{blockGasLimit:30_000_000},wallet:{totalAccounts:3}});
 t.after(()=>transport.disconnect());const provider=new BrowserProvider(transport);provider.pollingInterval=10;
 const owner=await provider.getSigner(0),contributor=await provider.getSigner(1),ownerAddress=await owner.getAddress();
 const math=await deploy('FloatMath',owner),ma=await math.getAddress();
 const scalar=await deploy('ScalarMath',owner,[ma]),elementary=await deploy('ElementaryMath',owner,[ma]);
 const random=await deploy('CounterRandom',owner,[ma,await scalar.getAddress(),await elementary.getAddress()]);
 const integrator=await deploy('LangevinBAOABKernel',owner,[ma,await scalar.getAddress()]);
 const registry=await deploy('ExperimentRegistry',owner,[ownerAddress]);
 const geometry=await deploy('OrthorhombicGeometry',owner,[ma]);
 const bond=await deploy('HarmonicBondKernel',owner,[ma]);
 const angle=await deploy('HarmonicAngleKernel',owner,[ma,await elementary.getAddress()]);
 const torsion=await deploy('PeriodicTorsionKernel',owner,[ma,await elementary.getAddress()]);
 const lj=await deploy('LennardJonesKernel',owner,[ma]);
 const softcore=await deploy('SoftcoreLennardJonesKernel',owner,[ma]);
 const realSpace=await deploy('EwaldRealSpaceKernel',owner,[ma,await scalar.getAddress()]);
 const reciprocal=await deploy('EwaldReciprocalKernel',owner,[ma,await scalar.getAddress(),await elementary.getAddress()]);
 const corrections=await deploy('EwaldCorrections',owner,[ma,await scalar.getAddress()]);
 const inputs=await deploy('PartitionedInputCatalog',owner,[ownerAddress]);
 const topology=await deploy('AlchemicalTopologyCatalog',owner,[ownerAddress,await inputs.getAddress(),ma,await geometry.getAddress()]);
 const all={registry,topology,math,integrator,random,geometry,bond,angle,torsion,lj,softcore,realSpace,reciprocal,corrections,inputs,scalar,elementary};
 const addresses=Object.fromEntries(await Promise.all(Object.entries(all).map(async([k,v])=>[k,await v.getAddress()])));
 const pipeline=await deploy('MolecularSimulationPipeline',owner,[ownerAddress,Object.fromEntries(['registry','topology','math','integrator','random'].map(k=>[k,addresses[k]]))]);
 const state=await deploy('ShardedWorkingState',owner,[await pipeline.getAddress()]);
 const modules=Object.fromEntries(['registry','topology','math','geometry','bond','angle','torsion','lj','softcore','realSpace','reciprocal','corrections'].map(k=>[k,addresses[k]]));
 const hamiltonian=await deploy('AlchemicalHamiltonianEvaluator',owner,[await pipeline.getAddress(),modules]);
 const output=await deploy('ShardedWorkingState',owner,[await hamiltonian.getAddress()]);
 const collector=await deploy('ReducedPotentialCollector',owner,[await pipeline.getAddress(),ma]);
 const chronology=await deploy('TimeSeriesDiagnostics',owner,[await pipeline.getAddress(),ma]);
 const estimator=await deploy('MBARFreeEnergyEstimator',owner,[await collector.getAddress(),ma,await scalar.getAddress()]);
 await transact(pipeline.bind(await state.getAddress(),await hamiltonian.getAddress(),await output.getAddress(),await collector.getAddress(),await chronology.getAddress(),await estimator.getAddress(),{gasLimit}));
 const protocol=id('ORVIA-ALCHEMICAL-PIPELINE-VALIDATION');
 const registered=[...Object.values(addresses),...await Promise.all([pipeline,state,hamiltonian,output,collector,chronology,estimator].map(c=>c.getAddress()))];
 await transact(registry.registerProtocol(protocol,id('Unconstrained finite hybrid model fixture; not molecular acceptance'),registered));
 let serial=0;
 async function stream(role,values){
  if(!values.length)return ZeroHash;const sid=id(`hybrid-stream-${++serial}`),r=id(role);
  await transact(inputs.beginStream(sid,r,values.length));
  for(let start=0;start<values.length;start+=4096){
   const chunk=values.slice(start,start+4096);const receipt=await transact(inputs.createPage(r,chunk.length));
   const event=receipt.logs.map(x=>{try{return inputs.interface.parseLog(x)}catch{return null}}).find(x=>x?.name==='PageCreated');
   const page=new Contract(event.args.page,artifacts.DataPage.abi,owner);
   for(let i=0;i<chunk.length;i+=128)await transact(page.append(chunk.slice(i,i+128).map(word)));
   await transact(page.seal(await page.rollingDigest()));await transact(inputs.appendPage(sid,await page.getAddress()));
  }
  await transact(inputs.sealStream(sid));return sid;
 }
 async function makeTopology(source,lambdas=[q(0),q(.5),q(1)]){
  const endpoint=async e=>({particles:await stream('PARTICLES',e.particles.flat()),nonbonded:await stream('NONBONDED',e.nonbonded.flat()),bonds:await stream('BONDS',e.bonds.flat()),angles:await stream('ANGLES',e.angles.flat()),torsions:await stream('TORSIONS',e.torsions.flat()),exceptions:await stream('EXCEPTIONS',e.exceptions.flat())});
  const d={modelPolicy:id('Declared finite fixture model; not drug inputs'),dummyPolicy:id('All fixture atoms physical; no disappearing atoms'),positions:await stream('POSITIONS',source.positions.flat()),a:await endpoint(source.a),b:await endpoint(source.b),atoms:source.positions.length,bonds:source.a.bonds.length,angles:source.a.angles.length,torsions:source.a.torsions.length,exceptions:source.a.exceptions.length,box:source.box,switchDistance:source.switchDistance,cutoff:source.cutoff,prefactor:source.prefactor,ewaldAlpha:source.alpha,ewaldExtent:source.extent,softcoreAlpha:source.softcoreAlpha};
  const tid=id(`hybrid-topology-${++serial}`);await transact(topology.create(tid,d,lambdas,{gasLimit}));
  for(let n=0;n<100;++n){if((await topology.info(tid)).stage===6n)return{tid,d,lambdas};await transact(topology.connect(contributor).advance(tid,8,{gasLimit}));}
  assert.fail('topology validation did not finish');
 }
 const policy=tid=>({protocol,topology:tid,leg:id('ORVIA.SOLVENT.v1'),seed:id('Pipeline repeat seed'),stream:id('Pipeline declared random stream'),replica:7,dt:q(1/32),friction:q(2),kT:q(1),equilibrationSteps:1,stride:1,samplesPerState:4,maxLag:1,minimumChronologySamples:4,mbarTolerance:q(1e-10),overlapThreshold:q(.01),minimumESS:q(1),normalizationTolerance:q(1e-8),maxMbarIterations:1000});
 async function campaign(tid,overrides={}){const cid=id(`hybrid-campaign-${++serial}`);await transact(pipeline.createCampaign(cid,{...policy(tid),...overrides},{gasLimit}));return cid;}
 async function start(cid,stateIndex){const run=await pipeline.nextRun();await transact(pipeline.startWindow(cid,stateIndex,{gasLimit}));return run;}
 const gas=[];
 async function advance(run,work=8){const before=await pipeline.runInfo(run);const receipt=await transact(pipeline.connect(contributor).advance(run,work,{gasLimit}));gas.push({run:String(run),stage:Number(before.stage),step:String(before.step),work,gas:String(receipt.gasUsed)});return pipeline.runInfo(run);}
 async function initialize(run){for(let n=0;n<2000;++n){if((await pipeline.runInfo(run)).stage===4n)return;await advance(run,1);}assert.fail('initialization did not finish');}
 async function finish(run,schedule=[8]){for(let n=0;n<5000;++n){if((await pipeline.runInfo(run)).stage===11n)return;await advance(run,schedule[n%schedule.length]);}assert.fail('window did not finish');}
 async function stateAt(run,atoms){const r=[];for(let n=0;n<atoms;++n){const s=await pipeline.stateAt(run,n);r.push(s.map(x=>[...x]));}return r;}
 return{transport,provider,owner,contributor,math,topology,inputs,pipeline,state,output,hamiltonian,collector,chronology,estimator,protocol,makeTopology,campaign,start,advance,initialize,finish,stateAt,gas};
}

function richFixture(){
 const p=JSON.parse(fs.readFileSync('reference/periodic_reference.json')).inputs;
 const a={particles:p.particles,nonbonded:p.nonbonded,bonds:p.bonds,angles:p.angles,torsions:p.torsions,exceptions:p.exceptions};
 const b=copy(a);b.bonds[0][2]=q(3);b.angles[0][3]=q(.75);b.torsions[0][5]=q(.375);b.nonbonded[0]=[q(.625),q(.1875),q(.25)];b.nonbonded[3][2]=q(-.125);b.exceptions[1][4]=q(.09375);b.exceptions[1][5]=q(-.0625);
 return{positions:p.positions,a,b,box:p.box,switchDistance:p.switchDistance,cutoff:p.cutoff,prefactor:p.prefactor,alpha:q(.75),extent:1,softcoreAlpha:q(.5)};
}
function harmonicFixture(){
 const a={particles:[[1,.125,0,0],[2,-.0625,0,0]].map(qvec),nonbonded:[[.5,0,0],[.5,0,0]].map(qvec),bonds:[[0,1,q(.25),q(1)]],angles:[],torsions:[],exceptions:[]};
 const b=copy(a);b.bonds[0][2]=q(.5);b.bonds[0][3]=q(.875);
 return{positions:[[0,0,0],[1.25,.25,.125]].map(qvec),a,b,box:qvec([8,8,8]),switchDistance:q(2),cutoff:q(3),prefactor:q(1),alpha:q(.75),extent:1,softcoreAlpha:q(.5)};
}

test('A molecular writer computes the entire selected Hamiltonian and authenticates sampling/continuation',async t=>{
 execFileSync(python,['-c','import mpmath; assert mpmath.__version__ == "1.3.0"']);
 const e=await setup(t);const report={scope:'Actual source-registered small molecular snapshots and NVT writer; not prepared myosin, physical sampling acceptance or mainnet workload.',passed:false};
 let rich,richer;let successfulChecks=0;
 await t.test('all endpoint and intermediate bonded/LJ/Ewald energy components and forces match independent differentiated scalar energy',async()=>{
  rich=richFixture();richer=await e.makeTopology(rich);const cid=await e.campaign(richer.tid);const comparisons=[];
  for(let state=0;state<3;++state){
   const run=await e.start(cid,state);await e.initialize(run);
   const evaluation=await e.pipeline.evaluationHistory(run,0);const components=[...await e.hamiltonian.components(evaluation)];const force=[];for(let atom=0;atom<4;++atom)force.push([...await e.hamiltonian.forceAt(evaluation,atom)]);
   const reference=JSON.parse(execFileSync(python,['reference/hybrid_hamiltonian.py'],{input:JSON.stringify({source:rich,positions:rich.positions,lambda:richer.lambdas[state]}),encoding:'utf8'}));
   const diagnostic={state,source:rich,positions:rich.positions,lambda:richer.lambdas[state],components,forces:force,reference,passed:false};fs.writeFileSync(`reports/molecular_hamiltonian_case_${state}.json`,JSON.stringify(diagnostic,null,2)+'\n');
   const compared=JSON.parse(execFileSync(python,['-c',`import json,sys,mpmath as m;sys.path.insert(0,'reference');from scalar_random_reference import quad;m.mp.dps=90;p=json.load(sys.stdin);errors=[]\nfor i,(a,b) in enumerate(zip(p['actual'],p['expected'])):\n e=abs(quad(a)-m.mpf(b));assert e<=m.mpf('1e-25')+abs(m.mpf(b))*m.mpf('1e-24'),str((i,quad(a),m.mpf(b),e));errors.append(e)\nprint(json.dumps({'compared':len(errors),'maximumAbsoluteError':str(max(errors))}))`],{input:JSON.stringify({actual:[...components,...force.flat()],expected:[...reference.components,...reference.forces.flat()]}),encoding:'utf8'}));
   diagnostic.passed=true;fs.writeFileSync(`reports/molecular_hamiltonian_case_${state}.json`,JSON.stringify(diagnostic,null,2)+'\n');
   comparisons.push({state,lambda:richer.lambdas[state],...compared});
  }
  report.fullHamiltonian=comparisons;++successfulChecks;
 });
 await t.test('registered hybrid topology rejects mass/topology substitution and external forces/energies',async()=>{
  const badMass=copy(rich);badMass.b.particles[0][0]=q(99);await assert.rejects(e.makeTopology(badMass));
  const badTopology=copy(rich);badTopology.b.bonds[0][1]=2;await assert.rejects(e.makeTopology(badTopology));
  assert.equal(e.pipeline.interface.getFunction('appendSample'),null);
  assert.equal(e.pipeline.interface.getFunction('writeForce'),null);
  assert.equal(e.pipeline.interface.getFunction('setPosition'),null);
  await assert.rejects(e.collector.appendSample(id('not owned'),0,1,[q(0),q(0)]));
  await assert.rejects(e.hamiltonian.registerEvaluation(e.protocol,richer.tid,0,await e.state.getAddress(),ZeroHash,0,9));
  report.noExternalResultInput=true;++successfulChecks;
 });
 await t.test('absolute stochastic counters and exact immutable source state survive a real continuation across transaction partitions',async()=>{
  const source=harmonicFixture();const{tid}=await e.makeTopology(source,[q(0),q(1)]);const ca=await e.campaign(tid),cb=await e.campaign(tid);
  const a0=await e.start(ca,0),a1=await e.start(ca,1),b0=await e.start(cb,0),b1=await e.start(cb,1);
  await e.initialize(a0);await e.initialize(b0);assert.deepEqual(await e.stateAt(a0,2),await e.stateAt(b0,2));
  const initial=await e.stateAt(a0,2),reference=JSON.parse(execFileSync(python,['reference/hybrid_hamiltonian.py'],{input:JSON.stringify({source,positions:source.positions,lambda:q(0)}),encoding:'utf8'}));
  execFileSync(python,['-c',`import json,sys,mpmath as m;sys.path.insert(0,'reference');from scalar_random_reference import quad;m.mp.dps=90;p=json.load(sys.stdin)\nfor a,b in zip(p['actual'],p['expected']):assert abs(quad(a)-m.mpf(b))<=m.mpf('1e-25')+abs(m.mpf(b))*m.mpf('1e-24')`],{input:JSON.stringify({actual:initial.flatMap(x=>x[2]),expected:reference.forces.flat()}),encoding:'utf8'});
  const before=await e.stateAt(b0,2);await e.advance(b0,1);assert.deepEqual(await e.stateAt(b0,2),before,'uncommitted drift is invisible');
  for(let n=0;n<2000;++n){const info=await e.pipeline.runInfo(b0);if(info.step===2n&&info.stage===4n)break;await e.advance(b0,1);if(n===1999)assert.fail('continuation barrier not reached');}
  const parent=await e.pipeline.runInfo(b0),parentState=await e.stateAt(b0,2),child=await e.pipeline.nextRun();await transact(e.pipeline.continueWindow(b0,{gasLimit}));
  assert.equal((await e.pipeline.runInfo(b0)).stage,12n);assert.equal((await e.pipeline.runInfo(child)).parent,b0);await assert.rejects(e.pipeline.advance(b0,1));
  await e.finish(a0,[8]);await e.finish(child,[1,8,3,2]);assert.deepEqual(await e.stateAt(child,2),await e.stateAt(a0,2));assert.deepEqual(await e.stateAt(b0,2),parentState,'continued parent checkpoint stays readable');
  assert.equal((await e.pipeline.runInfo(child)).step,5n);assert.equal(parent.step,2n);
  // Deliberately finish the other state in a different interleaving order.
  await e.finish(b1,[3,1,8]);await e.finish(a1,[8]);
  for(const cid of[ca,cb])for(let n=0;n<4;++n){if((await e.pipeline.campaignInfo(cid)).stage===2n)break;await transact(e.pipeline.flushRaw(cid,8,{gasLimit}));}
  const sa=await e.pipeline.rawSeries(ca),sb=await e.pipeline.rawSeries(cb);assert.equal((await e.collector.seriesInfo(sa)).isSealed,true);assert.equal((await e.collector.seriesInfo(sb)).isSealed,true);
  for(let n=0;n<8;++n){assert.deepEqual([...await e.collector.sampleInfo(sa,n)],[...await e.collector.sampleInfo(sb,n)]);for(let k=0;k<2;++k){assert.equal(await e.collector.potential(sa,n,k),await e.collector.potential(sb,n,k));assert.equal(await e.pipeline.sampleEnergy(ca,n,k),await e.pipeline.sampleEnergy(cb,n,k));}}
  report.continuation={atoms:2,states:2,globalSteps:5,samples:8,partitionInvariant:true,interleavingInvariant:true,preservedParent:true};
  for(const cid of[ca,cb])for(let k=0;k<2;++k){const ts=await e.pipeline.chronologySeries(cid,k);for(let n=0;n<100;++n){if((await e.chronology.summary(ts)).status===5n)break;await transact(e.chronology.advance(ts,8,{gasLimit}));}}
  await assert.rejects(e.pipeline.startAnalysis(ca));await assert.rejects(e.pipeline.beginSelection(ca));report.inadequateChronologyCannotBecomeAcceptedMBAR=true;++successfulChecks;
 });
 report.passed=successfulChecks===3;report.status=report.passed?'passed':'failed';fs.writeFileSync('reports/molecular_pipeline_validation.json',JSON.stringify(report,null,2)+'\n');
 fs.writeFileSync('reports/molecular_pipeline_gas.json',JSON.stringify({scope:report.scope,chainId:31337,transactions:e.gas},null,2)+'\n');
});
