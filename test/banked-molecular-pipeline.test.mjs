import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak256 } from 'ethers';
import { setup, harmonicFixture } from './molecular-pipeline-fixture.mjs';
import { quadFromNumber as q } from './helpers.mjs';
const plain = value => Array.isArray(value) ? [...value].map(plain) : value;

test('Fixed banks carry the molecular pipeline without new per-run contracts', async t => {
  const file = 'reports/banked_molecular_pipeline_validation.json';
  const sha = name => createHash('sha256').update(fs.readFileSync(name)).digest('hex');
  const report = { status: 'in_progress', passed: false, mainnetTransactionsSent: 0,
    scope: 'Actual local 248-address connected prototype and two-atom numerical equivalence; not a complete 256-contract or full-model campaign.',
    testSha256: sha(new URL(import.meta.url)), fixtureSha256: sha(new URL('./molecular-pipeline-fixture.mjs', import.meta.url)) };
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  const banked = await setup(t, { banked: true });
  const addresses = banked.coreDeployments.map(x => x.address);
  const bankRecords = [];
  for (const [pool, router, count] of [['input', banked.inputs, 96], ['pipeline', banked.state, 64], ['hamiltonian', banked.output, 64]]) {
    for (let index = 0; index < count; index++) {
      const [address, hash] = await router.bankInfo(index);
      const code = await banked.provider.getCode(address);
      assert.notEqual(code, '0x'); assert.equal(keccak256(code), hash);
      addresses.push(address); bankRecords.push({ pool, index, address, runtimeKeccak256: hash });
    }
  }
  assert.equal(banked.coreDeployments.length, 24);
  assert.equal(addresses.length, 248); assert.equal(new Set(addresses).size, 248);
  const routerAddresses = await Promise.all([banked.inputs, banked.state, banked.output].map(c => c.getAddress()));
  const nonces = await Promise.all(routerAddresses.map(address => banked.transport.request({ method: 'eth_getTransactionCount', params: [address, 'latest'] })));
  assert.deepEqual(nonces.map(Number), [97, 65, 65]);

  const legacy = await setup(t);
  const runs = [];
  for (const e of [banked, legacy]) {
    const { tid } = await e.makeTopology(harmonicFixture(), [q(0), q(1)]);
    const campaign = await e.campaign(tid), run = await e.start(campaign, 0);
    await e.initialize(run);
    const checkpoint = (await e.pipeline.runInfo(run)).checkpoint;
    const initialWords = plain(await e.state.readWords(checkpoint, 0, 19));
    await e.finish(run, e === banked ? [3, 8, 1] : [8]);
    assert.deepEqual(plain(await e.state.readWords(checkpoint, 0, 19)), initialWords);
    runs.push({ e, campaign, run, checkpoint, initialWords, finalState: plain(await e.stateAt(run, 2)) });
  }
  assert.deepEqual(runs[0].initialWords, runs[1].initialWords);
  assert.deepEqual(runs[0].finalState, runs[1].finalState);
  for (let sample = 0; sample < 4; sample++) {
    const records = await Promise.all(runs.map(({ e, campaign }) => e.pipeline.sampleInfo(campaign, sample)));
    assert.equal(records[0].step, records[1].step);
    for (let state = 0; state < 2; state++) {
      const energies = await Promise.all(runs.map(({ e, campaign }) => e.pipeline.sampleEnergy(campaign, sample, state)));
      assert.equal(energies[0], energies[1]);
    }
  }
  const after = await Promise.all(routerAddresses.map(address => banked.transport.request({ method: 'eth_getTransactionCount', params: [address, 'latest'] })));
  assert.deepEqual(after, nonces);
  report.compilation = banked.compilation;
  report.coreDeployments = banked.coreDeployments;
  report.banks = bankRecords;
  report.actualLocalAddresses = addresses.length;
  report.targetProductionAddresses = 256;
  report.unimplementedCoreIntegrations = 8;
  report.bankCreationReceipts = banked.bankDeployments;
  report.localCoreDeploymentGas = banked.coreDeployments.reduce((sum, row) => sum + BigInt(row.gas), 0n).toString();
  report.localBankCreationGas = banked.bankDeployments.reduce((sum, row) => sum + BigInt(row.gas), 0n).toString();
  report.localPipelineAdvanceGas = banked.gas.reduce((sum, row) => sum + BigInt(row.gas), 0n).toString();
  report.contractCountUnchangedDuringRuns = true;
  report.bitwiseInitialAndFinalStatesMatchLegacy = true;
  report.allEightCrossStateSampleEnergiesMatchLegacy = true;
  report.immutableInitialSnapshotRetained = true;
  report.passed = true; report.status = 'passed_local_fixture';
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
});
