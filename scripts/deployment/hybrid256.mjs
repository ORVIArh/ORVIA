// Dedicated GPU-hybrid release tooling. Public inputs only; no signing here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import solc from 'solc';
import ganache from 'ganache';
import {AbiCoder, Interface, formatEther, getAddress, getCreateAddress, getCreate2Address, id, keccak256, toQuantity, toBeHex} from 'ethers';

export const CHAIN_ID = 4663;
export const SHARD_COUNT = 255;
export const BATCH_SIZE = 8;
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const must = (condition, message) => { if (!condition) throw new Error(message); };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT = 'ORVIAHybridCoordinator';
const SHARD = 'ORVIAReportShard';

export function normalizeSpec(spec) {
  must(spec && typeof spec === 'object' && !Array.isArray(spec), 'Invalid release specification');
  const keys = ['chainId', 'sender', 'owner', 'operator', 'firstNonce'];
  must(Object.keys(spec).every(key => keys.includes(key)), 'Unknown release specification field');
  must(spec.chainId === CHAIN_ID, 'Only Robinhood mainnet 4663 is supported');
  const result = {chainId: CHAIN_ID};
  for (const key of ['sender', 'owner', 'operator']) {
    try { result[key] = getAddress(spec[key]); }
    catch { throw new Error('Invalid public address: ' + key); }
    must(BigInt(result[key]) !== 0n, 'Zero ' + key);
  }
  must(typeof spec.firstNonce === 'string' && /^(0|[1-9][0-9]*)$/.test(spec.firstNonce),
    'Nonce must be a canonical decimal string');
  must(BigInt(spec.firstNonce) + 33n < (1n << 64n) - 1n, 'Nonce range exhausted');
  must(BigInt(spec.firstNonce) + 33n <= BigInt(Number.MAX_SAFE_INTEGER),
    'Nonce range exceeds safe transaction representation');
  result.firstNonce = spec.firstNonce;
  // The deployment sender must own provisioning until all shards exist.
  must(result.owner === result.sender, 'Initial owner must be the deployment sender');
  return result;
}

export function compileHybrid(root = ROOT) {
  const sources = {};
  function add(relative) {
    must(relative.startsWith('contracts/hybrid/') && !relative.split('/').includes('..'),
      'Hybrid release source outside its reviewed directory');
    if (sources[relative]) return;
    const absolute = path.join(root, relative);
    // Reject symlinks in parent directories too, not only in the source file.
    must(fs.realpathSync(absolute) === path.join(fs.realpathSync(root), relative),
      'Symlinked release source refused');
    const content = fs.readFileSync(absolute, 'utf8');
    sources[relative] = {content};
    for (const match of content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']\s*;/g)) {
      add(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
    }
  }
  add('contracts/hybrid/' + CONTRACT + '.sol');
  must(solc.version() === '0.8.26+commit.8a97fa7a.Emscripten.clang', 'Unexpected Solidity compiler');
  const settings = {optimizer: {enabled: true, runs: 200}, evmVersion: 'shanghai',
    outputSelection: {'*': {'': ['ast'], '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object',
      'evm.deployedBytecode.immutableReferences', 'storageLayout']}}};
  const input = {language: 'Solidity', sources, settings};
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(error => error.severity === 'error');
  must(!errors.length, errors.map(error => error.formattedMessage).join('\n'));
  const artifacts = {};
  const immutableNames = {};
  function collectImmutables(node) {
    if (!node || typeof node !== 'object') return;
    if (node.nodeType === 'VariableDeclaration' && node.mutability === 'immutable')
      immutableNames[node.id] = node.name;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(collectImmutables);
      else if (value && typeof value === 'object') collectImmutables(value);
    }
  }
  Object.values(output.sources).forEach(source => collectImmutables(source.ast));
  for (const [source, definitions] of Object.entries(output.contracts)) {
    for (const [name, artifact] of Object.entries(definitions)) {
      if (!artifact.evm.bytecode.object) continue;
      must(!artifacts[name], 'Duplicate contract name');
      must(artifact.evm.deployedBytecode.object.length / 2 <= 24576,
        'Hybrid runtime exceeds ordinary EVM code limit');
      artifacts[name] = {source, abi: artifact.abi, creation: '0x' + artifact.evm.bytecode.object,
        runtime: '0x' + artifact.evm.deployedBytecode.object,
        immutableReferences: artifact.evm.deployedBytecode.immutableReferences,
        immutableNames: Object.fromEntries(Object.keys(artifact.evm.deployedBytecode.immutableReferences)
          .map(key => { must(immutableNames[key], 'Unknown constructor immutable'); return [key, immutableNames[key]]; })),
        storageLayout: artifact.storageLayout};
    }
  }
  must(artifacts[CONTRACT] && artifacts[SHARD], 'Incomplete hybrid release');
  return {input, artifacts, binding: {compiler: solc.version(), settings,
    sources: Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, sha256(value.content)])),
    packageLockSha256: sha256(fs.readFileSync(path.join(root, 'package-lock.json'))),
    standardInputSha256: sha256(canonical(input))}};
}

function sameRuntime(actual, artifact) {
  must(typeof actual === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(actual), 'Invalid runtime bytecode');
  let normalized = actual.slice(2).toLowerCase();
  let template = artifact.runtime.slice(2).toLowerCase();
  must(normalized.length === template.length, 'Runtime length differs from compiler');
  for (const entries of Object.values(artifact.immutableReferences)) for (const entry of entries) {
    const begin = entry.start * 2, end = (entry.start + entry.length) * 2;
    normalized = normalized.slice(0, begin) + '0'.repeat(end - begin) + normalized.slice(end);
    template = template.slice(0, begin) + '0'.repeat(end - begin) + template.slice(end);
  }
  must(normalized === template, 'Runtime differs outside immutable fields');
}

function boundRuntime(artifact, values) {
  let runtime = artifact.runtime.slice(2);
  must(Object.keys(values).length === Object.keys(artifact.immutableNames).length,
    'Unexpected constructor immutable layout');
  for (const [key, entries] of Object.entries(artifact.immutableReferences)) {
    const name = artifact.immutableNames[key];
    must(Object.hasOwn(values, name), 'Unbound constructor immutable: ' + name);
    for (const {start, length} of entries) {
      must(length === 32, 'Unsupported immutable width');
      const value = toBeHex(BigInt(values[name]), length).slice(2);
      runtime = runtime.slice(0, start * 2) + value + runtime.slice((start + length) * 2);
    }
  }
  return '0x' + runtime;
}

// Independently derive the exact post-constructor bytes and predecessor storage
// from the reviewed constructors. The plan's own hash is not a trust anchor.
function expectedInventoryAndStates(spec, bundle) {
  const {coordinator, transactions} = expectedTransactions(spec, bundle);
  const coordinatorRuntime = boundRuntime(bundle.artifacts[CONTRACT], {owner: spec.owner, operator: spec.operator});
  const coordinatorHash = keccak256(coordinatorRuntime);
  const contracts = [{role: 'coordinator', address: coordinator, runtime: coordinatorRuntime,
    runtimeKeccak256: coordinatorHash}];
  const shardInterface = new Interface(bundle.artifacts[SHARD].abi);
  for (let index = 0; index < SHARD_COUNT; index++) {
    const initcode = bundle.artifacts[SHARD].creation + shardInterface.encodeDeploy([coordinator, index]).slice(2);
    const runtime = boundRuntime(bundle.artifacts[SHARD], {coordinator, coordinatorCodeHash: coordinatorHash, index});
    contracts.push({role: 'report_shard', index,
      address: getCreate2Address(coordinator, toBeHex(index, 32), keccak256(initcode)), runtime,
      runtimeKeccak256: keccak256(runtime)});
  }
  const layout = bundle.artifacts[CONTRACT].storageLayout.storage;
  must(canonical(layout.map(entry => [entry.label, entry.offset, entry.type.replace(/\d+_storage/g, '_storage')]))
    === canonical([['shardCount', 0, 't_uint16'], ['deploymentCommitment', 0, 't_bytes32'],
      ['shards', 0, 't_mapping(t_uint256,t_address)'], ['shardCodeHash', 0, 't_mapping(t_uint256,t_bytes32)'],
      ['experiments', 0, 't_mapping(t_bytes32,t_struct(Experiment)_storage)']]),
    'Unexpected coordinator storage layout');
  const slots = Object.fromEntries(layout.map(entry => [entry.label, entry.slot]));
  const coder = AbiCoder.defaultAbiCoder();
  let commitment = keccak256(coder.encode(['bytes32', 'uint256', 'address', 'address', 'address', 'uint16'],
    [id('ORVIA.OperatorEIP712Attestation.NotComputationProof.v1'), CHAIN_ID, coordinator,
      spec.owner, spec.operator, SHARD_COUNT]));
  const state = Object.fromEntries(layout.map(entry => [toBeHex(BigInt(entry.slot), 32), toBeHex(0, 32)]));
  const conditionalStates = [];
  for (let index = 0; index < SHARD_COUNT; index++) {
    if (index % BATCH_SIZE === 0) {
      state[toBeHex(BigInt(slots.shardCount), 32)] = toBeHex(index, 32);
      state[toBeHex(BigInt(slots.deploymentCommitment), 32)] = commitment;
      const transactionIndex = conditionalStates.length + 1;
      conditionalStates.push({transactionIndex,
        description: 'Exact coordinator state from preceding local rehearsal transactions; undeployed on mainnet',
        overrides: {[coordinator]: {code: coordinatorRuntime, nonce: toQuantity(index + 1), state: {...state}},
          [spec.sender]: {nonce: transactions[transactionIndex].transaction.nonce}}});
    }
    const shard = contracts[index + 1];
    state[keccak256(coder.encode(['uint256', 'uint256'], [index, slots.shards]))] = toBeHex(BigInt(shard.address), 32);
    state[keccak256(coder.encode(['uint256', 'uint256'], [index, slots.shardCodeHash]))] = shard.runtimeKeccak256;
    commitment = keccak256(coder.encode(['bytes32', 'uint16', 'address', 'bytes32'],
      [commitment, index, shard.address, shard.runtimeKeccak256]));
  }
  return {contracts, conditionalStates};
}

export function expectedTransactions(spec, bundle) {
  spec = normalizeSpec(spec);
  const iface = new Interface(bundle.artifacts[CONTRACT].abi);
  const first = BigInt(spec.firstNonce);
  const coordinator = getCreateAddress({from: spec.sender, nonce: first});
  const transactions = [{kind: 'create_coordinator', creates: 1,
    transaction: {chainId: CHAIN_ID, from: spec.sender, nonce: toQuantity(first), value: '0x0',
      data: bundle.artifacts[CONTRACT].creation + iface.encodeDeploy([spec.owner, spec.operator]).slice(2)}}];
  for (let start = 0; start < SHARD_COUNT; start += BATCH_SIZE) {
    const count = Math.min(BATCH_SIZE, SHARD_COUNT - start);
    transactions.push({kind: 'create_shards', firstShard: start, creates: count,
      transaction: {chainId: CHAIN_ID, from: spec.sender, nonce: toQuantity(first + BigInt(transactions.length)),
        value: '0x0', to: coordinator, data: iface.encodeFunctionData('createShards', [count])}});
  }
  must(transactions.length === 33, 'Unexpected infrastructure transaction count');
  must((transactions[0].transaction.data.length - 2) / 2 <= 49152, 'Coordinator initcode exceeds EVM limit');
  return {coordinator, transactions};
}

export async function rehearseHybrid({spec, root = ROOT}) {
  spec = normalizeSpec(spec);
  const bundle = compileHybrid(root);
  const {coordinator, transactions} = expectedTransactions(spec, bundle);
  const engine = ganache.provider({logging: {quiet: true},
    chain: {chainId: CHAIN_ID, hardfork: 'shanghai'}, miner: {blockGasLimit: 30000000},
    wallet: {totalAccounts: 0, unlockedAccounts: [spec.sender]}});
  const request = (method, params = []) => engine.request({method, params});
  const iface = new Interface(bundle.artifacts[CONTRACT].abi);
  const shardInterface = new Interface(bundle.artifacts[SHARD].abi);
  const coder = AbiCoder.defaultAbiCoder();
  async function call(address, intf, name, args = []) {
    return intf.decodeFunctionResult(name, await request('eth_call',
      [{to: address, data: intf.encodeFunctionData(name, args)}, 'latest']));
  }
  try {
    await request('evm_setAccountBalance', [spec.sender, toQuantity(1000n * 10n ** 18n)]);
    await request('evm_setAccountNonce', [spec.sender, toQuantity(BigInt(spec.firstNonce))]);
    let totalGas = 0n;
    const receipts = [];
    const conditionalStates = [];
    for (const item of transactions) {
      if (item.kind === 'create_shards') {
        const state = {};
        const declarations = bundle.artifacts[CONTRACT].storageLayout.storage;
        const slots = new Set(declarations.map(field => field.slot));
        for (const slot of slots) {
          const key = toBeHex(BigInt(slot), 32);
          const value = await request('eth_getStorageAt', [coordinator, key, 'latest']);
          state[key] = '0x' + value.slice(2).padStart(64, '0');
        }
        for (const name of ['shards', 'shardCodeHash']) {
          const field = declarations.find(entry => entry.label === name);
          must(field, 'Missing declared shard storage');
          for (let index = 0; index < item.firstShard; index++) {
            const key = keccak256(coder.encode(['uint256', 'uint256'], [index, field.slot]));
            const value = await request('eth_getStorageAt', [coordinator, key, 'latest']);
            state[key] = '0x' + value.slice(2).padStart(64, '0');
          }
        }
        conditionalStates.push({transactionIndex: conditionalStates.length + 1,
          description: 'Exact coordinator state from preceding local rehearsal transactions; undeployed on mainnet',
          overrides: {[coordinator]: {code: await request('eth_getCode', [coordinator, 'latest']),
            nonce: await request('eth_getTransactionCount', [coordinator, 'latest']), state},
            [spec.sender]: {nonce: item.transaction.nonce}}});
      }
      const tx = {...item.transaction}; delete tx.chainId;
      const gas = await request('eth_estimateGas', [tx]);
      const hash = await request('eth_sendTransaction', [{...tx, gas: toQuantity(BigInt(gas) * 125n / 100n)}]);
      const receipt = await request('eth_getTransactionReceipt', [hash]);
      must(receipt.status === '0x1', 'Local rehearsal transaction reverted');
      if (item.kind === 'create_coordinator') must(getAddress(receipt.contractAddress) === coordinator,
        'Unexpected coordinator address');
      totalGas += BigInt(receipt.gasUsed);
      receipts.push({kind: item.kind, nonce: tx.nonce, gasUsed: BigInt(receipt.gasUsed).toString(),
        transactionHash: hash, localOnly: true});
    }
    const runtime = await request('eth_getCode', [coordinator, 'latest']);
    sameRuntime(runtime, bundle.artifacts[CONTRACT]);
    must(getAddress((await call(coordinator, iface, 'owner'))[0]) === spec.owner, 'Wrong owner');
    must(getAddress((await call(coordinator, iface, 'operator'))[0]) === spec.operator, 'Wrong operator');
    must(Number((await call(coordinator, iface, 'shardCount'))[0]) === SHARD_COUNT, 'Missing shards');
    const contracts = [{role: 'coordinator', address: coordinator, runtime, runtimeKeccak256: keccak256(runtime)}];
    for (let index = 0; index < SHARD_COUNT; index++) {
      const address = getAddress((await call(coordinator, iface, 'shards', [index]))[0]);
      const initcode = bundle.artifacts[SHARD].creation
        + shardInterface.encodeDeploy([coordinator, index]).slice(2);
      must(address === getCreate2Address(coordinator, toBeHex(index, 32), keccak256(initcode)),
        'Shard address differs from deterministic CREATE2 derivation');
      const code = await request('eth_getCode', [address, 'latest']);
      sameRuntime(code, bundle.artifacts[SHARD]);
      must(getAddress((await call(address, shardInterface, 'coordinator'))[0]) === coordinator,
        'Shard coordinator mismatch');
      must(Number((await call(address, shardInterface, 'index'))[0]) === index, 'Shard index mismatch');
      contracts.push({role: 'report_shard', index, address, runtime: code, runtimeKeccak256: keccak256(code)});
    }
    must(new Set(contracts.map(item => item.address)).size === 256, 'Contract inventory not exactly 256');
    must(BigInt(await request('eth_getTransactionCount', [coordinator, 'latest'])) === 256n,
      'Unexpected factory nonce');
    const independentlyDerived = expectedInventoryAndStates(spec, bundle);
    must(canonical(contracts) === canonical(independentlyDerived.contracts),
      'Constructor runtime bindings differ from independent derivation');
    must(canonical(conditionalStates) === canonical(independentlyDerived.conditionalStates),
      'Rehearsal predecessor states differ from independent derivation');
    const body = {schema: 'orvia.hybrid256.release.v1', createdAtUtc: new Date().toISOString(),
      purpose: 'GPU result attestation infrastructure; signatures do not prove correct molecular computation',
      spec, sourceBinding: bundle.binding, plannerSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
      coordinator, transactions, contracts, conditionalStates, contractCount: 256, infrastructureTransactionCount: 33,
      rehearsal: {passed: true, execution: 'local Ganache Shanghai', publicTransactionsSent: 0,
        totalGasUsed: totalGas.toString(), receipts, factoryNonce: '256'},
      scientificCampaignReady: false, infrastructureTargetVerified: false,
      productionSimulationResultAvailable: false, targetQuote: null};
    return {...body, planSha256: sha256(canonical(body))};
  } finally { await engine.disconnect(); }
}

export function verifyPlan(plan, root = ROOT, intendedSpec) {
  const {planSha256, ...body} = plan;
  must(planSha256 === sha256(canonical(body)), 'Release plan hash mismatch');
  must(plan.schema === 'orvia.hybrid256.release.v1', 'Wrong release schema');
  must(plan.plannerSha256 === sha256(fs.readFileSync(fileURLToPath(import.meta.url))), 'Release planner changed');
  const bundle = compileHybrid(root);
  must(canonical(plan.sourceBinding) === canonical(bundle.binding), 'Release source/compiler changed');
  const spec = normalizeSpec(plan.spec);
  must(canonical(plan.spec) === canonical(spec), 'Noncanonical release specification');
  const expected = expectedTransactions(spec, bundle);
  if (intendedSpec) must(canonical(spec) === canonical(normalizeSpec(intendedSpec)),
    'Plan differs from independently supplied intended specification');
  must(plan.coordinator === expected.coordinator && canonical(plan.transactions) === canonical(expected.transactions),
    'Release transaction intent mismatch');
  must(plan.contractCount === 256 && plan.contracts.length === 256 && plan.infrastructureTransactionCount === 33,
    'Incorrect release inventory');
  const derived = expectedInventoryAndStates(spec, bundle);
  must(canonical(plan.contracts) === canonical(derived.contracts),
    'Contract inventory, runtime, or constructor immutable mismatch');
  must(canonical(plan.conditionalStates) === canonical(derived.conditionalStates),
    'Conditional predecessor state mismatch');
  must(plan.scientificCampaignReady === false && plan.infrastructureTargetVerified === false
    && plan.productionSimulationResultAvailable === false && plan.targetQuote === null,
    'Unsigned local plan contains unsupported production claims');
  must(plan.rehearsal?.passed === true && plan.rehearsal?.publicTransactionsSent === 0
    && plan.rehearsal?.factoryNonce === '256' && plan.rehearsal?.receipts?.length === 33,
    'Invalid local rehearsal summary');
  let sum = 0n;
  for (let index = 0; index < 33; index++) {
    const receipt = plan.rehearsal.receipts[index];
    must(receipt.kind === plan.transactions[index].kind
      && receipt.nonce === plan.transactions[index].transaction.nonce && receipt.localOnly === true
      && typeof receipt.gasUsed === 'string' && /^(0|[1-9][0-9]*)$/.test(receipt.gasUsed)
      && BigInt(receipt.gasUsed) > 21000n,
      'Invalid local rehearsal receipt');
    sum += BigInt(receipt.gasUsed);
  }
  must(plan.rehearsal.totalGasUsed === sum.toString(), 'Local rehearsal gas total mismatch');
  return {bundle, spec};
}

export async function verifyRehearsal(plan, intendedSpec, root = ROOT) {
  verifyPlan(plan, root, intendedSpec);
  const rebuilt = await rehearseHybrid({spec: intendedSpec, root});
  for (const key of ['transactions', 'contracts', 'conditionalStates']) {
    must(canonical(plan[key]) === canonical(rebuilt[key]), 'Independent rehearsal differs: ' + key);
  }
  return {passed: true, planSha256: plan.planSha256, actualContracts: 256,
    constructorStorageAndBindingsRehearsed: true, publicTransactionsSent: 0};
}

const quantity = value => typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
function rpcQuantity(value, label) {
  must(quantity(value), 'Invalid RPC ' + label);
  return BigInt(value);
}

export async function quoteHybrid(plan, rpc, root = ROOT, intendedSpec) {
  const {spec} = verifyPlan(plan, root, intendedSpec);
  must(rpcQuantity(await rpc('eth_chainId'), 'chain ID') === BigInt(CHAIN_ID), 'Wrong RPC chain');
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  must(quantity(block?.number) && hash(block?.hash), 'No valid quote reference block');
  const blockGasLimit = rpcQuantity(block.gasLimit, 'block gas limit');
  must(blockGasLimit > 21000n, 'Invalid block gas limit');
  const nonce = await rpc('eth_getTransactionCount', [spec.sender, 'pending']);
  must(rpcQuantity(nonce, 'pending nonce') === BigInt(spec.firstNonce), 'Sender nonce changed; rebuild the plan');
  const [balance, price] = await Promise.all([rpc('eth_getBalance', [spec.sender, block.number]), rpc('eth_gasPrice')]);
  rpcQuantity(balance, 'balance');
  must(rpcQuantity(price, 'gas price') > 0n, 'Invalid gas price');
  for (const address of [spec.sender, spec.operator]) {
    must(await rpc('eth_getCode', [address, block.number]) === '0x', 'EOA sender and signer required');
  }
  const collisions = [];
  for (let start = 0; start < plan.contracts.length; start += 8) {
    await Promise.all(plan.contracts.slice(start, start + 8).map(async item => {
      const [code, count] = await Promise.all([rpc('eth_getCode', [item.address, block.number]),
        rpc('eth_getTransactionCount', [item.address, block.number])]);
      if (code !== '0x' || rpcQuantity(count, 'contract nonce') !== 0n) collisions.push(item.address);
    }));
  }
  must(collisions.length === 0, 'Planned address collision');
  const estimates = [];
  for (let index = 0; index < plan.transactions.length; index++) {
    const {chainId, ...tx} = plan.transactions[index].transaction;
    const params = [tx, block.number];
    if (index > 0) params.push(plan.conditionalStates[index - 1].overrides);
    const gas = rpcQuantity(await rpc('eth_estimateGas', params), 'gas estimate');
    must(gas > 21000n && gas <= blockGasLimit, 'Target gas estimate exceeds block limit or is invalid');
    estimates.push({index, kind: plan.transactions[index].kind, gasIncludingL1Data: gas.toString(),
      feeWeiAtObservedPrice: (gas * BigInt(price)).toString(),
      usesLocalPredecessorStateOverrides: index > 0});
  }
  const lastBlock = await rpc('eth_getBlockByNumber', [block.number, false]);
  must(lastBlock?.hash === block.hash, 'Quote block changed');
  must(await rpc('eth_getTransactionCount', [spec.sender, 'pending']) === nonce, 'Nonce changed during quote');
  const totalGas = estimates.reduce((sum, entry) => sum + BigInt(entry.gasIncludingL1Data), 0n);
  const totalWei = totalGas * BigInt(price);
  return {schema: 'orvia.hybrid256.quote.v1', planSha256: plan.planSha256,
    observedAtUtc: new Date().toISOString(), referenceBlock: {number: block.number, hash: block.hash},
    chainId: CHAIN_ID, sender: spec.sender, nonce, balanceWei: BigInt(balance).toString(),
    gasPriceWei: BigInt(price).toString(), actualContracts: 256, infrastructureTransactions: 33,
    totalInfrastructureGasIncludingL1Data: totalGas.toString(), totalInfrastructureFeeWei: totalWei.toString(),
    totalInfrastructureFeeEth: formatEther(totalWei),
    balanceCoversEstimate: BigInt(balance) >= totalWei, estimates,
    conditional: true, publicTransactionsSent: 0, fullCampaignTotalWei: null,
    scope: 'All 256 contracts and deployment provisioning. Dependent calls use exact local predecessor state overrides; re-estimate against real pending state before each signature. Experiment registration, reports and GPU campaign are excluded, not priced as zero.'};
}

export function readOnlyRpc(url) {
  const parsed = new URL(url);
  must(parsed.protocol === 'https:' && !parsed.username && !parsed.password, 'HTTPS RPC required');
  const methods = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance',
    'eth_getTransactionCount', 'eth_gasPrice', 'eth_estimateGas', 'eth_call']);
  let serial = 0;
  return async (method, params = []) => {
    must(methods.has(method), 'Non-read-only method refused');
    let response, body; const id = ++serial;
    try {
      response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id, method, params}), redirect: 'error',
        signal: AbortSignal.timeout(20000)});
      must(response.ok, 'RPC HTTP failure'); body = await response.json();
    } catch { throw new Error('RPC transport failed: ' + method); }
    must(body.jsonrpc === '2.0' && body.id === id && !body.error && Object.hasOwn(body, 'result'),
      'RPC rejected ' + method);
    return body.result;
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, specFile, planOrOutput, quoteOutput] = process.argv.slice(2);
    must((command === 'rehearse' && specFile && planOrOutput && process.argv.length === 5)
      || (command === 'quote' && specFile && planOrOutput && quoteOutput && process.argv.length === 6),
      'Usage: hybrid256.mjs rehearse spec.json new-plan.json | quote spec.json plan.json new-quote.json (ORVIA_RPC_URL environment variable)');
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    const output = command === 'rehearse' ? planOrOutput : quoteOutput;
    must(!fs.existsSync(output), 'Refusing existing plan output');
    let result;
    if (command === 'rehearse') result = await rehearseHybrid({spec});
    else {
      must(process.env.ORVIA_RPC_URL, 'Set ORVIA_RPC_URL locally; do not put credentials in the command');
      result = await quoteHybrid(JSON.parse(fs.readFileSync(planOrOutput, 'utf8')),
        readOnlyRpc(process.env.ORVIA_RPC_URL), ROOT, spec);
    }
    fs.mkdirSync(path.dirname(path.resolve(output)), {recursive: true});
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
    console.log(JSON.stringify({output, contractCount: result.contractCount ?? result.actualContracts,
      localGas: result.rehearsal?.totalGasUsed, totalInfrastructureFeeEth: result.totalInfrastructureFeeEth,
      publicTransactionsSent: 0}));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
