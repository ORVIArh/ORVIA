import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import solc from 'solc';
import ganache from 'ganache';
import { Interface, getAddress, id, keccak256, toBeHex, ZeroHash, ZeroAddress } from 'ethers';

const sha = value => createHash('sha256').update(value).digest('hex');
const referencePath = 'reference/full_model_constraint_reference.py';
const q = value => {
  if (value === 0) return toBeHex(0, 16);
  const b = Buffer.alloc(8); b.writeDoubleBE(value); const bits = b.readBigUInt64BE();
  return toBeHex(((bits >> 63n) << 127n) | ((((bits >> 52n) & 2047n) - 1023n + 16383n) << 112n)
    | ((bits & ((1n << 52n) - 1n)) << 60n), 16);
};
const word = value => toBeHex(BigInt(value), 32);
const vec = values => values.map(q);
function compile() {
  assert.equal(solc.version(), '0.8.26+commit.8a97fa7a.Emscripten.clang');
  const sources = {};
  function add(file) {
    if (sources[file]) return;
    const content = fs.readFileSync(file, 'utf8'); sources[file] = { content };
    for (const match of content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']\s*;/g))
      add(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
  }
  add('test/contracts/FullModelConstraintHarness.sol'); add('contracts/core/BankedInputCatalog.sol');
  const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  assert.deepEqual((output.errors || []).filter(error => error.severity === 'error'), []);
  return { input, artifacts: Object.fromEntries(Object.values(output.contracts).flatMap(contracts => Object.entries(contracts))) };
}

test('authenticated full-model constraint components project coupled frozen frames', { timeout: 1200000 }, async t => {
  const report = { schemaVersion: 1, status: 'incomplete', passed: false, chainId: 31337,
    publicTransactionsSent: 0, scientificParameterAcceptance: false, productionIntegratorIntegrated: false,
    scope: 'Synthetic three-atom SHAKE/RATTLE with real sealed topology, 96 input banks, frozen banked state; no production constrained BAOAB claim.', checks: [] };
  fs.mkdirSync('reports', { recursive: true });
  const save = () => fs.writeFileSync('reports/full_model_constraints_validation.json', JSON.stringify(report, null, 2) + '\n');
  save();
  try {
    report.scriptSha256 = sha(fs.readFileSync(import.meta.filename)); report.referenceSha256 = sha(fs.readFileSync(referencePath));
    const { input, artifacts } = compile(); report.compiler = solc.version();
    report.compilerInputSha256 = sha(JSON.stringify(input));
    report.sources = Object.fromEntries(Object.entries(input.sources).map(([file, entry]) => [file, sha(entry.content)])); save();
    const transport = ganache.provider({ logging: { quiet: true }, chain: { chainId: 31337, hardfork: 'shanghai' },
      wallet: { totalAccounts: 3 }, miner: { blockGasLimit: 30000000 } }); t.after(() => transport.disconnect());
    const rpc = (method, params = []) => transport.request({ method, params });
    const [owner, outsider] = await rpc('eth_accounts');
    const call = async (c, method, args = [], from = owner) => c.iface.decodeFunctionResult(method,
      await rpc('eth_call', [{ from, to: c.address, data: c.iface.encodeFunctionData(method, args) }, 'latest']));
    const send = async (c, method, args = [], from = owner, gas = '0x1c9c380') => {
      const hash = await rpc('eth_sendTransaction', [{ from, to: c.address, data: c.iface.encodeFunctionData(method, args), gas }]);
      const receipt = await rpc('eth_getTransactionReceipt', [hash]); assert.equal(receipt.status, '0x1', `${method} reverted ${hash}`); return receipt;
    };
    const deploy = async (name, args = []) => {
      const a = artifacts[name], iface = new Interface(a.abi);
      const hash = await rpc('eth_sendTransaction', [{ from: owner, data: '0x' + a.evm.bytecode.object + iface.encodeDeploy(args).slice(2), gas: '0x989680' }]);
      const receipt = await rpc('eth_getTransactionReceipt', [hash]); assert.equal(receipt.status, '0x1');
      return { address: getAddress(receipt.contractAddress), iface, receipt };
    };
    const rejects = async (c, method, args = [], from = owner, expected) => assert.rejects(call(c, method, args, from), error => {
      if (expected) {
        const data = typeof error.data === 'string' ? error.data : error.data?.result;
        assert(data?.startsWith(c.iface.getError(expected).selector), `Expected ${expected}, got ${data}`);
      }
      return true;
    });
    const check = async (name, operation) => { await operation(); report.checks.push({ name, passed: true }); save(); };
    const math = await deploy('FloatMath'), geometry = await deploy('OrthorhombicGeometry', [math.address]);
    const inputs = await deploy('BankedInputCatalog', [owner]);
    for (let i = 0; i < 24; i++) await send(inputs, 'createBanks', [4]);
    const topology = await deploy('AlchemicalTopologyCatalog', [owner, inputs.address, math.address, geometry.address]);
    const writer = await deploy('FullModelConstraintHarness'), state = await deploy('BankedWorkingState', [writer.address, 2]);
    await send(state, 'deployBanks', [2]); await send(writer, 'configure', [state.address]);
    const catalog = await deploy('FullModelConstraintCatalog', [owner, topology.address, math.address]);
    const kernel = await deploy('DistanceConstraintKernel', [math.address]);
    const solver = await deploy('FullModelConstraintSolver', [writer.address, math.address, kernel.address, catalog.address]);
    report.deployments = Object.fromEntries(Object.entries({ catalog, solver, kernel }).map(([name, c]) => [name,
      { address: c.address, localGasUsed: String(BigInt(c.receipt.gasUsed)), runtimeBytes: artifacts[c === catalog ? 'FullModelConstraintCatalog' : c === solver ? 'FullModelConstraintSolver' : 'DistanceConstraintKernel'].evm.deployedBytecode.object.length / 2 }]));
    const role = (await call(catalog, 'CONSTRAINT_STREAM_ROLE'))[0];
    const stream = async (name, values, streamRole = id('SYNTHETIC'), seal = true) => {
      const sid = id(name); await send(inputs, 'beginStream', [sid, streamRole, values.length]);
      if (values.length) await send(inputs, 'appendWords', [sid, values.map(word)]);
      if (seal) await send(inputs, 'sealStream', [sid]); return sid;
    };
    const anchor = [[0, 0, 0], [0.6, 0.8, 0], [0, 0, 1]].map(vec);
    // Exact dyadic 3-D triangle so the reference geometry is independent of binary64 sqrt.
    anchor[1] = vec([0.75, 0, 0]); anchor[2] = vec([0, 0.75, 1]);
    const trial = [[0.01, -0.02, 0.03], [0.78, 0.01, -0.01], [-0.01, 0.78, 0.98]].map(vec);
    const masses = [16, 1, 2].map(q), velocities = [[0.1, 0.2, -0.3], [-0.3, 0.4, 0.2], [0.5, -0.1, 0.4]].map(vec);
    const positionsStream = await stream('positions', anchor.flat());
    const particlesStream = await stream('particles', masses.flatMap(m => [m, q(0), q(0), q(0)]));
    const nonbondedStream = await stream('nonbonded', masses.flatMap(() => [q(1), q(0), q(0)]));
    const endpoint = [particlesStream, nonbondedStream, ZeroHash, ZeroHash, ZeroHash, ZeroHash];
    const topologyId = id('topology'), d = [id('model-policy'), id('dummy-policy'), positionsStream, endpoint, endpoint,
      3, 0, 0, 0, 0, vec([10, 10, 10]), q(2), q(3), q(0), q(.25), 1, q(.5)];
    await send(topology, 'create', [topologyId, d, [q(0), q(1)]]); await send(topology, 'advance', [topologyId, 8]);
    const distance12 = (await call(math, 'sqrt', [q(2.125)]))[0];
    const constraints = [[0, 1, q(.75)], [0, 2, q(1.25)], [1, 2, distance12]];
    const constraintStream = await stream('constraints', constraints.flat(), role);
    const setId = id('set'), policy = id('explicit-constraint-selection-policy');
    await send(catalog, 'createSet', [setId, topologyId, constraintStream, 3, policy]);
    await rejects(catalog, 'assertSet', [setId]);
    await send(catalog, 'advance', [setId, 1], outsider); await send(catalog, 'advance', [setId, 8], outsider);
    const frame = async (name, positions, velocity = velocities) => {
      const source = id(name + '-source'), snapshot = id(name + '-snapshot');
      const words = positions.flatMap((p, i) => [...p, ...velocity[i], q(0), q(0), q(0)]).concat(q(0));
      await send(writer, 'frame', [source, snapshot, words.map(word)]); return { source, snapshot, words };
    };
    const oldFrame = await frame('anchor', anchor), trialFrame = await frame('trial', trial);
    const params = (changes = {}) => ({ setId, mode: 0, sourcePage: state.address, anchorSnapshot: oldFrame.snapshot,
      trialSnapshot: trialFrame.snapshot, sourceProtocolHash: id('synthetic-projection-protocol'), positionTolerance: q(1e-12),
      velocityTolerance: q(1e-12), maxSweeps: 256, ...changes });
    const register = async (name, p = params()) => { const pid = id(name); await send(writer, 'register', [solver.address, pid, p]); return pid; };
    const info = async pid => (await call(solver, 'problemInfo', [pid]))[0];
    const complete = async (pid, work) => {
      let count = 0, gas = 0n, s;
      while ((s = await info(pid)).status < 3n) {
        assert(count++ < 600, 'bounded test progress'); const receipt = await send(solver, 'advance', [pid, work], outsider); gas += BigInt(receipt.gasUsed);
      }
      return { info: s, transactions: count, gas: String(gas) };
    };
    const solution = async pid => Promise.all(masses.map(async (_, atom) => [...(await call(solver, 'solutionAt', [pid, atom]))[0]]));
    const observations = [];
    report.observations = observations;
    await check('sealed_role_exact_coverage_canonical_unique_pairs_and_catalog_auth', async () => {
      await rejects(catalog, 'createSet', [id('outsider-set'), topologyId, constraintStream, 3, policy], outsider, 'Unauthorized');
      await rejects(catalog, 'createSet', [setId, topologyId, constraintStream, 3, policy]);
      await rejects(catalog, 'createSet', [id('wrong-count'), topologyId, constraintStream, 2, policy]);
      await rejects(catalog, 'createSet', [id('empty-policy'), topologyId, constraintStream, 3, ZeroHash]);
      await rejects(catalog, 'advance', [setId, 1]); await rejects(catalog, 'constraintAt', [setId, 3]);
      const badRole = await stream('wrong-role', constraints.flat());
      await rejects(catalog, 'createSet', [id('wrong-role-set'), topologyId, badRole, 3, policy]);
      const unsealed = await stream('unsealed', constraints.flat(), role, false);
      await rejects(catalog, 'createSet', [id('unsealed-set'), topologyId, unsealed, 3, policy]);
      for (const [name, rows] of [ ['duplicate', [constraints[0], constraints[0]]], ['unsorted', [constraints[1], constraints[0]]],
        ['bad-index', [[0, 3, q(1)]]], ['reverse', [[1, 0, q(1)]]], ['zero-target', [[0, 1, q(0)]]],
        ['nonfinite', [[0, 1, '0x7fff0000000000000000000000000000']]], ['high-bits', [[0, 1, 1n << 200n]]] ]) {
        const sid = await stream(name, rows.flat(), role), cid = id(name + '-set');
        await send(catalog, 'createSet', [cid, topologyId, sid, rows.length, policy]);
        await rejects(catalog, 'advance', [cid, 8]); assert.equal((await call(catalog, 'info', [cid]))[0].cursor, 0n);
      }
      assert.equal((await call(catalog, 'info', [setId]))[0].count, 3n);
      assert.equal((await call(inputs, 'bankCount'))[0], 96n);
    });
    await check('writer_only_registration_frozen_writer_state_protocol_and_tolerance_binding', async () => {
      await rejects(solver, 'registerProblem', [id('eoa'), params()], owner, 'Unauthorized');
      await rejects(solver, 'processRecord', [id('eoa'), constraints[0]], owner, 'Unauthorized');
      for (const changes of [{ sourceProtocolHash: ZeroHash }, { positionTolerance: q(0) }, { positionTolerance: q(1) },
        { velocityTolerance: q(-1) }, { positionTolerance: '0x7fff0000000000000000000000000000' }, { maxSweeps: 0 },
        { maxSweeps: 4097 }, { sourcePage: ZeroAddress }, { anchorSnapshot: oldFrame.source },
        { trialSnapshot: trialFrame.source }, { mode: 1 }, { setId: id('missing') }])
        await rejects(writer, 'register', [solver.address, id('bad-register'), params(changes)]);
      await rejects(solver, 'advance', [id('missing'), 8]);
    });
    let positionOutput;
    await check('coupled_position_projection_full_final_sweep_and_partition_invariance', async () => {
      const before = await rpc('evm_snapshot');
      // The first projection sees a mutated live namespace, the replay does not.
      // Both must read the same retained trial snapshot and converge identically.
      await send(writer, 'write', [trialFrame.source, 0, [word(q(999))]]);
      const pid = await register('position'); await rejects(solver, 'solutionAt', [pid, 0]);
      await rejects(solver, 'advance', [pid, 0]); await rejects(solver, 'advance', [pid, 9]);
      await send(solver, 'advance', [pid, 3], outsider); assert.equal((await info(pid)).status, 2n);
      await rejects(solver, 'solutionAt', [pid, 0]);
      await send(solver, 'advance', [pid, 3], outsider);
      assert.equal((await info(pid)).status, 1n, 'coupled checking detects residual introduced by later corrections');
      const first = await complete(pid, 8); assert.equal(first.info.status, 3n); assert(first.info.sweeps > 1n);
      positionOutput = await solution(pid); const firstCommitment = first.info.outputCommitment;
      const firstCorrection = [...(await call(solver, 'correctionAt', [pid, 1]))[0]];
      await rejects(solver, 'advance', [pid, 1]); await rejects(solver, 'solutionAt', [pid, 3]);
      assert.equal((await call(solver, 'assertSolution', [pid]))[0], firstCommitment);
      await rpc('evm_revert', [before]);
      const replay = await register('position'); const second = await complete(replay, 1);
      assert.deepEqual(await solution(replay), positionOutput); assert.equal(second.info.outputCommitment, firstCommitment);
      assert.deepEqual([...(await call(solver, 'correctionAt', [replay, 1]))[0]], firstCorrection);
      observations.push({ name: 'coupled-position', mode: 'position', anchor, trial, masses, constraints,
        solution: positionOutput, tolerance: params().positionTolerance, maxSweeps: 256, sweeps: Number(second.info.sweeps), maximumResidual: second.info.maximumResidual });
      report.position = { sweeps: Number(second.info.sweeps), work1Transactions: second.transactions,
        work8RemainingTransactions: first.transactions, maximumResidual: second.info.maximumResidual, work1GasUsed: second.gas };
    });
    await check('coupled_velocity_projection_conserves_mass_weighted_momentum', async () => {
      const corrected = await frame('corrected-positions', positionOutput);
      const pid = await register('velocity', params({ mode: 1, anchorSnapshot: corrected.snapshot, trialSnapshot: corrected.snapshot }));
      const result = await complete(pid, 8); assert.equal(result.info.status, 3n);
      observations.push({ name: 'coupled-velocity', mode: 'velocity', anchor: positionOutput, trial: velocities, masses, constraints,
        solution: await solution(pid), tolerance: params().velocityTolerance, maxSweeps: 256,
        sweeps: Number(result.info.sweeps), maximumResidual: result.info.maximumResidual });
      report.velocity = { sweeps: Number(result.info.sweeps), transactions: result.transactions, localGasUsed: result.gas };
    });
    await check('iteration_cap_and_invalid_geometry_are_terminal_without_solution', async () => {
      const capped = await register('capped', params({ maxSweeps: 1 }));
      assert.equal((await complete(capped, 8)).info.status, 4n);
      await rejects(solver, 'solutionAt', [capped, 0]); await rejects(solver, 'advance', [capped, 1]);
      for (const x of [-.8, -.75]) {
        const flipped = await frame('flipped-' + x, [[0, 0, 0], [x, 0, 0], [0, .75, 1]].map(vec));
        const bad = await register('flipped-' + x, params({ trialSnapshot: flipped.snapshot }));
        const failed = await complete(bad, 8); assert.equal(failed.info.status, 4n);
        assert.equal(failed.info.failure, kernel.iface.getError('NoLocalSolution').selector);
      }
      for (const x of [5, 5.00001]) {
        const half = await frame('half-' + x, [[0, 0, 0], [x, 0, 0], [0, .75, 1]].map(vec));
        const pid = await register('half-' + x, params({ trialSnapshot: half.snapshot }));
        assert.equal((await complete(pid, 8)).info.failure, solver.iface.getError('InvalidGeometry').selector);
      }
      const invalidAnchor = await register('bad-anchor', params({ anchorSnapshot: trialFrame.snapshot }));
      assert.equal((await complete(invalidAnchor, 8)).info.failure, solver.iface.getError('InvalidGeometry').selector);
    });
    await check('frozen_source_is_unchanged_by_live_mutation_and_dependency_tampering_reverts', async () => {
      await send(writer, 'write', [trialFrame.source, 0, [word(q(999))]]);
      const pid = await register('frozen-replay'); await send(solver, 'advance', [pid, 1]);
      const prior = await info(pid);
      const [stateBank] = await call(state, 'bankInfo', [0]), [inputBank] = await call(inputs, 'bankInfo', [0]);
      for (const address of [math.address, kernel.address, catalog.address, topology.address, state.address, stateBank, inputBank, writer.address]) {
        const code = await rpc('eth_getCode', [address, 'latest']); await rpc('evm_setAccountCode', [address, '0x00']);
        await rejects(solver, 'advance', [pid, 1]);
        assert.deepEqual([...(await info(pid))], [...prior], 'dependency failure cannot become terminal numerical failure');
        await rpc('evm_setAccountCode', [address, code]);
      }
      await send(solver, 'advance', [pid, 1]);
      assert.equal((await info(pid)).cursor, 2n, 'restoring dependencies resumes the same pending record');
      // A deliberately underfunded unit must roll back, not record Failed.
      const limited = await register('out-of-gas');
      const hash = await rpc('eth_sendTransaction', [{ from: outsider, to: solver.address,
        data: solver.iface.encodeFunctionData('advance', [limited, 8]), gas: '0x186a0' }]);
      assert.equal((await rpc('eth_getTransactionReceipt', [hash])).status, '0x0');
      assert.equal((await info(limited)).status, 1n); assert.equal((await info(limited)).cursor, 0n);
    });
    await check('independent_110_digit_projection_residuals_and_mass_conservation', async () => {
      const python = process.env.ORVIA_RESEARCH_PYTHON || process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3';
      report.independentReference = JSON.parse(execFileSync(python, [referencePath], { input: JSON.stringify(observations), encoding: 'utf8' }));
    });
    await check('132936_atom_index_capacity_with_explicitly_synthetic_metadata_and_sparse_state', async () => {
      const metadata = await deploy('FullModelConstraintMetadataHarness', [math.address, inputs.address]);
      const largeCatalog = await deploy('FullModelConstraintCatalog', [owner, metadata.address, math.address]);
      const largeSolver = await deploy('FullModelConstraintSolver', [writer.address, math.address, kernel.address, largeCatalog.address]);
      const sid = await stream('large-indices', [132934, 132935, q(1)], role), cid = id('large-set');
      await send(largeCatalog, 'createSet', [cid, id('synthetic-large-topology'), sid, 1, policy]);
      await send(largeCatalog, 'advance', [cid, 1]);
      const sparse = async (name, length) => {
        const source = id(name + '-source'), snapshot = id(name + '-snapshot');
        const words = [0, 0, 0, 0, 0, 0, 0, 0, 0, length, 0, 0, 0, 0, 0, 0, 0, 0].map(q).map(word);
        await send(writer, 'sparseFrame', [source, snapshot, 132936 * 9 + 1, 132934, words]); return snapshot;
      };
      const old = await sparse('sparse-old', 1), trial = await sparse('sparse-trial', 1.125), pid = id('large-problem');
      await send(writer, 'register', [largeSolver.address, pid, params({ setId: cid, anchorSnapshot: old, trialSnapshot: trial })]);
      await send(largeSolver, 'advance', [pid, 2]);
      assert.equal((await call(largeSolver, 'problemInfo', [pid]))[0].status, 3n);
      assert.deepEqual([...(await call(largeSolver, 'solutionAt', [pid, 132934]))[0]], vec([.0625, 0, 0]));
      assert.deepEqual([...(await call(largeSolver, 'solutionAt', [pid, 132935]))[0]], vec([1.0625, 0, 0]));
      assert.deepEqual([...(await call(largeSolver, 'solutionAt', [pid, 100000]))[0]], vec([0, 0, 0]));
      assert.deepEqual([...(await call(largeSolver, 'correctionAt', [pid, 100000]))[0]], vec([0, 0, 0]));
      report.largeIndexCheck = { declaredAtoms: 132936, actuallyStoredAndEvaluatedAtoms: 2,
        topologyMetadata: 'synthetic harness; not a validated full molecular topology', stateCapacityWords: 132936 * 9 + 1,
        constraintAtoms: [132934, 132935], unchangedUnconstrainedAtom: 100000 };
    });
    await check('no_child_contracts_from_catalog_solver_or_projection_work', async () => {
      assert.equal(BigInt(await rpc('eth_getTransactionCount', [catalog.address, 'latest'])), 1n);
      assert.equal(BigInt(await rpc('eth_getTransactionCount', [solver.address, 'latest'])), 1n);
      assert.equal((await call(inputs, 'bankCount'))[0], 96n); assert.equal((await call(state, 'deployedBankCount'))[0], 2n);
      for (const [file, hash] of Object.entries(report.sources)) assert.equal(sha(fs.readFileSync(file)), hash, `source changed: ${file}`);
      assert.equal(sha(fs.readFileSync(import.meta.filename)), report.scriptSha256);
      assert.equal(sha(fs.readFileSync(referencePath)), report.referenceSha256);
    });
    report.status = 'passed'; report.passed = true; report.completedAt = new Date().toISOString(); save();
  } catch (error) { report.status = 'failed'; report.passed = false; report.error = error.message; save(); throw error; }
});
