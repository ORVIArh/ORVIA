import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AbiCoder, Contract, encodeBytes32String, id, keccak256, MaxUint256, toBeHex, ZeroHash, zeroPadValue } from 'ethers';
import {
  artifacts, environment, deploy, transact, qvec,
  quadFromNumber as q, quadToNumber
} from './helpers.mjs';

const word = value => zeroPadValue(value, 32);
const indexWord = value => toBeHex(value, 32);
const zeroVector = qvec([0, 0, 0]);
const positionWords = positions => positions.flat().map(word);
const bondWords = bonds => bonds.flatMap(([a, b, k, r0]) => [indexWord(a), indexWord(b), word(k), word(r0)]);

test('Working pages enforce writer authority, namespace isolation, bounds and irreversible seals', async t => {
  const env = await environment();
  t.after(() => env.transport.disconnect());
  const { owner, contributor } = env;
  const writer = await deploy('WorkingStateWriterHarness', owner);
  await assert.rejects(deploy('WorkingStatePage', owner, [await owner.getAddress()]));
  const page = await deploy('WorkingStatePage', owner, [await writer.getAddress()]);
  const pageAddress = await page.getAddress();
  const first = id('working-unit-first'), second = id('working-unit-second');
  const unknown = id('working-unit-unknown'), value = id('stored-word');
  const call = (name, args) => writer.forward(pageAddress, page.interface.encodeFunctionData(name, args));
  const rejects = async (name, args) => assert.rejects(
    writer.forward.staticCall(pageAddress, page.interface.encodeFunctionData(name, args)));

  assert.equal(await page.writer(), await writer.getAddress());
  await assert.rejects(transact(page.createNamespace(first, 2)));
  await rejects('createNamespace', [ZeroHash, 2]);
  await rejects('createNamespace', [first, 0]);
  await rejects('createNamespace', [first, 65537]);
  await transact(call('createNamespace', [first, 2]));
  await transact(call('createNamespace', [second, 65536]));
  await rejects('createNamespace', [first, 2]);
  assert.deepEqual([...await page.namespaceInfo(first)], [2n, false]);
  assert.equal(await page.connect(contributor).readWord(first, 0), ZeroHash);
  await assert.rejects(page.readWord(unknown, 0));
  await assert.rejects(page.readWords(unknown, 0, 0));
  await assert.rejects(page.namespaceInfo(unknown));
  await rejects('writeWord', [unknown, 0, value]);
  await rejects('sealNamespace', [unknown]);

  await transact(call('writeWords', [first, 0, [value, value]]));
  assert.deepEqual([...await page.readWords(first, 0, 2)], [value, value]);
  assert.equal(await page.readWord(second, 0), ZeroHash);
  await rejects('writeWords', [first, 1, [ZeroHash, ZeroHash]]);
  assert.equal(await page.readWord(first, 1), value);
  await rejects('writeWord', [first, 2, value]);
  await rejects('writeWord', [first, MaxUint256, value]);
  await rejects('writeWords', [first, MaxUint256, [value]]);
  await rejects('writeWords', [first, 0, []]);
  await rejects('writeWords', [second, 0, Array(129).fill(value)]);
  await assert.rejects(page.readWord(first, 2));
  await assert.rejects(page.readWords(second, 0, 129));
  await assert.rejects(page.readWords(first, MaxUint256, 0));
  assert.deepEqual([...await page.readWords(first, 2, 0)], []);

  await transact(call('writeWords', [second, 0, Array(128).fill(value)]));
  assert.deepEqual([...await page.readWords(second, 0, 128)], Array(128).fill(value));
  await transact(call('writeWord', [second, 65535, value]));
  assert.equal(await page.readWord(second, 65535), value);
  await transact(call('writeWord', [first, 0, ZeroHash]));
  assert.equal(await page.readWord(first, 0), ZeroHash);
  await assert.rejects(transact(page.connect(contributor).writeWord(first, 0, value)));
  await assert.rejects(transact(page.sealNamespace(first)));
  await transact(call('sealNamespace', [first]));
  assert.deepEqual([...await page.namespaceInfo(first)], [2n, true]);
  await rejects('writeWord', [first, 0, value]);
  await rejects('writeWords', [first, 0, [value]]);
  await rejects('sealNamespace', [first]);
  assert.equal(await page.readWord(first, 1), value);
  await transact(call('writeWord', [second, 0, ZeroHash]));
  assert.equal(await page.readWord(second, 0), ZeroHash);
});

test('Paged bond execution consumes sealed input pages and commits resumable output pages', async t => {
  const env = await environment();
  t.after(() => env.transport.disconnect());
  const { owner, contributor } = env;
  const ownerAddress = await owner.getAddress();
  const math = await deploy('FloatMath', owner);
  const kernel = await deploy('HarmonicBondKernel', owner, [await math.getAddress()]);
  const registry = await deploy('ExperimentRegistry', owner, [ownerAddress]);
  const catalog = await deploy('DatasetCatalog', owner, [ownerAddress]);
  const coordinatorArgs = [ownerAddress, await math.getAddress(), await kernel.getAddress(),
    await registry.getAddress(), await catalog.getAddress()];
  const coordinator = await deploy('PagedBondCoordinator', owner, coordinatorArgs);
  const page = await deploy('WorkingStatePage', owner, [await coordinator.getAddress()]);
  await transact(coordinator.bindWorkingPage(await page.getAddress()));
  const legacy = await deploy('ResumableBondEngine', owner, coordinatorArgs.slice(0, 4));
  const protocol = id('ORVIA-PAGED-COMPONENT-VALIDATION');
  const modules = [math, kernel, catalog, page, coordinator, legacy];
  const addresses = await Promise.all(modules.map(module => module.getAddress()));
  await transact(registry.registerProtocol(protocol, id('paged harmonic fixture only'), addresses));
  const positionRole = await catalog.POSITION_ROLE(), bondRole = await catalog.BOND_ROLE();
  let nextRunId = 1n, datasetSequence = 0;
  const gas = [];

  async function createPage(role, words, sealed = true) {
    const receipt = await transact(catalog.createPage(role, words.length));
    const event = receipt.logs.map(log => {
      try { return catalog.interface.parseLog(log); } catch { return null; }
    }).find(log => log?.name === 'PageCreated');
    assert.ok(event, 'factory must emit its created page address');
    const inputPage = new Contract(event.args.page, artifacts.DataPage.abi, owner);
    for (let i = 0; i < words.length; i += 128) await transact(inputPage.append(words.slice(i, i + 128)));
    if (sealed) await transact(inputPage.seal(await inputPage.rollingDigest()));
    return inputPage;
  }

  async function createStream(role, words, splitAt = []) {
    const boundaries = [0, ...splitAt, words.length];
    const pages = [];
    for (let i = 1; i < boundaries.length; i++) {
      pages.push(await createPage(role, words.slice(boundaries[i - 1], boundaries[i])));
    }
    return pages;
  }

  async function createDataset(positions, bonds, options = {}) {
    const datasetId = id(`paged-dataset-${++datasetSequence}`);
    const pwords = options.positionWords ?? positionWords(positions);
    const bwords = options.bondWords ?? bondWords(bonds);
    const positionPages = await createStream(positionRole, pwords, options.positionSplits);
    const bondPages = await createStream(bondRole, bwords, options.bondSplits);
    const paddresses = await Promise.all(positionPages.map(p => p.getAddress()));
    const baddresses = await Promise.all(bondPages.map(p => p.getAddress()));
    await transact(catalog.registerDataset(datasetId, paddresses, baddresses, positions.length, bonds.length));
    return { datasetId, pwords, bwords, positionPages, bondPages, paddresses, baddresses };
  }

  async function register(datasetId) {
    await transact(coordinator.registerExperiment(protocol, datasetId));
    return nextRunId++;
  }

  async function advanceValidation(runId, batch = 16, recordGas = false) {
    for (let calls = 0; calls < 100; calls++) {
      const state = await coordinator.runInfo(runId);
      if (state.status === 3n) return;
      assert.ok(state.status === 1n || state.status === 2n, 'must be in a validation phase');
      const count = state.status === 1n ? state.atomCount : state.bondCount;
      const work = Math.min(batch, Number(count - state.cursor));
      assert.ok(work > 0, 'validation cannot stall at a completed phase');
      const receipt = await transact(coordinator.connect(contributor).advanceExperiment(runId, work));
      if (recordGas) gas.push({
        scenario: state.status === 1n ? '4-atom validation batch' : '3-bond validation batch',
        requestedWork: work,
        gasUsed: receipt.gasUsed.toString()
      });
    }
    assert.fail('bounded fixture validation did not finish');
  }

  async function allForces(runId, count) {
    const forces = [];
    for (let atom = 0; atom < count; atom++) forces.push([...await coordinator.forceAt(runId, atom)]);
    return forces;
  }

  async function assertZeroOutputs(runId, count) {
    assert.deepEqual(await allForces(runId, count), Array.from({ length: count }, () => zeroVector));
    assert.equal((await coordinator.runInfo(runId)).totalEnergy, q(0));
  }

  const positions = [[0, 0, 0], [2, 0, 0], [2, 3, 0], [1, 1, 2]].map(qvec);
  const bonds = [[0, 1, q(3), q(1)], [1, 2, q(4), q(2)], [2, 3, q(2), q(1)]];
  const dataset = await createDataset(positions, bonds, { positionSplits: [5], bondSplits: [3, 8] });
  let wholeRun, splitRun;

  await t.test('catalog reads coordinates and bond records across page boundaries', async () => {
    for (let i = 0; i < dataset.pwords.length; i++) {
      assert.equal(await catalog.readPositionWord(dataset.datasetId, i), dataset.pwords[i]);
    }
    for (let i = 0; i < dataset.bwords.length; i++) {
      assert.equal(await catalog.readBondWord(dataset.datasetId, i), dataset.bwords[i]);
    }
    assert.equal(await catalog.pageCount(dataset.datasetId, false), 2n);
    assert.equal(await catalog.pageCount(dataset.datasetId, true), 3n);
    assert.equal(await catalog.assertDataset(dataset.datasetId), (await catalog.datasetInfo(dataset.datasetId)).commitment);
    await assert.rejects(catalog.readPositionWord(dataset.datasetId, dataset.pwords.length));
    await assert.rejects(catalog.readBondWord(dataset.datasetId, dataset.bwords.length));
    await assert.rejects(catalog.readPositionWord(id('missing dataset'), 0));
  });

  await t.test('validation is resumable and every input is validated before force evaluation', async () => {
    wholeRun = await register(dataset.datasetId);
    splitRun = await register(dataset.datasetId);
    const initial = await coordinator.runInfo(splitRun);
    assert.equal(initial.status, 1n);
    assert.equal(initial.cursor, 0n);
    assert.equal(initial.protocolId, protocol);
    assert.equal(initial.datasetId, dataset.datasetId);
    await assertZeroOutputs(splitRun, positions.length);
    for (let i = 0; i < positions.length; i++) {
      await transact(coordinator.connect(contributor).advanceExperiment(splitRun, 1));
      const state = await coordinator.runInfo(splitRun);
      assert.equal(state.status, i + 1 === positions.length ? 2n : 1n);
      assert.equal(state.cursor, i + 1 === positions.length ? 0n : BigInt(i + 1));
      await assertZeroOutputs(splitRun, positions.length);
    }
    for (let i = 0; i < bonds.length; i++) {
      await transact(coordinator.connect(contributor).advanceExperiment(splitRun, 1));
      const state = await coordinator.runInfo(splitRun);
      assert.equal(state.status, i + 1 === bonds.length ? 3n : 2n);
      assert.equal(state.cursor, i + 1 === bonds.length ? 0n : BigInt(i + 1));
      await assertZeroOutputs(splitRun, positions.length);
    }
    await advanceValidation(wholeRun, 16, true);
    assert.equal((await coordinator.runInfo(wholeRun)).status, 3n);
    await assertZeroOutputs(wholeRun, positions.length);
  });

  await t.test('paged results agree bit-for-bit across transaction partitions and with the original engine', async () => {
    const receipt = await transact(coordinator.advanceExperiment(wholeRun, 16));
    gas.push({ scenario: '3-bond force batch and output seal', requestedWork: 16, processedWork: 3,
      gasUsed: receipt.gasUsed.toString() });
    for (let i = 0; i < bonds.length; i++) {
      await transact(coordinator.connect(contributor).advanceExperiment(splitRun, 1));
      const progress = await coordinator.runInfo(splitRun);
      assert.equal(progress.cursor, BigInt(i + 1));
      assert.equal(progress.status, i + 1 === bonds.length ? 4n : 3n);
    }
    await transact(legacy.registerExperiment(protocol, positions, bonds));
    await transact(legacy.advanceExperiment(1, 16));
    const whole = await coordinator.runInfo(wholeRun), split = await coordinator.runInfo(splitRun);
    assert.equal(whole.status, 4n);
    assert.equal(whole.totalEnergy, split.totalEnergy);
    assert.equal(whole.totalEnergy, (await legacy.runInfo(1)).totalEnergy);
    assert.notEqual(whole.commitment, split.commitment);
    assert.notEqual(whole.stateNamespace, split.stateNamespace);
    assert.equal(quadToNumber(whole.totalEnergy), 7.5);
    const net = [0, 0, 0];
    for (let atom = 0; atom < positions.length; atom++) {
      const force = [...await coordinator.forceAt(wholeRun, atom)];
      assert.deepEqual(force, [...await coordinator.forceAt(splitRun, atom)]);
      assert.deepEqual(force, [...await legacy.forceAt(1, atom)]);
      assert.deepEqual([...await coordinator.positionAt(wholeRun, atom)], positions[atom]);
      force.forEach((value, axis) => { net[axis] += quadToNumber(value); });
      for (let axis = 0; axis < 3; axis++) {
        assert.equal(await page.readWord(whole.stateNamespace, atom * 3 + axis), word(force[axis]));
      }
    }
    net.forEach(value => assert.ok(Math.abs(value) < 1e-12, 'net internal force must vanish'));
    assert.equal(await page.readWord(whole.stateNamespace, positions.length * 3), word(whole.totalEnergy));
    assert.deepEqual([...await page.namespaceInfo(whole.stateNamespace)], [BigInt(positions.length * 3 + 1), true]);
    assert.deepEqual([...await page.namespaceInfo(split.stateNamespace)], [BigInt(positions.length * 3 + 1), true]);
  });

  await t.test('separate runs isolate checkpoints and completed outputs', async () => {
    const completed = await coordinator.runInfo(wholeRun);
    const saved = [...await page.readWords(completed.stateNamespace, 0, positions.length * 3 + 1)];
    const fresh = await register(dataset.datasetId);
    assert.notEqual((await coordinator.runInfo(fresh)).stateNamespace, completed.stateNamespace);
    await advanceValidation(fresh);
    await transact(coordinator.advanceExperiment(fresh, 1));
    assert.equal((await coordinator.runInfo(fresh)).cursor, 1n);
    assert.deepEqual([...await page.readWords(completed.stateNamespace, 0, saved.length)], saved);
    assert.equal((await coordinator.runInfo(splitRun)).status, 4n);
  });

  await t.test('independently reconstructs page, dataset, configuration and run commitments', async () => {
    const coder = AbiCoder.defaultAbiCoder();
    const hash = (types, values) => keccak256(coder.encode(types, values));
    const codeHash = async address => keccak256(await env.provider.getCode(address));
    async function streamHash(role, pages, sourceWords) {
      let stream = hash(['bytes32', 'uint256'], [role, pages.length]);
      let offset = 0;
      for (let i = 0; i < pages.length; i++) {
        const inputPage = pages[i], address = await inputPage.getAddress();
        const capacity = await inputPage.capacityWords(), count = Number(await inputPage.wordCount());
        let digest = hash(['bytes32', 'bytes32', 'uint32'],
          [encodeBytes32String('ORVIA-DATA-PAGE-v1'), role, capacity]);
        for (const value of sourceWords.slice(offset, offset + count)) digest = hash(['bytes32', 'bytes32'], [digest, value]);
        offset += count;
        assert.equal(await inputPage.rollingDigest(), digest);
        stream = hash(['bytes32', 'uint256', 'address', 'bytes32', 'uint32', 'bytes32'],
          [stream, i, address, await codeHash(address), count, digest]);
      }
      assert.equal(offset, sourceWords.length);
      return stream;
    }
    const positionStream = await streamHash(id('ORVIA.POSITIONS.v1'), dataset.positionPages, dataset.pwords);
    const bondStream = await streamHash(id('ORVIA.BONDS.v1'), dataset.bondPages, dataset.bwords);
    const catalogAddress = await catalog.getAddress(), coordinatorAddress = await coordinator.getAddress();
    const datasetCommitment = hash(['bytes32', 'uint256', 'address', 'bytes32', 'uint32', 'uint32', 'bytes32', 'bytes32'],
      [id('ORVIA.DATASET.v1'), 31337, catalogAddress, dataset.datasetId, positions.length, bonds.length, positionStream, bondStream]);
    assert.equal((await catalog.datasetInfo(dataset.datasetId)).commitment, datasetCommitment);
    const dependencies = [math, kernel, registry, catalog];
    const coreValues = [];
    for (const dependency of dependencies) {
      const address = await dependency.getAddress();
      coreValues.push(address, await codeHash(address));
    }
    const core = hash(Array(4).fill(['address', 'bytes32']).flat(), coreValues);
    assert.equal(await coordinator.coreConfigurationHash(), core);
    const pageAddress = await page.getAddress();
    const configuration = hash(['bytes32', 'address', 'bytes32'], [core, pageAddress, await codeHash(pageAddress)]);
    assert.equal(await coordinator.configurationHash(), configuration);
    const moduleHashes = await Promise.all(addresses.map(codeHash));
    const protocolManifest = hash(['bytes32', 'bytes32', 'address[]', 'bytes32[]'],
      [protocol, id('paged harmonic fixture only'), addresses, moduleHashes]);
    assert.equal((await registry.getProtocol(protocol)).manifestHash, protocolManifest);
    const namespace = hash(['bytes32', 'uint256', 'address', 'uint256'],
      [encodeBytes32String('ORVIA-PAGED-STATE-v1'), 31337, coordinatorAddress, wholeRun]);
    const run = await coordinator.runInfo(wholeRun);
    assert.equal(run.stateNamespace, namespace);
    const commitment = hash(['bytes32', 'uint256', 'address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [encodeBytes32String('ORVIA-PAGED-BOND-v1'), 31337, coordinatorAddress, wholeRun, protocolManifest,
        dataset.datasetId, datasetCommitment, configuration, namespace]);
    assert.equal(run.commitment, commitment);
  });

  await t.test('one bounded transaction can cross validation barriers and finish without skipping records', async () => {
    const runId = await register(dataset.datasetId);
    const receipt = await transact(coordinator.connect(contributor).advanceExperiment(runId, 16));
    const event = receipt.logs.map(log => {
      try { return coordinator.interface.parseLog(log); } catch { return null; }
    }).find(log => log?.name === 'ExperimentAdvanced');
    assert.ok(event);
    assert.equal(event.args.processed, BigInt(positions.length + bonds.length * 2));
    gas.push({ scenario: 'all validation and force stages in one transaction', requestedWork: 16,
      processedWork: Number(event.args.processed), gasUsed: receipt.gasUsed.toString() });
    const state = await coordinator.runInfo(runId);
    assert.equal(state.status, 4n);
    assert.equal(state.cursor, BigInt(bonds.length));
    assert.equal(state.totalEnergy, (await coordinator.runInfo(wholeRun)).totalEnergy);
    assert.deepEqual(await allForces(runId, positions.length), await allForces(wholeRun, positions.length));
    assert.equal((await page.namespaceInfo(state.stateNamespace)).isSealed, true);
  });

  await t.test('binding, caller permissions, run bounds and declared dependencies are enforced', async () => {
    await assert.rejects(transact(coordinator.bindWorkingPage(await page.getAddress())));
    await assert.rejects(transact(coordinator.connect(contributor).bindWorkingPage(await page.getAddress())));
    await assert.rejects(transact(coordinator.connect(contributor).registerExperiment(protocol, dataset.datasetId)));
    await assert.rejects(transact(coordinator.advanceExperiment(999, 1)));
    await assert.rejects(transact(coordinator.advanceExperiment(wholeRun, 1)));
    const pending = await register(dataset.datasetId);
    const before = [...await coordinator.runInfo(pending)];
    await assert.rejects(transact(coordinator.advanceExperiment(pending, 0)));
    await assert.rejects(transact(coordinator.advanceExperiment(pending, 17)));
    await assert.rejects(coordinator.forceAt(pending, positions.length));
    await assert.rejects(coordinator.positionAt(pending, positions.length));
    assert.deepEqual([...await coordinator.runInfo(pending)], before);
    await assert.rejects(transact(coordinator.registerExperiment(protocol, id('missing dataset'))));
    await assert.rejects(transact(page.writeWord(before[3], 0, ZeroHash)));

    const unbound = await deploy('PagedBondCoordinator', owner, coordinatorArgs);
    await assert.rejects(transact(unbound.registerExperiment(protocol, dataset.datasetId)));
    await assert.rejects(transact(unbound.bindWorkingPage(await page.getAddress())));
    const incomplete = id('paged-incomplete-protocol');
    await transact(registry.registerProtocol(incomplete, id('missing working page module'),
      addresses.filter(address => address !== addresses[3])));
    await assert.rejects(transact(coordinator.registerExperiment(incomplete, dataset.datasetId)));
  });

  await t.test('catalog rejects unsealed, untrusted, wrong-role, duplicate and incorrectly covered page sets', async () => {
    const rejected = label => id(`rejected-dataset-${label}`);
    await assert.rejects(transact(catalog.connect(contributor).createPage(positionRole, 1)));
    await assert.rejects(transact(catalog.createPage(id('wrong role'), 1)));
    await assert.rejects(transact(catalog.connect(contributor).registerDataset(rejected('owner'),
      dataset.paddresses, dataset.baddresses, positions.length, bonds.length)));
    const unsealed = await createPage(positionRole, dataset.pwords, false);
    await assert.rejects(transact(catalog.registerDataset(rejected('unsealed'),
      [await unsealed.getAddress()], dataset.baddresses, positions.length, bonds.length)));
    const untrusted = await deploy('DataPage', owner, [ownerAddress, positionRole, dataset.pwords.length]);
    await transact(untrusted.append(dataset.pwords));
    await transact(untrusted.seal(await untrusted.rollingDigest()));
    await assert.rejects(transact(catalog.registerDataset(rejected('untrusted'),
      [await untrusted.getAddress()], dataset.baddresses, positions.length, bonds.length)));
    await assert.rejects(transact(catalog.registerDataset(rejected('roles'),
      dataset.baddresses, dataset.paddresses, positions.length, bonds.length)));
    await assert.rejects(transact(catalog.registerDataset(rejected('duplicate'),
      [dataset.paddresses[0], dataset.paddresses[0]], dataset.baddresses, positions.length, bonds.length)));
    await assert.rejects(transact(catalog.registerDataset(rejected('coverage'),
      dataset.paddresses, dataset.baddresses, positions.length + 1, bonds.length)));
    await assert.rejects(transact(catalog.registerDataset(dataset.datasetId,
      dataset.paddresses, dataset.baddresses, positions.length, bonds.length)));
  });

  await t.test('noncanonical schemas and invalid numerical inputs cannot pass staged validation', async () => {
    const p = [[0, 0, 0], [2, 0, 0]].map(qvec), b = [[0, 1, q(3), q(1)]];
    const highPosition = positionWords(p);
    highPosition[0] = indexWord(1n << 128n);
    const highEndpoint = bondWords(b);
    highEndpoint[0] = indexWord(1n << 32n);
    const highParameter = bondWords(b);
    highParameter[2] = indexWord((1n << 128n) | BigInt(q(3)));
    const nonfinite = positionWords(p);
    nonfinite[0] = word('0x7fff0000000000000000000000000000');
    const invalid = [
      { name: 'position encoding', options: { positionWords: highPosition }, phase: 1, read: ['position', 0] },
      { name: 'endpoint encoding', options: { bondWords: highEndpoint }, phase: 2, read: ['bond', 0] },
      { name: 'parameter encoding', options: { bondWords: highParameter }, phase: 2, read: ['bond', 2] },
      { name: 'nonfinite coordinate', options: { positionWords: nonfinite }, phase: 1 },
      { name: 'negative spring', options: { bondWords: bondWords([[0, 1, q(-1), q(1)]]) }, phase: 2 },
      { name: 'negative rest length', options: { bondWords: bondWords([[0, 1, q(1), q(-1)]]) }, phase: 2 },
      { name: 'self bond', options: { bondWords: bondWords([[0, 0, q(1), q(1)]]) }, phase: 2 },
      { name: 'endpoint out of range', options: { bondWords: bondWords([[0, 2, q(1), q(1)]]) }, phase: 2 }
    ];
    for (const sample of invalid) {
      const bad = await createDataset(p, b, sample.options);
      if (sample.read) {
        const [kind, index] = sample.read;
        await assert.rejects(kind === 'position' ? catalog.readPositionWord(bad.datasetId, index)
          : catalog.readBondWord(bad.datasetId, index));
      }
      const runId = await register(bad.datasetId);
      if (sample.phase === 2) await transact(coordinator.advanceExperiment(runId, p.length));
      const before = [...await coordinator.runInfo(runId)];
      await assert.rejects(transact(coordinator.advanceExperiment(runId, 1, { gasLimit: 12000000 })), sample.name);
      assert.deepEqual([...await coordinator.runInfo(runId)], before, sample.name);
      await assertZeroOutputs(runId, p.length);
    }
  });

  await t.test('later arithmetic failure reverts earlier cross-contract output writes in the same transaction', async () => {
    const p = [[0, 0, 0], [2, 0, 0], [2, 0, 0]].map(qvec);
    const b = [[0, 1, q(3), q(1)], [1, 2, q(4), q(2)]];
    const bad = await createDataset(p, b, { positionSplits: [4], bondSplits: [5] });
    const runId = await register(bad.datasetId);
    await advanceValidation(runId);
    const before = [...await coordinator.runInfo(runId)], ns = before[3];
    const zeroState = [...await page.readWords(ns, 0, p.length * 3 + 1)];
    await assert.rejects(transact(coordinator.advanceExperiment(runId, 2, { gasLimit: 12000000 })));
    assert.deepEqual([...await coordinator.runInfo(runId)], before);
    assert.deepEqual([...await page.readWords(ns, 0, zeroState.length)], zeroState);
    await assertZeroOutputs(runId, p.length);

    await transact(coordinator.advanceExperiment(runId, 1));
    const checkpoint = [...await coordinator.runInfo(runId)];
    const stored = [...await page.readWords(ns, 0, zeroState.length)];
    assert.equal(checkpoint[4], 1n);
    assert.equal(quadToNumber(checkpoint[8]), 1.5);
    assert.notDeepEqual(stored, zeroState);
    await assert.rejects(transact(coordinator.advanceExperiment(runId, 1, { gasLimit: 12000000 })));
    assert.deepEqual([...await coordinator.runInfo(runId)], checkpoint);
    assert.deepEqual([...await page.readWords(ns, 0, stored.length)], stored);
    assert.equal((await page.namespaceInfo(ns)).isSealed, false);
  });
  fs.writeFileSync('reports/paged_execution_gas.json', JSON.stringify({
    scope: 'Local Ganache Shanghai EVM harmonic component fixture only; not Robinhood mainnet pricing, a full protein calculation, or an RBFE cost estimate.',
    chainId: 31337,
    fixture: { atoms: positions.length, bonds: bonds.length, positionPages: 2, bondPages: 3 },
    transactions: gas
  }, null, 2) + '\n');
});
