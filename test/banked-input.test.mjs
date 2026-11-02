import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import solc from 'solc';
import ganache from 'ganache';
import { AbiCoder, Interface, encodeBytes32String, getAddress, getCreate2Address, id, keccak256, toBeHex, toQuantity, ZeroHash } from 'ethers';

const sourcePath = 'contracts/core/BankedInputCatalog.sol';
const sha = value => createHash('sha256').update(value).digest('hex');
const abi = AbiCoder.defaultAbiCoder();
const harnessSource = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {InputWordBank} from "contracts/core/BankedInputCatalog.sol";
contract InputBankTestHarness {
    InputWordBank public bank;
    function create(uint8 index) external { require(address(bank)==address(0)); bank=new InputWordBank(address(this),index); }
    function write(bytes32 stream,uint64 start,bytes32[] calldata values) external { bank.writeWords(stream,start,values); }
}`;
function compileFixture() {
  assert.equal(solc.version(), '0.8.26+commit.8a97fa7a.Emscripten.clang');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const input = { language: 'Solidity', sources: { [sourcePath]: { content: source },
    'InputBankTestHarness.sol': { content: harnessSource } }, settings: { optimizer: { enabled: true, runs: 200 },
    evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  assert.deepEqual((output.errors || []).filter(error => error.severity === 'error'), []);
  const artifacts = Object.fromEntries(Object.values(output.contracts).flatMap(contracts => Object.entries(contracts)));
  const interfaces = Object.fromEntries(Object.entries(artifacts).map(([name, artifact]) => [name, new Interface(artifact.abi)]));
  return { source, input, artifacts, interfaces };
}

test('fixed 96-bank input catalog: bounded deployment, canonical sealed streams and authenticated routing', async t => {
  const report = { schemaVersion: 1, status: 'incomplete', passed: false,
    scriptSha256: sha(fs.readFileSync(import.meta.filename)), compiler: solc.version(),
    chainId: 31337, publicTransactionsSent: 0,
    scope: 'Local synthetic 96-bank deployment and 4133-word stream, partition replay, cross-stream isolation and direct bank-cycle harness. Not a full prepared model, production pipeline or mainnet fee quote.',
    checks: [], deployment: {}, gas: [] };
  fs.mkdirSync('reports', { recursive: true });
  const save = () => fs.writeFileSync('reports/banked_input_validation.json', JSON.stringify(report, null, 2) + '\n');
  save();
  const transport = ganache.provider({ logging: { quiet: true }, chain: { chainId: 31337, hardfork: 'shanghai' },
    wallet: { totalAccounts: 2 }, miner: { blockGasLimit: 30000000 } });
  t.after(() => transport.disconnect());
  const rpc = (method, params = []) => transport.request({ method, params });
  const [owner, outsider] = await rpc('eth_accounts');
  let artifacts, interfaces;
  const contract = async (name, args = []) => {
    const data = '0x' + artifacts[name].evm.bytecode.object + interfaces[name].encodeDeploy(args).slice(2);
    const hash = await rpc('eth_sendTransaction', [{ from: owner, data, gas: '0x989680' }]);
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    assert.equal(receipt.status, '0x1');
    return { name, address: getAddress(receipt.contractAddress), iface: interfaces[name], receipt };
  };
  const call = async (c, method, args = [], from = owner) => c.iface.decodeFunctionResult(method,
    await rpc('eth_call', [{ from, to: c.address, data: c.iface.encodeFunctionData(method, args) }, 'latest']));
  const send = async (c, method, args = [], label = method) => {
    const hash = await rpc('eth_sendTransaction', [{ from: owner, to: c.address,
      data: c.iface.encodeFunctionData(method, args), gas: '0x989680' }]);
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    assert.equal(receipt.status, '0x1', label);
    report.gas.push({ label, gasUsed: BigInt(receipt.gasUsed).toString() });
    return receipt;
  };
  const revert = async (c, name, method, args = [], from = owner) => {
    await assert.rejects(call(c, method, args, from), error => {
      const data = typeof error.data === 'string' ? error.data : error.data?.result;
      assert(data?.startsWith(c.iface.getError(name).selector), `Expected ${name} for ${method}`);
      return true;
    });
  };
  const check = async (name, operation) => { await operation(); report.checks.push({ name, passed: true }); save(); };
  try {
    // Invalidate historical PASS before source reading or compilation can fail.
    const compiled = compileFixture();
    artifacts = compiled.artifacts; interfaces = compiled.interfaces;
    report.sourceSha256 = sha(compiled.source); report.compilerInputSha256 = sha(JSON.stringify(compiled.input));
    save();
    const catalog = await contract('BankedInputCatalog', [owner]);
    report.deployment.routerGas = BigInt(catalog.receipt.gasUsed).toString();
    report.deployment.routerRuntimeBytes = (await rpc('eth_getCode', [catalog.address, 'latest'])).length / 2 - 1;
    const stream = id('banked-real-4133-word-stream'), role = id('ORVIA.BANKED.TEST.RAW.WORDS'), total = 4133;
    await check('only_owner_and_bounded_bank_creation_before_any_stream', async () => {
      await revert(catalog, 'Unauthorized', 'createBanks', [1], outsider);
      await revert(catalog, 'InvalidBankBatch', 'createBanks', [0]);
      await revert(catalog, 'InvalidBankBatch', 'createBanks', [5]);
      await revert(catalog, 'BanksIncomplete', 'beginStream', [stream, role, total]);
      assert.equal((await call(catalog, 'bankCount'))[0], 0n);
      assert.equal(BigInt(await rpc('eth_getTransactionCount', [catalog.address, 'latest'])), 1n);
    });
    let creationGas = 0n;
    const banks = [];
    await check('exactly_96_factory_banks_with_bound_codehash_and_predictable_addresses', async () => {
      for (let count = 0; count < 96;) {
        const batch = Math.min(count === 0 ? 1 : 4, 96 - count);
        const receipt = await send(catalog, 'createBanks', [batch], `create ${batch} banks at ${count}`);
        creationGas += BigInt(receipt.gasUsed);
        const events = receipt.logs.map(log => { try { return catalog.iface.parseLog(log); } catch { return null; } })
          .filter(event => event?.name === 'BankCreated');
        assert.equal(events.length, batch);
        count += batch;
        assert.equal((await call(catalog, 'bankCount'))[0], BigInt(count));
      }
      for (let index = 0; index < 96; index++) {
        const [address, codeHash] = await call(catalog, 'bankInfo', [index]);
        const bank = { address, iface: interfaces.InputWordBank };
        const code = await rpc('eth_getCode', [address, 'latest']);
        assert.equal(keccak256(code), codeHash);
        assert.equal((await call(bank, 'router'))[0], catalog.address);
        assert.equal((await call(bank, 'bankIndex'))[0], BigInt(index));
        assert.equal((await call(bank, 'routerCodeHash'))[0], keccak256(await rpc('eth_getCode', [catalog.address, 'latest'])));
        const init = '0x' + artifacts.InputWordBank.evm.bytecode.object
          + interfaces.InputWordBank.encodeDeploy([catalog.address, index]).slice(2);
        assert.equal(address, getCreate2Address(catalog.address, toBeHex(index, 32), keccak256(init)));
        banks.push({ index, address, codeHash, runtimeBytes: code.length / 2 - 1 });
      }
      assert.equal(new Set(banks.map(bank => bank.address)).size, 96);
      assert.equal(BigInt(await rpc('eth_getTransactionCount', [catalog.address, 'latest'])), 97n);
      await revert(catalog, 'InvalidBankBatch', 'createBanks', [1]);
      await revert(catalog, 'InvalidRead', 'bankInfo', [96]);
      report.deployment.bankCount = banks.length;
      report.deployment.bankCreationGas = creationGas.toString();
      report.deployment.routerPlus96BanksGas = (creationGas + BigInt(catalog.receipt.gasUsed)).toString();
      report.deployment.banks = banks;
    });
    await check('stream_guards_and_sealed_read_requirement', async () => {
      await revert(catalog, 'Unauthorized', 'beginStream', [stream, role, total], outsider);
      await revert(catalog, 'InvalidConfiguration', 'beginStream', [ZeroHash, role, total]);
      await revert(catalog, 'InvalidConfiguration', 'beginStream', [stream, ZeroHash, total]);
      await send(catalog, 'beginStream', [stream, role, total]);
      await revert(catalog, 'StreamExists', 'beginStream', [stream, role, total]);
      await revert(catalog, 'IncompleteStream', 'assertStream', [stream]);
      await revert(catalog, 'IncompleteStream', 'readWord', [stream, 0]);
      await revert(catalog, 'IncompleteStream', 'sealStream', [stream]);
      await revert(catalog, 'Unauthorized', 'appendWords', [stream, [ZeroHash]], outsider);
      await revert(catalog, 'InvalidBatch', 'appendWords', [stream, []]);
      await revert(catalog, 'InvalidBatch', 'appendWords', [stream, Array(129).fill(ZeroHash)]);
      await revert(catalog, 'UnknownStream', 'appendWords', [id('missing'), [ZeroHash]]);
      const bank = { address: banks[0].address, iface: interfaces.InputWordBank };
      await revert(bank, 'Unauthorized', 'writeWords', [stream, 0, [id('bad-write')]]);
    });
    const values = Array.from({ length: total }, (_, index) => index % 17 === 0 ? ZeroHash : toBeHex(index + 1, 32));
    const bankCommitment = (await call(catalog, 'banksCommitment'))[0];
    let digest = keccak256(abi.encode(['bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'uint64', 'bytes32'],
      [encodeBytes32String('ORVIA-BANKED-INPUT-v1'), 31337, catalog.address, stream, role, total, bankCommitment]));
    for (let index = 0; index < total; index++) digest = keccak256(abi.encode(['bytes32', 'uint64', 'bytes32'], [digest, index, values[index]]));
    const expectedCommitment = keccak256(abi.encode(['bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'uint64', 'bytes32', 'bytes32'],
      [encodeBytes32String('ORVIA-SEALED-BANKS-v1'), 31337, catalog.address, stream, role, total, digest, bankCommitment]));
    const beforeUpload = await rpc('evm_snapshot');
    await check('real_4133_word_upload_crosses_bank_boundary_and_matches_independent_commitment', async () => {
      let offset = 0;
      while (offset < total) {
        const count = Math.min(offset === 0 ? 127 : 128, total - offset);
        await send(catalog, 'appendWords', [stream, values.slice(offset, offset + count)], `append ${count} at ${offset}`);
        offset += count;
      }
      const info = await call(catalog, 'streamInfo', [stream]);
      assert.deepEqual([...info.slice(1, 5)], [4133n, 4133n, 2n, false]);
      await revert(catalog, 'InvalidBatch', 'appendWords', [stream, [ZeroHash]]);
      await send(catalog, 'sealStream', [stream]);
      assert.deepEqual([...(await call(catalog, 'assertStream', [stream]))], [expectedCommitment, 4133n]);
      for (const index of [0, 16, 17, 4094, 4095, 4096, 4132]) assert.equal((await call(catalog, 'readWord', [stream, index]))[0], values[index]);
      assert.deepEqual([...(await call(catalog, 'readWords', [stream, 4093, 40]))[0]], values.slice(4093));
      assert.equal(BigInt(await rpc('eth_getTransactionCount', [catalog.address, 'latest'])), 97n);
    });
    await check('different_transaction_partition_preserves_canonical_stream_commitment', async () => {
      assert.equal(await rpc('evm_revert', [beforeUpload]), true);
      for (let offset = 0; offset < total; offset += 128)
        await send(catalog, 'appendWords', [stream, values.slice(offset, offset + 128)], `partition replay at ${offset}`);
      await send(catalog, 'sealStream', [stream]);
      assert.equal((await call(catalog, 'assertStream', [stream]))[0], expectedCommitment);
      report.realStreamWords = total; report.realStreamCommitment = expectedCommitment;
    });
    await check('sealed_inputs_cannot_change_and_cross_streams_do_not_alias', async () => {
      await revert(catalog, 'StreamSealed', 'appendWords', [stream, [id('changed')]]);
      await revert(catalog, 'StreamSealed', 'sealStream', [stream]);
      await revert(catalog, 'InvalidRead', 'readWord', [stream, total]);
      await revert(catalog, 'InvalidRead', 'readWords', [stream, total - 1, 2]);
      await revert(catalog, 'InvalidRead', 'readWords', [stream, 0, 129]);
      await revert(catalog, 'InvalidRead', 'readWords', [stream, (1n << 64n) - 1n, 1]);
      assert.deepEqual([...(await call(catalog, 'readWords', [stream, total, 0]))[0]], []);
      const second = id('independent-stream');
      await send(catalog, 'beginStream', [second, role, 1]);
      await send(catalog, 'appendWords', [second, [id('independent-value')]]);
      await send(catalog, 'sealStream', [second]);
      assert.equal((await call(catalog, 'readWord', [second, 0]))[0], id('independent-value'));
      assert.equal((await call(catalog, 'readWord', [stream, 0]))[0], ZeroHash);
      const empty = id('empty-stream');
      await send(catalog, 'beginStream', [empty, role, 0]);
      await send(catalog, 'sealStream', [empty]);
      assert.equal((await call(catalog, 'assertStream', [empty]))[1], 0n);
      assert.deepEqual([...(await call(catalog, 'readWords', [empty, 0, 0]))[0]], []);
      await revert(catalog, 'InvalidRead', 'readWord', [empty, 0]);
    });
    await check('routing_reuses_same_96_banks_across_cycles_and_at_uint64_boundary', async () => {
      for (const index of [0n, 4095n, 4096n, 393215n, 393216n, 786432n, (1n << 64n) - 1n])
        assert.equal((await call(catalog, 'bankForWord', [index]))[0], (index / 4096n) % 96n);
      const harness = await contract('InputBankTestHarness');
      await send(harness, 'create', [0]);
      const bank = { address: (await call(harness, 'bank'))[0], iface: interfaces.InputWordBank };
      await send(harness, 'write', [stream, 0, [id('cycle-zero')]]);
      await send(harness, 'write', [stream, 393216, [id('cycle-one')]]);
      await send(harness, 'write', [id('different-stream'), 0, [id('different')]]);
      assert.equal((await call(bank, 'readWord', [stream, 0]))[0], id('cycle-zero'));
      assert.equal((await call(bank, 'readWord', [stream, 393216]))[0], id('cycle-one'));
      assert.equal((await call(bank, 'readWord', [id('different-stream'), 0]))[0], id('different'));
      await revert(bank, 'InvalidRange', 'readWords', [stream, 4095, 2]);
      await revert(bank, 'InvalidRange', 'readWord', [stream, 4096]);
      assert.equal(BigInt(await rpc('eth_getTransactionCount', [catalog.address, 'latest'])), 97n);
      report.cycleBoundaryScope = 'Direct isolated bank harness writes indices0 and393216; this does not claim384k-word canonical catalog upload.';
    });
    await check('changed_bank_runtime_is_rejected_before_reads_or_further_writes', async () => {
      const crossing = id('rollback-across-second-bank');
      await send(catalog, 'beginStream', [crossing, role, total]);
      for (let offset = 0; offset < 4095; offset += 128)
        await send(catalog, 'appendWords', [crossing, values.slice(offset, Math.min(offset + 128, 4095))], `rollback prefix at ${offset}`);
      const bank0 = { address: banks[0].address, iface: interfaces.InputWordBank };
      const bank1Code = await rpc('eth_getCode', [banks[1].address, 'latest']);
      const before = [...await call(catalog, 'streamInfo', [crossing])];
      assert.equal((await call(bank0, 'readWord', [crossing, 4095]))[0], ZeroHash);
      await rpc('evm_setAccountCode', [banks[1].address, '0x00']);
      const rejectedHash = await rpc('eth_sendTransaction', [{ from: owner, to: catalog.address, gas: '0x989680',
        data: catalog.iface.encodeFunctionData('appendWords', [crossing, [id('must-roll-back'), id('second-bank-failure')]]) }]);
      const rejected = await rpc('eth_getTransactionReceipt', [rejectedHash]);
      assert.equal(rejected.status, '0x0');
      report.gas.push({ label: 'actual reverted cross-bank append', gasUsed: BigInt(rejected.gasUsed).toString(), reverted: true });
      assert.equal((await call(bank0, 'readWord', [crossing, 4095]))[0], ZeroHash);
      assert.deepEqual([...await call(catalog, 'streamInfo', [crossing])], before);
      await rpc('evm_setAccountCode', [banks[1].address, bank1Code]);
      await send(catalog, 'appendWords', [crossing, values.slice(4095)]);
      await send(catalog, 'sealStream', [crossing]);
      let crossingDigest = keccak256(abi.encode(['bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'uint64', 'bytes32'],
        [encodeBytes32String('ORVIA-BANKED-INPUT-v1'), 31337, catalog.address, crossing, role, total, bankCommitment]));
      for (let index = 0; index < total; index++) crossingDigest = keccak256(abi.encode(['bytes32', 'uint64', 'bytes32'], [crossingDigest, index, values[index]]));
      const crossingCommitment = keccak256(abi.encode(['bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'uint64', 'bytes32', 'bytes32'],
        [encodeBytes32String('ORVIA-SEALED-BANKS-v1'), 31337, catalog.address, crossing, role, total, crossingDigest, bankCommitment]));
      assert.equal((await call(catalog, 'assertStream', [crossing]))[0], crossingCommitment);
      report.crossBankRollback = { actualRevertedTransaction: true, firstBankWriteReverted: true,
        streamCursorUnchanged: true, subsequentCompletionCommitmentMatches: true };
      const pending = id('pending-bank-integrity');
      await send(catalog, 'beginStream', [pending, role, 1]);
      await rpc('evm_setAccountCode', [banks[0].address, '0x00']);
      await revert(catalog, 'BankChanged', 'readWord', [stream, 0]);
      await revert(catalog, 'BankChanged', 'appendWords', [pending, [id('blocked')]]);
      assert.equal((await call(catalog, 'streamInfo', [pending]))[2], 0n);
      assert.equal((await call(catalog, 'readWord', [stream, 4096]))[0], values[4096]);
    });
    assert.equal(sha(fs.readFileSync(sourcePath)), report.sourceSha256);
    assert.equal(sha(fs.readFileSync(import.meta.filename)), report.scriptSha256);
    report.status = 'passed_local_synthetic_checks'; report.passed = true;
    report.completedAtUtc = new Date().toISOString();
  } catch (error) {
    report.status = 'failed'; report.error = error.message; throw error;
  } finally { save(); }
});
