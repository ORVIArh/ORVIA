import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import ganache from "ganache";
import {
  AbiCoder,
  BrowserProvider,
  Contract,
  encodeBytes32String,
  id,
  keccak256,
  toBeHex,
  zeroPadValue,
} from "ethers";
import {
  artifacts,
  deploy,
  transact,
  quadFromNumber as q,
} from "./helpers.mjs";

const reference = JSON.parse(
    fs.readFileSync("reference/ewald_dynamics_reference.json", "utf8"),
  ),
  input = reference.input;
const word = (x) =>
    typeof x === "number" ? toBeHex(x, 32) : zeroPadValue(x, 32),
  gasLimit = 28_000_000;
const plain = (x) => (Array.isArray(x) ? x.map(plain) : x);
function verify(actual, expected, label) {
  const script = String.raw`
import json,sys
from decimal import Decimal as D,localcontext
p=json.load(sys.stdin)
def decode(h):
 b=int(h,16);e=(b>>112)&32767;f=b&((1<<112)-1)
 if e==32767:raise ValueError('nonfinite output')
 return (-1 if b>>127 else 1)*((D(1)+D(f)/D(2)**112)*D(2)**(e-16383) if e else D(f)*D(2)**(-16382-112))
with localcontext() as c:
 c.prec=130;rows=[]
 for got,want in zip(p['actual'],p['expected'],strict=True):
  assert got['step']==want['step'];maximum=D(0);count=0
  for field in ['positions','velocities','forces']:
   for av,ev in zip(got[field],want[field],strict=True):
    for h,s in zip(av,ev,strict=True):
     y=D(s);err=abs(decode(h)-y)
     assert err<=D('1e-27')+D('1e-26')*abs(y),(field,got['step'],str(err))
     maximum=max(maximum,err);count+=1
  y=D(want['energy']);err=abs(decode(got['energy'])-y)
  assert err<=D('1e-27')+D('1e-26')*abs(y),('energy',got['step'],str(err))
  rows.append({'step':got['step'],'values_checked':count+1,'maximum_absolute_error':str(max(maximum,err))})
 print(json.dumps({'label':p['label'],'absolute_tolerance':'1e-27','relative_tolerance':'1e-26','checkpoints':rows,'passed':True}))
`;
  return JSON.parse(
    execFileSync(
      process.env.ORVIA_RESEARCH_PYTHON ||
        process.env.CODEX_PRIMARY_RUNTIME_PYTHON ||
        "python3",
      ["-c", script],
      { input: JSON.stringify({ actual, expected, label }), encoding: "utf8" },
    ),
  );
}

test("Ewald NVE integrates complete on-chain electrostatic forces with bonded and LJ terms", async (t) => {
  // Explicit local relaxation: this does not prove the target chain accepts a runtime size.
  const transport = ganache.provider({
    logging: { quiet: true },
    chain: {
      chainId: 31337,
      hardfork: "shanghai",
      allowUnlimitedContractSize: true,
    },
    wallet: { totalAccounts: 3 },
    miner: { blockGasLimit: 30000000 },
  });
  t.after(() => transport.disconnect());
  const provider = new BrowserProvider(transport);
  provider.pollingInterval = 10;
  const owner = await provider.getSigner(0),
    contributor = await provider.getSigner(1),
    ownerAddress = await owner.getAddress();
  const math = await deploy("FloatMath", owner),
    mathAddress = math.target;
  const elementary = await deploy("ElementaryMath", owner, [mathAddress]),
    elementaryAddress = elementary.target;
  const scalar = await deploy("ScalarMath", owner, [mathAddress]);
  const registry = await deploy("ExperimentRegistry", owner, [ownerAddress]);
  const base = await deploy("DatasetCatalog", owner, [ownerAddress]);
  const dynamics = await deploy("DynamicsDataset", owner, [
    ownerAddress,
    base.target,
  ]);
  const dataset = await deploy("PeriodicDataset", owner, [
    ownerAddress,
    dynamics.target,
  ]);
  const integrator = await deploy("VelocityVerletKernel", owner, [mathAddress]);
  const bond = await deploy("HarmonicBondKernel", owner, [mathAddress]);
  const angle = await deploy("HarmonicAngleKernel", owner, [
    mathAddress,
    elementaryAddress,
  ]);
  const torsion = await deploy("PeriodicTorsionKernel", owner, [
    mathAddress,
    elementaryAddress,
  ]);
  const lj = await deploy("LennardJonesKernel", owner, [mathAddress]);
  const coulomb = await deploy("CoulombPairKernel", owner, [mathAddress]);
  const geometry = await deploy("OrthorhombicGeometry", owner, [mathAddress]);
  const nonbonded = await deploy("SwitchedNonbondedKernel", owner, [
    mathAddress,
    lj.target,
    coulomb.target,
  ]);
  const realSpace = await deploy("EwaldRealSpaceKernel", owner, [
    mathAddress,
    scalar.target,
  ]);
  const reciprocal = await deploy("EwaldReciprocalKernel", owner, [
    mathAddress,
    scalar.target,
    elementaryAddress,
  ]);
  const corrections = await deploy("EwaldCorrections", owner, [
    mathAddress,
    scalar.target,
  ]);
  const moduleContracts = {
    registry,
    dataset,
    math,
    integrator,
    bond,
    angle,
    torsion,
    lj,
    coulomb,
    elementary,
    geometry,
    nonbonded,
  };
  const modules = Object.fromEntries(
    Object.entries(moduleContracts).map(([k, c]) => [k, c.target]),
  );
  const engine = await deploy("EwaldDynamicsCoordinator", owner, [
    ownerAddress,
    modules,
  ]);
  const page = await deploy("WorkingStatePage", owner, [engine.target]);
  await transact(engine.bindWorkingPage(page.target));
  const em = {
    registry: registry.target,
    dataset: dataset.target,
    math: mathAddress,
    scalar: scalar.target,
    elementary: elementaryAddress,
    geometry: geometry.target,
    realSpace: realSpace.target,
    reciprocal: reciprocal.target,
    corrections: corrections.target,
  };
  const evaluator = await deploy("EwaldForceEvaluator", owner, [
    engine.target,
    em,
  ]);
  await transact(engine.bindEwald(evaluator.target));
  const snapshot = new Contract(
    await engine.snapshotPage(),
    artifacts.WorkingStatePage.abi,
    owner,
  );
  const output = new Contract(
    await engine.ewaldOutputPage(),
    artifacts.WorkingStatePage.abi,
    owner,
  );
  const runtimeBytes =
    (await provider.getCode(engine.target)).slice(2).length / 2;
  assert.ok(
    runtimeBytes < 96 * 1024,
    "Explicitly assumed target runtime limit",
  );
  const protocol = id("ORVIA-EWALD-NVE-VALIDATION-005"),
    specification = id("Two-atom finite Ewald NVE fixture; not myosin");
  const protocolAddresses = [
    ...new Set([
      ...Object.values(modules),
      ...Object.values(em),
      base.target,
      dynamics.target,
      page.target,
      engine.target,
      evaluator.target,
      snapshot.target,
      output.target,
    ]),
  ];
  await transact(
    registry.registerProtocol(protocol, specification, protocolAddresses),
  );
  let sequence = 0;
  const measuredGas = [],
    reports = [];
  async function pages(factory, role, values, split) {
    if (!values.length) return [];
    const chunks =
      split && split < values.length
        ? [values.slice(0, split), values.slice(split)]
        : [values];
    const addresses = [];
    for (const chunk of chunks) {
      const receipt = await transact(factory.createPage(role, chunk.length));
      const event = receipt.logs
        .map((log) => {
          try {
            return factory.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((x) => x?.name === "PageCreated");
      assert.ok(event);
      const p = new Contract(event.args.page, artifacts.DataPage.abi, owner);
      for (let start = 0; start < chunk.length; start += 128)
        await transact(p.append(chunk.slice(start, start + 128).map(word)));
      await transact(p.seal(await p.rollingDigest()));
      addresses.push(await p.getAddress());
    }
    return addresses;
  }

  async function createDataset(values) {
    const serial = ++sequence,
      baseId = id(`dynamics-base-${serial}`),
      datasetId = id(`periodic-dataset-${serial}`),
      dynamicsId = id(`periodic-dynamics-${serial}`);
    const positionPages = await pages(
      base,
      await base.POSITION_ROLE(),
      values.positions.flat(),
      5,
    );
    const bondPages = await pages(
      base,
      await base.BOND_ROLE(),
      values.bonds.flat(),
      3,
    );
    await transact(
      base.registerDataset(
        baseId,
        positionPages,
        bondPages,
        values.positions.length,
        values.bonds.length,
      ),
    );
    const registration = {
      baseDatasetId: baseId,
      particlePages: await pages(
        dynamics,
        await dynamics.PARTICLE_ROLE(),
        values.particles.flat(),
        5,
      ),
      anglePages: await pages(
        dynamics,
        await dynamics.ANGLE_ROLE(),
        values.angles.flat(),
        4,
      ),
      torsionPages: await pages(
        dynamics,
        await dynamics.TORSION_ROLE(),
        values.torsions.flat(),
        5,
      ),
      pairPages: await pages(
        dynamics,
        await dynamics.PAIR_ROLE(),
        values.pairs.flat(),
      ),
      angleCount: values.angles.length,
      torsionCount: values.torsions.length,
      pairCount: values.pairs.length,
    };
    await transact(dynamics.registerDataset(dynamicsId, registration));
    await transact(
      dataset.registerDataset(datasetId, {
        dynamicsDatasetId: dynamicsId,
        nonbondedPages: await pages(
          dataset,
          await dataset.NONBONDED_ROLE(),
          values.nonbonded.flat(),
          4,
        ),
        exceptionPages: await pages(
          dataset,
          await dataset.EXCEPTION_ROLE(),
          values.exceptions.flat(),
          5,
        ),
        exceptionCount: values.exceptions.length,
        box: values.box,
        switchDistance: values.switchDistance,
        cutoff: values.cutoff,
        prefactor: values.prefactor,
      }),
    );
    return datasetId;
  }

  const datasetId = await createDataset(input);
  async function register(data = datasetId, parameters = input) {
    const run = await engine.nextExperimentId();
    await transact(
      engine.registerExperiment(
        protocol,
        data,
        parameters.dt,
        parameters.steps,
        parameters.alpha,
        parameters.maxMode,
      ),
    );
    return run;
  }
  async function advance(run, work) {
    const before = await engine.runInfo(run);
    const receipt = await transact(
      engine.connect(contributor).advanceExperiment(run, work, { gasLimit }),
    );
    measuredGas.push({
      runId: run.toString(),
      stage: Number(before.status),
      cursor: Number(before.cursor),
      work,
      gas: receipt.gasUsed.toString(),
    });
    return await engine.runInfo(run);
  }
  async function state(run) {
    const info = await engine.runInfo(run),
      positions = [],
      velocities = [],
      forces = [];
    for (let atom = 0; atom < Number(info.atomCount); atom++) {
      const values = await engine.stateAt(run, atom);
      positions.push(plain(values[0]));
      velocities.push(plain(values[1]));
      forces.push(plain(values[2]));
    }
    return {
      step: Number(info.completedSteps),
      positions,
      velocities,
      forces,
      energy: info.potentialEnergy,
    };
  }
  const first = await register(),
    checkpoints = [];
  await t.test(
    "uninitialized and partially merged forces are never presented as committed state",
    async () => {
      await assert.rejects(engine.stateAt(first, 0));
      assert.equal((await engine.runInfo(first)).potentialEnergy, q(0));
      for (let calls = 0; calls < 200; calls++) {
        if ((await engine.ewaldParameters(first)).initialized) break;
        await advance(first, 1);
      }
      assert.equal((await engine.runInfo(first)).status, 14n);
      checkpoints.push(await state(first));
      reports.push(
        verify(
          checkpoints,
          reference.trajectory.slice(0, 1),
          "initial force pass",
        ),
      );
      const committed = await state(first);
      await advance(first, 8);
      for (let calls = 0; calls < 200; calls++) {
        if ((await engine.runInfo(first)).status === 22n) break;
        await advance(first, 1);
      }
      const before = await engine.runInfo(first);
      assert.equal(before.status, 22n);
      assert.equal(before.cursor, 0n);
      const params = await engine.ewaldParameters(first);
      assert.equal(
        (await snapshot.namespaceInfo(params.snapshotNamespace)).isSealed,
        true,
      );
      assert.equal((await evaluator.runInfo(params.evaluatorRunId))[0], 9n);
      await advance(first, 1);
      assert.equal((await engine.runInfo(first)).cursor, 1n);
      assert.deepEqual(await state(first), committed);
      const raw = plain(await page.readWords(before.stateNamespace, 0, 38)),
        staged = plain(await engine.runInfo(first));
      const originalCode = await transport.request({
        method: "eth_getCode",
        params: [evaluator.target, "latest"],
      });
      await transport.request({
        method: "evm_setAccountCode",
        params: [evaluator.target, "0x60006000fd"],
      });
      await assert.rejects(
        transact(engine.advanceExperiment(first, 1, { gasLimit })),
      );
      assert.deepEqual(plain(await engine.runInfo(first)), staged);
      assert.deepEqual(
        plain(await page.readWords(before.stateNamespace, 0, 38)),
        raw,
      );
      assert.deepEqual(await state(first), committed);
      await transport.request({
        method: "evm_setAccountCode",
        params: [evaluator.target, originalCode],
      });
      await advance(first, 2);
      assert.equal((await engine.runInfo(first)).status, 23n);
      assert.equal((await engine.runInfo(first)).cursor, 1n);
      assert.deepEqual(await state(first), committed);
      await advance(first, 1);
      assert.equal((await engine.runInfo(first)).completedSteps, 1n);
      checkpoints.push(await state(first));
    },
  );
  await t.test(
    "two NVE steps match independently differentiated Ewald plus LJ and bond energies",
    async () => {
      for (let calls = 0; calls < 200; calls++) {
        if ((await advance(first, 8)).status === 24n) break;
      }
      assert.equal((await engine.runInfo(first)).status, 24n);
      checkpoints.push(await state(first));
      reports.push(
        verify(
          checkpoints,
          reference.trajectory,
          "two-step normal-pair trajectory",
        ),
      );
      assert.equal(
        (await page.namespaceInfo((await engine.runInfo(first)).stateNamespace))
          .isSealed,
        true,
      );
      await assert.rejects(engine.advanceExperiment(first, 1));
    },
  );
  await t.test(
    "alternate transaction partitions reproduce a completed first step bit for bit",
    async () => {
      const second = await register(datasetId, { ...input, steps: 1 }),
        partition = [1, 4, 3, 2, 8];
      const parked = await register();
      await advance(parked, 8);
      const parkedInfo = plain(await engine.runInfo(parked));
      const parkedParameters = plain(await engine.ewaldParameters(parked));
      assert.equal(parkedInfo[9], 12n);
      assert.equal(
        (await snapshot.namespaceInfo(parkedParameters[3])).isSealed,
        true,
      );
      const parkedWords = plain(
        await snapshot.readWords(parkedParameters[3], 0, 6),
      );
      await advance(second, 8);
      const secondParameters = await engine.ewaldParameters(second);
      assert.notEqual(secondParameters.snapshotNamespace, parkedParameters[3]);
      for (let calls = 0; calls < 20; calls++) {
        if (
          (await evaluator.runInfo(secondParameters.evaluatorRunId))[0] === 9n
        )
          break;
        const receipt = await transact(
          evaluator
            .connect(contributor)
            .advance(secondParameters.evaluatorRunId, 8, { gasLimit }),
        );
        measuredGas.push({
          runId: second.toString(),
          origin: "evaluator",
          stage: 12,
          work: 8,
          gas: receipt.gasUsed.toString(),
        });
      }
      assert.equal(
        (await evaluator.runInfo(secondParameters.evaluatorRunId))[0],
        9n,
      );
      assert.equal((await engine.runInfo(second)).status, 12n);
      await advance(second, 1);
      assert.equal((await engine.runInfo(second)).status, 13n);
      assert.equal((await engine.ewaldParameters(second)).initialized, false);
      for (let calls = 0; calls < 300; calls++) {
        if (
          (await advance(second, partition[calls % partition.length]))
            .status === 24n
        )
          break;
      }
      assert.equal((await engine.runInfo(second)).status, 24n);
      assert.deepEqual(await state(second), checkpoints[1]);
      assert.deepEqual(plain(await engine.runInfo(parked)), parkedInfo);
      assert.deepEqual(
        plain(await engine.ewaldParameters(parked)),
        parkedParameters,
      );
      assert.deepEqual(
        plain(await snapshot.readWords(parkedParameters[3], 0, 6)),
        parkedWords,
      );
      assert.notEqual(
        (await engine.runInfo(first)).stateNamespace,
        (await engine.runInfo(second)).stateNamespace,
      );
    },
  );
  await t.test(
    "direct exceptions include LJ and the Ewald correction exactly once",
    async () => {
      const run = await register(
        await createDataset(reference.exception_input),
        reference.exception_input,
      );
      const frames = [];
      let initialized = false;
      for (let calls = 0; calls < 300; calls++) {
        const info = await advance(run, 8);
        if (!initialized && (await engine.ewaldParameters(run)).initialized) {
          initialized = true;
          frames.push(await state(run));
        }
        if (info.status === 24n) {
          frames.push(await state(run));
          break;
        }
      }
      assert.equal((await engine.runInfo(run)).status, 24n);
      reports.push(
        verify(
          frames,
          reference.exception_trajectory,
          "one-step direct-exception trajectory",
        ),
      );
    },
  );
  await t.test(
    "identities and alpha/mode extent are independently bound in run commitments",
    async () => {
      const coder = AbiCoder.defaultAbiCoder(),
        hash = (types, values) => keccak256(coder.encode(types, values));
      const moduleType =
        "tuple(address registry,address dataset,address math,address integrator,address bond,address angle,address torsion,address lj,address coulomb,address elementary,address geometry,address nonbonded)";
      const hashes = await Promise.all(
        Object.values(modules).map(async (a) =>
          keccak256(await provider.getCode(a)),
        ),
      );
      const core = hash([moduleType, "bytes32[12]"], [modules, hashes]);
      assert.equal(await engine.coreConfigurationHash(), core);
      const ph = keccak256(await provider.getCode(page.target)),
        eh = keccak256(await provider.getCode(evaluator.target));
      const sh = keccak256(await provider.getCode(snapshot.target)),
        oh = keccak256(await provider.getCode(output.target));
      const config = hash(
        [
          "bytes32",
          "address",
          "bytes32",
          "address",
          "bytes32",
          "bytes32",
          "address",
          "bytes32",
          "address",
          "bytes32",
        ],
        [
          core,
          page.target,
          ph,
          evaluator.target,
          eh,
          await evaluator.configurationHash(),
          snapshot.target,
          sh,
          output.target,
          oh,
        ],
      );
      assert.equal(await engine.configurationHash(), config);
      const info = await engine.runInfo(first),
        data = await dataset.assertDataset(datasetId),
        manifest = await registry.assertProtocol(protocol);
      const expected = hash(
        [
          "bytes32",
          "uint256",
          "address",
          "uint256",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes16",
          "uint32",
          "bytes16",
          "uint32",
          "bytes32",
        ],
        [
          encodeBytes32String("ORVIA-EWALD-MD-RUN-v1"),
          31337,
          engine.target,
          first,
          manifest,
          datasetId,
          data,
          config,
          input.dt,
          input.steps,
          input.alpha,
          input.maxMode,
          info.stateNamespace,
        ],
      );
      assert.equal(info.commitment, expected);
      const params = await engine.ewaldParameters(first);
      assert.equal(params.alpha, input.alpha);
      assert.equal(params.maxMode, 1n);
    },
  );
  await t.test(
    "authority, unsupported damping and invalid work cannot alter an experiment",
    async () => {
      await assert.rejects(
        engine
          .connect(contributor)
          .registerExperiment(protocol, datasetId, input.dt, 1, input.alpha, 1),
      );
      await assert.rejects(engine.bindEwald(evaluator.target));
      await assert.rejects(
        evaluator.registerRun(protocol, {
          datasetId,
          sourcePage: snapshot.target,
          sourceNamespace: id("missing"),
          positionOffset: 0,
          positionStride: 3,
          alpha: input.alpha,
          maxMode: 1,
        }),
      );
      for (const alpha of [q(0), q(-1), q(1 / 1024), q(16)])
        await assert.rejects(
          engine.registerExperiment(protocol, datasetId, input.dt, 1, alpha, 1),
        );
      for (const extent of [0, 33])
        await assert.rejects(
          engine.registerExperiment(
            protocol,
            datasetId,
            input.dt,
            1,
            input.alpha,
            extent,
          ),
        );
      const pending = await register(),
        before = plain(await engine.runInfo(pending));
      for (const work of [0, 9])
        await assert.rejects(engine.advanceExperiment(pending, work));
      assert.deepEqual(plain(await engine.runInfo(pending)), before);
      const bad = structuredClone(input);
      bad.particles[1][0] = q(0);
      const invalid = await register(await createDataset(bad)),
        invalidBefore = plain(await engine.runInfo(invalid));
      const raw = plain(await page.readWords(invalidBefore[3], 0, 38));
      await assert.rejects(
        transact(engine.advanceExperiment(invalid, 2, { gasLimit })),
      );
      assert.deepEqual(plain(await engine.runInfo(invalid)), invalidBefore);
      assert.deepEqual(
        plain(await page.readWords(invalidBefore[3], 0, 38)),
        raw,
      );
    },
  );
  fs.writeFileSync(
    "reports/ewald_dynamics_validation.json",
    JSON.stringify(
      {
        scope: reference.scope,
        localUnlimitedContractSize: true,
        runtimeBytes,
        runtimeLimitAssumption: 96 * 1024,
        checks: reports,
        passed: true,
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(
    "reports/ewald_dynamics_execution_gas.json",
    JSON.stringify(
      {
        scope:
          "Finite two-atom Ewald NVE, 13 canonical modes; local measurements only",
        localUnlimitedContractSize: true,
        transactions: measuredGas,
        totalGas: measuredGas
          .reduce((s, r) => s + BigInt(r.gas), 0n)
          .toString(),
        maximumTransactionGas: measuredGas
          .reduce((s, r) => (s > BigInt(r.gas) ? s : BigInt(r.gas)), 0n)
          .toString(),
      },
      null,
      2,
    ) + "\n",
  );
});
