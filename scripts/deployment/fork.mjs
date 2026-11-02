import fs from 'node:fs';
import path from 'node:path';
import ganache from 'ganache';
import solc from 'solc';
import { BrowserProvider, ContractFactory, keccak256 } from 'ethers';
import { LOCAL_CHAIN_ID, TARGET_CHAIN_ID, canonical, sha256, runtimeMatches } from './release.mjs';

export const FORK_READ_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'net_version',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionByHash',
  'eth_getTransactionReceipt', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_getCode', 'eth_getStorageAt', 'eth_getLogs']);
const quantity = x => typeof x === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(x);
const hash = x => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x);

// This is the only upstream interface passed to Ganache. Signing, sending,
// impersonation and administrative RPC methods cannot cross this boundary.
export function readonlyForkProvider(rpc) {
  const counts = {};
  return { counts, async request({ method, params = [] }) {
    if (!FORK_READ_METHODS.includes(method)) throw new Error(`Upstream fork mutation or unsupported method refused: ${/^[a-zA-Z0-9_]{1,80}$/.test(method) ? method : '[invalid]'}`);
    counts[method] = (counts[method] || 0) + 1;
    return rpc(method, params);
  } };
}

export function httpsForkReader(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Fork RPC must use HTTPS without embedded user credentials');
  let serial = 0;
  return async (method, params) => {
    if (!FORK_READ_METHODS.includes(method)) throw new Error('Upstream fork mutation or unsupported method refused');
    const id = ++serial;
    let response, body;
    try {
      response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(20_000) });
    } catch { throw new Error(`${method}: fork RPC transport failed`); }
    if (!response.ok) throw new Error(`${method}: fork RPC HTTP ${response.status}`);
    try { body = await response.json(); } catch { throw new Error(`${method}: invalid fork RPC JSON`); }
    if (body.jsonrpc !== '2.0' || body.id !== id || body.error || !Object.hasOwn(body, 'result')) throw new Error(`${method}: invalid/error fork RPC response`);
    return body.result;
  };
}

export async function pinForkBlock(upstream, blockTag = 'latest') {
  if (blockTag !== 'latest' && !quantity(blockTag)) throw new Error('Fork block must be latest or a canonical hexadecimal height');
  const chainId = await upstream.request({ method: 'eth_chainId' });
  if (!quantity(chainId) || BigInt(chainId) !== BigInt(TARGET_CHAIN_ID)) throw new Error('Fork source is not Robinhood mainnet 4663');
  const block = await upstream.request({ method: 'eth_getBlockByNumber', params: [blockTag, false] });
  if (!block || !quantity(block.number) || !hash(block.hash) || !hash(block.stateRoot)
    || !quantity(block.timestamp) || !quantity(block.gasLimit)) throw new Error('Invalid fork reference block');
  const height = Number(BigInt(block.number));
  if (!Number.isSafeInteger(height)) throw new Error('Fork height exceeds local simulator range');
  if (blockTag !== 'latest' && BigInt(blockTag) !== BigInt(block.number)) throw new Error('RPC returned a different fork height');
  return { chainId: TARGET_CHAIN_ID, number: block.number, height, hash: block.hash,
    stateRoot: block.stateRoot, timestamp: block.timestamp, gasLimit: block.gasLimit };
}

export async function assertForkBlockStable(upstream, pinned) {
  const block = await upstream.request({ method: 'eth_getBlockByNumber', params: [pinned.number, false] });
  if (block?.hash !== pinned.hash || block?.stateRoot !== pinned.stateRoot || block?.number !== pinned.number)
    throw new Error('Fork source block changed during rehearsal');
}

function kernelArtifacts(root) {
  const files = ['contracts/math/FloatMath.sol', 'contracts/math/vendor/ABDKMathQuad.sol',
    'contracts/kernels/InlineNonbondedKernel.sol'];
  const sources = Object.fromEntries(files.map(file => [file, { content: fs.readFileSync(path.join(root, file), 'utf8') }]));
  const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } } };
  const input = { language: 'Solidity', sources, settings };
  const result = JSON.parse(solc.compile(JSON.stringify(input)));
  if (result.errors?.some(e => e.severity === 'error')) throw new Error('Pinned fork-smoke kernel compilation failed');
  const artifacts = {};
  for (const [file, contracts] of Object.entries(result.contracts)) for (const [name, c] of Object.entries(contracts)) {
    artifacts[name] = { abi: c.abi, source: file, bytecode: '0x' + c.evm.bytecode.object,
      deployedBytecode: '0x' + c.evm.deployedBytecode.object,
      immutableReferences: c.evm.deployedBytecode.immutableReferences || {} };
  }
  return { artifacts, compiler: solc.version(), settings,
    standardInputSha256: sha256(canonical(input)),
    sources: Object.fromEntries(files.map(file => [file, sha256(sources[file].content)])) };
}

export async function runForkSmoke({ rpc, blockTag = 'latest', root = process.cwd() }) {
  const upstream = readonlyForkProvider(rpc);
  const pinned = await pinForkBlock(upstream, blockTag);
  const compilation = kernelArtifacts(root);
  const transport = ganache.provider({ logging: { quiet: true },
    fork: { provider: upstream, blockNumber: pinned.height, disableCache: true },
    chain: { chainId: LOCAL_CHAIN_ID, networkId: LOCAL_CHAIN_ID, hardfork: 'shanghai' },
    wallet: { deterministic: true, totalAccounts: 1 },
    miner: { blockGasLimit: 30_000_000 } });
  let provider;
  try {
    provider = new BrowserProvider(transport); provider.pollingInterval = 10;
    if ((await provider.getNetwork()).chainId !== BigInt(LOCAL_CHAIN_ID)) throw new Error('Rehearsal signer is not local');
    const inherited = await provider.getBlock(pinned.height);
    if (inherited?.hash !== pinned.hash) throw new Error('Local fork does not match pinned Robinhood block');
    const signer = await provider.getSigner(0);
    const deployed = {}, deployments = [];
    for (const name of ['FloatMath', 'InlineNonbondedKernel']) {
      const artifact = compilation.artifacts[name];
      const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy();
      const receipt = await contract.deploymentTransaction().wait();
      if (receipt.status !== 1) throw new Error('Local fork deployment failed');
      const address = await contract.getAddress(), code = await provider.getCode(address);
      if (!runtimeMatches(code, artifact)) throw new Error('Fork deployment runtime does not match source');
      deployed[name] = contract;
      deployments.push({ contract: name, address, localTransactionHash: receipt.hash,
        localExecutionGas: receipt.gasUsed.toString(), runtimeCodeKeccak256: keccak256(code),
        runtimeBytes: (code.length - 2) / 2, runtimeMatched: true });
    }
    const math = deployed.FloatMath;
    const q = async x => math.fromInt(x);
    const zero = await q(0), one = await q(1), two = await q(2), three = await q(3);
    const scalar = await math.add(one, two);
    if (scalar !== three) throw new Error('Fork binary128 scalar smoke mismatch');
    const pair = await deployed.InlineNonbondedKernel.evaluate([one, zero, zero], one, one,
      zero, one, two, three, true);
    if (pair[0] !== zero || pair[1][0] !== await q(-24) || pair[1][1] !== zero || pair[1][2] !== zero)
      throw new Error('Fork pair smoke mismatch');
    await assertForkBlockStable(upstream, pinned);
    return { schemaVersion: 1, checkedAtUtc: new Date().toISOString(), status: 'passed',
      scope: 'Two compiled ORVIA numerical kernels deployed and queried on a local Shanghai simulator seeded from a pinned Robinhood block.',
      mode: 'local_state_fork_smoke', sourceChain: pinned, executionChainId: LOCAL_CHAIN_ID,
      sourceBlockUnchangedAfterRun: true, mainnetTransactionsSent: 0, productionReady: false,
      completePreparedModelValidated: false, targetExecutionRulesValidated: false,
      compiler: compilation.compiler, compilerSettings: compilation.settings,
      harnessSourceSha256: Object.fromEntries(['scripts/deployment/fork.mjs', 'scripts/fork-smoke.mjs']
        .map(file => [file, sha256(fs.readFileSync(path.join(root, file)))])),
      standardInputSha256: compilation.standardInputSha256, sourceSha256: compilation.sources,
      deployments, scalarResult: scalar, pairResult: { energy: pair[0], force: [...pair[1]] },
      upstreamReadCounts: { ...upstream.counts },
      limitations: ['Ganache applies local Ethereum Shanghai rules, not a Robinhood Nitro execution client.',
        'Inherited state is trusted RPC data; a stateRoot binding is recorded but state proofs are not independently verified.',
        'This is a kernel smoke check, not the integrated 64-instance or full prepared molecular experiment.',
        'Local execution gas excludes Robinhood L1 data fees and does not establish network throughput or a full-run cost.'] };
  } finally { provider?.destroy(); await transport.disconnect(); }
}
