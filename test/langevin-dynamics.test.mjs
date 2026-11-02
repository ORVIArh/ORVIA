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
const input={positions:[[0,0,0],[1.25,.25,0]].map(qvec),particles:[[12,.125,-.25,0],[16,-.25,.125,.0625]].map(qvec),bonds:[[0,1,q(2),q(1)]],angles:[],torsions:[],pairs:[],nonbonded:[[.5,.125,.5],[.75,.25,-.25]].map(qvec),exceptions:[],box:qvec([8,8,8]),switchDistance:q(2),cutoff:q(3),prefactor:q(1),dt:q(1/32),steps:3};
const parameters={dt:input.dt,steps:input.steps,skin:q(.5),friction:q(2),kT:q(2.5),seed:id('Langevin seed fixture'),streamId:id('Langevin repeat stream'),replica:7};
const word=x=>typeof x==='number'?toBeHex(x,32):zeroPadValue(x,32);
const abi=AbiCoder.defaultAbiCoder(),gasLimit=28_000_000;
function uniform(step,atom,offset){const draw=2*atom+Math.floor(offset/2),lane=offset%2;const h=keccak256(abi.encode(['bytes32','bytes32','bytes32','uint32','uint64','uint64','uint8'],[id('ORVIA.CounterRandom.v1'),parameters.seed,parameters.streamId,parameters.replica,step,draw,lane]));const n=2n*(BigInt(h)>>144n)+1n,top=BigInt(n.toString(2).length-1);return '0x'+(((top-113n+16383n)<<112n)|((n-(1n<<top))<<(112n-top))).toString(16).padStart(32,'0');}
const referenceInput={source:input,thermostat:[parameters.friction,parameters.kT],uniforms:Array.from({length:input.steps},(_,step)=>Array.from({length:input.positions.length},(_,atom)=>Array.from({length:4},(_,offset)=>uniform(step,atom,offset))))};

test('Contract BAOAB trajectories retain deterministic streams, neighbor stages and atomic checkpoints',async t=>{
 // This dedicated fixture allows the documented RH code-size envelope. It is not a chain fork.
 assert.ok((artifacts.LangevinDynamicsCoordinator.deployedBytecode.length-2)/2<96*1024);
 const transport=ganache.provider({logging:{quiet:true},chain:{chainId:31337,hardfork:'shanghai',allowUnlimitedContractSize:true},wallet:{totalAccounts:3},miner:{blockGasLimit:30_000_000}});
 t.after(()=>transport.disconnect());const provider=new BrowserProvider(transport);provider.pollingInterval=10;
 const owner=await provider.getSigner(0),contributor=await provider.getSigner(1),ownerAddress=await owner.getAddress();
 const math=await deploy('FloatMath',owner),mathAddress=await math.getAddress();
 const elementary=await deploy('ElementaryMath',owner,[mathAddress]),elementaryAddress=await elementary.getAddress();
 const scalar=await deploy('ScalarMath',owner,[mathAddress]);
 const random=await deploy('CounterRandom',owner,[mathAddress,await scalar.getAddress(),elementaryAddress]);
 const registry=await deploy('ExperimentRegistry',owner,[ownerAddress]);
 const base=await deploy('DatasetCatalog',owner,[ownerAddress]);
 const dynamics=await deploy('DynamicsDataset',owner,[ownerAddress,await base.getAddress()]);
 const dataset=await deploy('PeriodicDataset',owner,[ownerAddress,await dynamics.getAddress()]);
 const integrator=await deploy('LangevinBAOABKernel',owner,[mathAddress,await scalar.getAddress()]);
 const verlet=await deploy('VelocityVerletKernel',owner,[mathAddress]);
 const bond=await deploy('HarmonicBondKernel',owner,[mathAddress]);
 const angle=await deploy('HarmonicAngleKernel',owner,[mathAddress,elementaryAddress]);
 const torsion=await deploy('PeriodicTorsionKernel',owner,[mathAddress,elementaryAddress]);
 const lj=await deploy('LennardJonesKernel',owner,[mathAddress]),coulomb=await deploy('CoulombPairKernel',owner,[mathAddress]);
 const geometry=await deploy('OrthorhombicGeometry',owner,[mathAddress]);
 const nonbonded=await deploy('SwitchedNonbondedKernel',owner,[mathAddress,await lj.getAddress(),await coulomb.getAddress()]);
 const modules=Object.fromEntries(await Promise.all(Object.entries({registry,dataset,math,integrator,bond,angle,torsion,lj,coulomb,elementary,geometry,nonbonded,scalar,random}).map(async([n,c])=>[n,await c.getAddress()])));
 const engine=await deploy('LangevinDynamicsCoordinator',owner,[ownerAddress,modules]);
 const page=await deploy('WorkingStatePage',owner,[await engine.getAddress()]);
 const neighbors=await deploy('NeighborList',owner,[await engine.getAddress(),mathAddress,await geometry.getAddress(),await page.getAddress()]);
 await transact(engine.bindWorkingPage(await page.getAddress(),await neighbors.getAddress()));
 const baselineModules={...modules,integrator:await verlet.getAddress()};delete baselineModules.scalar;delete baselineModules.random;
 const baseline=await deploy('NeighborDynamicsCoordinator',owner,[ownerAddress,baselineModules]);
 const baselinePage=await deploy('WorkingStatePage',owner,[await baseline.getAddress()]);
 const baselineNeighbors=await deploy('NeighborList',owner,[await baseline.getAddress(),mathAddress,await geometry.getAddress(),await baselinePage.getAddress()]);
 await transact(baseline.bindWorkingPage(await baselinePage.getAddress(),await baselineNeighbors.getAddress()));
 const protocol=id('ORVIA LANGEVIN VALIDATION');
 const addresses=[...Object.values(modules),await verlet.getAddress(),await base.getAddress(),await dynamics.getAddress(),await engine.getAddress(),await page.getAddress(),await neighbors.getAddress(),await baseline.getAddress(),await baselinePage.getAddress(),await baselineNeighbors.getAddress()];
 await transact(registry.registerProtocol(protocol,id('Independent stochastic cutoff fixture'),addresses));
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
 const dataId=await createDataset(input);
 const reference=JSON.parse(execFileSync(python,[path.join(project,'reference/scalar_random_trajectory.py')],{input:JSON.stringify(referenceInput),encoding:'utf8'}));
 fs.writeFileSync('reports/langevin_reference.json',JSON.stringify(reference,null,2)+'\n');
 async function register(p=parameters,d=dataId){const r=await engine.nextExperimentId();await transact(engine.registerExperiment(protocol,d,p));return r;}
 async function state(c,r){const info=await c.runInfo(r),positions=[],velocities=[],forces=[];for(let i=0;i<Number(info.atomCount);i++){const a=await c.stateAt(r,i);positions.push([...a[0]]);velocities.push([...a[1]]);forces.push([...a[2]]);}return{step:Number(info.completedSteps),positions,velocities,forces,energy:info.potentialEnergy};}
 async function advance(c,r,work,label){const info=await c.runInfo(r),receipt=await transact(c.connect(contributor).advanceExperiment(r,work,{gasLimit}));gas.push({runId:String(r),engine:label,stage:Number(info.status),work,gasUsed:String(receipt.gasUsed)});return c.runInfo(r);}
 async function initialize(c,r,label){for(let i=0;i<100;i++){if((await c.runInfo(r)).status===11n)return;await advance(c,r,1,label);}assert.fail('initialization cap');}
 async function complete(c,r,schedule,label){const out=[];let seen=Number((await c.runInfo(r)).completedSteps);for(let i=0;i<200;i++){const info=await advance(c,r,schedule[i%schedule.length],label);if(Number(info.completedSteps)>seen){seen=Number(info.completedSteps);out.push(await state(c,r));}if(info.status===18n)return out;}assert.fail('completion cap');}
 const first=await register();let finalState;const actual=[];
 await t.test('initial force completion and stochastic drift leave committed current coordinates unchanged',async()=>{
  await initialize(engine,first,'stochastic-primary');actual.push(await state(engine,first));
  const before=await state(engine,first),run=await engine.runInfo(first);
  await advance(engine,first,1,'stochastic-primary');
  assert.deepEqual(await state(engine,first),before);
  const staged=await page.readWords(run.stateNamespace,18,3);
  assert.notDeepEqual([...staged],[...await page.readWords(run.stateNamespace,0,3)]);
 });
 await t.test('three full stochastic timesteps match differentiated-energy and independent hash-normal oracle',async()=>{
  actual.push(...await complete(engine,first,[8],'stochastic-primary'));
  assert.equal(actual.length,4);finalState=actual.at(-1);
  const comparison=execFileSync(python,[path.join(project,'reference/scalar_random_trajectory.py')],{input:JSON.stringify({input:referenceInput,actual}),encoding:'utf8'});
  fs.writeFileSync('reports/langevin_validation.json',comparison);
  assert.equal(JSON.parse(comparison).checkpoints.length,4);
  const info=await engine.runInfo(first);assert.equal((await page.namespaceInfo(info.stateNamespace)).isSealed,true);
 });
 await t.test('registered stream identity preserves exact final bytes across run IDs and transaction partitions',async()=>{
  const second=await register();await complete(engine,second,[1,3,2,8],'stochastic-partition');
  assert.deepEqual(await state(engine,second),finalState);
  assert.notEqual((await engine.runInfo(first)).stateNamespace,(await engine.runInfo(second)).stateNamespace);
 });
 await t.test('zero friction reproduces the existing neighbor velocity-Verlet trajectory exactly',async()=>{
  const p={...parameters,friction:q(0),steps:2};
  const a=await register(p),b=await baseline.nextExperimentId();
  await transact(baseline.registerExperiment(protocol,dataId,p.dt,p.steps,p.skin));
  await initialize(engine,a,'zero-friction');await initialize(baseline,b,'verlet');
  assert.deepEqual(await state(engine,a),await state(baseline,b));
  assert.deepEqual(await complete(engine,a,[8],'zero-friction'),await complete(baseline,b,[8],'verlet'));
 });
 await t.test('seed, stream, replica and thermostat parameters enter immutable independently reconstructed commitments',async()=>{
  const hash=(types,values)=>keccak256(abi.encode(types,values));
  const moduleAddresses=Object.values(modules),codeHashes=await Promise.all(moduleAddresses.map(async a=>keccak256(await provider.getCode(a))));
  const moduleType='tuple('+Array(14).fill('address').join(',')+')';
  const core=hash([moduleType,'bytes32[14]'],[moduleAddresses,codeHashes]);assert.equal(await engine.coreConfigurationHash(),core);
  const pageAddress=await page.getAddress(),listAddress=await neighbors.getAddress();
  const config=hash(['bytes32','address','bytes32','address','bytes32'],[core,pageAddress,keccak256(await provider.getCode(pageAddress)),listAddress,keccak256(await provider.getCode(listAddress))]);assert.equal(await engine.configurationHash(),config);
  const ns=hash(['bytes32','uint256','address','uint256'],[encodeBytes32String('ORVIA-LANGEVIN-STATE-v1'),31337,await engine.getAddress(),first]);
  const parameterType='tuple(bytes16,uint32,bytes16,bytes16,bytes16,bytes32,bytes32,uint32)';
  const committed=hash(['bytes32','uint256','address','uint256','bytes32','bytes32','bytes32','bytes32',parameterType,'bytes32'],[encodeBytes32String('ORVIA-LANGEVIN-RUN-v1'),31337,await engine.getAddress(),first,await registry.assertProtocol(protocol),dataId,(await dataset.datasetInfo(dataId)).commitment,config,Object.values(parameters),ns]);
  assert.equal((await engine.runInfo(first)).commitment,committed);
  const changed=await register({...parameters,seed:id('different repeat seed')});assert.notEqual((await engine.runInfo(changed)).commitment,committed);
  assert.deepEqual([...await engine.stochasticParameters(first)],[parameters.friction,parameters.kT,parameters.seed,parameters.streamId,BigInt(parameters.replica)]);
 });
 await t.test('invalid thermostat or stream domains and unauthorized registration fail before execution',async()=>{
  for(const change of[{dt:q(0)},{kT:q(0)},{friction:q(-1)},{friction:q(9000)},{streamId:'0x'+'00'.repeat(32)}])await assert.rejects(engine.registerExperiment(protocol,dataId,{...parameters,...change}));
  await assert.rejects(engine.connect(contributor).registerExperiment(protocol,dataId,parameters));
  await assert.rejects(engine.advanceExperiment(first,1));
 });
 fs.writeFileSync('reports/langevin_execution_gas.json',JSON.stringify({scope:'Two-atom BAOAB cutoff-model fixture on local Ganache with a 96KiB code-size assertion and unlimited-size engine enabled; not a Robinhood fork or fee estimate',chainId:31337,runtimeBytes:(artifacts.LangevinDynamicsCoordinator.deployedBytecode.length-2)/2,primaryFixture:{atoms:2,steps:3,friction:2,kT:2.5,dt:1/32},transactions:gas},null,2)+'\n');
});
