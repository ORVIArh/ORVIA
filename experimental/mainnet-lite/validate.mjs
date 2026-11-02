// Focused local security checks. This file has no target RPC or broadcast path.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const sourcePath = new URL('./ORVIAResultAnchor.sol', import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const reportPath = new URL('./validation-report.json', import.meta.url);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const result = {
  schemaVersion: 1, status: 'incomplete', passed: false,
  startedAtUtc: new Date().toISOString(),
  sourceSha256: null, scriptSha256: null, dependencyLockSha256: null,
  executionScope: 'In-process Ganache only; no remote RPC or target broadcast.',
  mainnetTransactionsSent: 0, scientificComputationVerified: false,
  duplicateSemantics: 'Identical signed reports may emit repeatedly. Deduplicate by EIP-712 digest, not signature or event count.',
  limitations: [
    'An operator signature authenticates an attestation, not scientific computation or correctness.',
    'This checks an EOA operator; ERC-1271, key rotation and revocation are not provided by this contract.',
    'No real scientific artifact availability, production key custody, target deployment or network-fee claim is tested.',
  ],
  checks: [],
};
const save = () => fs.writeFileSync(reportPath, JSON.stringify(result, null, 2) + '\n');
save(); // A stale successful report must not survive a failed or interrupted run.

let local;
let provider;
async function check(name, work) {
  try { await work(); result.checks.push({ name, passed: true }); }
  catch (error) {
    result.checks.push({ name, passed: false, error: error.shortMessage ?? error.message });
  }
  save();
}

try {
  const source = fs.readFileSync(sourcePath, 'utf8');
  Object.assign(result, { sourceSha256: sha(source), scriptSha256: sha(fs.readFileSync(scriptPath)),
    dependencyLockSha256: sha(fs.readFileSync(new URL('../../package-lock.json', import.meta.url))) });
  // Load pinned dependencies only after invalidating any prior successful report.
  const [{ default: solc }, { default: ganache }, ethers] = await Promise.all([
    import('solc'), import('ganache'), import('ethers'),
  ]);
  const { BrowserProvider, ContractFactory, Wallet, TypedDataEncoder, Signature,
    id, keccak256, toBeHex, zeroPadValue, ZeroAddress, ZeroHash } = ethers;
  assert(solc.version().startsWith('0.8.26+commit.8a97fa7a'), 'Wrong compiler');
  const settings = {
    optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object',
      'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
  };
  const input = { language: 'Solidity', sources: { 'ORVIAResultAnchor.sol': { content: source } }, settings };
  const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = compiled.errors?.filter(entry => entry.severity === 'error') ?? [];
  assert.equal(errors.length, 0, errors.map(entry => entry.formattedMessage).join('\n'));
  const artifact = compiled.contracts['ORVIAResultAnchor.sol'].ORVIAResultAnchor;
  Object.assign(result, {
    compiler: solc.version(), compilerSettings: settings,
    standardInputSha256: sha(JSON.stringify(input)),
    creationTemplateKeccak256: keccak256('0x' + artifact.evm.bytecode.object),
    runtimeTemplateKeccak256: keccak256('0x' + artifact.evm.deployedBytecode.object),
  });

  local = ganache.provider({ chain: { chainId: 4663, hardfork: 'shanghai' },
    wallet: { totalAccounts: 3 }, logging: { quiet: true } });
  provider = new BrowserProvider(local);
  const deployer = await provider.getSigner(0);
  const relayer = await provider.getSigner(1);
  const secondRelayer = await provider.getSigner(2);
  // Fresh local development keys stay in memory and are never serialized.
  const accounts = Object.values(local.getInitialAccounts());
  const operator = new Wallet(accounts[0].secretKey);
  const wrongOperator = new Wallet(accounts[2].secretKey);
  const factory = new ContractFactory(artifact.abi, '0x' + artifact.evm.bytecode.object, deployer);
  const contract = await factory.deploy(operator.address);
  const creationReceipt = await contract.deploymentTransaction().wait();
  const address = await contract.getAddress();
  const secondContract = await factory.deploy(operator.address);
  await secondContract.waitForDeployment();
  const otherAddress = await secondContract.getAddress();
  const types = { Report: [
    { name: 'inputHash', type: 'bytes32' }, { name: 'methodHash', type: 'bytes32' },
    { name: 'settingsHash', type: 'bytes32' }, { name: 'outputHash', type: 'bytes32' },
    { name: 'atomCount', type: 'uint32' }, { name: 'sampleCount', type: 'uint64' },
  ] };
  const domain = { name: 'ORVIAResultAnchor', version: '1', chainId: 4663, verifyingContract: address };
  const report = {
    inputHash: id('ORVIA local security fixture input; no scientific run'),
    methodHash: id('ORVIA local security fixture method; no scientific run'),
    settingsHash: id('ORVIA local security fixture settings; no scientific run'),
    outputHash: id('ORVIA local security fixture output; no scientific run'),
    atomCount: 132936n, sampleCount: 1000n,
  };
  const sign = (value = report, signingDomain = domain, signer = operator) =>
    signer.signTypedData(signingDomain, types, value);
  const args = (value, signature) => [value.inputHash, value.methodHash, value.settingsHash,
    value.outputHash, value.atomCount, value.sampleCount, signature];
  const signature = await sign();
  const digest = TypedDataEncoder.hash(domain, types, report);
  result.fixture = { synthetic: true, chainId: 4663, operator: operator.address,
    relayers: [await relayer.getAddress(), await secondRelayer.getAddress()],
    contract: address, secondContract: otherAddress, typedReportDigest: digest,
    report: { ...report, atomCount: String(report.atomCount), sampleCount: String(report.sampleCount) } };
  result.localGas = { deploymentGas: String(creationReceipt.gasUsed) };

  const errorData = error => {
    const candidates = [error?.data, error?.error?.data, error?.info?.error?.data,
      error?.cause?.data];
    for (const candidate of candidates) {
      if (typeof candidate === 'string') return candidate;
      if (typeof candidate?.result === 'string') return candidate.result;
      if (typeof candidate?.data === 'string') return candidate.data;
    }
    return undefined;
  };
  async function expectRevert(work, errorName) {
    let caught;
    try { await work(); } catch (error) { caught = error; }
    assert(caught, `Expected ${errorName} revert`);
    assert.equal(errorData(caught)?.toLowerCase(),
      contract.interface.getError(errorName).selector.toLowerCase(),
      `Expected exact ${errorName} revert data; got ${errorData(caught) ?? caught.shortMessage ?? caught.message}`);
  }
  const reject = (value, signed, instance = contract) =>
    expectRevert(() => instance.connect(relayer).anchor.staticCall(...args(value, signed)), 'InvalidSignature');
  function exactEvent(receipt, value, instance = contract) {
    assert.equal(receipt.status, 1);
    assert.equal(receipt.logs.length, 1, 'Exactly one event expected');
    const log = receipt.logs[0];
    assert.equal(log.address.toLowerCase(), instance.target.toLowerCase());
    assert.equal(log.topics.length, 4);
    assert.deepEqual(log.topics.slice(1), [value.inputHash, value.outputHash, value.methodHash]);
    const event = instance.interface.parseLog(log);
    assert.equal(event.name, 'ResultAnchored');
    for (const key of ['inputHash', 'methodHash', 'settingsHash', 'outputHash', 'atomCount', 'sampleCount']) {
      assert.equal(event.args[key], value[key], `Emitted ${key}`);
    }
    assert.equal(event.args.operator, operator.address);
  }

  await check('compiled_runtime_and_immutable_operator_match', async () => {
    assert.equal(await contract.operator(), operator.address);
    assert.equal((await provider.getNetwork()).chainId, 4663n);
    const runtime = await provider.getCode(address);
    const expected = Buffer.from(artifact.evm.deployedBytecode.object, 'hex');
    const refs = Object.values(artifact.evm.deployedBytecode.immutableReferences).flat();
    assert(refs.length > 0, 'Compiler must expose immutable operator locations');
    for (const ref of refs) {
      assert.equal(ref.length, 32);
      Buffer.from(zeroPadValue(operator.address, 32).slice(2), 'hex').copy(expected, ref.start);
    }
    assert.equal(runtime.toLowerCase(), '0x' + expected.toString('hex'));
    const creation = (await factory.getDeployTransaction(operator.address)).data;
    result.localRuntime = { runtimeKeccak256: keccak256(runtime),
      runtimeBytes: (runtime.length - 2) / 2, initcodeWithArgumentsBytes: (creation.length - 2) / 2,
      creationWithArgumentsKeccak256: keccak256(creation) };
  });
  await check('zero_operator_constructor_rejected', async () => {
    const zeroCreation = await factory.getDeployTransaction(ZeroAddress);
    await expectRevert(() => provider.call({ from: operator.address, data: zeroCreation.data }), 'InvalidOperator');
  });
  await check('valid_operator_signature_permissionless_relay_exact_event', async () => {
    assert.notEqual(await relayer.getAddress(), operator.address);
    const receipt = await (await contract.connect(relayer).anchor(...args(report, signature))).wait();
    exactEvent(receipt, report);
    result.localGas.validReportGas = String(receipt.gasUsed);
  });
  await check('duplicate_report_allowed_from_another_relayer', async () => {
    const receipt = await (await contract.connect(secondRelayer).anchor(...args(report, signature))).wait();
    exactEvent(receipt, report);
    assert.equal(TypedDataEncoder.hash(domain, types, report), digest);
    result.localGas.duplicateReportGas = String(receipt.gasUsed);
  });
  for (const field of ['inputHash', 'methodHash', 'settingsHash', 'outputHash', 'atomCount', 'sampleCount']) {
    await check(`tampered_signed_${field}_rejected`, async () => {
      const altered = { ...report, [field]: typeof report[field] === 'bigint'
        ? report[field] + 1n : id('Changed signed field: ' + field) };
      await reject(altered, signature);
    });
  }
  await check('wrong_operator_signature_rejected', async () => reject(report, await sign(report, domain, wrongOperator)));
  for (const [name, changed] of [
    ['chain', { chainId: 4664 }], ['contract', { verifyingContract: otherAddress }],
    ['name', { name: 'OtherResultAnchor' }], ['version', { version: '2' }],
  ]) {
    await check(`wrong_domain_${name}_rejected`, async () => reject(report, await sign(report, { ...domain, ...changed })));
  }
  await check('cross_deployment_replay_rejected', async () => reject(report, signature, secondContract));
  for (const field of ['inputHash', 'methodHash', 'settingsHash', 'outputHash', 'atomCount', 'sampleCount']) {
    await check(`operator_signed_zero_${field}_rejected`, async () => {
      const zeroReport = { ...report, [field]: typeof report[field] === 'bigint' ? 0n : ZeroHash };
      const zeroSignature = await sign(zeroReport);
      await expectRevert(() => contract.connect(relayer).anchor.staticCall(...args(zeroReport, zeroSignature)), 'InvalidReport');
    });
  }
  for (const [name, malformed] of [
    ['empty', '0x'], ['64_bytes', '0x' + '11'.repeat(64)],
    ['66_bytes', '0x' + '11'.repeat(66)], ['all_zero_65_bytes', '0x' + '00'.repeat(65)],
  ]) await check(`malformed_signature_${name}_rejected`, async () => reject(report, malformed));
  const parsed = Signature.from(signature);
  const encodeSignature = (r, s, v) => r + s.slice(2) + toBeHex(v, 1).slice(2);
  for (const v of [0, 1, 26, 29, 255]) {
    await check(`invalid_recovery_v_${v}_rejected`, async () => reject(report, encodeSignature(parsed.r, parsed.s, v)));
  }
  for (const [name, r, s] of [
    ['zero_r', ZeroHash, parsed.s], ['zero_s', parsed.r, ZeroHash],
    ['out_of_range_r', '0x' + 'ff'.repeat(32), parsed.s],
    ['out_of_range_s', parsed.r, '0x' + 'ff'.repeat(32)],
  ]) await check(`invalid_signature_${name}_rejected`, async () => reject(report, encodeSignature(r, s, parsed.v)));
  await check('malleable_high_s_signature_rejected', async () => {
    const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = toBeHex(order - BigInt(parsed.s), 32);
    await reject(report, encodeSignature(parsed.r, highS, parsed.v === 27 ? 28 : 27));
  });
  await check('maximum_uint32_uint64_counts_preserved_exactly', async () => {
    const maxReport = { ...report, atomCount: (1n << 32n) - 1n, sampleCount: (1n << 64n) - 1n };
    const signed = await sign(maxReport);
    const receipt = await (await contract.connect(relayer).anchor(...args(maxReport, signed))).wait();
    exactEvent(receipt, maxReport);
  });
  await check('source_script_and_dependency_lock_unchanged_during_run', async () => {
    assert.equal(sha(fs.readFileSync(sourcePath)), result.sourceSha256);
    assert.equal(sha(fs.readFileSync(scriptPath)), result.scriptSha256);
    assert.equal(sha(fs.readFileSync(new URL('../../package-lock.json', import.meta.url))), result.dependencyLockSha256);
  });
  result.checkCount = result.checks.length;
  result.failedCheckCount = result.checks.filter(entry => !entry.passed).length;
  assert.equal(result.failedCheckCount, 0, 'Focused security checks failed');
  result.status = 'passed_local_security_checks';
  result.passed = true;
} catch (error) {
  result.status = 'failed_or_incomplete';
  result.error = error.shortMessage ?? error.message;
  process.exitCode = 2;
} finally {
  try { if (provider) provider.destroy(); if (local) await local.disconnect(); }
  catch (error) { result.passed = false; result.status = 'failed_cleanup'; result.error = error.message; process.exitCode = 2; }
  result.completedAtUtc = new Date().toISOString();
  save();
}
console.log(JSON.stringify({ status: result.status, passed: result.passed,
  checks: result.checkCount ?? result.checks.length,
  failed: result.checks.filter(entry => !entry.passed),
  sourceSha256: result.sourceSha256, report: fileURLToPath(reportPath), error: result.error }));
