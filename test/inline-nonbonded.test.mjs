import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import solc from 'solc';
import ganache from 'ganache';
import { AbiCoder, BrowserProvider, ContractFactory, ZeroHash, keccak256 } from 'ethers';
import { quadFromNumber as q, qvec } from './helpers.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const encode = AbiCoder.defaultAbiCoder();
const sourcesToCompile = ['contracts/math/vendor/ABDKMathQuad.sol', 'contracts/math/FloatMath.sol',
  'contracts/kernels/LennardJonesKernel.sol', 'contracts/kernels/CoulombPairKernel.sol',
  'contracts/kernels/SwitchedNonbondedKernel.sol', 'contracts/kernels/InlineNonbondedKernel.sol',
  'contracts/kernels/OrthorhombicGeometry.sol', 'test/contracts/PairWorkMeter.sol'];
const defaultParameters = [0.75, 0.5, -0.25, 2, 2, 4].map(q);

test('Optional inlined pair kernel preserves v0.4 bytes and measures real local gas savings', async t => {
  const researchPython = process.env.ORVIA_RESEARCH_PYTHON || process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3';
  // Fail before expensive EVM work if the required independent oracle is unavailable.
  execFileSync(researchPython, ['-c', 'import mpmath; assert mpmath.__version__ == "1.3.0"']);
  const sources = Object.fromEntries(sourcesToCompile.map(p => [p, { content: fs.readFileSync(p, 'utf8') }]));
  const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } } };
  const input = { language: 'Solidity', sources, settings };
  const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
  assert.deepEqual((compiled.errors ?? []).filter(e => e.severity === 'error'), []);
  const artifacts = Object.fromEntries(Object.entries(compiled.contracts).flatMap(([source, values]) =>
    Object.entries(values).map(([name, value]) => [name, { ...value, source }])));
  const transport = ganache.provider({ logging: { quiet: true }, chain: { chainId: 31337, hardfork: 'shanghai' },
    wallet: { deterministic: true, totalAccounts: 1 }, miner: { blockGasLimit: 30_000_000 } });
  t.after(() => transport.disconnect());
  const provider = new BrowserProvider(transport); provider.pollingInterval = 10;
  assert.equal((await provider.getNetwork()).chainId, 31337n);
  const owner = await provider.getSigner(0), deployments = [];
  async function deploy(name, args = []) {
    const a = artifacts[name];
    const c = await new ContractFactory(a.abi, '0x' + a.evm.bytecode.object, owner).deploy(...args);
    const receipt = await c.deploymentTransaction().wait(); assert.equal(receipt.status, 1);
    const runtime = await provider.getCode(await c.getAddress());
    deployments.push({ name, address: await c.getAddress(), runtimeKeccak256: keccak256(runtime),
      runtimeBytes: (runtime.length - 2) / 2, creationKeccak256: keccak256('0x' + a.evm.bytecode.object),
      deploymentGas: receipt.gasUsed.toString() });
    return c;
  }
  const math = await deploy('FloatMath'), ma = await math.getAddress();
  const lj = await deploy('LennardJonesKernel', [ma]);
  const coulomb = await deploy('CoulombPairKernel', [ma]);
  const reference = await deploy('SwitchedNonbondedKernel', [ma, await lj.getAddress(), await coulomb.getAddress()]);
  const inline = await deploy('InlineNonbondedKernel');
  const geometry = await deploy('OrthorhombicGeometry', [ma]);
  const equivalence = [], rejections = [], gasCases = [], completedChecks = [];
  async function check(name, fn) {
    await t.test(name, async () => { await fn(); completedChecks.push(name); });
  }
  async function compare(name, displacement, parameters = defaultParameters, exception = false) {
    const args = [displacement, ...parameters, exception];
    const [before, after] = await Promise.all([reference.evaluate(...args), inline.evaluate(...args)]);
    assert.equal(after[0], before[0], name + ' energy');
    assert.deepEqual([...after[1]], [...before[1]], name + ' force');
    equivalence.push({ name, displacement, parameters, exception, energy: after[0], force: [...after[1]], bitwiseEqual: true });
  }
  let oracle;

  await check('identifies self-contained pinned arithmetic and fits the ordinary 24 KiB limit', async () => {
    assert.equal(inline.interface.getFunction('numericalMath'), null);
    assert.equal(await inline.ABDK_COMMIT(), '0x5e1e7c11b35f8313d3f7ce11c1b86320d7c0b554');
    assert.equal(await inline.ABDK_SOURCE_SHA256(), '0x' + sha256(sources['contracts/math/vendor/ABDKMathQuad.sol'].content));
    assert.equal(await inline.ARITHMETIC_IMPLEMENTATION_ID(), await math.IMPLEMENTATION_ID());
    const runtime = await provider.getCode(await inline.getAddress());
    assert.equal(runtime, '0x' + artifacts.InlineNonbondedKernel.evm.deployedBytecode.object);
    assert((runtime.length - 2) / 2 < 24 * 1024);
  });

  await check('matches all v0.4 branch, boundary, exchange, zero and direct-reference sample bytes', async () => {
    const cases = [
      ['repulsive_core', [0.5, 0, 0]], ['below_switch', [1.5, 0, 0]], ['at_switch', [2, 0, 0]],
      ['switch_middle', [3, 0, 0]], ['nonaxis_switch', [1.25, -2.5, 0.75]],
      ['near_cutoff', [4 - 2 ** -20, 0, 0]], ['at_cutoff', [4, 0, 0]], ['above_cutoff', [4.5, 0, 0]],
      ['like_charge', [0.5, 1.5, -0.25], [0.75, 0.5, 0.25, 2, 2, 4]],
      ['neutral', [1.25, 2, 0.5], [0.75, 0.5, 0, 2, 2, 4]],
      ['no_lj', [-1, 2, 1], [0.75, 0, -0.25, 2, 2, 4]],
      ['all_zero_strength', [1, 2, 1], [0.75, 0, -0.25, 0, 2, 4]],
      ['exception_inside', [1, 0.5, 0.25], undefined, true], ['exception_outside', [5, -1, 2], undefined, true]
    ];
    for (const [name, d, parameters, exception = false] of cases) await compare(name, qvec(d), parameters?.map(q), exception);
    const h = 2 ** -16;
    for (const r of [2, 2.5, 3.5]) for (const delta of [0, h, -h]) await compare(`finite_difference_${r}_${delta}`, qvec([r + delta, 0, 0]));
    for (const r of [4 - h, 4, 5]) await compare(`cutoff_limit_${r}`, qvec([r, 0, 0]));
    for (const d of [[1.5, 0, 0], [3, 1, -0.5], [5, 0, 0]]) await compare(`direct_exception_${d}`, qvec(d), undefined, true);
    for (const exception of [false, true]) {
      for (const sign of [1, -1]) await compare(`exchange_${exception}_${sign}`, qvec([1.25, -2.5, 0.75].map(v => sign * v)), undefined, exception);
      const p = [...defaultParameters]; p[1] = p[2] = '0x80000000000000000000000000000000';
      await compare(`signed_zero_${exception}`, qvec([1.25, -2.5, 0.75]), p, exception);
      await compare(`signed_zero_coordinates_${exception}`, [q(1.5), q(-0), q(0)], undefined, exception);
    }
    const vectors = JSON.parse(fs.readFileSync('reference/nonbonded_vectors.json', 'utf8'));
    for (const kind of ['lj', 'coulomb']) for (const v of vectors[kind + '_vectors']) {
      const d = await Promise.all(v.b.map((x, axis) => math.sub(x, v.a[axis])));
      const params = kind === 'lj' ? [v.sigma, v.epsilon, q(0), q(1), q(2), q(4)]
        : [q(1), q(0), v.chargeProduct, v.prefactor, q(2), q(4)];
      await compare(`direct_reference_${kind}_${v.name}`, d, params, true);
    }
  });

  await check('matches prepared v0.4 fixture normal/exception pairs and low binary128 mantissa perturbations', async () => {
    const f = JSON.parse(fs.readFileSync('reference/periodic_reference.json', 'utf8')).inputs;
    for (let a = 0; a < f.positions.length; ++a) for (let b = a + 1; b < f.positions.length; ++b) {
      const ex = f.exceptions.find(x => x[0] === a && x[1] === b);
      if (ex?.[2] === 1) continue; // exclusions never call either pair kernel
      const d = [...await geometry.displacement(f.positions[a], f.positions[b], f.box)];
      const params = ex ? [ex[3], ex[4], ex[5], f.prefactor, f.switchDistance, f.cutoff] : [
        await math.div(await math.add(f.nonbonded[a][0], f.nonbonded[b][0]), q(2)),
        await math.sqrt(await math.mul(f.nonbonded[a][1], f.nonbonded[b][1])),
        await math.mul(f.nonbonded[a][2], f.nonbonded[b][2]), f.prefactor, f.switchDistance, f.cutoff];
      await compare(`periodic_fixture_${a}_${b}`, d, params, Boolean(ex));
    }
    const addLowBits = (value, delta) => '0x' + (BigInt(q(value)) + BigInt(delta)).toString(16).padStart(32, '0');
    for (let i = 1; i <= 32; ++i) {
      const d = [addLowBits(i % 2 ? 1.25 : 2.5, i), addLowBits(-0.25, i * 17), addLowBits(0.125, i * 43)];
      const p = [addLowBits(0.75, i * 19), addLowBits(0.5, i * 31), addLowBits(-0.25, i * 47),
        addLowBits(2, i * 11), q(2), q(4)];
      await compare(`low_mantissa_bits_${i}`, d, p, i % 3 === 0);
    }
    await compare('one_ulp_below_cutoff', ['0x' + (BigInt(q(4)) - 1n).toString(16), q(0), q(0)]);
    await compare('subnormal_sigma', qvec([1.25, 0.25, 0.125]), ['0x00000000000000000000000000000001', ...defaultParameters.slice(1)]);
  });

  await check('matches finite-domain, overflow and zero-distance revert bytes', async () => {
    async function failure(contract, args) {
      try { await contract.evaluate(...args); assert.fail('Expected revert'); }
      catch (error) { assert.equal(typeof error.data, 'string'); assert(error.data.startsWith('0x') && error.data.length >= 10); return error.data; }
    }
    async function reject(name, d, p, exception) {
      const args = [d, ...p, exception];
      const [a, b] = await Promise.all([failure(reference, args), failure(inline, args)]);
      assert.equal(a, b, name); rejections.push({ name, revertData: a, equal: true });
    }
    const infinity = '0x7fff0000000000000000000000000000', nan = '0x7fff8000000000000000000000000000';
    const largest = '0x7ffeffffffffffffffffffffffffffff';
    for (const ex of [false, true]) {
      for (let parameter = 0; parameter < 6; ++parameter) {
        const p = [...defaultParameters]; p[parameter] = parameter % 2 ? infinity : nan;
        await reject(`nonfinite_parameter_${parameter}_${ex}`, qvec([5, 0, 0]), p, ex);
      }
      for (const p of [[0, 0.5, -0.25, 2, 2, 4], [-1, 0.5, -0.25, 2, 2, 4], [0.75, -1, -0.25, 2, 2, 4],
        [0.75, 0.5, -0.25, -1, 2, 4], [0.75, 0.5, -0.25, 2, 0, 4], [0.75, 0.5, -0.25, 2, 4, 4],
        [0.75, 0.5, -0.25, 2, 5, 4]]) await reject(`invalid_parameters_${p}_${ex}`, qvec([5, 0, 0]), p.map(q), ex);
      await reject(`nonfinite_coordinate_${ex}`, [infinity, q(0), q(0)], defaultParameters, ex);
      await reject(`singular_${ex}`, qvec([0, 0, 0]), [0.75, 0, 0, 0, 2, 4].map(q), ex);
      await reject(`underflow_squared_distance_${ex}`, ['0x00000000000000000000000000000001', q(0), q(0)], defaultParameters, ex);
      await reject(`overflow_squared_distance_${ex}`, [largest, q(0), q(0)], defaultParameters, ex);
      for (const index of [0, 1, 2]) {
        const p = [...defaultParameters]; p[index] = largest;
        await reject(`overflow_arithmetic_${index}_${ex}`, qvec([1, 0.25, 0.125]), p, ex);
      }
    }
  });

  await check('passes the current independent 90-digit scalar-potential differentiation oracle', () => {
    // Execute the current v0.4 oracle itself, preserving its exact equations and tolerances.
    const oracleSource = fs.readFileSync('test/switched-nonbonded.test.mjs', 'utf8');
    const match = oracleSource.match(/const python = String.raw`([\s\S]*?)`;/);
    assert(match);
    oracle = JSON.parse(execFileSync(researchPython,
      ['-c', match[1]], { input: JSON.stringify(equivalence), encoding: 'utf8' }));
    assert.equal(oracle.vectors.length, equivalence.length);
    oracle.sourceFile = 'test/switched-nonbonded.test.mjs'; oracle.sourceSha256 = sha256(oracleSource);
  });

  await check('benchmarks both kernels through the same 0/1/2/4/8 pair transaction meter', async () => {
    for (const [implementation, kernel] of [['external', reference], ['inline', inline]]) {
      const meter = await deploy('PairWorkMeter', [await kernel.getAddress()]);
      for (const insideSwitch of [false, true]) {
        const d = qvec([insideSwitch ? 2.5 : 1, 0.25, 0.125]);
        const out = await kernel.evaluate(d, ...[0.5, 0.125, -0.25, 1, 2, 3].map(q), false);
        const measurements = [];
        for (const count of [0, 1, 2, 4, 8]) {
          const tx = await meter.measure(count, insideSwitch, { gasLimit: 8_000_000 });
          const receipt = await tx.wait(); assert.equal(receipt.status, 1);
          const event = receipt.logs.map(log => { try { return meter.interface.parseLog(log); } catch { return null; } })
            .find(log => log?.name === 'Measured');
          assert(event); assert.equal(event.args.count, BigInt(count));
          let digest = ZeroHash;
          for (let i = 0; i < count; ++i) digest = keccak256(encode.encode(['bytes32', 'bytes16', 'bytes16[3]'], [digest, out[0], [...out[1]]]));
          assert.equal(event.args.digest, digest);
          const callGas = [...event.args.callGas].slice(0, count).map(Number);
          const intrinsic = 21000 + [...Buffer.from(tx.data.slice(2), 'hex')].reduce((sum, b) => sum + (b ? 16 : 4), 0);
          measurements.push({ count, transactionHash: receipt.hash, receiptGas: Number(receipt.gasUsed), intrinsicGas: intrinsic,
            executionGas: Number(receipt.gasUsed) - intrinsic, callGas, outputDigest: digest });
        }
        const warm = measurements.at(-1).callGas.slice(1);
        const fixed = measurements[0].executionGas;
        gasCases.push({ implementation, insideSwitch, warmPairGas: Math.min(...warm), warmPairGasMaximum: Math.max(...warm),
          fixedExecutionGas: fixed, measurements: measurements.map(m => ({ ...m, fixedOverheadSubtracted: m.executionGas - fixed })) });
      }
    }
    for (const insideSwitch of [false, true]) {
      const a = gasCases.find(c => c.implementation === 'external' && c.insideSwitch === insideSwitch);
      const b = gasCases.find(c => c.implementation === 'inline' && c.insideSwitch === insideSwitch);
      assert(b.warmPairGas < a.warmPairGas);
    }
  });

  assert.equal(completedChecks.length, 6, 'Never emit a success report after a failed subtest');
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), status: 'optional_standalone_kernel_local_validation',
    checks: completedChecks,
    mainnetTransactionsSent: 0, productionIntegrated: false, scientificMethodChanged: false, exactEquivalenceProofForAllInputs: false,
    provenance: { compiler: solc.version(), settings, standardInputSha256: sha256(JSON.stringify(input)),
      sourceSha256: Object.fromEntries(sourcesToCompile.map(p => [p, sha256(sources[p].content)])), deployments,
      acknowledgement: 'This product includes software developed by ABDK Consulting.', license: 'contracts/math/vendor/LICENSE.md' },
    comparisonScope: 'Same finite/canonical-zero wrappers and same operation expressions/order; tests establish sampled bitwise equality, not exhaustive proof.',
    equivalence, rejectionEquivalence: rejections, independentOracle: oracle, gasCases,
    improvements: [false, true].map(insideSwitch => {
      const oldGas = gasCases.find(c => c.implementation === 'external' && c.insideSwitch === insideSwitch).warmPairGas;
      const newGas = gasCases.find(c => c.implementation === 'inline' && c.insideSwitch === insideSwitch).warmPairGas;
      return { insideSwitch, oldWarmPairGas: oldGas, inlineWarmPairGas: newGas, reductionPercent: (oldGas - newGas) * 100 / oldGas,
        speedupGasRatio: oldGas / newGas };
    }),
    limitations: ['Local Shanghai gas only; target-chain schedule, L1 fees and capacity remain unverified.',
      'This kernel is not integrated into coordinators; no unused FloatMath dependency is claimed.',
      'Lennard-Jones plus conducting reaction field remains unchanged; no Ewald/PME or alchemical method completion is implied.',
      'Whole-simulation savings are smaller when storage, integration and other forces are included.',
      'A fewfold arithmetic saving does not resolve the full-workload feasibility gap by itself.'] };
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/inline_nonbonded_gas.json', JSON.stringify(report, null, 2) + '\n');
});
