import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verificationBundle, compileVerification, readinessReport, periodicFixturePlan,
  runtimeMatches, deploymentRequest, assertReadOnlyRehearsalChain, canonical, sha256,
  PRODUCTION_CAPABILITIES, WORKLOAD_PHASES, productionAcceptanceBindings, loadProductionAcceptanceEvidence } from '../scripts/deployment/release.mjs';
import { rehearsePeriodicFixture } from '../scripts/deployment/rehearsal.mjs';
import { quoteTransaction, validateUnsignedTransaction, readOnlyRpc } from '../scripts/deployment/quote.mjs';

test('Deployment rehearsal and production readiness boundaries', async t => {
  await t.test('reconstructs a reproducible plan with real dependencies and refuses remote rehearsal chains', () => {
    const owner = '0x1000000000000000000000000000000000000001';
    const first = periodicFixturePlan(owner), repeat = periodicFixturePlan(owner);
    assert.equal(canonical(first), canonical(repeat));
    assert.equal(first.entries.length, 16);
    assert.equal(new Set(first.entries.map(x => x.address)).size, 16);
    assert.deepEqual(first.entries.at(-1).args, [first.addresses.engine]);
    assert.notEqual(periodicFixturePlan(owner, 1).addresses.math, first.addresses.math);
    assert.throws(() => assertReadOnlyRehearsalChain(4663), /refuses non-local/);
    assert.throws(() => assertReadOnlyRehearsalChain(46630), /refuses non-local/);
    assertReadOnlyRehearsalChain(31337);
  });
  await t.test('current experimental inputs cannot pass production readiness even with connected RPC', () => {
    const manifest = JSON.parse(fs.readFileSync('data/contract_manifest.json'));
    const report = readinessReport(manifest, { passed: true, projectVersion: manifest.architecture_version },
      { status: 'verified_read_only', chain_id_observed: 4663 });
    assert.equal(report.readyForMainnet, false);
    assert.equal(report.completeValidatedSlots, 0);
    assert.equal(report.inventory.length, 64);
    assert.ok(report.inventory.some(x => x.implementationState === 'experimental_candidates_only'));
    assert.ok(report.inventory.some(x => x.implementationState === 'no_registered_candidate'));
    assert.ok(report.blockers.some(x => x.includes('complete production system')));
    assert.ok(report.blockers.some(x => x.includes('maximum-work gas evidence')));
    assert.equal(report.broadcastEnabled, false);
  });
  await t.test('broadcast flags are rejected without loading a signer or contacting a network', () => {
    try {
      execFileSync(process.execPath, ['scripts/deploy.mjs', '--mainnet'], { stdio: 'pipe' });
      assert.fail('Unexpected broadcast entry point');
    } catch (error) {
      assert.equal(error.status, 2);
      assert.match(error.stderr.toString(), /broadcast is not implemented or enabled/);
    }
  });
  await t.test('fee quotes are read-only, chain-bound and include the exact transaction and gas margin', async () => {
    const request = { chainId: 4663, from: '0x1000000000000000000000000000000000000001', to: '0x2000000000000000000000000000000000000002', data: '0x1234', value: '0x0' };
    const calls = [];
    const rpc = async (method, params) => {
      calls.push({ method, params });
      return { eth_chainId: '0x1237', eth_getBlockByNumber: { number: '0x20', hash: '0x' + '11'.repeat(32) },
        eth_getTransactionCount: '0x3', eth_gasPrice: '0xa', eth_estimateGas: '0x64', eth_getBalance: '0x1000' }[method];
    };
    const quote = await quoteTransaction(request, rpc);
    assert.equal(quote.gasEstimateIncludingL1Data, '100');
    assert.equal(quote.estimatedFeeWei, '1000');
    assert.equal(quote.feeBudgetAtQuotedGasPriceWei, '1200');
    assert.equal(quote.balanceCoversQuotedBudgetAndValue, true);
    assert.equal(quote.transactionsSent, 0);
    const estimate = calls.find(x => x.method === 'eth_estimateGas');
    assert.equal(estimate.params[0].nonce, '0x3');
    assert.equal(estimate.params[0].data, '0x1234');
    await assert.rejects(quoteTransaction(request, async () => '0x1'), /chain ID/);
    assert.throws(() => validateUnsignedTransaction({ ...request, privateKey: 'not-accepted' }), /Unsupported/);
    assert.throws(() => validateUnsignedTransaction({ ...request, chainId: 1 }), /4663/);
    await assert.rejects(readOnlyRpc('https://example.invalid')('eth_sendRawTransaction', []), /refused/);
  });
  const bundle = verificationBundle();
  const artifacts = compileVerification(bundle);
  await t.test('runtime checks distinguish compiler code from immutable constructor slots', () => {
    const artifact = artifacts.WorkingStatePage;
    const reference = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
    assert.ok(Object.values(artifact.immutableReferences).flat().length > 0);
    const changedImmutable = Buffer.from(reference);
    const first = Object.values(artifact.immutableReferences).flat()[0];
    changedImmutable[first.start + first.length - 1] ^= 1;
    assert.equal(runtimeMatches('0x' + changedImmutable.toString('hex'), artifact), true);
    const changedCode = Buffer.from(reference); changedCode[0] ^= 1;
    assert.equal(runtimeMatches('0x' + changedCode.toString('hex'), artifact), false);
    assert.equal(runtimeMatches('0x00', artifact), false);
    assert.throws(() => deploymentRequest({ ...artifact, bytecode: '0x' + '00'.repeat(192 * 1024) }, ['0x1000000000000000000000000000000000000001']), /including constructor/);
  });
  await t.test('deploys, binds, uploads and verifies the complete periodic fixture locally', async () => {
    const fixture = JSON.parse(fs.readFileSync('reference/periodic_reference.json'));
    const report = await rehearsePeriodicFixture({ bundle, artifacts, fixture, outputDirectory: 'reports' });
    assert.equal(report.passed, true);
    assert.equal(report.productionReady, false);
    assert.equal(report.executionChainId, 31337);
    assert.equal(report.mainnetTransactionsSent, 0);
    assert.equal(report.coreInstances, 16);
    assert.equal(report.populatedInputPageInstances, 7);
    assert.equal(report.totalLocalInstances, 23);
    assert.equal(report.completedSteps, 0);
    assert.ok(report.inputPages.every(p => p.sealed && p.populatedBytes > 0));
    assert.ok(report.sourceVerificationDescriptors.every(d => d.compilerTemplateMatchedOutsideImmutables && !d.sourceVerifiedOnExplorer));
    assert.ok(report.dependencyChecks.every(d => d.passed));
    for (const transaction of report.transactions) {
      assert.ok(BigInt(transaction.gasUsed) <= BigInt(transaction.gasLimit));
    }
  });
});

test('Production acceptance gate requires bound end-to-end and full-system workload evidence', async t => {
  function fixture() {
    // Synthetic unit-test declarations only. Nothing is saved into production data.
    const h = '1'.repeat(64), manifest = JSON.parse(fs.readFileSync('data/contract_manifest.json'));
    manifest.requirements.compiled_production_system = true;
    manifest.requirements.scientifically_validated = true;
    manifest.scientific_blockers = [];
    manifest.production_protocol_keccak256 = '0x' + '2'.repeat(64);
    for (const slot of manifest.slots) {
      slot.production_status = 'validated';
      slot.code = { source_bundle_sha256: h, runtime_code_keccak256: '0x' + h, runtime_size_bytes: 1000, initcode_size_bytes: 1100 };
      if (slot.category === 'input_storage') slot.data = { sealed: true, size_bytes: 128 };
    }
    const validation = { passed: true, projectVersion: manifest.architecture_version };
    const preflight = { status: 'verified_read_only', chain_id_observed: 4663 };
    const slots = manifest.slots.map(s => ({ slot: s.id, targetForkSimulationPassed: true,
      sourceVerificationRehearsalPassed: true, worstCaseGasMeasured: true }));
    const scientific = { ready_for_orvia_001_registration: true, accepted_model_sha256: '3'.repeat(64),
      accepted_model_atom_counts: { complex: 10000, solvent: 1000 } };
    const operator = { address: '0x1000000000000000000000000000000000000001', startNonce: 0,
      productionPlanSha256: '4'.repeat(64), liveFeeQuotesVerified: true, preparedTransactionCount: 100,
      acceptedMaxDurationSeconds: '10' };
    const bindings = productionAcceptanceBindings(manifest, validation, scientific, operator, h);
    const common = { schemaVersion: 1, status: 'passed', bindings };
    const fork = { chainId: 4663, mode: 'target_chain_fork', blockHash: '0x' + '5'.repeat(64) };
    const records = {
      pipeline: { ...common, evidenceId: 'pipeline', kind: 'pipeline_execution', scope: 'full_prepared_model_pipeline',
        execution: fork, capabilities: [...PRODUCTION_CAPABILITIES] },
      workload: { ...common, evidenceId: 'workload', kind: 'full_system_workload_measurement', scope: 'full_prepared_model_complete_protocol',
        execution: fork, modelAtomCounts: scientific.accepted_model_atom_counts, maxTransactionGas: '500',
        phaseMeasurements: WORKLOAD_PHASES.map(phase => ({ phase, measuredGasPerUnit: '100', campaignUnits: '10' })) },
      throughput: { ...common, evidenceId: 'throughput', kind: 'allocated_throughput_measurement', scope: 'observed_allocated_target_chain_gas',
        execution: { chainId: 4663, mode: 'target_chain_observation', startBlockHash: '0x' + '6'.repeat(64), endBlockHash: '0x' + '7'.repeat(64) },
        observedAllocatedGas: '100000', observationSeconds: '100', transactionGasLimit: '1000000' }
    };
    const acceptance = { schemaVersion: 1, scope: 'ORVIA-001-full-rbfe', bindings,
      evidence: Object.entries(records).map(([id, record]) => ({ id, path: `reports/production/${id}.json`, sha256: sha256(canonical(record)) })),
      capabilities: PRODUCTION_CAPABILITIES.map(id => ({ id, evidenceId: 'pipeline' })),
      workload: { measurementEvidenceId: 'workload', throughputEvidenceId: 'throughput', gasBudget: '10000', maxDurationSeconds: '10' } };
    const context = { sourceBundleSha256: h, evidenceRecords: Object.fromEntries(Object.entries(records).map(([id, record]) =>
      [id, { sha256: sha256(canonical(record)), record }])) };
    return { manifest, validation, preflight, slots, scientific, operator, acceptance, context, records };
  }
  const evaluate = (f, acceptance = f.acceptance) => readinessReport(f.manifest, f.validation, f.preflight,
    f.slots, f.scientific, f.operator, acceptance, f.context);
  await t.test('all component/science/RPC/operator booleans cannot substitute for missing production acceptance', () => {
    const f = fixture(), report = evaluate(f, null);
    assert.equal(report.completeValidatedSlots, f.manifest.slots.length);
    assert.equal(report.readyForMainnet, false);
    assert(report.blockers.some(b => b.includes('complete end-to-end pipeline')));
    assert.equal(evaluate(f, { schemaVersion: 1, passed: true, pipelineComplete: true, workloadAffordable: true }).readyForMainnet, false);
  });
  await t.test('complete synthetic evidence passes structure only, while every capability is mandatory', () => {
    const f = fixture(), report = evaluate(f);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.readyForMainnet, true);
    assert.equal(report.broadcastEnabled, false);
    assert.match(report.productionAcceptance.notice, /do not prove report truth/);
    for (const id of PRODUCTION_CAPABILITIES) {
      const g = fixture(); g.acceptance.capabilities = g.acceptance.capabilities.filter(c => c.id !== id);
      assert.equal(evaluate(g).readyForMainnet, false, id);
    }
  });
  await t.test('rejects stale bindings, missing files, small fixtures, omitted phases and hypothetical throughput', () => {
    const mutations = [
      f => { f.acceptance.bindings = { ...f.acceptance.bindings, sourceBundleSha256: '9'.repeat(64) }; },
      f => { f.context.evidenceRecords.pipeline = null; },
      f => { f.context.evidenceRecords.pipeline.sha256 = '9'.repeat(64); },
      f => { f.records.pipeline.bindings = { ...f.records.pipeline.bindings, protocolKeccak256: '0x' + '9'.repeat(64) }; },
      f => { f.records.pipeline.scope = 'four_atom_fixture'; },
      f => { f.records.workload.modelAtomCounts = { complex: 4, solvent: 4 }; },
      f => { f.records.workload.phaseMeasurements.pop(); },
      f => { f.records.workload.phaseMeasurements.push({ phase: 'unbudgeted_extra_work', measuredGasPerUnit: '999999999', campaignUnits: '999999999' }); },
      f => { f.records.throughput.execution.mode = 'hypothetical_gas_per_second'; },
      f => { f.acceptance.workload.gasBudget = '5999'; },
      f => { f.operator.acceptedMaxDurationSeconds = '9'; },
      f => { f.records.workload.maxTransactionGas = '1000001'; }
    ];
    for (const mutate of mutations) { const f = fixture(); mutate(f); assert.equal(evaluate(f).readyForMainnet, false); }
  });
  await t.test('evidence loader verifies actual bytes and refuses changed files or path escape', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvia-production-evidence-'));
    try {
      const f = fixture(); fs.mkdirSync(path.join(root, 'reports/production'), { recursive: true });
      for (const [id, record] of Object.entries(f.records)) fs.writeFileSync(path.join(root, `reports/production/${id}.json`), canonical(record));
      f.context.evidenceRecords = loadProductionAcceptanceEvidence(root, f.acceptance);
      assert.equal(evaluate(f).readyForMainnet, true);
      fs.appendFileSync(path.join(root, 'reports/production/pipeline.json'), '\n');
      f.context.evidenceRecords = loadProductionAcceptanceEvidence(root, f.acceptance);
      assert.equal(evaluate(f).readyForMainnet, false);
      f.acceptance.evidence[0].path = 'reports/production/../../outside.json';
      assert.match(loadProductionAcceptanceEvidence(root, f.acceptance).pipeline.error, /outside/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
