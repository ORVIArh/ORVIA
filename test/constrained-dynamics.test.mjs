import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import ganache from 'ganache';
import {AbiCoder,BrowserProvider,Contract,encodeBytes32String,id,keccak256,toBeHex,zeroPadValue} from 'ethers';
import {artifacts,deploy,transact,quadFromNumber as q,qvec} from './helpers.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const python=process.env.ORVIA_RESEARCH_PYTHON||process.env.CODEX_PRIMARY_RUNTIME_PYTHON||'python3';
const input={positions:[[0,0,0],[1,0,0],[0,1,0]].map(qvec),particles:[[16,.125,-.0625,.03125],[1,.125,.0625,.03125],[1,0,-.0625,.03125]].map(qvec),bonds:[[0,1,q(2),q(.875)],[0,2,q(2),q(.875)]],angles:[[1,0,2,q(.5),q(1.5)]],torsions:[],pairs:[],nonbonded:Array.from({length:3},()=>[.5,0,0].map(q)),exceptions:[],box:qvec([8,8,8]),switchDistance:q(2),cutoff:q(3),prefactor:q(1),dt:q(1/32),steps:2};
const constraints=[[0,1,q(1)],[0,2,q(1)]],positionTolerance=q(1e-20),velocityTolerance=q(1e-20);
const referenceInput={source:input,constraints,positionTolerance,velocityTolerance};
const word=x=>typeof x==='number'?toBeHex(x,32):zeroPadValue(x,32);
const abi=AbiCoder.defaultAbiCoder(),gasLimit=28_000_000;

test('Constrained NVE integrates onchain SHAKE and RATTLE before atomic timestep commit',async t=>{
 assert.ok((artifacts.ConstrainedDynamicsCoordinator.deployedBytecode.length-2)/2<96*1024);
 const transport=ganache.provider({logging:{quiet:true},chain:{chainId:31337,hardfork:'shanghai',allowUnlimitedContractSize:true},wallet:{totalAccounts:3},miner:{blockGasLimit:30_000_000}});
 t.after(()=>transport.disconnect());const provider=new BrowserProvider(transport);provider.pollingInterval=10;
 const owner=await provider.getSigner(0),contributor=await provider.getSigner(1),ownerAddress=await owner.getAddress();
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
 const catalog=await deploy('ConstraintCatalog',owner,[ownerAddress,await dataset.getAddress(),mathAddress]);
 const modules=Object.fromEntries(await Promise.all(Object.entries({registry,dataset,math,integrator,bond,angle,torsion,lj,coulomb,elementary,geometry,nonbonded}).map(async([n,c])=>[n,await c.getAddress()])));
 const engine=await deploy('ConstrainedDynamicsCoordinator',owner,[ownerAddress,modules,await catalog.getAddress()]);
 const page=await deploy('WorkingStatePage',owner,[await engine.getAddress()]);
 const neighbors=await deploy('NeighborList',owner,[await engine.getAddress(),mathAddress,await geometry.getAddress(),await page.getAddress()]);
 const kernel=await deploy('DistanceConstraintKernel',owner,[mathAddress]);
 const solver=await deploy('ConstraintSolver',owner,[await engine.getAddress(),mathAddress,await kernel.getAddress()]);
 await transact(engine.bindWorkingPage(await page.getAddress(),await neighbors.getAddress(),await solver.getAddress()));
 const protocol=id('ORVIA CONSTRAINED VALIDATION');
 const addresses=[...Object.values(modules),await base.getAddress(),await dynamics.getAddress(),await engine.getAddress(),await page.getAddress(),await neighbors.getAddress(),await catalog.getAddress(),await solver.getAddress(),await kernel.getAddress()];
 await transact(registry.registerProtocol(protocol,id('Independent SHAKE RATTLE cutoff fixture'),addresses));
 let sequence=0;const gas=[];
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
 const dataId=await createDataset(input),setId=id('Constrained water O-H lengths');
 async function createSet(d,s,entries=constraints){await transact(catalog.createSet(s,d,entries.length));await transact(catalog.append(s,entries));await transact(catalog.seal(s));}
 await createSet(dataId,setId);
 const parameters={dt:input.dt,steps:input.steps,skin:q(.5),constraintSetId:setId,positionTolerance,velocityTolerance,maxIterations:64};
 const reference=JSON.parse(execFileSync(python,[path.join(project,'reference/constrained_trajectory.py')],{input:JSON.stringify(referenceInput),encoding:'utf8'}));
 fs.writeFileSync('reports/constrained_reference.json',JSON.stringify(reference,null,2)+'\n');
 async function register(p=parameters,d=dataId){const r=await engine.nextExperimentId();await transact(engine.registerExperiment(protocol,d,p));return r;}
 async function state(r){const info=await engine.runInfo(r),positions=[],velocities=[],forces=[];for(let i=0;i<Number(info.atomCount);i++){const a=await engine.stateAt(r,i);positions.push([...a[0]]);velocities.push([...a[1]]);forces.push([...a[2]]);}return{step:Number(info.completedSteps),positions,velocities,forces,energy:info.potentialEnergy};}
 async function advance(r,work,label){const info=await engine.runInfo(r),receipt=await transact(engine.connect(contributor).advanceExperiment(r,work,{gasLimit}));gas.push({runId:String(r),engine:label,stage:Number(info.status),work,gasUsed:String(receipt.gasUsed)});return engine.runInfo(r);}
 async function until(r,status,label){for(let i=0;i<300;i++){const info=await engine.runInfo(r);if(info.status===BigInt(status))return;await advance(r,1,label);}assert.fail('stage cap '+status);}
 async function complete(r,schedule,label){const out=[];let seen=Number((await engine.runInfo(r)).completedSteps);for(let i=0;i<800;i++){const info=await advance(r,schedule[i%schedule.length],label);if(Number(info.completedSteps)>seen){seen=Number(info.completedSteps);out.push(await state(r));}if(info.status===30n)return out;if(info.status===31n)assert.fail('solver failed');}assert.fail('completion cap');}
 const first=await register(),actual=[];let finalState;
 await t.test('committed current state is protected throughout SHAKE and external solver advancement',async()=>{
  await until(first,12,'constrained-primary');const before=await state(first);actual.push(before);
  await until(first,16,'constrained-primary');assert.deepEqual(await state(first),before);
  const info=await engine.constraintParameters(first),problemId=info.problemId;
  await assert.rejects(solver.connect(contributor).appendAtoms(problemId,[]));
  for(let i=0;i<128;i++){const info=await solver.problemInfo(problemId);if(info.status===4n)break;assert.notEqual(info.status,5n);const receipt=await transact(solver.connect(contributor).advance(problemId,8,{gasLimit}));gas.push({runId:String(first),engine:'constrained-primary',stage:16,work:8,execution:'external solver',gasUsed:String(receipt.gasUsed)});}
  assert.equal((await solver.problemInfo(problemId)).status,4n);
  await until(first,28,'constrained-primary');assert.deepEqual(await state(first),before);
 });
 await t.test('two constrained timesteps match an independent simultaneous multiplier and dense velocity oracle',async()=>{
  actual.push(...await complete(first,[8],'constrained-primary'));assert.equal(actual.length,3);finalState=actual.at(-1);
  const comparison=execFileSync(python,[path.join(project,'reference/constrained_trajectory.py')],{input:JSON.stringify({input:referenceInput,actual}),encoding:'utf8'});
  fs.writeFileSync('reports/constrained_validation.json',comparison);assert.equal(JSON.parse(comparison).checkpoints.length,3);
  assert.equal((await page.namespaceInfo((await engine.runInfo(first)).stateNamespace)).isSealed,true);
 });
 await t.test('transaction partitioning preserves every final position velocity force and energy byte',async()=>{
  const second=await register();await complete(second,[1,3,2,8],'constrained-partition');assert.deepEqual(await state(second),finalState);
 });
 await t.test('maximum-iteration failure and reverted transactions preserve the committed checkpoint',async()=>{
  const fail=await register({...parameters,maxIterations:1});await until(fail,12,'failure');const before=await state(fail);
  await assert.rejects(transact(engine.advanceExperiment(fail,8,{gasLimit:50_000})));assert.deepEqual(await state(fail),before);
  for(let i=0;i<40;i++){const info=await advance(fail,8,'failure');if(info.status===31n)break;}
  assert.equal((await engine.runInfo(fail)).status,31n);assert.deepEqual(await state(fail),before);
  assert.equal((await page.namespaceInfo((await engine.runInfo(fail)).stateNamespace)).isSealed,true);
  const problem=(await engine.constraintParameters(fail)).problemId;assert.equal((await solver.problemInfo(problem)).status,5n);
  await assert.rejects(engine.advanceExperiment(fail,1));await assert.rejects(solver.solutionAt(problem,0));
 });
 await t.test('wrapped input images and a trial constraint crossing the half-box boundary fail closed',async()=>{
  const wrongLengths=id('incompatible initial target');await createSet(dataId,wrongLengths,[[0,1,q(1.5)],[0,2,q(1)]]);
  const incompatible=await register({...parameters,constraintSetId:wrongLengths});await until(incompatible,6,'initial-target');
  await assert.rejects(transact(engine.advanceExperiment(incompatible,1,{gasLimit})));
  const wrapped=structuredClone(input);wrapped.positions[1][0]=q(9);
  const wd=await createDataset(wrapped),ws=id('wrapped constraints');await createSet(wd,ws);
  const w=await register({...parameters,constraintSetId:ws},wd);await until(w,6,'wrapped');const before=await state(w);
  await assert.rejects(transact(engine.advanceExperiment(w,1,{gasLimit})));assert.deepEqual(await state(w),before);
  const crossing=structuredClone(input);crossing.particles[1][2]=q(128);
  const cd=await createDataset(crossing),cs=id('crossing constraints');await createSet(cd,cs);
  const c=await register({...parameters,constraintSetId:cs},cd);await until(c,12,'crossing');const saved=await state(c);
  await until(c,15,'crossing');await assert.rejects(transact(engine.advanceExperiment(c,1,{gasLimit})));assert.deepEqual(await state(c),saved);
 });
 await t.test('catalog commitments and solver source identities bind exact immutable inputs',async()=>{
  const hash=(types,values)=>keccak256(abi.encode(types,values)),catalogAddress=await catalog.getAddress();
  let digest=hash(['bytes32','uint256','address','bytes32','bytes32','bytes32','uint32','uint32','bytes32','bytes32'],[encodeBytes32String('ORVIA-CONSTRAINT-SET-v1'),31337,catalogAddress,setId,dataId,await dataset.assertDataset(dataId),3,2,keccak256(await provider.getCode(modules.dataset)),keccak256(await provider.getCode(modules.math))]);
  for(let i=0;i<constraints.length;i++)digest=hash(['bytes32','uint256','tuple(uint32,uint32,bytes16)'],[digest,i,constraints[i]]);
  const setCommitment=hash(['bytes32','uint32'],[digest,2]);assert.equal(await catalog.assertSet(setId),setCommitment);
  const moduleAddresses=Object.values(modules),hashes=await Promise.all(moduleAddresses.map(async a=>keccak256(await provider.getCode(a))));
  const core=hash(['tuple('+Array(12).fill('address').join(',')+')','bytes32[12]','address','bytes32'],[moduleAddresses,hashes,catalogAddress,keccak256(await provider.getCode(catalogAddress))]);assert.equal(await engine.coreConfigurationHash(),core);
  const pa=await page.getAddress(),na=await neighbors.getAddress(),sa=await solver.getAddress();
  const config=hash(['bytes32','address','bytes32','address','bytes32','address','bytes32','bytes32'],[core,pa,keccak256(await provider.getCode(pa)),na,keccak256(await provider.getCode(na)),sa,keccak256(await provider.getCode(sa)),await solver.configurationHash()]);assert.equal(await engine.configurationHash(),config);
  const ns=hash(['bytes32','uint256','address','uint256'],[encodeBytes32String('ORVIA-CONSTRAINED-STATE-v1'),31337,await engine.getAddress(),first]);
  const commitment=hash(['bytes32','uint256','address','uint256','bytes32','bytes32','bytes32','bytes32','tuple(bytes16,uint32,bytes16,bytes32,bytes16,bytes16,uint32)','bytes32','bytes32'],[encodeBytes32String('ORVIA-CONSTRAINED-RUN-v1'),31337,await engine.getAddress(),first,await registry.assertProtocol(protocol),dataId,await dataset.assertDataset(dataId),config,Object.values(parameters),setCommitment,ns]);
  assert.equal((await engine.runInfo(first)).commitment,commitment);
  const problemId=(await engine.constraintParameters(first)).problemId,problem=await solver.problemInfo(problemId);
  assert.equal(problem.sourceCommitment,hash(['bytes32','bytes32','uint32','bool'],[encodeBytes32String('ORVIA-CONSTRAINT-SOURCE-v1'),commitment,1,false]));
  assert.equal(problem.mode,1n);assert.equal(problem.status,4n);assert.equal(problem.loadedAtoms,3n);assert.equal(problem.loadedConstraints,2n);
  for(let i=0;i<2;i++)assert.equal((await solver.constraintAt(problemId,i)).distance,q(0));
 });
 await t.test('catalog authoring, registration and solver writer permissions reject invalid requests',async()=>{
  await assert.rejects(catalog.append(setId,constraints));await assert.rejects(catalog.seal(setId));
  await assert.rejects(catalog.connect(contributor).createSet(id('unauthorized set'),dataId,2));
  const bad=id('bad order');await transact(catalog.createSet(bad,dataId,2));await assert.rejects(catalog.append(bad,[constraints[1],constraints[0]]));
  await assert.rejects(engine.registerExperiment(protocol,dataId,{...parameters,constraintSetId:bad}));
  for(const change of[{positionTolerance:q(0)},{velocityTolerance:q(-1)},{maxIterations:0},{maxIterations:4097}])await assert.rejects(engine.registerExperiment(protocol,dataId,{...parameters,...change}));
  await assert.rejects(engine.connect(contributor).registerExperiment(protocol,dataId,parameters));
  await assert.rejects(engine.bindWorkingPage(await page.getAddress(),await neighbors.getAddress(),await solver.getAddress()));
  await assert.rejects(engine.advanceExperiment(first,1));
 });
 fs.writeFileSync('reports/constrained_execution_gas.json',JSON.stringify({scope:'Three-atom SHAKE/RATTLE cutoff-model fixture on local Ganache with 96KiB assertion and unlimited-size engine; not a Robinhood fork or fee estimate',chainId:31337,runtimeBytes:(artifacts.ConstrainedDynamicsCoordinator.deployedBytecode.length-2)/2,primaryFixture:{atoms:3,constraints:2,steps:2,dt:1/32},transactions:gas},null,2)+'\n');
});
