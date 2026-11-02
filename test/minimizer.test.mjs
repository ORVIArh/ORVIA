import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import ganache from 'ganache';
import {AbiCoder,BrowserProvider,Contract,encodeBytes32String,id,keccak256,toBeHex,zeroPadValue} from 'ethers';
import {artifacts,deploy,transact,quadFromNumber as q,quadToNumber,qvec} from './helpers.mjs';
const word=x=>typeof x==='number'?toBeHex(x,32):zeroPadValue(x,32),gasLimit=28_000_000;
const input={positions:[[0,0,0],[2,0,0],[4,0,0]].map(qvec),particles:Array.from({length:3},()=>[1,0,0,0].map(q)),bonds:[[0,1,q(1),q(1)],[1,2,q(1),q(1)]],angles:[],torsions:[],pairs:[],nonbonded:Array.from({length:3},()=>[.5,0,0].map(q)),exceptions:[[0,1,1,q(0),q(0),q(0)],[0,2,1,q(0),q(0),q(0)],[1,2,1,q(0),q(0),q(0)]],box:qvec([16,16,16]),switchDistance:q(2),cutoff:q(3),prefactor:q(1)};
const normalize=x=>Array.isArray(x)?x.map(normalize):x;
const settings={initialStep:q(4),forceTolerance:q(2**-30),armijo:q(.25),maxIterations:10,maxTrials:8};

test('Periodic minimization uses complete forces, Armijo backtracking and explicit convergence',async t=>{
 const researchPython=process.env.ORVIA_RESEARCH_PYTHON||process.env.CODEX_PRIMARY_RUNTIME_PYTHON||'python3';
 execFileSync(researchPython,['-c','import mpmath; assert mpmath.__version__ == "1.3.0"']);
 assert.ok((artifacts.PeriodicMinimizer.deployedBytecode.length-2)/2<96*1024);
 // Local EVM with the documented RH-size allowance; this is not a chain fork.
 const transport=ganache.provider({logging:{quiet:true},chain:{chainId:31337,hardfork:'shanghai',allowUnlimitedContractSize:true},wallet:{totalAccounts:3},miner:{blockGasLimit:30_000_000}});t.after(()=>transport.disconnect());
 const provider=new BrowserProvider(transport);provider.pollingInterval=10;const owner=await provider.getSigner(0),contributor=await provider.getSigner(1),ownerAddress=await owner.getAddress();
 const math=await deploy('FloatMath',owner),mathAddress=await math.getAddress();const elementary=await deploy('ElementaryMath',owner,[mathAddress]),elementaryAddress=await elementary.getAddress();
 const registry=await deploy('ExperimentRegistry',owner,[ownerAddress]),base=await deploy('DatasetCatalog',owner,[ownerAddress]);
 const dynamics=await deploy('DynamicsDataset',owner,[ownerAddress,await base.getAddress()]),dataset=await deploy('PeriodicDataset',owner,[ownerAddress,await dynamics.getAddress()]);
 const bond=await deploy('HarmonicBondKernel',owner,[mathAddress]),angle=await deploy('HarmonicAngleKernel',owner,[mathAddress,elementaryAddress]),torsion=await deploy('PeriodicTorsionKernel',owner,[mathAddress,elementaryAddress]);
 const lj=await deploy('LennardJonesKernel',owner,[mathAddress]),coulomb=await deploy('CoulombPairKernel',owner,[mathAddress]),geometry=await deploy('OrthorhombicGeometry',owner,[mathAddress]);
 const nonbonded=await deploy('SwitchedNonbondedKernel',owner,[mathAddress,await lj.getAddress(),await coulomb.getAddress()]);
 const modules=Object.fromEntries(await Promise.all(Object.entries({registry,dataset,math,bond,angle,torsion,lj,coulomb,elementary,geometry,nonbonded}).map(async([n,c])=>[n,await c.getAddress()])));
 const engine=await deploy('PeriodicMinimizer',owner,[ownerAddress,modules]),page=await deploy('WorkingStatePage',owner,[await engine.getAddress()]);await transact(engine.bindWorkingPage(await page.getAddress()));
 const protocol=id('ORVIA MINIMIZER VALIDATION'),specification=id('Symmetric harmonic chain with independently known minimum');const protocolAddresses=[...Object.values(modules),await base.getAddress(),await dynamics.getAddress(),await engine.getAddress(),await page.getAddress()];await transact(registry.registerProtocol(protocol,specification,protocolAddresses));
 let sequence=0;const gas=[],runs=[];let successfulChecks=0;
 async function check(name,fn){await t.test(name,async()=>{await fn();successfulChecks++;});}
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
 async function register(config=settings,d=dataId){const r=await engine.nextExperimentId();await transact(engine.registerExperiment(protocol,d,config));runs.push({runId:String(r),datasetId:d,settings:config});return r;}
 async function state(r){const info=await engine.runInfo(r),positions=[],forces=[];for(let a=0;a<Number(info.atomCount);a++){const x=await engine.stateAt(r,a);positions.push([...x[0]]);forces.push([...x[1]]);}return{positions,forces,energy:info.potentialEnergy};}
 async function advance(r,w){const before=await engine.runInfo(r),receipt=await transact(engine.connect(contributor).advanceExperiment(r,w,{gasLimit}));gas.push({runId:String(r),stage:Number(before.status),work:w,gasUsed:String(receipt.gasUsed)});return await engine.runInfo(r);}
 async function reach(r,status){for(let i=0;i<300;i++){const info=await engine.runInfo(r);if(info.status===BigInt(status))return;assert.ok(info.status<18n,'unexpected terminal');await advance(r,1);}assert.fail('stage timeout');}
 async function finish(r,schedule=[8]){for(let i=0;i<300;i++){const info=await engine.runInfo(r);if(info.status>=18n)return info;await advance(r,schedule[i%schedule.length]);}assert.fail('minimization timeout');}
 const first=await register(),second=await register();let initial,finalState;
 await check('complete initial gradient agrees with the independent harmonic-chain equations',async()=>{
  await reach(first,11);initial=await state(first);assert.equal(initial.energy,q(1));assert.deepEqual(initial.positions,input.positions);assert.deepEqual(initial.forces,[[1,0,0],[0,0,0],[-1,0,0]].map(qvec));const info=await engine.minimizerInfo(first);assert.ok(Math.abs(quadToNumber(info.rmsForce)-Math.sqrt(2/3))<1e-14);assert.equal(info.maximumForce,q(1));await assert.rejects(engine.processTrialRecord(first));await assert.rejects(engine.armijoAccept(first));
 });
 await check('energy and singular trial rejections preserve current state, then converge at the exact minimum',async()=>{
  await reach(first,17);assert.deepEqual(await state(first),initial);await advance(first,1);assert.equal((await engine.minimizerInfo(first)).stepSize,q(2));assert.equal((await engine.minimizerInfo(first)).rejectedTrials,1n);assert.equal((await engine.minimizerInfo(first)).lastTrialInvalid,false);assert.deepEqual(await state(first),initial);
  await reach(first,17);assert.equal((await engine.minimizerInfo(first)).lastTrialInvalid,true);assert.deepEqual(await state(first),initial);await advance(first,1);assert.equal((await engine.minimizerInfo(first)).stepSize,q(1));assert.equal((await engine.minimizerInfo(first)).rejectedTrials,2n);
  await reach(first,17);assert.equal((await engine.advanceExperiment.staticCall(first,1))[1],true);const done=await finish(first);assert.equal(done.status,18n);assert.equal(done.iterations,1n);finalState=await state(first);assert.deepEqual(finalState.positions,[[1,0,0],[2,0,0],[3,0,0]].map(qvec));assert.deepEqual(finalState.forces,Array.from({length:3},()=>qvec([0,0,0])));assert.equal(finalState.energy,q(0));assert.equal((await engine.minimizerInfo(first)).rmsForce,q(0));assert.equal((await page.namespaceInfo(done.stateNamespace)).isSealed,true);await assert.rejects(engine.advanceExperiment(first,1));
 });
 await check('different transaction partitions produce the same accepted state and rejection count',async()=>{
  const done=await finish(second,[1,8,3,2]);assert.equal(done.status,18n);assert.deepEqual(await state(second),finalState);assert.equal((await engine.minimizerInfo(second)).rejectedTrials,2n);assert.notEqual(done.stateNamespace,(await engine.runInfo(first)).stateNamespace);
 });
 await check('iteration and line-search limits report failure rather than convergence',async()=>{
  const iteration=await register({...settings,initialStep:q(.25),maxIterations:1});const a=await finish(iteration);assert.equal(a.status,19n);assert.equal((await engine.minimizerInfo(iteration)).failure,2n);assert.equal(a.iterations,1n);assert.equal((await state(iteration)).energy,q(.5625));assert.deepEqual((await state(iteration)).positions,[[.25,0,0],[2,0,0],[3.75,0,0]].map(qvec));
  const line=await register({...settings,maxTrials:1});await reach(line,17);assert.equal((await engine.advanceExperiment.staticCall(line,1))[1],false);const b=await finish(line);assert.equal(b.status,19n);assert.equal((await engine.minimizerInfo(line)).failure,1n);assert.equal(b.iterations,0n);assert.deepEqual(await state(line),initial);assert.equal((await page.namespaceInfo(b.stateNamespace)).isSealed,true);
 });
 await check('an already stationary complete gradient converges without a trial',async()=>{
  const values=structuredClone(input);values.positions=[[1,0,0],[2,0,0],[3,0,0]].map(qvec);const r=await register(settings,await createDataset(values));const done=await finish(r);assert.equal(done.status,18n);assert.equal(done.iterations,0n);assert.equal((await engine.minimizerInfo(r)).rejectedTrials,0n);
 });
 await check('insufficient gas reverts instead of changing the line-search decision',async()=>{
  const r=await register();await reach(r,11);const before=[...await engine.runInfo(r)],metrics=normalize(await engine.minimizerInfo(r)),raw=[...await page.readWords(before[3],0,56)];const estimate=await engine.advanceExperiment.estimateGas(r,8);await assert.rejects(transact(engine.advanceExperiment(r,8,{gasLimit:estimate/2n})));assert.deepEqual([...await engine.runInfo(r)],before);assert.deepEqual(normalize(await engine.minimizerInfo(r)),metrics);assert.deepEqual([...await page.readWords(before[3],0,56)],raw);
 });
 await check('immutable settings and module/page identity are independently committed',async()=>{
  const coder=AbiCoder.defaultAbiCoder(),hash=(types,values)=>keccak256(coder.encode(types,values));const hashes=await Promise.all(Object.values(modules).map(async a=>keccak256(await provider.getCode(a))));
  const moduleType='tuple(address registry,address dataset,address math,address bond,address angle,address torsion,address lj,address coulomb,address elementary,address geometry,address nonbonded)';const core=hash([moduleType,'bytes32[11]'],[modules,hashes]);assert.equal(await engine.coreConfigurationHash(),core);const address=await engine.getAddress(),pageAddress=await page.getAddress();const config=hash(['bytes32','address','bytes32'],[core,pageAddress,keccak256(await provider.getCode(pageAddress))]);assert.equal(await engine.configurationHash(),config);const ns=hash(['bytes32','uint256','address','uint256'],[encodeBytes32String('ORVIA-MINIMIZER-STATE-v1'),31337,address,first]);
  const commit=hash(['bytes32','uint256','address','uint256','bytes32','bytes32','bytes32','bytes32','tuple(bytes16 initialStep,bytes16 forceTolerance,bytes16 armijo,uint32 maxIterations,uint32 maxTrials)','bytes32'],[encodeBytes32String('ORVIA-MINIMIZER-RUN-v1'),31337,address,first,await registry.assertProtocol(protocol),dataId,(await dataset.datasetInfo(dataId)).commitment,config,settings,ns]);assert.equal((await engine.runInfo(first)).commitment,commit);
 });
 await check('all bonded, periodic pair and exception forces agree with independent energy differentiation before and after an accepted trial',async()=>{
  const periodic=JSON.parse(fs.readFileSync('reference/periodic_reference.json','utf8'));
  const r=await register({...settings,initialStep:q(2**-12),maxIterations:1},await createDataset(periodic.inputs));
  await reach(r,11);const before=await state(r);const result=await finish(r);assert.equal(result.status,19n);assert.equal(result.iterations,1n);assert.equal((await engine.minimizerInfo(r)).failure,2n);const after=await state(r);assert.ok(quadToNumber(after.energy)<quadToNumber(before.energy));
  const comparison=String.raw`
import sys,json
sys.path.insert(0,sys.argv[1])
import mpmath as mp
from generate_periodic_reference import potential,forces
mp.mp.dps=100
p=json.load(sys.stdin)
def decode(h):
 b=int(h,16);e=(b>>112)&32767;f=b&((1<<112)-1)
 assert e!=32767
 return (-1 if b>>127 else 1)*((1+mp.mpf(f)/2**112)*mp.power(2,e-16383) if e else mp.mpf(f)*mp.power(2,-16494))
for state in p:
 x=[[decode(h) for h in row] for row in state['positions']]
 expected=forces(x);energy=potential(x)
 for row,want in zip(state['forces'],expected):
  for h,value in zip(row,want):
   assert abs(decode(h)-value)<=mp.mpf('1e-25')+mp.mpf('1e-24')*abs(value)
 assert abs(decode(state['energy'])-energy)<=mp.mpf('1e-25')+mp.mpf('1e-24')*abs(energy)
print('26 energy/force values matched independent 100-digit periodic energy derivatives')
`;
  const output=execFileSync(researchPython,['-c',comparison,new URL('../reference/',import.meta.url).pathname],{input:JSON.stringify([before,after]),encoding:'utf8'});assert.match(output,/26 energy\/force values matched/);
 });
 await check('authority and numerical controls reject invalid registrations and work',async()=>{
  await assert.rejects(engine.connect(contributor).registerExperiment(protocol,dataId,settings));await assert.rejects(engine.bindWorkingPage(await page.getAddress()));for(const edit of[{initialStep:q(0)},{forceTolerance:q(0)},{forceTolerance:q(2**-1001)},{armijo:q(0)},{armijo:q(1)},{maxIterations:0},{maxIterations:4097},{maxTrials:0},{maxTrials:65}])await assert.rejects(engine.registerExperiment(protocol,dataId,{...settings,...edit}));for(const work of[0,9])await assert.rejects(engine.advanceExperiment(second,work));await assert.rejects(engine.runInfo(999));
 });
 assert.equal(successfulChecks,9,'All validation checks must pass before emitting a success report');
 fs.writeFileSync('reports/minimizer_validation.json',JSON.stringify({scope:'Three-atom harmonic-chain minimization plus four-atom complete periodic force checks; not prepared protein or mainnet validation',passed:true,initialEnergy:'1',finalEnergy:'0',acceptedIterations:1,rejectedTrials:2,forceRMS:'0',exactFinalPositions:[[1,0,0],[2,0,0],[3,0,0]],independentReference:'Exact harmonic-chain minimum and independent 100-digit derivatives of the complete periodic Hamiltonian',partitionInvariant:true,explicitFailureLimits:true,gasFailureDoesNotBacktrack:true,completePeriodicHamiltonianDerivativeChecks:26},null,2)+'\n');
 fs.writeFileSync('reports/minimizer_execution_gas.json',JSON.stringify({scope:'Local EVM advancement only; deployment/uploads/registration excluded',chainId:31337,runs,transactions:gas},null,2)+'\n');
});
