import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { AbiCoder, Contract, encodeBytes32String, id, keccak256, toBeHex, zeroPadValue } from 'ethers';
import { artifacts, environment, deploy, transact, quadFromNumber as q, quadToNumber, qvec } from './helpers.mjs';

const reference = JSON.parse(fs.readFileSync('reference/periodic_reference.json', 'utf8'));
const input = reference.inputs;
const word = x => typeof x === 'number' ? toBeHex(x, 32) : zeroPadValue(x, 32);
const gasLimit = 28_000_000;

test('Periodic dynamics computes all unordered nonbonded pairs and an independent periodic trajectory', async t => {
  const env = await environment(); t.after(() => env.transport.disconnect());
  const { owner, contributor } = env, ownerAddress = await owner.getAddress();
  const math = await deploy('FloatMath', owner), mathAddress = await math.getAddress();
  const elementary = await deploy('ElementaryMath', owner, [mathAddress]);
  const elementaryAddress = await elementary.getAddress();
  const registry = await deploy('ExperimentRegistry', owner, [ownerAddress]);
  const base = await deploy('DatasetCatalog', owner, [ownerAddress]);
  const dynamics = await deploy('DynamicsDataset', owner, [ownerAddress, await base.getAddress()]);
  const dataset = await deploy('PeriodicDataset', owner, [ownerAddress, await dynamics.getAddress()]);
  const integrator = await deploy('VelocityVerletKernel', owner, [mathAddress]);
  const bond = await deploy('HarmonicBondKernel', owner, [mathAddress]);
  const angle = await deploy('HarmonicAngleKernel', owner, [mathAddress, elementaryAddress]);
  const torsion = await deploy('PeriodicTorsionKernel', owner, [mathAddress, elementaryAddress]);
  const lj = await deploy('LennardJonesKernel', owner, [mathAddress]);
  const coulomb = await deploy('CoulombPairKernel', owner, [mathAddress]);
  const geometry = await deploy('OrthorhombicGeometry', owner, [mathAddress]);
  const nonbonded = await deploy('SwitchedNonbondedKernel', owner, [mathAddress, await lj.getAddress(), await coulomb.getAddress()]);
  const moduleContracts = { registry, dataset, math, integrator, bond, angle, torsion, lj, coulomb, elementary, geometry, nonbonded };
  const modules = Object.fromEntries(await Promise.all(Object.entries(moduleContracts).map(async ([name, c]) => [name, await c.getAddress()])));
  const engine = await deploy('PeriodicDynamicsCoordinator', owner, [ownerAddress, modules]);
  const page = await deploy('WorkingStatePage', owner, [await engine.getAddress()]);
  await transact(engine.bindWorkingPage(await page.getAddress()));
  const protocol = id('ORVIA-PERIODIC-VALIDATION-004'), specification = id('Periodic four-atom velocity-Verlet fixture; not myosin');
  const protocolAddresses = [...Object.values(modules), await base.getAddress(), await dynamics.getAddress(), await page.getAddress(), await engine.getAddress()];
  await transact(registry.registerProtocol(protocol, specification, protocolAddresses));
  let sequence = 0;
  const measuredGas = [], runDefinitions = [];

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

  const datasetId = await createDataset(input);
  async function register(dataId = datasetId, dt = input.dt, steps = input.steps) {
    const runId = await engine.nextExperimentId();
    await transact(engine.registerExperiment(protocol, dataId, dt, steps));
    const info = await dataset.datasetInfo(dataId);
    runDefinitions.push({runId:runId.toString(),datasetId:dataId,atoms:Number(info.atomCount),
      bonds:Number(info.bondCount),angles:Number(info.angleCount),torsions:Number(info.torsionCount),
      pairs:Number(info.pairCount),dtBinary128:dt,targetSteps:steps});
    return runId;
  }
  async function advance(runId, work) {
    const before = await engine.runInfo(runId);
    const receipt = await transact(engine.connect(contributor).advanceExperiment(runId, work, { gasLimit }));
    measuredGas.push({ runId: runId.toString(), phaseBefore: Number(before.status), work, gasUsed: receipt.gasUsed.toString() });
    return await engine.runInfo(runId);
  }
  async function state(runId) {
    const info = await engine.runInfo(runId), positions = [], velocities = [], forces = [];
    for (let atom = 0; atom < Number(info.atomCount); atom++) {
      const values = await engine.stateAt(runId, atom);
      positions.push([...values[0]]); velocities.push([...values[1]]); forces.push([...values[2]]);
    }
    return { step: Number(info.completedSteps), positions, velocities, forces, energy: info.potentialEnergy };
  }
  async function reachDrift(runId) {
    for (let calls = 0; calls < 200; calls++) {
      if ((await engine.runInfo(runId)).status === 10n) return;
      await advance(runId, 1);
    }
    assert.fail('Initialization failed to reach Drift');
  }
  const first = await register(), second = await register();
  const checkpoints = [];
  let finalState;

  await t.test('all bonded and periodic pair forces initialize; staged writes preserve committed state', async () => {
    await reachDrift(first);
    const before = await state(first), info = await engine.runInfo(first);
    assert.equal(info.completedSteps, 0n);
    assert.equal(info.activeBuffer, 0n);
    assert.deepEqual(before.positions, input.positions);
    assert.deepEqual(before.velocities, input.particles.map(row => row.slice(1)));
    checkpoints.push(before);
    await advance(first, 1);
    const after = await engine.runInfo(first);
    assert.equal(after.status, 10n); assert.equal(after.cursor, 1n);
    assert.equal(after.completedSteps, 0n); assert.equal(after.activeBuffer, 0n);
    assert.deepEqual(await state(first), before);
    assert.notEqual(await page.readWord(info.stateNamespace, input.positions.length * 9), word(input.positions[0][0]));
  });

  await t.test('three steps across a periodic face match independent differentiated-energy trajectory', async () => {
    let seen = 0;
    for (let calls = 0; calls < 400; calls++) {
      const info = await advance(first, 8);
      if (Number(info.completedSteps) > seen) {
        assert.equal(Number(info.completedSteps), seen + 1);
        seen++; checkpoints.push(await state(first));
      }
      if (info.status === 16n) break;
    }
    assert.equal((await engine.runInfo(first)).status, 16n);
    assert.equal(seen, input.steps);
    finalState = await state(first);
    assert.ok(quadToNumber(finalState.positions[0][0]) > 8, 'Unwrapped atom crosses the box face');
    const periodic = await engine.periodicParameters(first);
    assert.deepEqual([...periodic.box], input.box);
    assert.equal(periodic.exceptionCount, 2n);
    assert.equal((await engine.experimentParameters(first)).pairCount, 6n);
    const comparison = String.raw`
import json,sys
from decimal import Decimal as D,localcontext
p=json.load(sys.stdin)
def decode(h):
 b=int(h,16);e=(b>>112)&32767;f=b&((1<<112)-1)
 if e==32767:raise ValueError('nonfinite EVM output')
 return (-1 if b>>127 else 1)*((D(1)+D(f)/D(2)**112)*D(2)**(e-16383) if e else D(f)*D(2)**(-16382-112))
report=[]
with localcontext() as c:
 c.prec=150
 for got,want in zip(p['actual'],p['expected']):
  assert got['step']==want['step']
  maximum=D(0);count=0
  for field,refkey in [('positions','positions_decimal'),('velocities','velocities_decimal'),('forces','forces_decimal')]:
   for actual,expected in zip(got[field],want[refkey]):
    for h,s in zip(actual,expected):
     y=D(s);error=abs(decode(h)-y);tol=D('1e-25')+D('1e-24')*abs(y)
     if error>tol:raise AssertionError((got['step'],field,str(error),str(tol)))
     maximum=max(maximum,error);count+=1
  y=D(want['potential_energy_decimal']);error=abs(decode(got['energy'])-y)
  assert error<=D('1e-25')+D('1e-24')*abs(y),(got['step'],'energy',str(error))
  report.append({'step':got['step'],'component_values_checked':count+1,'max_absolute_error':str(max(maximum,error)),'passed':True})
print(json.dumps({'scope':'Three-step orthorhombic four-atom validation fixture; not solvated myosin or free energy','oracle':'mpmath 90-digit energy differentiation and velocity Verlet','absolute_tolerance':'1e-25','relative_tolerance':'1e-24','checkpoints':report},indent=2))
`;
    assert.equal(checkpoints.length, reference.checkpoints.length);
    const result = execFileSync(process.env.ORVIA_RESEARCH_PYTHON || process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3', ['-c', comparison],
      { input: JSON.stringify({ actual: checkpoints, expected: reference.checkpoints }), encoding: 'utf8' });
    fs.writeFileSync('reports/periodic_dynamics_validation.json', result);
  });

  await t.test('different transaction partitions reproduce final positions, velocities, forces and energy exactly', async () => {
    const partition = [1,4,3,2,8];
    for (let calls = 0; calls < 400; calls++) {
      const info = await advance(second, partition[calls % partition.length]);
      if (info.status === 16n) break;
    }
    assert.equal((await engine.runInfo(second)).status, 16n);
    assert.deepEqual(await state(second), finalState);
    const a = await engine.runInfo(first), b = await engine.runInfo(second);
    assert.notEqual(a.stateNamespace, b.stateNamespace);
    assert.notEqual(a.commitment, b.commitment);
    assert.equal((await page.namespaceInfo(a.stateNamespace)).isSealed, true);
    assert.equal((await page.namespaceInfo(b.stateNamespace)).isSealed, true);
    await assert.rejects(transact(engine.advanceExperiment(first, 1)));
  });

  await t.test('run commitment independently binds the timestep, step count, modules and dataset', async () => {
    const coder = AbiCoder.defaultAbiCoder(), hash = (types, values) => keccak256(coder.encode(types, values));
    const addresses = Object.values(modules);
    const hashes = await Promise.all(addresses.map(async a => keccak256(await env.provider.getCode(a))));
    const core = hash(['tuple(address registry,address dataset,address math,address integrator,address bond,address angle,address torsion,address lj,address coulomb,address elementary,address geometry,address nonbonded)','bytes32[12]'], [modules, hashes]);
    assert.equal(await engine.coreConfigurationHash(), core);
    const pageAddress = await page.getAddress(), engineAddress = await engine.getAddress();
    const config = hash(['bytes32','address','bytes32'], [core, pageAddress, keccak256(await env.provider.getCode(pageAddress))]);
    assert.equal(await engine.configurationHash(), config);
    const protocolHashes = await Promise.all(protocolAddresses.map(async a => keccak256(await env.provider.getCode(a))));
    const manifest = hash(['bytes32','bytes32','address[]','bytes32[]'], [protocol,specification,protocolAddresses,protocolHashes]);
    const ns = hash(['bytes32','uint256','address','uint256'], [encodeBytes32String('ORVIA-PERIODIC-STATE-v1'),31337,engineAddress,first]);
    const expected = hash(['bytes32','uint256','address','uint256','bytes32','bytes32','bytes32','bytes32','bytes16','uint32','bytes32'],
      [encodeBytes32String('ORVIA-PERIODIC-RUN-v1'),31337,engineAddress,first,manifest,datasetId,
        (await dataset.datasetInfo(datasetId)).commitment,config,input.dt,input.steps,ns]);
    assert.equal((await engine.runInfo(first)).commitment, expected);
  });

  await t.test('a singular trial step cannot change committed coordinates and rolls back same-transaction writes', async () => {
    const colliding = { positions:[[0,0,0],[2,0,0]].map(qvec), particles:[[1,1,0,0],[1,-1,0,0]].map(row=>row.map(q)),
      bonds:[[0,1,q(0),q(1)]], angles:[], torsions:[], pairs:[],
      nonbonded:[[.5,0,0],[.5,0,0]].map(qvec),exceptions:[],box:qvec([8,8,8]),switchDistance:q(2),cutoff:q(3),prefactor:q(1) };
    const badId = await createDataset(colliding), runId = await register(badId, q(1), 1);
    await reachDrift(runId);
    const before = [...await engine.runInfo(runId)], original = await state(runId), ns = before[3];
    const rawBefore = [...await page.readWords(ns, 0, 38)];
    await assert.rejects(transact(engine.advanceExperiment(runId,8,{gasLimit})));
    assert.deepEqual([...await engine.runInfo(runId)], before);
    assert.deepEqual([...await page.readWords(ns,0,38)], rawBefore);
    await advance(runId,2);
    const staged = [...await engine.runInfo(runId)], rawStaged = [...await page.readWords(ns,0,38)];
    assert.equal(staged[9],11n);
    await assert.rejects(transact(engine.advanceExperiment(runId,1,{gasLimit})));
    assert.deepEqual([...await engine.runInfo(runId)],staged);
    assert.deepEqual([...await page.readWords(ns,0,38)],rawStaged);
    assert.deepEqual(await state(runId),original);
    assert.equal((await page.namespaceInfo(ns)).isSealed,false);
  });

  await t.test('authority, invalid integration parameters and bad masses are rejected', async () => {
    await assert.rejects(transact(engine.connect(contributor).registerExperiment(protocol,datasetId,input.dt,1)));
    await assert.rejects(transact(engine.bindWorkingPage(await page.getAddress())));
    for(const dt of [q(0),q(-1),'0x7fff0000000000000000000000000000']) await assert.rejects(transact(engine.registerExperiment(protocol,datasetId,dt,1)));
    for(const steps of [0,4097]) await assert.rejects(transact(engine.registerExperiment(protocol,datasetId,input.dt,steps)));
    const pending = await register();
    for(const work of [0,9]) await assert.rejects(transact(engine.advanceExperiment(pending,work)));
    await assert.rejects(transact(engine.advanceExperiment(999,1)));
    await assert.rejects(engine.stateAt(pending,4));
    const bad = structuredClone(input);bad.particles[0][0]=q(0);
    const badId = await createDataset(bad), invalid = await register(badId);
    const before = [...await engine.runInfo(invalid)];
    await assert.rejects(transact(engine.advanceExperiment(invalid,1,{gasLimit})));
    assert.deepEqual([...await engine.runInfo(invalid)],before);
    assert.deepEqual(await state(first),finalState);
  });
  await t.test('empty optional streams and a batch crossing the last kick preserve the commit barrier', async () => {
    const minimal = {positions:[[0,0,0],[2,0,0]].map(qvec), particles:[[1,0,0,0],[1,0,0,0]].map(row=>row.map(q)),
      bonds:[[0,1,q(1),q(1)]],angles:[],torsions:[],pairs:[],
      nonbonded:[[.5,0,0],[.5,0,0]].map(qvec),exceptions:[],box:qvec([8,8,8]),switchDistance:q(2),cutoff:q(3),prefactor:q(1)};
    const dataId = await createDataset(minimal), runId = await register(dataId,q(0.125),2);
    await reachDrift(runId);
    const initial = await state(runId);
    await advance(runId,2); // drift both atoms
    await advance(runId,2); // bond and the one automatically enumerated normal pair
    await advance(runId,1); // only the first atom's final kick
    const paused = await engine.runInfo(runId);
    assert.equal(paused.status,15n);assert.equal(paused.cursor,1n);
    assert.equal(paused.completedSteps,0n);assert.equal(paused.activeBuffer,0n);
    assert.deepEqual(await state(runId),initial);
    const crossed = await advance(runId,2); // last kick commits; first drift of next step begins
    assert.equal(crossed.completedSteps,1n);assert.equal(crossed.activeBuffer,1n);
    assert.equal(crossed.status,10n);assert.equal(crossed.cursor,1n);
    const committed = await state(runId);
    assert.deepEqual(committed.positions,[[0.0078125,0,0],[1.9921875,0,0]].map(qvec));
    const expectedVelocities = [[0.1240234375,0,0],[-0.1240234375,0,0]];
    for(let atom=0;atom<2;atom++) for(let axis=0;axis<3;axis++) {
      assert.ok(Math.abs(quadToNumber(committed.velocities[atom][axis])-expectedVelocities[atom][axis])<1e-14);
    }
    const done = await advance(runId,8);
    assert.equal(done.status,16n);assert.equal(done.completedSteps,2n);
    assert.equal((await page.namespaceInfo(done.stateNamespace)).isSealed,true);
  });
  await t.test('invalid per-atom parameters and unordered, duplicate or malformed exceptions fail before forces', async () => {
    const cases = [];
    const sigma = structuredClone(input); sigma.nonbonded[0][0] = q(0); cases.push(sigma);
    const epsilon = structuredClone(input); epsilon.nonbonded[0][1] = q(-1); cases.push(epsilon);
    const duplicate = structuredClone(input); duplicate.exceptions[1] = [...duplicate.exceptions[0]]; cases.push(duplicate);
    const reversed = structuredClone(input); reversed.exceptions[0] = [1,0,1,q(0),q(0),q(0)]; cases.push(reversed);
    const excluded = structuredClone(input); excluded.exceptions[0][3] = '0x80000000000000000000000000000000'; cases.push(excluded);
    const kind = structuredClone(input); kind.exceptions[0][2] = 3; cases.push(kind);
    for (const values of cases) {
      const dataId = await createDataset(values), runId = await register(dataId);
      let reverted = false;
      for (let i = 0; i < 20; i++) {
        const before = [...await engine.runInfo(runId)];
        try { await transact(engine.advanceExperiment(runId,1,{gasLimit})); }
        catch {
          reverted = true;
          assert.deepEqual([...await engine.runInfo(runId)], before);
          assert.ok(before[9] <= 5n, 'Malformed values must fail no later than exception validation');
          break;
        }
      }
      assert.equal(reverted, true);
    }
  });

  await t.test('half-box bonded or direct-exception ties cannot commit an ambiguous force', async () => {
    const values = {positions:[[0,0,0],[4,0,0]].map(qvec), particles:[[1,0,0,0],[1,0,0,0]].map(qvec),
      bonds:[[0,1,q(1),q(1)]],angles:[],torsions:[],pairs:[],
      nonbonded:[[.5,0,0],[.5,0,0]].map(qvec),exceptions:[],box:qvec([8,8,8]),switchDistance:q(2),cutoff:q(3),prefactor:q(1)};
    const runId = await register(await createDataset(values), q(.125), 1);
    await advance(runId,3); // Two loaded atoms and one validated bond.
    const before = [...await engine.runInfo(runId)], raw = [...await page.readWords(before[3],0,38)];
    assert.equal(before[9],6n);
    await assert.rejects(transact(engine.advanceExperiment(runId,1,{gasLimit})));
    assert.deepEqual([...await engine.runInfo(runId)],before);
    assert.deepEqual([...await page.readWords(before[3],0,38)],raw);

    const direct = {positions:[[0,0,0],[1,0,0],[4,0,0]].map(qvec),particles:[[1,0,0,0],[1,0,0,0],[1,0,0,0]].map(qvec),
      bonds:[[0,1,q(0),q(1)]],angles:[],torsions:[],pairs:[],
      nonbonded:[[.5,0,0],[.5,0,0],[.5,0,0]].map(qvec),exceptions:[[0,2,2,q(.5),q(0),q(0)]],
      box:qvec([8,8,8]),switchDistance:q(2),cutoff:q(3),prefactor:q(1)};
    const directId = await register(await createDataset(direct),q(.125),1);
    await advance(directId,7); // Load 3, validate bond/exception, initial bond, regular pair(0,1).
    const directBefore = [...await engine.runInfo(directId)];
    assert.equal(directBefore[9],9n); assert.equal(directBefore[4],1n);
    const directRaw = [...await page.readWords(directBefore[3],0,56)];
    await assert.rejects(transact(engine.advanceExperiment(directId,1,{gasLimit})));
    assert.deepEqual([...await engine.runInfo(directId)],directBefore);
    assert.deepEqual([...await page.readWords(directBefore[3],0,56)],directRaw);
  });
  fs.writeFileSync('reports/periodic_dynamics_execution_gas.json',JSON.stringify({
    scope:'Local Ganache Shanghai EVM, four-atom orthorhombic system; not Robinhood fees or protein/RBFE cost',
    chainId:31337,primaryFixture:{atoms:4,bonds:3,angles:2,torsions:1,pairs:6,exceptions:2,steps:3},runs:runDefinitions,transactions:measuredGas
  },null,2)+'\n');
});
