import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readonlyForkProvider, httpsForkReader, pinForkBlock, assertForkBlockStable } from '../scripts/deployment/fork.mjs';

const block = { number: '0x20', hash: '0x' + '12'.repeat(32), stateRoot: '0x' + '34'.repeat(32),
  timestamp: '0x60', gasLimit: '0x1c9c380' };

test('fork transport refuses every mutation before contacting the upstream', async () => {
  const requests = [];
  const provider = readonlyForkProvider(async (method, params) => { requests.push([method, params]); return '0x1237'; });
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_unlockAccount',
    'evm_mine', 'evm_setAccountBalance', 'debug_setHead', 'wallet_addEthereumChain']) {
    await assert.rejects(provider.request({ method }), /refused/);
  }
  assert.equal(requests.length, 0);
  assert.equal(await provider.request({ method: 'eth_chainId' }), '0x1237');
  assert.deepEqual(requests, [['eth_chainId', []]]);
  assert.deepEqual(provider.counts, { eth_chainId: 1 });
  await assert.rejects(httpsForkReader('https://example.invalid')('eth_sendRawTransaction', []), /refused/);
  assert.throws(() => httpsForkReader('http://example.invalid'), /HTTPS/);
  assert.throws(() => httpsForkReader('https://user:pass@example.invalid'), /credentials/);
});

test('fork pin rejects a wrong chain, missing identity, wrong height and unsafe block number', async () => {
  const make = (chain = '0x1237', b = block) => readonlyForkProvider(async method => method === 'eth_chainId' ? chain : b);
  const pinned = await pinForkBlock(make(), '0x20');
  assert.equal(pinned.height, 32);
  assert.equal(pinned.hash, block.hash);
  assert.equal(pinned.stateRoot, block.stateRoot);
  await assert.rejects(pinForkBlock(make('0x1')), /4663/);
  await assert.rejects(pinForkBlock(make('0x1237', { ...block, stateRoot: undefined })), /reference block/);
  await assert.rejects(pinForkBlock(make(), '0x21'), /different fork height/);
  await assert.rejects(pinForkBlock(make(), '0x020'), /canonical/);
  await assert.rejects(pinForkBlock(make('0x1237', { ...block, number: '0x20000000000000' })), /simulator range/);
});

test('fork completion rejects a reorg or changed state root at the pinned height', async () => {
  const provider = readonlyForkProvider(async () => block);
  const pinned = { ...block };
  await assertForkBlockStable(provider, pinned);
  await assert.rejects(assertForkBlockStable(provider, { ...pinned, hash: '0x' + '99'.repeat(32) }), /changed/);
  await assert.rejects(assertForkBlockStable(provider, { ...pinned, stateRoot: '0x' + '99'.repeat(32) }), /changed/);
});

test('HTTPS fork reader rejects redirects and malformed replies without exposing provider paths', async () => {
  const original = globalThis.fetch;
  const endpoint = 'https://example.invalid/private-provider-path';
  let mode = 'valid';
  globalThis.fetch = async (url, options) => {
    assert.equal(url, endpoint);
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    const request = JSON.parse(options.body);
    if (mode === 'transport') throw new Error(endpoint);
    if (mode === 'http') return { ok: false, status: 403 };
    return { ok: true, json: async () => {
      if (mode === 'json') throw new Error(endpoint);
      return { jsonrpc: '2.0', id: request.id, result: '0x1237',
        ...(mode === 'id' ? { id: request.id + 1 } : {}),
        ...(mode === 'rpc' ? { error: { message: endpoint } } : {}),
        ...(mode === 'envelope' ? { jsonrpc: '1.0' } : {}) };
    } };
  };
  try {
    const reader = httpsForkReader(endpoint);
    assert.equal(await reader('eth_chainId', []), '0x1237');
    for (mode of ['transport', 'http', 'json', 'id', 'rpc', 'envelope']) {
      await assert.rejects(reader('eth_chainId', []), error => {
        assert.doesNotMatch(error.message, /private-provider-path/);
        assert.match(error.message, /transport failed|HTTP 403|invalid/);
        return true;
      });
    }
  } finally { globalThis.fetch = original; }
});
