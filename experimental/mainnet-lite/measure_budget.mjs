// Read-only target rehearsal. Ephemeral signing keys are used only for synthetic
// fixtures and local Ganache transactions; no target send method is available.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import solc from 'solc';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, Wallet, keccak256 } from 'ethers';

const ENDPOINT = 'https://robinhood.rpc.pinax.network';
const ALLOWED = new Set(['eth_chainId','eth_getBlockByNumber','eth_getCode',
  'eth_getTransactionCount','eth_gasPrice','eth_call','eth_estimateGas']);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sourcePath = new URL('./ORVIAResultAnchor.sol', import.meta.url);
const outputPath = new URL('./budget-measurement.json', import.meta.url);
const source = fs.readFileSync(sourcePath, 'utf8');
const result = {
  schemaVersion: 2, status: 'incomplete', passed: false,
  startedAtUtc: new Date().toISOString(), mainnetTransactionsSent: 0,
  productionReady: false, targetChainId: 4663, endpoint: ENDPOINT,
  sourceSha256: sha(source), scriptSha256: sha(fs.readFileSync(import.meta.filename)),
  dependencyLockSha256: sha(fs.readFileSync(new URL('../../package-lock.json', import.meta.url))),
  networkReadAllowlist: [...ALLOWED], requests: [],
  scope: 'Synthetic operator/report rehearsal, not a deployed contract, accepted scientific report or final wallet quote.',
  limitations: [
    'Target provider responses are trusted; state overrides are ephemeral simulations.',
    'Both target estimates include the provider\'s current execution and data-posting allocation under the Nitro fee model; estimates can change.',
    'Actual operator, wallet nonce, report hashes/signature and deployment address must be bound and re-estimated before signing.',
    'An operator signature authenticates a claim; it does not prove scientific computation or correctness.',
  ],
};
const save = () => fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
save();
let serial = 0;
async function rpc(method, params = []) {
  assert(ALLOWED.has(method), 'RPC method outside read-only allowlist');
  const payload = { jsonrpc: '2.0', id: ++serial, method, params };
  const record = { id: serial, method, requestSha256: sha(JSON.stringify(payload)) };
  result.requests.push(record);
  const response = await fetch(ENDPOINT, { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000) });
  assert(response.ok, `RPC HTTP ${response.status}`);
  const raw = await response.text();
  assert(raw.length < 1_000_000, 'Oversized RPC response');
  record.responseSha256 = sha(raw);
  const value = JSON.parse(raw);
  assert.equal(value.id, payload.id); assert.equal(value.jsonrpc, '2.0');
  if (value.error) { record.error = value.error; const e = new Error(value.error.message); e.rpcError = value.error; throw e; }
  assert(Object.hasOwn(value, 'result'), 'Missing RPC result');
  return value.result;
}

let local;
try {
  assert(solc.version().startsWith('0.8.26+'), 'Wrong compiler');
  const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi','evm.bytecode.object','evm.deployedBytecode.object'] } } };
  const input = { language: 'Solidity', sources: { 'ORVIAResultAnchor.sol': { content: source } }, settings };
  const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
  assert(!compiled.errors?.some(x => x.severity === 'error'), 'Compilation failed');
  const artifact = compiled.contracts['ORVIAResultAnchor.sol'].ORVIAResultAnchor;
  Object.assign(result, { compiler: solc.version(), compilerSettings: settings, standardInputSha256: sha(JSON.stringify(input)) });

  local = ganache.provider({ chain: { chainId: 4663, hardfork: 'shanghai' },
    wallet: { totalAccounts: 2 }, logging: { quiet: true } });
  const provider = new BrowserProvider(local);
  const operator = new Wallet(Object.values(local.getInitialAccounts())[0].secretKey, provider);
  const relayer = await provider.getSigner(1);
  const factory = new ContractFactory(artifact.abi, '0x'+artifact.evm.bytecode.object, operator);
  const contract = await factory.deploy(operator.address);
  const creationReceipt = await contract.deploymentTransaction().wait();
  const address = await contract.getAddress();
  const runtime = await provider.getCode(address);
  const creation = (await factory.getDeployTransaction(operator.address)).data;
  const report = {
    inputHash: keccak256(Buffer.from('ORVIA synthetic input; not a scientific run')),
    methodHash: keccak256(Buffer.from(source)),
    settingsHash: keccak256(Buffer.from('ORVIA synthetic settings; no scientific acceptance')),
    outputHash: keccak256(Buffer.from('ORVIA synthetic output; no claimed result')),
    atomCount: 132935, sampleCount: 1000,
  };
  const types = { Report: [
    { name: 'inputHash', type: 'bytes32' }, { name: 'methodHash', type: 'bytes32' },
    { name: 'settingsHash', type: 'bytes32' }, { name: 'outputHash', type: 'bytes32' },
    { name: 'atomCount', type: 'uint32' }, { name: 'sampleCount', type: 'uint64' },
  ] };
  const domain = { name: 'ORVIAResultAnchor', version: '1', chainId: 4663, verifyingContract: address };
  const signature = await operator.signTypedData(domain, types, report);
  const args = [...Object.values(report), signature];
  const receipt = await (await contract.connect(relayer).anchor(...args)).wait();
  const event = receipt.logs.map(log => { try { return contract.interface.parseLog(log); } catch { return null; } })
    .find(log => log?.name === 'ResultAnchored');
  assert(event && event.args.inputHash === report.inputHash && event.args.outputHash === report.outputHash);
  const calldata = contract.interface.encodeFunctionData('anchor', args);
  result.fixture = { synthetic: true, operator: operator.address, relayer: await relayer.getAddress(),
    domain, report, signature, calldata, runtimeKeccak256: keccak256(runtime), creationKeccak256: keccak256(creation) };
  result.local = { deploymentGas: String(creationReceipt.gasUsed), reportGas: String(receipt.gasUsed),
    runtimeBytes: (runtime.length-2)/2, initcodeWithArgumentsBytes: (creation.length-2)/2, emittedExpectedEvent: true };

  assert.equal(BigInt(await rpc('eth_chainId')), 4663n, 'Wrong target chain');
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  assert(/^0x[0-9a-f]+$/i.test(block.number) && /^0x[0-9a-f]{64}$/i.test(block.hash));
  result.referenceBlock = { number: block.number, hash: block.hash, stateRoot: block.stateRoot, baseFeePerGas: block.baseFeePerGas };
  assert.equal(await rpc('eth_getCode', [address, block.number]), '0x', 'Synthetic target address has code');
  const nonce = await rpc('eth_getTransactionCount', [operator.address, block.number]);
  const gasPrice = BigInt(await rpc('eth_gasPrice'));
  const deployTx = { from: operator.address, data: creation, value: '0x0' };
  const callTx = { from: await relayer.getAddress(), to: address, data: calldata, value: '0x0' };
  const overrides = { [address]: { code: runtime } };
  const created = await rpc('eth_call', [{ ...deployTx, gas: '0x989680', gasPrice: '0x0' }, block.number]);
  assert.equal(created.toLowerCase(), runtime.toLowerCase(), 'Target constructor runtime mismatch');
  assert.equal(await rpc('eth_call', [callTx, block.number, overrides]), '0x', 'Target anchor call failed');
  const altered = [...args]; altered[3] = report.inputHash;
  const invalidTx = { ...callTx, data: contract.interface.encodeFunctionData('anchor', altered) };
  let rejected = false;
  try { await rpc('eth_call', [invalidTx, block.number, overrides]); }
  catch (e) { rejected = e.rpcError?.code === 3 && e.rpcError?.data === contract.interface.getError('InvalidSignature').selector; }
  assert(rejected, 'Target did not explicitly reject altered signed output');
  const deployGas = BigInt(await rpc('eth_estimateGas', [deployTx, block.number]));
  const anchorGas = BigInt(await rpc('eth_estimateGas', [callTx, block.number, overrides]));
  assert(deployGas > 21000n && anchorGas > 21000n && gasPrice > 0n, 'Invalid target estimate');
  result.target = { creationRuntimeMatches: true, validReportAccepted: true, alteredReportRejected: true,
    deploymentEstimateGas: String(deployGas), anchorEstimateGas: String(anchorGas),
    combinedEstimateGas: String(deployGas + anchorGas), observedGasPriceWei: String(gasPrice),
    estimatedNetworkFeeWei: String((deployGas + anchorGas) * gasPrice),
    feeScope: 'Both are target eth_estimateGas, including current provider execution/data allocation. The report uses a temporary exact-runtime override; no deployed instance exists.',
    feeDocumentation: 'https://docs.robinhood.com/chain/gas-and-fees/' };
  const deployLimit = (deployGas * 125n + 99n) / 100n;
  const anchorLimit = (anchorGas * 125n + 99n) / 100n;
  const maxFee = gasPrice * 2n;
  const maximumSpend = (deployLimit + anchorLimit) * maxFee;
  const ethCeilingUsdCents = 1_000_000n; // Explicit conservative assumption: $10,000/ETH.
  const budgetUsdCents = 20_000n;
  const budgetWei = budgetUsdCents * 10n**18n / ethCeilingUsdCents;
  result.budgetPolicy = { capUsd: 200, assumedEthUsdCeiling: 10000, marketPriceClaim: false,
    maximumTotalNetworkFeeWei: String(budgetWei), proposedDeploymentGasLimit: String(deployLimit),
    proposedAnchorGasLimit: String(anchorLimit), proposedMaxFeePerGasWei: String(maxFee),
    maximumNetworkSpendForTheseTwoTransactionsWei: String(maximumSpend),
    fitsConditionalBudget: maximumSpend <= budgetWei,
    readyToSign: false, prerequisites: ['Bind real operator and sender addresses/nonces',
      'Bind actual available report artifacts and signature', 'Refresh both exact transaction estimates',
      'Confirm ETH/USD remains at or below the stated ceiling before approving the two transactions'],
    scope: 'Only these two zero-value EOA transactions. Retries and separately charged wallet/relayer services need a new aggregate budget. These synthetic envelopes must not be sent.' };
  assert.equal(await rpc('eth_getCode', [address, block.number]), '0x');
  assert.equal(await rpc('eth_getTransactionCount', [operator.address, block.number]), nonce);
  const recheck = await rpc('eth_getBlockByNumber', [block.number, false]);
  assert.equal(recheck.hash, block.hash); assert.equal(recheck.stateRoot, block.stateRoot);
  assert.equal(sha(fs.readFileSync(sourcePath)), result.sourceSha256, 'Source changed during run');
  assert.equal(sha(fs.readFileSync(import.meta.filename)), result.scriptSha256, 'Script changed during run');
  result.status = 'passed_readonly_fixture'; result.passed = true;
} catch (error) {
  result.status = 'failed_or_unsupported'; result.error = error.message; process.exitCode = 2;
} finally {
  if (local) await local.disconnect();
  result.completedAtUtc = new Date().toISOString(); save();
}
console.log(JSON.stringify({ status: result.status, target: result.target, budgetPolicy: result.budgetPolicy, error: result.error }));
