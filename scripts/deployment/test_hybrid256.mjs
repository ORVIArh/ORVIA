// Focused local-only adversarial tests. No keys, real RPCs, or public broadcasts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {before, test} from 'node:test';
import {keccak256, toBeHex, toQuantity} from 'ethers';
import {CHAIN_ID, canonical, compileHybrid, normalizeSpec, quoteHybrid, readOnlyRpc,
  rehearseHybrid, sha256, verifyPlan, verifyRehearsal} from './hybrid256.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = path.resolve(ROOT, '../output/hybrid256-review');
const sender = '0x2541a9e93B5C853E9208b0C5C7386dD458424c77';
const spec = {chainId: CHAIN_ID, sender, owner: sender, operator: sender, firstNonce: '0'};
let plan, bundle;
const clone = value => structuredClone(value);
function rehash(value) {
  const {planSha256, ...body} = value;
  return {...body, planSha256: sha256(canonical(body))};
}
function alter(change) { const value = clone(plan); change(value); return rehash(value); }

before(async () => {
  plan = await rehearseHybrid({spec});
  bundle = compileHybrid();
  fs.mkdirSync(OUTPUT, {recursive: true});
  fs.writeFileSync(path.join(OUTPUT, 'reviewed-local-plan.json'), JSON.stringify(plan, null, 2) + '\n');
  fs.writeFileSync(path.join(OUTPUT, 'public-spec.json'), JSON.stringify(spec, null, 2) + '\n');
});

test('rehearses exactly 256 contracts across 33 local transactions', () => {
  assert.equal(plan.contractCount, 256);
  assert.equal(plan.transactions.length, 33);
  assert.equal(plan.transactions.reduce((sum, tx) => sum + tx.creates, 0), 256);
  assert.equal(plan.transactions.at(-1).creates, 7);
  assert.equal(plan.conditionalStates.length, 32);
  assert.equal(new Set(plan.contracts.map(c => c.address)).size, 256);
  assert.equal(plan.rehearsal.factoryNonce, '256');
  assert.equal(plan.rehearsal.publicTransactionsSent, 0);
  assert(BigInt(plan.rehearsal.totalGasUsed) > 0n);
  verifyPlan(plan, ROOT, spec);
});

test('rejects invalid, mismatched, or noncanonical release configuration', () => {
  for (const change of [
    s => { s.chainId = 1; }, s => { s.firstNonce = '00'; }, s => { s.firstNonce = '-1'; },
    s => { s.firstNonce = 0; }, s => { s.firstNonce = (2n ** 64n).toString(); },
    s => { s.firstNonce = String(Number.MAX_SAFE_INTEGER - 32); },
    s => { s.owner = '0x0000000000000000000000000000000000000001'; },
    s => { s.operator = '0x0000000000000000000000000000000000000000'; },
    s => { s.privateKey = 'not-a-key'; },
  ]) { const invalid = clone(spec); change(invalid); assert.throws(() => normalizeSpec(invalid)); }
  assert.throws(() => verifyPlan(plan, ROOT, {...spec, operator: '0x0000000000000000000000000000000000000001'}),
    /independently supplied/);
  assert.throws(() => normalizeSpec({...spec, sender: 'SENSITIVE_INPUT_CANARY'}),
    error => !error.message.includes('SENSITIVE_INPUT_CANARY'));
});

test('rejects plan hash, source binding, transaction, and asserted readiness tampering', () => {
  const stale = clone(plan); stale.contractCount = 257;
  assert.throws(() => verifyPlan(stale), /hash mismatch/);
  for (const change of [
    p => { p.sourceBinding.compiler = 'unreviewed'; },
    p => { p.transactions[0].transaction.value = '0x1'; },
    p => { p.transactions[1].transaction.to = spec.sender; },
    p => { p.transactions[1].transaction.data += '00'; },
    p => { p.transactions[1].transaction.nonce = '0x2'; },
    p => { p.scientificCampaignReady = true; },
    p => { p.rehearsal.totalGasUsed = '1'; },
  ]) assert.throws(() => verifyPlan(alter(change), ROOT, spec));
});

test('rejects rehashed constructor-immutable and runtime-hash substitutions', () => {
  for (const [index, artifact] of [[0, bundle.artifacts.ORVIAHybridCoordinator], [1, bundle.artifacts.ORVIAReportShard]]) {
    const changed = alter(p => {
      const entry = p.contracts[index];
      const location = Object.values(artifact.immutableReferences)[0][0].start * 2 + 2;
      const replacement = entry.runtime.slice(location, location + 2) === '00' ? '01' : '00';
      entry.runtime = entry.runtime.slice(0, location) + replacement + entry.runtime.slice(location + 2);
      entry.runtimeKeccak256 = keccak256(entry.runtime);
    });
    assert.throws(() => verifyPlan(changed), /immutable mismatch/);
  }
  assert.throws(() => verifyPlan(alter(p => { p.contracts[0].runtimeKeccak256 = '0x' + '00'.repeat(32); })),
    /immutable mismatch/);
});

test('rejects every rehashed predecessor-state substitution before quoting', async () => {
  for (const change of [
    p => { p.conditionalStates.pop(); },
    p => { p.conditionalStates[0].overrides[p.coordinator].nonce = '0x2'; },
    p => { p.conditionalStates[1].overrides[p.coordinator].state[toBeHex(0, 32)] = toBeHex(0, 32); },
    p => { p.conditionalStates[0].overrides[p.coordinator].balance = '0xffff'; },
    p => { p.conditionalStates[0].overrides[spec.sender].nonce = '0xff'; },
  ]) {
    let calls = 0;
    await assert.rejects(quoteHybrid(alter(change), async () => { calls++; throw new Error('must not reach RPC'); }),
      /predecessor state mismatch/);
    assert.equal(calls, 0);
  }
});

test('detects actual source, lockfile, and directory-symlink drift', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orvia-hybrid-review-'));
  try {
    fs.mkdirSync(path.join(temp, 'contracts'), {recursive: true});
    fs.cpSync(path.join(ROOT, 'contracts/hybrid'), path.join(temp, 'contracts/hybrid'), {recursive: true});
    fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(temp, 'package-lock.json'));
    verifyPlan(plan, temp, spec);
    const source = path.join(temp, 'contracts/hybrid/ORVIAReportShard.sol');
    fs.appendFileSync(source, '\n// source drift test\n');
    assert.throws(() => verifyPlan(plan, temp, spec), /source\/compiler changed/);
    fs.copyFileSync(path.join(ROOT, 'contracts/hybrid/ORVIAReportShard.sol'), source);
    fs.appendFileSync(path.join(temp, 'package-lock.json'), '\n');
    assert.throws(() => verifyPlan(plan, temp, spec), /source\/compiler changed/);
    fs.rmSync(path.join(temp, 'contracts/hybrid'), {recursive: true});
    fs.symlinkSync(path.join(ROOT, 'contracts/hybrid'), path.join(temp, 'contracts/hybrid'), 'dir');
    assert.throws(() => compileHybrid(temp), /Symlinked/);
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
});

function mockRpc(change = {}) {
  const calls = [];
  let estimates = 0, pendingReads = 0, blockReads = 0;
  const block = {number: '0x123', hash: '0x' + '11'.repeat(32), gasLimit: toQuantity(30000000)};
  return {calls, rpc: async (method, params = []) => {
    calls.push({method, params});
    assert(!method.startsWith('eth_send'), 'No broadcast permitted');
    switch (method) {
      case 'eth_chainId': return change.chain ?? toQuantity(CHAIN_ID);
      case 'eth_getBlockByNumber': return change.block?.(++blockReads, block) ?? block;
      case 'eth_getTransactionCount':
        return params[1] === 'pending' ? (change.pending?.(++pendingReads) ?? '0x0')
          : (change.collisionNonce ?? '0x0');
      case 'eth_getBalance': return change.balance ?? toQuantity(10n ** 18n);
      case 'eth_gasPrice': return change.price ?? toQuantity(1000000000n);
      case 'eth_getCode': return change.code ?? '0x';
      case 'eth_estimateGas': {
        const index = estimates++;
        assert.deepEqual(params[0], (({chainId, ...tx}) => tx)(plan.transactions[index].transaction));
        assert.equal(params[1], block.number);
        if (index) assert.deepEqual(params[2], plan.conditionalStates[index - 1].overrides);
        else assert.equal(params.length, 2);
        return change.estimate ?? toQuantity(BigInt(plan.rehearsal.receipts[index].gasUsed) + 1000n);
      }
      default: throw new Error('Unapproved RPC: ' + method);
    }
  }};
}

test('quotes the entire 256-contract infrastructure with read-only mocked RPC', async () => {
  const {rpc, calls} = mockRpc();
  const quote = await quoteHybrid(plan, rpc, ROOT, spec);
  assert.equal(quote.actualContracts, 256);
  assert.equal(quote.infrastructureTransactions, 33);
  assert.equal(quote.estimates.length, 33);
  assert.equal(quote.estimates.filter(e => e.usesLocalPredecessorStateOverrides).length, 32);
  const gas = BigInt(plan.rehearsal.totalGasUsed) + 33000n;
  assert.equal(quote.totalInfrastructureGasIncludingL1Data, gas.toString());
  assert.equal(quote.totalInfrastructureFeeWei, (gas * 1000000000n).toString());
  assert.equal(quote.fullCampaignTotalWei, null);
  assert.equal(quote.publicTransactionsSent, 0);
  assert.equal(quote.balanceCoversEstimate, true);
  assert(calls.every(c => !c.method.startsWith('eth_send')));
  fs.writeFileSync(path.join(OUTPUT, 'mock-quote.json'), JSON.stringify({...quote, mocked: true}, null, 2) + '\n');
});

test('rejects network, nonce, collision, malformed quantity, block-limit, and reorg hazards', async () => {
  for (const change of [
    {chain: '0x1'}, {pending: () => '0x1'}, {collisionNonce: '0x1'}, {code: '0x00'},
    {price: '-1'}, {price: '0x0'}, {balance: '0x00'}, {estimate: '0x0'},
    {estimate: toQuantity(30000001)},
    {block: (i, b) => i === 2 ? {...b, hash: '0x' + '22'.repeat(32)} : b},
    {pending: i => i === 2 ? '0x1' : '0x0'},
  ]) await assert.rejects(quoteHybrid(plan, mockRpc(change).rpc, ROOT, spec));
  const low = await quoteHybrid(plan, mockRpc({balance: '0x0'}).rpc, ROOT, spec);
  assert.equal(low.balanceCoversEstimate, false);
});

test('readOnlyRpc refuses writes and hides endpoint details in errors', async () => {
  assert.throws(() => readOnlyRpc('http://example.invalid'));
  assert.throws(() => readOnlyRpc('https://user:secret@example.invalid'));
  const rpc = readOnlyRpc('https://example.invalid/SENSITIVE_ENDPOINT_CANARY');
  await assert.rejects(rpc('eth_sendRawTransaction', ['0x']), /Non-read-only/);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('SENSITIVE_ENDPOINT_CANARY'); };
    await assert.rejects(rpc('eth_chainId'), error => !error.message.includes('SENSITIVE_ENDPOINT_CANARY'));
    globalThis.fetch = async (_, options) => ({ok: true, json: async () => ({jsonrpc: '2.0',
      id: JSON.parse(options.body).id, result: '0x1237'})});
    assert.equal(await rpc('eth_chainId'), '0x1237');
    globalThis.fetch = async () => ({ok: true, json: async () => ({jsonrpc: '2.0', id: -1, result: '0x1237'})});
    await assert.rejects(rpc('eth_chainId'), /RPC rejected/);
  } finally { globalThis.fetch = originalFetch; }
});

test('independent repeated rehearsal confirms all constructor bindings and states', async () => {
  const result = await verifyRehearsal(plan, spec);
  assert.equal(result.passed, true);
  assert.equal(result.actualContracts, 256);
  assert.equal(result.publicTransactionsSent, 0);
  fs.writeFileSync(path.join(OUTPUT, 'independent-rehearsal.json'), JSON.stringify(result, null, 2) + '\n');
});
