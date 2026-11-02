import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AbiCoder, Contract, encodeBytes32String, id, keccak256, toBeHex, zeroPadValue } from 'ethers';
import { artifacts, environment, deploy, transact, quadFromNumber as q, quadToNumber, qvec } from './helpers.mjs';
const input=JSON.parse(fs.readFileSync('reference/periodic_reference.json','utf8')).inputs;
const word=x=>typeof x==='number'?toBeHex(x,32):zeroPadValue(x,32);
const gasLimit=28_000_000;
test('Neighbor dynamics preserves the exhaustive Hamiltonian, ordering and commit barriers',async t=>{
 const env=await environment();t.after(()=>env.transport.disconnect());const{owner,contributor}=env,ownerAddress=await owner.getAddress();
 const math=await deploy('FloatMath',owner),mathAddress=await math.getAddress();
 const elementary=await deploy('ElementaryMath',owner,[mathAddress]),elementaryAddress=await elementary.getAddress();
 const registry=await deploy('ExperimentRegistry',owner,[ownerAddress]);
 const base=await deploy('DatasetCatalog',owner,[ownerAddress]);
 const dynamics=await deploy('DynamicsDataset',owner,[ownerAddress,await base.getAddress()]);
 const dataset=await deploy('PeriodicDataset',owner,[ownerAddress,await dynamics.getAddress()]);
 const integrator=await deploy('VelocityVerletKernel',owner,[mathAddress]);
 const bond=await deploy('HarmonicBondKernel',owner,[mathAddress]);
 const angle=await deploy('HarmonicAngleKernel',owner,[mathAddress,elementaryAddress]);
 const torsion=await deploy('PeriodicTorsionKernel',owner,[mathAddress,elementaryAddress]);
 const lj=await deploy('LennardJonesKernel',owner,[mathAddress]),coulomb=await deploy('CoulombPairKernel',owner,[mathAddress]);
 const geometry=await deploy('OrthorhombicGeometry',owner,[mathAddress]);
 const nonbonded=await deploy('SwitchedNonbondedKernel',owner,[mathAddress,await lj.getAddress(),await coulomb.getAddress()]);
 const inline=await deploy('InlineNonbondedKernel',owner);
 const modules=Object.fromEntries(await Promise.all(Object.entries({registry,dataset,math,integrator,bond,angle,torsion,lj,coulomb,elementary,geometry,nonbonded}).map(async([n,c])=>[n,await c.getAddress()])));
 const exhaustive=await deploy('PeriodicDynamicsCoordinator',owner,[ownerAddress,modules]);
 const exhaustivePage=await deploy('WorkingStatePage',owner,[await exhaustive.getAddress()]);
 await transact(exhaustive.bindWorkingPage(await exhaustivePage.getAddress()));
 const engine=await deploy('NeighborDynamicsCoordinator',owner,[ownerAddress,modules]);
 const page=await deploy('WorkingStatePage',owner,[await engine.getAddress()]);
 const neighbors=await deploy('NeighborList',owner,[await engine.getAddress(),mathAddress,await geometry.getAddress(),await page.getAddress()]);
 await transact(engine.bindWorkingPage(await page.getAddress(),await neighbors.getAddress()));
 const inlineModules={...modules,nonbonded:await inline.getAddress()};
 const optimized=await deploy('NeighborDynamicsCoordinator',owner,[ownerAddress,inlineModules]);
 const inlinePage=await deploy('WorkingStatePage',owner,[await optimized.getAddress()]);
 const inlineNeighbors=await deploy('NeighborList',owner,[await optimized.getAddress(),mathAddress,await geometry.getAddress(),await inlinePage.getAddress()]);
 await transact(optimized.bindWorkingPage(await inlinePage.getAddress(),await inlineNeighbors.getAddress()));
 const protocol=id('ORVIA-NEIGHBOR-VALIDATION'),specification=id('Neighbor versus allpairs research fixture');
 const addresses=[...Object.values(modules),await base.getAddress(),await dynamics.getAddress(),await exhaustive.getAddress(),await exhaustivePage.getAddress(),await engine.getAddress(),await page.getAddress(),await neighbors.getAddress(),await inline.getAddress(),await optimized.getAddress(),await inlinePage.getAddress(),await inlineNeighbors.getAddress()];
 await transact(registry.registerProtocol(protocol,specification,addresses));
 let sequence=0;const gas=[],runs=[];const validation={scope:"Local EVM comparison against the exhaustive periodic cutoff engine; not prepared protein or mainnet validation",passed:false};
  async function pages(factory, role, values, split) {
    if (!values.length) return [];
    const chunks = split && split < values.length ? [values.slice(0, split), values.slice(split)] : [values];
    const addresses = [];
    for (const chunk of chunks) {
      const receipt = await transact(factory.createPage(role, chunk.length));
      const event = receipt.logs.map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
        .find(x => x?.name === 'PageCreated');
      assert.ok(event);
      const p = new Contract(event.args.page, artifacts.DataPage.abi, owner);
      for (let start = 0; start < chunk.length; start += 128) await transact(p.append(chunk.slice(start, start + 128).map(word)));
      await transact(p.seal(await p.rollingDigest()));
      addresses.push(await p.getAddress());
    }
    return addresses;
  }

  async function createDataset(values) {
    const serial = ++sequence, baseId = id(`dynamics-base-${serial}`), datasetId = id(`periodic-dataset-${serial}`), dynamicsId = id(`periodic-dynamics-${serial}`);
    const positionPages = await pages(base, await base.POSITION_ROLE(), values.positions.flat(), 5);
    const bondPages = await pages(base, await base.BOND_ROLE(), values.bonds.flat(), 3);
    await transact(base.registerDataset(baseId, positionPages, bondPages, values.positions.length, values.bonds.length));
    const registration = {
      baseDatasetId: baseId,
      particlePages: await pages(dynamics, await dynamics.PARTICLE_ROLE(), values.particles.flat(), 5),
      anglePages: await pages(dynamics, await dynamics.ANGLE_ROLE(), values.angles.flat(), 4),
      torsionPages: await pages(dynamics, await dynamics.TORSION_ROLE(), values.torsions.flat(), 5),
      pairPages: await pages(dynamics, await dynamics.PAIR_ROLE(), values.pairs.flat()),
      angleCount: values.angles.length, torsionCount: values.torsions.length, pairCount: values.pairs.length
    };
    await transact(dynamics.registerDataset(dynamicsId, registration));
    await transact(dataset.registerDataset(datasetId, {
      dynamicsDatasetId: dynamicsId,
      nonbondedPages: await pages(dataset, await dataset.NONBONDED_ROLE(), values.nonbonded.flat(), 4),
      exceptionPages: await pages(dataset, await dataset.EXCEPTION_ROLE(), values.exceptions.flat(), 5),
      exceptionCount: values.exceptions.length, box: values.box, switchDistance: values.switchDistance,
      cutoff: values.cutoff, prefactor: values.prefactor
    }));
    return datasetId;
  }


 const dataId=await createDataset(input);
 async function register(catalogId=dataId,dt=input.dt,steps=input.steps,skin=q(.5),baseline=false){const c=baseline===true?exhaustive:baseline===false?engine:baseline,r=await c.nextExperimentId();await transact(c===exhaustive?c.registerExperiment(protocol,catalogId,dt,steps):c.registerExperiment(protocol,catalogId,dt,steps,skin));const info=await dataset.datasetInfo(catalogId);runs.push({implementation:c===exhaustive?'PeriodicDynamicsCoordinator':c===optimized?'NeighborDynamicsCoordinator:inline':'NeighborDynamicsCoordinator:external',runId:String(r),datasetId:catalogId,atoms:Number(info.atomCount),bondCount:Number(info.bondCount),angleCount:Number(info.angleCount),torsionCount:Number(info.torsionCount),allPairCount:Number(info.pairCount),dt,steps,skin:c===exhaustive?null:skin});return r;}
 async function state(c,r){const i=await c.runInfo(r),positions=[],velocities=[],forces=[];for(let a=0;a<Number(i.atomCount);a++){const v=await c.stateAt(r,a);positions.push([...v[0]]);velocities.push([...v[1]]);forces.push([...v[2]]);}return{step:Number(i.completedSteps),positions,velocities,forces,energy:i.potentialEnergy};}
 async function advance(c,r,work,label){const before=await c.runInfo(r),receipt=await transact(c.connect(contributor).advanceExperiment(r,work,{gasLimit}));gas.push({engine:label,implementation:c===exhaustive?'PeriodicDynamicsCoordinator':c===optimized?'NeighborDynamicsCoordinator:inline':'NeighborDynamicsCoordinator:external',runId:String(r),stage:Number(before.status),work,gasUsed:String(receipt.gasUsed)});return await c.runInfo(r);}
 async function initialize(c,r,label){const target=c===exhaustive?10n:11n;for(let n=0;n<300;n++){if((await c.runInfo(r)).status===target)return;await advance(c,r,1,label);}assert.fail('initialization timeout');}
 async function complete(c,r,schedule,label){const out=[],last=c===exhaustive?16n:18n;let seen=Number((await c.runInfo(r)).completedSteps);for(let n=0;n<500;n++){const i=await advance(c,r,schedule[n%schedule.length],label);if(Number(i.completedSteps)>seen){seen=Number(i.completedSteps);out.push(await state(c,r));}if(i.status===last)return out;}assert.fail('run timeout');}
 const baseline=await register(dataId,input.dt,input.steps,q(.5),true),first=await register(),second=await register();
 let expected,finalState,initialState;
 await t.test('initial neighbor forces exactly match exhaustive forces including periodic bonded images',async()=>{
  await initialize(exhaustive,baseline,'allpairs');await initialize(engine,first,'neighbors');initialState=await state(engine,first);assert.deepEqual(initialState,await state(exhaustive,baseline));
  const info=await engine.runInfo(first),list=await neighbors.listInfo(info.stateNamespace);assert.equal(list.generation,1n);assert.equal(list.candidateCount,5n);
  await assert.rejects(neighbors.connect(contributor).beginEvaluation(info.stateNamespace,0));
 });
 await t.test('all three timesteps and face crossing remain bitwise equal while list rebuilds and reuses',async()=>{
  expected=await complete(exhaustive,baseline,[8],'allpairs');const actual=await complete(engine,first,[8],'neighbors');assert.deepEqual(actual,expected);assert.equal(actual.length,3);finalState=actual.at(-1);assert.ok(quadToNumber(finalState.positions[0][0])>8);
  const info=await engine.runInfo(first),list=await neighbors.listInfo(info.stateNamespace);assert.equal(list.generation,2n);assert.equal(list.reuseCount,2n);assert.equal((await page.namespaceInfo(info.stateNamespace)).isSealed,true);validation.periodic={atoms:4,steps:3,bitwiseComparedScalars:148,builds:Number(list.generation),reuses:Number(list.reuseCount),candidateCount:Number(list.candidateCount)};
 });
 await t.test('pinned inline policy preserves every complete trajectory checkpoint and reduces actual advancement gas',async()=>{
  assert.equal(await engine.nonbondedPolicy(),await engine.EXTERNAL_NONBONDED_POLICY());
  assert.equal(await optimized.nonbondedPolicy(),await optimized.INLINE_NONBONDED_POLICY());
  const coder=AbiCoder.defaultAbiCoder(),inlineHashes=await Promise.all(Object.values(inlineModules).map(async a=>keccak256(await env.provider.getCode(a))));
  const boundCore=keccak256(coder.encode(['tuple(address registry,address dataset,address math,address integrator,address bond,address angle,address torsion,address lj,address coulomb,address elementary,address geometry,address nonbonded)','bytes32[12]'],[inlineModules,inlineHashes]));
  assert.equal(await optimized.coreConfigurationHash(),boundCore);
  assert.notEqual(boundCore,await engine.coreConfigurationHash());
  const r=await register(dataId,input.dt,input.steps,q(.5),optimized);
  await initialize(optimized,r,'inline-primary');assert.deepEqual(await state(optimized,r),initialState);
  const checkpoints=await complete(optimized,r,[8],'inline-primary');assert.deepEqual(checkpoints,expected);
  const total=label=>gas.filter(x=>x.engine===label).reduce((sum,x)=>sum+BigInt(x.gasUsed),0n);
  const externalGas=total('neighbors'),inlineGas=total('inline-primary');
  assert.ok(inlineGas<externalGas,'entire identical fixture advancement must improve, not just pair microbenchmark');
  validation.inline={policy:await optimized.nonbondedPolicy(),kernelRuntimeHash:keccak256(await env.provider.getCode(await inline.getAddress())),initialAndCompletedCheckpoints:checkpoints.length+1,bitwiseEqual:true,externalAdvancementGas:String(externalGas),inlineAdvancementGas:String(inlineGas),gasReductionPercent:100*Number(externalGas-inlineGas)/Number(externalGas),scope:'Same four-atom, three-step trajectory and batching; advancement only, excluding deployments and input preparation; local chain 31337'};
 });
 await t.test('inline trajectory remains exact across interruption, arbitrary batching and isolated namespaces',async()=>{
  const r=await register(dataId,input.dt,input.steps,q(.5),optimized);
  await initialize(optimized,r,'inline-partition');
  const before=await state(optimized,r);await advance(optimized,r,1,'inline-partition');
  assert.deepEqual(await state(optimized,r),before,'partial drift cannot replace committed coordinates');
  await complete(optimized,r,[1,8,3,2],'inline-partition');assert.deepEqual(await state(optimized,r),finalState);
  const info=await optimized.runInfo(r);assert.equal((await inlinePage.namespaceInfo(info.stateNamespace)).isSealed,true);
  validation.inline.partitionInvariant=true;validation.inline.commitBarrier=true;
 });
 await t.test('arbitrary transaction partition preserves final state and namespace isolation',async()=>{
  await complete(engine,second,[1,8,3,2],'partition');assert.deepEqual(await state(engine,second),finalState);const a=await engine.runInfo(first),b=await engine.runInfo(second);assert.notEqual(a.stateNamespace,b.stateNamespace);assert.equal((await neighbors.listInfo(b.stateNamespace)).generation,2n);validation.partitionInvariant=true;
  await assert.rejects(engine.advanceExperiment(first,1));await assert.rejects(engine.bindWorkingPage(await page.getAddress(),await neighbors.getAddress()));
 });
 await t.test('skin and neighbor module identity are bound to the independently reconstructed run commitment',async()=>{
  const coder=AbiCoder.defaultAbiCoder(),hash=(types,values)=>keccak256(coder.encode(types,values));
  const moduleHashes=await Promise.all(Object.values(modules).map(async a=>keccak256(await env.provider.getCode(a))));
  const core=hash(['tuple(address registry,address dataset,address math,address integrator,address bond,address angle,address torsion,address lj,address coulomb,address elementary,address geometry,address nonbonded)','bytes32[12]'],[modules,moduleHashes]);assert.equal(await engine.coreConfigurationHash(),core);
  const pageAddress=await page.getAddress(),listAddress=await neighbors.getAddress();
  const config=hash(['bytes32','address','bytes32','address','bytes32'],[core,pageAddress,keccak256(await env.provider.getCode(pageAddress)),listAddress,keccak256(await env.provider.getCode(listAddress))]);assert.equal(await engine.configurationHash(),config);
  const ns=hash(['bytes32','uint256','address','uint256'],[encodeBytes32String('ORVIA-NEIGHBOR-STATE-v1'),31337,await engine.getAddress(),first]);
  const manifest=await registry.assertProtocol(protocol);
  const commitment=hash(['bytes32','uint256','address','uint256','bytes32','bytes32','bytes32','bytes32','bytes16','uint32','bytes16','bytes32'],[encodeBytes32String('ORVIA-NEIGHBOR-RUN-v1'),31337,await engine.getAddress(),first,manifest,dataId,(await dataset.datasetInfo(dataId)).commitment,config,input.dt,input.steps,q(.5),ns]);assert.equal((await engine.runInfo(first)).commitment,commitment);
  for(const skin of[q(0),q(-1),q(1)])await assert.rejects(engine.registerExperiment(protocol,dataId,input.dt,1,skin));
 });
 await t.test('failed next force evaluation rolls back both external and inline preparation and staged state',async()=>{
  const values={positions:[[0,0,0],[2,0,0]].map(qvec),particles:[[1,1,0,0],[1,-1,0,0]].map(qvec),bonds:[[0,1,q(0),q(1)]],angles:[],torsions:[],pairs:[],nonbonded:[[.5,0,0],[.5,0,0]].map(qvec),exceptions:[],box:qvec([8,8,8]),switchDistance:q(2),cutoff:q(3),prefactor:q(1)};
  const data=await createDataset(values);
  for(const c of[engine,optimized]){
   const p=c===engine?page:inlinePage,list=c===engine?neighbors:inlineNeighbors;
   const r=await register(data,q(1),1,q(.5),c);await initialize(c,r,'rollback');
   await advance(c,r,4,'rollback');const before=[...await c.runInfo(r)],ns=before[3],listBefore=[...await list.listInfo(ns)],raw=[...await p.readWords(ns,0,38)];
   await assert.rejects(transact(c.advanceExperiment(r,8,{gasLimit})));assert.deepEqual([...await c.runInfo(r)],before);assert.deepEqual([...await list.listInfo(ns)],listBefore);assert.deepEqual([...await p.readWords(ns,0,38)],raw);assert.equal(before[5],0n);
  }
  validation.inline.failureRollback=true;
 });
 await t.test('inline admission rejects copied identifiers, incompatible math runtime and mismatched external dependencies',async()=>{
  const forged=await deploy('ForgedInlineKernelIdentity',owner);
  await assert.rejects(deploy('NeighborDynamicsCoordinator',owner,[ownerAddress,{...modules,nonbonded:await forged.getAddress()}]));
  const forgedMath=await deploy('ForgedFloatMathIdentity',owner);
  const originalMathCode=await env.provider.getCode(mathAddress),forgedMathCode=await env.provider.getCode(await forgedMath.getAddress());
  await env.transport.request({method:'evm_setAccountCode',params:[mathAddress,forgedMathCode]});
  try{await assert.rejects(deploy('NeighborDynamicsCoordinator',owner,[ownerAddress,inlineModules]));}
  finally{await env.transport.request({method:'evm_setAccountCode',params:[mathAddress,originalMathCode]});}
  await assert.rejects(deploy('NeighborDynamicsCoordinator',owner,[ownerAddress,{...modules,lj:await coulomb.getAddress()}]));
  const r=await register(dataId,input.dt,1,q(.5),optimized),before=[...await optimized.runInfo(r)];
  const inlineAddress=await inline.getAddress(),inlineCode=await env.provider.getCode(inlineAddress);
  await env.transport.request({method:'evm_setAccountCode',params:[inlineAddress,await env.provider.getCode(await forged.getAddress())]});
  try{await assert.rejects(transact(optimized.advanceExperiment(r,1,{gasLimit})));assert.deepEqual([...await optimized.runInfo(r)],before);}
  finally{await env.transport.request({method:'evm_setAccountCode',params:[inlineAddress,inlineCode]});}
  validation.inline.forgedIdentityRejection=true;
  validation.inline.moduleCodeChangeRejection=true;
 });
 await t.test('sparse-system cutoff pairs and distant direct exceptions match while neighbor reuse reduces work',async()=>{
  const values={positions:[[0,0,0],[.75,0,0],[4,1,0],[4.75,1,0],[8,2,0],[8.75,2,0]].map(qvec),particles:Array.from({length:6},()=>[12,1,0,0].map(q)),bonds:[[0,1,q(0),q(.75)]],angles:[],torsions:[],pairs:[],nonbonded:Array.from({length:6},(_,i)=>[.25,.015625,i%2?-.125:.125].map(q)),exceptions:[[0,4,2,q(.25),q(.03125),q(-.0625)]],box:qvec([20,20,20]),switchDistance:q(1.5),cutoff:q(2),prefactor:q(1)};
  const d=await createDataset(values),a=await register(d,q(1/64),2,q(.5),true),b=await register(d,q(1/64),2,q(.5));
  await initialize(exhaustive,a,'sparse-allpairs');await initialize(engine,b,'sparse-neighbors');assert.deepEqual(await state(engine,b),await state(exhaustive,a));
  const ns=(await engine.runInfo(b)).stateNamespace;assert.equal((await neighbors.listInfo(ns)).candidateCount,4n);
  assert.deepEqual(await complete(engine,b,[8],'sparse-neighbors'),await complete(exhaustive,a,[8],'sparse-allpairs'));
  const info=await neighbors.listInfo(ns);assert.equal(info.generation,1n);assert.equal(info.reuseCount,2n);validation.sparse={atoms:6,steps:2,bitwiseComparedScalars:165,builds:1,reuses:2,candidateCount:4,allPairCount:15,directExceptionBeyondCutoff:true};
 });
 await t.test('an empty candidate list skips pair stages without skipping timestep commits',async()=>{
  const values={positions:[[0,0,0],[3,0,0]].map(qvec),particles:[[1,0,0,0],[1,0,0,0]].map(qvec),bonds:[[0,1,q(0),q(3)]],angles:[],torsions:[],pairs:[],nonbonded:[[.5,0,0],[.5,0,0]].map(qvec),exceptions:[],box:qvec([8,8,8]),switchDistance:q(1.5),cutoff:q(2),prefactor:q(1)};
  const r=await register(await createDataset(values),q(.125),1);await initialize(engine,r,'empty');const initial=await state(engine,r),ns=(await engine.runInfo(r)).stateNamespace;assert.equal((await neighbors.listInfo(ns)).candidateCount,0n);
  await advance(engine,r,2,'empty');assert.deepEqual(await state(engine,r),initial);assert.equal((await engine.runInfo(r)).status,12n);
  const checkpoints=await complete(engine,r,[8],'empty');assert.equal(checkpoints.length,1);assert.deepEqual(checkpoints[0],{...initial,step:1});assert.equal((await neighbors.listInfo(ns)).candidateCount,0n);validation.emptyListCommits=true;
 });
 validation.passed=true;fs.writeFileSync('reports/neighbor_validation.json',JSON.stringify(validation,null,2)+'\n');
 fs.writeFileSync('reports/neighbor_execution_gas.json',JSON.stringify({scope:'Four-atom trajectory, six-atom sparse fixture and two-atom edge cases; local EVM advancement only, excluding deployment/uploads/registration; not protein or Robinhood cost',chainId:31337,runs,transactions:gas},null,2)+'\n');
});
