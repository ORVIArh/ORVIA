import fs from 'node:fs';
import path from 'node:path';
import ganache from 'ganache';
import { AbiCoder, BrowserProvider, Contract, encodeBytes32String, id, keccak256, toBeHex, zeroPadValue } from 'ethers';
import { LOCAL_CHAIN_ID, TARGET_CHAIN_ID, assertReadOnlyRehearsalChain, periodicFixturePlan,
  deploymentRequest, runtimeMatches, sourceVerificationDescriptor, sha256, canonical } from './release.mjs';

const equal = (a, b, label) => { if (String(a).toLowerCase() !== String(b).toLowerCase()) throw new Error(`Verification failed: ${label}`); };
const word = x => typeof x === 'number' ? toBeHex(x, 32) : zeroPadValue(x, 32);
const abi = AbiCoder.defaultAbiCoder();

export async function rehearsePeriodicFixture({ bundle, artifacts, fixture, outputDirectory = null }) {
  // The transport is created here and is never selected from an RPC URL or key.
  const transport = ganache.provider({ logging: { quiet: true },
    chain: { chainId: LOCAL_CHAIN_ID, hardfork: 'shanghai' },
    wallet: { deterministic: true, totalAccounts: 2 }, miner: { blockGasLimit: 30_000_000 } });
  const provider = new BrowserProvider(transport); provider.pollingInterval = 10;
  try {
    assertReadOnlyRehearsalChain((await provider.getNetwork()).chainId);
    const owner = await provider.getSigner(0), contributor = await provider.getSigner(1);
    const ownerAddress = await owner.getAddress();
    const plan = periodicFixturePlan(ownerAddress, await provider.getTransactionCount(ownerAddress, 'pending'));
    const contracts = {}, descriptors = [], transactions = [], dependencies = [];
    async function send(request, phase, label, signer = owner) {
      const estimate = await signer.estimateGas(request);
      const limit = estimate * 12n / 10n + 10_000n;
      if (limit > 28_000_000n) throw new Error(`Rehearsal gas limit exceeded: ${label}`);
      const response = await signer.sendTransaction({ ...request, gasLimit: limit });
      const receipt = await response.wait();
      if (receipt.status !== 1) throw new Error(`Transaction failed: ${label}`);
      transactions.push({ phase, label, transactionHash: receipt.hash, gasEstimate: estimate.toString(),
        gasLimit: limit.toString(), gasUsed: receipt.gasUsed.toString(),
        calldataBytes: request.data ? (request.data.length - 2) / 2 : 0 });
      return receipt;
    }
    async function call(contract, method, args, phase, label, signer = owner) {
      return send(await contract.getFunction(method).populateTransaction(...args), phase, label, signer);
    }
    for (const entry of plan.entries) {
      const artifact = artifacts[entry.contract];
      if (!artifact) throw new Error(`Missing compiled contract ${entry.contract}`);
      const request = deploymentRequest(artifact, entry.args);
      const receipt = await send({ data: request.data, value: 0n, nonce: entry.nonce }, 'core_deployment', entry.key);
      equal(receipt.contractAddress, entry.address, `${entry.key} predicted CREATE address`);
      const code = await provider.getCode(entry.address);
      if (!runtimeMatches(code, artifact)) throw new Error(`Deployed runtime mismatch: ${entry.key}`);
      descriptors.push(sourceVerificationDescriptor(entry, artifact, receipt, code, bundle));
      contracts[entry.key] = new Contract(entry.address, artifact.abi, owner);
    }
    const a = plan.addresses, c = contracts;
    async function check(contract, getter, expected, label) {
      const observed = await contract.getFunction(getter)(); equal(observed, expected, label);
      dependencies.push({ label, expected, observed: String(observed), passed: true });
    }
    for (const key of ['registry', 'base', 'dynamics', 'dataset', 'engine']) await check(c[key], 'owner', ownerAddress, `${key}.owner`);
    for (const key of ['elementary', 'integrator', 'bond', 'angle', 'torsion', 'lj', 'coulomb', 'geometry', 'nonbonded']) await check(c[key], 'numericalMath', a.math, `${key}.numericalMath`);
    for (const key of ['angle', 'torsion']) await check(c[key], 'elementaryMath', a.elementary, `${key}.elementaryMath`);
    await check(c.nonbonded, 'ljKernel', a.lj, 'nonbonded.ljKernel');
    await check(c.nonbonded, 'coulombKernel', a.coulomb, 'nonbonded.coulombKernel');
    await check(c.dynamics, 'baseCatalog', a.base, 'dynamics.baseCatalog');
    await check(c.dataset, 'dynamicsCatalog', a.dynamics, 'dataset.dynamicsCatalog');
    await check(c.working, 'writer', a.engine, 'working.writer');
    const modules = await c.engine.modules();
    for (const [key, expected] of Object.entries(plan.modules)) equal(modules[key], expected, `engine.modules.${key}`);
    await call(c.engine, 'bindWorkingPage', [a.working], 'configuration', 'bind working page');
    await check(c.engine, 'statePage', a.working, 'engine.statePage');
    const protocolId = id('ORVIA-LOCAL-DEPLOYMENT-REHEARSAL-v1');
    const specification = id('Four-atom periodic deployment rehearsal; not the ORVIA-001 scientific system');
    const protocolAddresses = [...Object.values(plan.modules), a.base, a.dynamics, a.working, a.engine];
    await call(c.registry, 'registerProtocol', [protocolId, specification, protocolAddresses], 'configuration', 'register fixture protocol');
    const codeHashes = await Promise.all(protocolAddresses.map(async address => keccak256(await provider.getCode(address))));
    const expectedManifest = keccak256(abi.encode(['bytes32', 'bytes32', 'address[]', 'bytes32[]'],
      [protocolId, specification, protocolAddresses, codeHashes]));
    equal(await c.registry.assertProtocol(protocolId), expectedManifest, 'protocol commitment');

    const inputPages = [];
    async function page(factory, role, values, label) {
      if (!values.length) return [];
      if (values.length > 4096) throw new Error('Fixture page too large');
      const creation = await call(factory, 'createPage', [role, values.length], 'input_page_deployment', `create ${label}`);
      const event = creation.logs.map(log => { try { return factory.interface.parseLog(log); } catch { return null; } }).find(x => x?.name === 'PageCreated');
      if (!event) throw new Error('Missing page creation event');
      const address = event.args.page, instance = new Contract(address, artifacts.DataPage.abi, owner);
      const encoded = values.map(word);
      let digest = keccak256(abi.encode(['bytes32', 'bytes32', 'uint32'],
        [encodeBytes32String('ORVIA-DATA-PAGE-v1'), role, values.length]));
      for (const value of encoded) digest = keccak256(abi.encode(['bytes32', 'bytes32'], [digest, value]));
      for (let offset = 0; offset < encoded.length; offset += 128) await call(instance, 'append', [encoded.slice(offset, offset + 128)], 'input_upload', `append ${label}:${offset}`);
      equal(await instance.rollingDigest(), digest, `${label} digest`);
      await call(instance, 'seal', [digest], 'input_seal', `seal ${label}`);
      equal(await instance.owner(), ownerAddress, `${label} owner`);
      equal(await instance.role(), role, `${label} role`);
      equal(await instance.capacityWords(), values.length, `${label} capacity`);
      if (!(await instance.isSealed())) throw new Error('Input page not sealed');
      for (let offset = 0; offset < encoded.length; offset += 128) {
        const read = await instance.readWords(offset, Math.min(128, encoded.length - offset));
        read.forEach((value, i) => equal(value, encoded[offset + i], `${label} stored word`));
      }
      const code = await provider.getCode(address);
      if (!runtimeMatches(code, artifacts.DataPage)) throw new Error('Input page runtime mismatch');
      const entry = { key: label, contract: 'DataPage', address, args: [ownerAddress, role, values.length] };
      descriptors.push({ ...sourceVerificationDescriptor(entry, artifacts.DataPage, creation, code, bundle), creationViaFactory: true });
      inputPages.push({ label, address, role, words: values.length, populatedBytes: values.length * 32, digest, sealed: true });
      return [address];
    }
    const input = fixture.inputs;
    const baseId = id('ORVIA-LOCAL-DEPLOYMENT-BASE-v1'), dynamicsId = id('ORVIA-LOCAL-DEPLOYMENT-DYNAMICS-v1'), datasetId = id('ORVIA-LOCAL-DEPLOYMENT-PERIODIC-v1');
    const positions = await page(c.base, await c.base.POSITION_ROLE(), input.positions.flat(), 'positions');
    const bonds = await page(c.base, await c.base.BOND_ROLE(), input.bonds.flat(), 'bonds');
    await call(c.base, 'registerDataset', [baseId, positions, bonds, input.positions.length, input.bonds.length], 'dataset_registration', 'register base');
    const particles = await page(c.dynamics, await c.dynamics.PARTICLE_ROLE(), input.particles.flat(), 'particles');
    const angles = await page(c.dynamics, await c.dynamics.ANGLE_ROLE(), input.angles.flat(), 'angles');
    const torsions = await page(c.dynamics, await c.dynamics.TORSION_ROLE(), input.torsions.flat(), 'torsions');
    await call(c.dynamics, 'registerDataset', [dynamicsId, { baseDatasetId: baseId, particlePages: particles,
      anglePages: angles, torsionPages: torsions, pairPages: [], angleCount: input.angles.length,
      torsionCount: input.torsions.length, pairCount: 0 }], 'dataset_registration', 'register dynamics');
    const nonbonded = await page(c.dataset, await c.dataset.NONBONDED_ROLE(), input.nonbonded.flat(), 'nonbonded');
    const exceptions = await page(c.dataset, await c.dataset.EXCEPTION_ROLE(), input.exceptions.flat(), 'exceptions');
    await call(c.dataset, 'registerDataset', [datasetId, { dynamicsDatasetId: dynamicsId, nonbondedPages: nonbonded,
      exceptionPages: exceptions, exceptionCount: input.exceptions.length, box: input.box,
      switchDistance: input.switchDistance, cutoff: input.cutoff, prefactor: input.prefactor }], 'dataset_registration', 'register periodic');
    const datasetCommitment = await c.dataset.assertDataset(datasetId);
    const runId = await c.engine.nextExperimentId();
    await call(c.engine, 'registerExperiment', [protocolId, datasetId, input.dt, input.steps], 'experiment_registration', 'register fixture experiment');
    await call(c.engine, 'advanceExperiment', [runId, 1], 'permissionless_smoke', 'load first particle', contributor);
    const runInfo = await c.engine.runInfo(runId);
    equal(runInfo.cursor, 1, 'first permissionless work unit'); equal(runInfo.completedSteps, 0, 'no trajectory completion claim');
    const phaseGas = {};
    for (const row of transactions) phaseGas[row.phase] = (BigInt(phaseGas[row.phase] || '0') + BigInt(row.gasUsed)).toString();
    const report = { schemaVersion: 1, mode: 'local_rehearsal', targetChainId: TARGET_CHAIN_ID,
      executionChainId: LOCAL_CHAIN_ID, passed: true, productionReady: false, mainnetTransactionsSent: 0,
      scope: 'Deployment/configuration/input upload and one permissionless loading unit for the existing four-atom periodic fixture. Does not execute or validate the complete myosin system or a mainnet fork.',
      compiler: bundle.compiler, standardInputSha256: bundle.inputSha256, fixtureSha256: sha256(canonical(fixture)),
      coreInstances: plan.entries.length, populatedInputPageInstances: inputPages.length,
      totalLocalInstances: descriptors.length, productionPlannedInstances: 64,
      owner: ownerAddress, planSha256: sha256(canonical(plan)), plan,
      dependencyChecks: dependencies, sourceVerificationDescriptors: descriptors, inputPages,
      protocolId, protocolManifest: expectedManifest, datasetId, datasetCommitment,
      runId: runId.toString(), completedSteps: Number(runInfo.completedSteps),
      transactions, gasByPhase: phaseGas,
      totalMeasuredGas: transactions.reduce((sum, row) => sum + BigInt(row.gasUsed), 0n).toString(),
      feeLimitations: 'Local execution gas only. No live Robinhood estimate, L1 data fee, maximum-sized input quote or complete scientific run quote.' };
    if (outputDirectory) {
      fs.mkdirSync(outputDirectory, { recursive: true });
      fs.writeFileSync(path.join(outputDirectory, 'deployment_rehearsal.json'), JSON.stringify(report, null, 2) + '\n');
      fs.writeFileSync(path.join(outputDirectory, 'deployment_standard_input.json'), JSON.stringify(bundle.input, null, 2) + '\n');
      fs.writeFileSync(path.join(outputDirectory, 'deployment_fixture_plan.json'), JSON.stringify(plan, null, 2) + '\n');
    }
    return report;
  } finally { await transport.disconnect(); }
}
