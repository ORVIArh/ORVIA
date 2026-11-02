import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import solc from 'solc';
import ganache from 'ganache';
import { AbiCoder, BrowserProvider, ContractFactory, ZeroHash, keccak256 } from 'ethers';

const SOURCES = [
  'contracts/math/vendor/ABDKMathQuad.sol', 'contracts/math/FloatMath.sol',
  'contracts/kernels/LennardJonesKernel.sol', 'contracts/kernels/CoulombPairKernel.sol',
  'contracts/kernels/SwitchedNonbondedKernel.sol', 'test/contracts/PairWorkMeter.sol'
];
const SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } } };
const sha256 = x => crypto.createHash('sha256').update(x).digest('hex');
const encode = AbiCoder.defaultAbiCoder();
const q = { one: '0x3fff0000000000000000000000000000', half: '0x3ffe0000000000000000000000000000',
  quarter: '0x3ffd0000000000000000000000000000', eighth: '0x3ffc0000000000000000000000000000',
  negativeQuarter: '0xbffd0000000000000000000000000000', two: '0x40000000000000000000000000000000',
  twoAndHalf: '0x40004000000000000000000000000000', three: '0x40008000000000000000000000000000' };
const serial = x => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';

export function projectWorkload({ atoms, neighbors, steps, pairGas, replicas = 1, lambdaStates = 1, legs = 1 }) {
  for (const [name, v] of Object.entries({ atoms, neighbors, steps, pairGas, replicas, lambdaStates, legs })) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`Invalid positive integer ${name}`);
  }
  if (neighbors >= atoms || (BigInt(atoms) * BigInt(neighbors)) % 2n) throw new Error('Invalid undirected mean-neighbor count');
  const pairsPerStep = BigInt(atoms) * BigInt(neighbors) / 2n;
  const simulations = BigInt(replicas) * BigInt(lambdaStates) * BigInt(legs);
  const pairEvaluations = pairsPerStep * BigInt(steps) * simulations;
  const gas = pairEvaluations * BigInt(pairGas);
  return { atoms, meanWithinCutoffNeighbors: neighbors, steps, replicas, lambdaStates, legs,
    pairsPerStep: pairsPerStep.toString(), simulationCount: simulations.toString(),
    pairEvaluations: pairEvaluations.toString(), pairGasProxy: pairGas, partialPairGas: gas.toString(),
    hypotheticalDedicatedThroughput: [100_000_000, 1_000_000_000].map(rate => ({ gasPerSecond: rate,
      seconds: Number(gas) / rate, days: Number(gas) / rate / 86400,
      status: 'Hypothetical entire sustained allocation; not a Robinhood capacity measurement or forecast.' })) };
}

export async function benchmarkWorkload(root = process.cwd()) {
  const sources = Object.fromEntries(SOURCES.map(p => [p, { content: fs.readFileSync(path.join(root, p), 'utf8') }]));
  const input = { language: 'Solidity', sources, settings: SETTINGS };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  const artifacts = Object.fromEntries(Object.entries(out.contracts).flatMap(([source, contracts]) =>
    Object.entries(contracts).map(([name, c]) => [name, { ...c, source }])));
  const transport = ganache.provider({ logging: { quiet: true },
    chain: { chainId: 31337, hardfork: 'shanghai' },
    wallet: { deterministic: true, totalAccounts: 1 }, miner: { blockGasLimit: 30_000_000 } });
  const provider = new BrowserProvider(transport); provider.pollingInterval = 10;
  try {
    assert.equal((await provider.getNetwork()).chainId, 31337n);
    const signer = await provider.getSigner(0), deployed = [];
    async function deploy(name, args = []) {
      const a = artifacts[name];
      const contract = await new ContractFactory(a.abi, '0x' + a.evm.bytecode.object, signer).deploy(...args);
      const receipt = await contract.deploymentTransaction().wait();
      assert.equal(receipt.status, 1);
      const address = await contract.getAddress(), runtime = await provider.getCode(address);
      deployed.push({ name, source: a.source, address, runtimeKeccak256: keccak256(runtime),
        runtimeBytes: (runtime.length - 2) / 2, deploymentGas: receipt.gasUsed.toString() });
      return contract;
    }
    const math = await deploy('FloatMath'), ma = await math.getAddress();
    const lj = await deploy('LennardJonesKernel', [ma]);
    const coulomb = await deploy('CoulombPairKernel', [ma]);
    const kernel = await deploy('SwitchedNonbondedKernel', [ma, await lj.getAddress(), await coulomb.getAddress()]);
    const meter = await deploy('PairWorkMeter', [await kernel.getAddress()]);
    const cases = [];
    for (const insideSwitch of [false, true]) {
      const displacement = [insideSwitch ? q.twoAndHalf : q.one, q.quarter, q.eighth];
      const args = [displacement, q.half, q.eighth, q.negativeQuarter, q.one, q.two, q.three, false];
      const output = await kernel.evaluate(...args);
      assert.notEqual(output[0], '0x00000000000000000000000000000000');
      const transactions = [];
      for (const count of [0, 1, 2, 4, 8]) {
        const request = await meter.measure.populateTransaction(count, insideSwitch);
        const tx = await signer.sendTransaction({ ...request, gasLimit: 29_000_000 });
        const receipt = await tx.wait();
        assert.equal(receipt.status, 1);
        const event = receipt.logs.map(log => { try { return meter.interface.parseLog(log); } catch { return null; } })
          .find(log => log?.name === 'Measured');
        assert(event); assert.equal(event.args.count, BigInt(count)); assert.equal(event.args.insideSwitch, insideSwitch);
        let digest = ZeroHash;
        for (let i = 0; i < count; ++i) digest = keccak256(encode.encode(
          ['bytes32', 'bytes16', 'bytes16[3]'], [digest, output[0], [...output[1]]]));
        assert.equal(event.args.digest, digest);
        const callGas = [...event.args.callGas].slice(0, count).map(Number);
        assert(callGas.every(g => g > 0));
        const intrinsicGas = 21_000 + [...Buffer.from(request.data.slice(2), 'hex')].reduce((sum, b) => sum + (b ? 16 : 4), 0);
        transactions.push({ count, transactionHash: receipt.hash, transactionGas: Number(receipt.gasUsed), intrinsicGas,
          executionGas: Number(receipt.gasUsed) - intrinsicGas, callGas,
          measuredCallGasSum: callGas.reduce((a, b) => a + b, 0), outputDigest: digest, outputsVerified: true });
      }
      const baseline = transactions[0];
      assert.equal(baseline.measuredCallGasSum, 0);
      for (const tx of transactions) tx.fixedOverheadSubtractedExecutionGas = tx.executionGas - baseline.executionGas;
      const slopes = transactions.slice(2).map((current, i) => {
        const previous = transactions[i + 1];
        return { fromPairs: previous.count, toPairs: current.count,
          marginalTransactionGasPerPair: (current.executionGas - previous.executionGas) / (current.count - previous.count) };
      });
      const warmCalls = transactions.at(-1).callGas.slice(1);
      assert(transactions.at(-1).callGas[0] > Math.max(...warmCalls));
      assert(transactions.slice(1).every(t => t.fixedOverheadSubtractedExecutionGas >= t.measuredCallGasSum));
      assert(slopes.every(s => s.marginalTransactionGasPerPair > Math.min(...warmCalls)));
      cases.push({ name: insideSwitch ? 'inside_switch_charged' : 'below_switch_charged', insideSwitch,
        displacementDecimal: insideSwitch ? [2.5, 0.25, 0.125] : [1, 0.25, 0.125],
        parametersDecimal: { sigma: 0.5, epsilon: 0.125, chargeProduct: -0.25, prefactor: 1, switchDistance: 2, cutoff: 3, exception: false },
        binary128Arguments: args, energy: output[0], forceOnA: [...output[1]], transactions,
        zeroPairFixedExecutionGas: baseline.executionGas, marginalSlopes: slopes,
        firstCallGasInEightPairBatch: transactions.at(-1).callGas[0],
        warmCallGasRange: { minimum: Math.min(...warmCalls), maximum: Math.max(...warmCalls) },
        favorableWarmPairGasProxy: Math.min(...warmCalls) });
    }
    assert(cases[1].favorableWarmPairGasProxy > cases[0].favorableWarmPairGasProxy);
    const capFiles = ['contracts/core/NeighborDynamicsCoordinator.sol', 'contracts/core/LangevinDynamicsCoordinator.sol'];
    const currentDevelopmentCaps = capFiles.map(file => {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      const read = name => {
        const match = source.match(new RegExp(`uint256 public constant ${name} = ([0-9_]+);`));
        if (!match) throw new Error(`Cannot establish ${name} in ${file}`);
        return Number(match[1].replaceAll('_', ''));
      };
      return { file, sourceSha256: sha256(source), maxAtoms: read('MAX_ATOMS'), maxSteps: read('MAX_STEPS'), maxWork: read('MAX_WORK') };
    });
    const scenarios = cases.flatMap(c => [1000, 10000, 100000].flatMap(atoms => [100, 500].flatMap(neighbors =>
      [1000, 1000000].map(steps => ({ kernelCase: c.name, ...projectWorkload({ atoms, neighbors, steps,
        pairGas: c.favorableWarmPairGasProxy }),
        satisfiesOnlyDevelopmentCountCaps: currentDevelopmentCaps.every(cap => atoms <= cap.maxAtoms && steps <= cap.maxSteps) })))));
    const included = 'Current charged, nonzero LJ plus conducting reaction-field kernel: validation, distance, force/energy arithmetic, external numerical calls, and call/return marshalling inside the measured interval.';
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), status: 'local_partial_workload_measurement_only',
      mainnetReadinessDemonstrated: false, productionMyosinModelEstimated: false, mainnetTransactionsSent: 0,
      chain: { localChainId: 31337, localEngine: 'ganache 7.9.2', hardfork: 'shanghai', localBlockGasLimit: 30000000,
        targetChainId: 4663, targetGasScheduleVerified: false, targetSustainedGasPerSecond: null,
        targetRpcLastEvidence: 'reports/mainnet_preflight.json; HTTP 403 observed, no capacity inferred.' },
      provenance: { compiler: solc.version(), settings: SETTINGS, standardInputSha256: sha256(JSON.stringify(input)),
        sourceSha256: Object.fromEntries(SOURCES.map(p => [p, sha256(sources[p].content)])), deployed },
      method: { counts: [0, 1, 2, 4, 8], transactionGas: 'Receipt gasUsed, including local EVM transaction intrinsic gas.',
        intrinsicGas: '21000 + 4 per zero calldata byte + 16 per nonzero calldata byte; Shanghai, no access list.',
        fixedOverheadSubtraction: 'Subtract zero-pair executionGas after separately removing each transaction intrinsic gas. Positive-count slopes cancel baseline and first-call cold overhead.',
        callGas: 'gasleft immediately before kernel.evaluate minus gasleft after ABI return decoding. Includes call/return marshalling and a small meter-instruction overhead; excludes checksum, event, loop control and transaction intrinsic gas.',
        warmProxy: 'Minimum of calls 2..8 in an eight-pair transaction. Identical repeated inputs favor warm account access; not a varied-trajectory average or worst case.',
        repeatedRunsRequiredForGasNoise: false, deterministicGas: true, included,
        boundMeaning: 'Conditional partial-work lower-bound accounting proxy for workloads using these measured nonzero charged paths. Not a mathematical lower bound on arbitrary inputs, another electrostatics method, another implementation, or Robinhood execution.' },
      exclusions: ['bonded forces and constraints', 'periodic nearest-image geometry and pair-parameter mixing',
        'neighbor-list construction, rebuilds, exclusions and out-of-cutoff skin candidates', 'Ewald/PME real-space replacement and reciprocal-space work',
        'coordinate/velocity/force storage and dataset reads', 'coordinator integrity assertions, work dispatch and transaction overhead',
        'integration, thermostat and random generation', 'all-state alchemical sample energies, MBAR, diagnostics and uncertainty',
        'input preparation/uploads, deployment, equilibration and restart work', 'chain L1/data fees, contention and scheduling'],
      formulas: { pairsPerStep: 'N*z/2 for average symmetric within-cutoff neighbor count z, counting each unordered pair once',
        timeSteps: 'ceil(T/dt) for requested duration T and integration step dt in the same units; the tables specify steps directly',
        gasSingleSimulation: 'pairs_per_step * steps * favorable_warm_pair_gas_proxy',
        gasCampaign: 'sum over systems/legs/lambda windows/repeats of each simulation pair gas; homogeneous simplification multiplies by legs*lambda_states*replicas',
        timeHypothesis: 'partial_pair_gas / explicitly hypothetical sustained dedicated gas_per_second' },
      currentDevelopmentCaps, benchmarkCases: cases, scenarios,
      checks: { actualTransactionsPassed: 10, outputDigestsVerified: 10, zeroPairBaselines: 2,
        positiveMeasuredCalls: true, firstCallCostsMoreThanWarmCalls: true,
        receiptWorkAtLeastMeasuredCallGas: true, receiptSlopesAtLeastWarmCallGas: true,
        insideSwitchCostsMoreThanBelowSwitch: true, formulaIntegerArithmetic: 'BigInt for counts and total gas' },
      sources: ['https://eips.ethereum.org/EIPS/eip-2929', 'https://eips.ethereum.org/EIPS/eip-2028'],
      limitations: ['These scenarios are parameter choices, not prepared myosin atom counts, neighbor counts, accepted sampling lengths or production resource estimates.',
        'Scenarios above current atom/step caps cannot execute through current coordinators; lifting a constant would not establish scalability or scientific validity.',
        'One pair-force evaluation per pair per integration step is assumed; initialization and extra force evaluations only increase this accounting.',
        'Both branches are shown separately; actual branch mixture and zero-strength early exits change cost.',
        'The measured conducting reaction-field model is not Ewald/PME and cannot stand in for an unimplemented full RBFE force path.',
        'More contracts or transactions distribute finite work; they do not remove total gas, sequential timestep dependence or chain capacity constraints.',
        'A finite compute schedule may be resumable, but this benchmark establishes neither an acceptable scientific runtime nor unlimited on-chain capacity.'] };
  } finally { await transport.disconnect(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/workload.mjs')) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/workload.mjs (local only; no RPC/key options)');
  const report = await benchmarkWorkload();
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/workload_feasibility.json', serial(report));
  console.log(serial({ status: report.status, mainnetTransactionsSent: 0,
    cases: report.benchmarkCases.map(c => ({ name: c.name, warmPairGas: c.favorableWarmPairGasProxy, slopes: c.marginalSlopes })),
    scenarios: report.scenarios.length, report: 'reports/workload_feasibility.json' }));
}
