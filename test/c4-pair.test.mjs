import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import solc from 'solc';
import ganache from 'ganache';
import { Interface, getAddress, keccak256, toBeHex, ZeroAddress } from 'ethers';

const sourcePath = 'contracts/kernels/C4PairKernel.sol';
const referencePath = 'reference/c4_pair_reference.py';
const sha = value => createHash('sha256').update(value).digest('hex');
const zero = toBeHex(0n, 16);
const pow2 = exponent => toBeHex(BigInt(exponent + 16383) << 112n, 16);
const negative = encoded => BigInt(encoded) === 0n ? zero : toBeHex(BigInt(encoded) ^ (1n << 127n), 16);
const adjacent = (encoded, delta) => toBeHex(BigInt(encoded) + BigInt(delta), 16);
const scale = (encoded, exponent) => BigInt(encoded) === 0n ? zero : toBeHex(BigInt(encoded) + (BigInt(exponent) << 112n), 16);
function quadNumber(value) {
  if (value === 0) return zero;
  const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value);
  const bits = bytes.readBigUInt64BE(), exponent = (bits >> 52n) & 2047n;
  assert(exponent > 0n && exponent < 2047n);
  return toBeHex(((bits >> 63n) << 127n) | ((exponent - 1023n + 16383n) << 112n)
    | ((bits & ((1n << 52n) - 1n)) << 60n), 16);
}
function compileFixture() {
  assert.equal(solc.version(), '0.8.26+commit.8a97fa7a.Emscripten.clang');
  const sources = {};
  function add(file) {
    if (sources[file]) return;
    const content = fs.readFileSync(file, 'utf8'); sources[file] = { content };
    for (const match of content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']\s*;/g))
      add(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
  }
  add(sourcePath);
  const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  assert.deepEqual((output.errors || []).filter(error => error.severity === 'error'), []);
  return { input, artifacts: Object.fromEntries(Object.values(output.contracts).flatMap(contracts => Object.entries(contracts))) };
}

test('raw C4 binary128 pair agrees with independent 110-digit scalar-potential derivatives', async t => {
  const report = { schemaVersion: 1, status: 'incomplete', passed: false, chainId: 31337,
    publicTransactionsSent: 0, productionMethodSelected: false, scientificParameterAcceptance: false,
    scope: 'Raw unswitched C4 pair primitive; no cutoff, switching, exclusions, tail correction or alchemical integration.', checks: [] };
  fs.mkdirSync('reports', { recursive: true });
  const save = () => fs.writeFileSync('reports/c4_pair_validation.json', JSON.stringify(report, null, 2) + '\n');
  save();
  let transport;
  try {
    report.scriptSha256 = sha(fs.readFileSync(import.meta.filename));
    report.referenceSha256 = sha(fs.readFileSync(referencePath));
    const { input, artifacts } = compileFixture();
    report.compiler = solc.version(); report.compilerInputSha256 = sha(JSON.stringify(input));
    report.sources = Object.fromEntries(Object.entries(input.sources).map(([file, entry]) => [file, sha(entry.content)]));
    save();
    transport = ganache.provider({ logging: { quiet: true }, chain: { chainId: 31337, hardfork: 'shanghai' },
      wallet: { totalAccounts: 2 }, miner: { blockGasLimit: 30000000 } });
    t.after(() => transport.disconnect());
    const rpc = (method, params = []) => transport.request({ method, params });
    const [owner] = await rpc('eth_accounts');
    async function deploy(name, args = []) {
      const artifact = artifacts[name], iface = new Interface(artifact.abi);
      const data = '0x' + artifact.evm.bytecode.object + iface.encodeDeploy(args).slice(2);
      const hash = await rpc('eth_sendTransaction', [{ from: owner, data, gas: '0x989680' }]);
      const receipt = await rpc('eth_getTransactionReceipt', [hash]); assert.equal(receipt.status, '0x1');
      return { address: getAddress(receipt.contractAddress), iface, receipt };
    }
    const math = await deploy('FloatMath'), kernel = await deploy('C4PairKernel', [math.address]);
    const call = async (contract, method, args = []) => contract.iface.decodeFunctionResult(method,
      await rpc('eth_call', [{ to: contract.address, data: contract.iface.encodeFunctionData(method, args) }, 'latest']));
    const reject = async (name, displacement, coefficient) => assert.rejects(call(kernel, 'evaluate', [displacement, coefficient]), error => {
      const data = typeof error.data === 'string' ? error.data : error.data?.result;
      assert(data?.startsWith(kernel.iface.getError(name).selector), `Expected ${name}`); return true;
    });
    const observations = [];
    async function observe(name, displacement, c4) {
      const [energy, forceOnA] = await call(kernel, 'evaluate', [displacement, c4]);
      const row = { name, displacement, c4, energy, forceOnA: [...forceOnA] }; observations.push(row); return row;
    }
    const check = async (name, operation) => { await operation(); report.checks.push({ name, passed: true }); save(); };
    await check('immutable_math_binding_and_no_eoa_constructor', async () => {
      assert.equal((await call(kernel, 'numericalMath'))[0], math.address);
      assert.equal((await call(kernel, 'numericalMathCodeHash'))[0], keccak256(await rpc('eth_getCode', [math.address, 'latest'])));
      assert.equal((await call(kernel, 'MIN_POSITIVE_INPUT'))[0], pow2(-256));
      assert.equal((await call(kernel, 'MAX_POSITIVE_INPUT'))[0], pow2(256));
      const iface = kernel.iface;
      for (const invalid of [ZeroAddress, owner]) {
        const data = '0x' + artifacts.C4PairKernel.evm.bytecode.object + iface.encodeDeploy([invalid]).slice(2);
        await assert.rejects(rpc('eth_call', [{ from: owner, data }, 'latest']));
      }
    });
    await check('positive_c4_attracts_with_all_components_and_swap_antisymmetry', async () => {
      const axis = await observe('unit_axis', [pow2(0), zero, zero], pow2(0));
      assert.equal(axis.energy, negative(pow2(0))); assert.deepEqual(axis.forceOnA, [pow2(2), zero, zero]);
      for (let index = 0; index < 24; index++) {
        const d = [((index * 7) % 19 + 1) / 16, -((index * 11) % 23 + 1) / 32, ((index * 13) % 29 + 1) / 64].map(quadNumber);
        const row = await observe(`three_axis_${index}`, d, quadNumber((index + 1) / 32));
        const swap = await observe(`swapped_${index}`, d.map(negative), row.c4);
        assert.equal(swap.energy, row.energy); assert.deepEqual(swap.forceOnA, row.forceOnA.map(negative));
        assert((BigInt(row.energy) >> 127n) === 1n);
        for (let axis = 0; axis < 3; axis++) assert.equal(BigInt(row.forceOnA[axis]) >> 127n, BigInt(d[axis]) >> 127n);
      }
    });
    await check('zero_coefficient_keeps_geometry_validation_and_returns_canonical_zero', async () => {
      for (const coefficient of [zero, '0x80000000000000000000000000000000']) {
        const row = await observe('zero_strength_' + coefficient, [pow2(0), negative(pow2(1)), pow2(-2)], coefficient);
        assert.equal(row.energy, zero); assert.deepEqual(row.forceOnA, [zero, zero, zero]);
        await reject('ZeroSeparation', [zero, zero, zero], coefficient);
      }
    });
    await check('exact_power_of_two_homogeneity_across_r2_scales', async () => {
      const base = await observe('scale_base', [pow2(-2), negative(pow2(-1)), quadNumber(.75)], pow2(-3));
      for (const exponent of [-60, -10, -1, 1, 10, 60]) {
        const row = await observe(`distance_scaled_2p${exponent}`, base.displacement.map(value => scale(value, exponent)), base.c4);
        assert.equal(row.energy, scale(base.energy, -4 * exponent));
        assert.deepEqual(row.forceOnA, base.forceOnA.map(value => scale(value, -5 * exponent)));
      }
      const doubled = await observe('coefficient_doubled', base.displacement, scale(base.c4, 1));
      assert.equal(doubled.energy, scale(base.energy, 1));
      assert.deepEqual(doubled.forceOnA, base.forceOnA.map(value => scale(value, 1)));
    });
    await check('supported_boundaries_remain_finite_and_adjacent_outside_values_reject', async () => {
      for (const distancePower of [-128, 128]) for (const coefficientPower of [-256, 0, 256])
        await observe(`boundary_d${distancePower}_c${coefficientPower}`, [pow2(distancePower), zero, zero], pow2(coefficientPower));
      await observe('small_transverse_component', [pow2(0), pow2(-256), zero], pow2(0));
      await observe('smallest_force_component', [pow2(128), pow2(-256), zero], pow2(-256));
      await reject('CoefficientOutsideDomain', [pow2(0), zero, zero], adjacent(pow2(-256), -1));
      await reject('CoefficientOutsideDomain', [pow2(0), zero, zero], adjacent(pow2(256), 1));
      await reject('DisplacementOutsideDomain', [pow2(0), adjacent(pow2(-256), -1), zero], pow2(0));
      await reject('DisplacementOutsideDomain', [adjacent(pow2(256), 1), zero, zero], pow2(0));
      await reject('SeparationOutsideDomain', [adjacent(pow2(-128), -1), zero, zero], pow2(0));
      await reject('SeparationOutsideDomain', [adjacent(pow2(128), 1), zero, zero], pow2(0));
      await reject('SeparationOutsideDomain', [pow2(-256), zero, zero], zero);
    });
    await check('negative_nonfinite_and_singular_inputs_fail_closed', async () => {
      await reject('NegativeC4', [pow2(0), zero, zero], negative(pow2(0)));
      await reject('ZeroSeparation', [zero, zero, zero], pow2(0));
      for (const nonfinite of ['0x7fff0000000000000000000000000000', '0xffff0000000000000000000000000000', '0x7fff8000000000000000000000000000']) {
        await reject('NonFiniteInput', [pow2(0), zero, zero], nonfinite);
        for (let axis = 0; axis < 3; axis++) {
          const d = [pow2(0), pow2(0), pow2(0)]; d[axis] = nonfinite;
          await reject('NonFiniteInput', d, pow2(0));
        }
      }
    });
    await check('independent_110_digit_potential_and_three_coordinate_derivatives', async () => {
      const python = process.env.ORVIA_RESEARCH_PYTHON || process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3';
      const reference = JSON.parse(execFileSync(python, [referencePath], { input: JSON.stringify({ observations }), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
      assert.equal(reference.passed, true); assert.equal(reference.decimal_precision, 110);
      assert.equal(reference.derivatives_checked, observations.length * 3);
      report.reference = reference; report.observations = observations;
    });
    const data = kernel.iface.encodeFunctionData('evaluate', [[quadNumber(.25), quadNumber(-.5), quadNumber(.75)], quadNumber(.125)]);
    report.gas = { localDeploymentGas: BigInt(kernel.receipt.gasUsed).toString(),
      localEvaluateEstimateGas: BigInt(await rpc('eth_estimateGas', [{ from: owner, to: kernel.address, data }])).toString(),
      runtimeBytes: (await rpc('eth_getCode', [kernel.address, 'latest'])).length / 2 - 1,
      includesMathDeployment: false, targetChainQuote: false };
    await check('changed_math_runtime_rejected_before_calculation', async () => {
      await rpc('evm_setAccountCode', [math.address, '0x00']);
      await reject('DependencyChanged', [pow2(0), zero, zero], pow2(0));
    });
    for (const [file, hash] of Object.entries(report.sources)) assert.equal(sha(fs.readFileSync(file)), hash);
    assert.equal(sha(fs.readFileSync(import.meta.filename)), report.scriptSha256);
    assert.equal(sha(fs.readFileSync(referencePath)), report.referenceSha256);
    report.status = 'passed_local_primitive_checks'; report.passed = true; report.completedAtUtc = new Date().toISOString();
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { save(); }
});
