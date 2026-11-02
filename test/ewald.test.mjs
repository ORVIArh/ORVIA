import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  Contract,
  id,
  zeroPadValue,
  AbiCoder,
  keccak256,
  encodeBytes32String,
} from "ethers";
import {
  artifacts,
  environment,
  deploy,
  transact,
  quadFromNumber as q,
  qvec,
} from "./helpers.mjs";

const reference = JSON.parse(
  fs.readFileSync("reference/ewald_reference.json", "utf8"),
);
const word = (x) =>
  zeroPadValue(
    typeof x === "number" ? "0x" + x.toString(16).padStart(2, "0") : x,
    32,
  );
const plain = (x) => Array.from(x, (v) => (Array.isArray(v) ? plain(v) : v));
const gasLimit = 28_000_000;

test("Ewald real, reciprocal and correction components and bounded on-chain force evaluation", async (t) => {
  const { transport, provider, owner, contributor } = await environment();
  t.after(() => transport.disconnect());
  const math = await deploy("FloatMath", owner),
    scalar = await deploy("ScalarMath", owner, [math.target]);
  const elementary = await deploy("ElementaryMath", owner, [math.target]);
  const geometry = await deploy("OrthorhombicGeometry", owner, [math.target]);
  const real = await deploy("EwaldRealSpaceKernel", owner, [
    math.target,
    scalar.target,
  ]);
  const reciprocal = await deploy("EwaldReciprocalKernel", owner, [
    math.target,
    scalar.target,
    elementary.target,
  ]);
  const corrections = await deploy("EwaldCorrections", owner, [
    math.target,
    scalar.target,
  ]);
  const observations = { real: [], exceptions: [], evaluations: [] };

  await t.test(
    "real and exception energies and forces match independently differentiated scalar references",
    async () => {
      for (const row of reference.real_pairs) {
        const a = row.input;
        const got = await real.evaluate(
          a.displacement,
          a.chargeProduct,
          a.prefactor,
          a.alpha,
          a.cutoff,
        );
        observations.real.push({ energy: got[0], force: plain(got[1]) });
      }
      for (const row of reference.exceptions) {
        const a = row.input;
        const got = await corrections.exception(
          a.displacement,
          a.original,
          a.desired,
          a.prefactor,
          a.alpha,
        );
        observations.exceptions.push({ energy: got[0], force: plain(got[1]) });
      }
      verify(observations);
    },
  );
  await t.test(
    "mode enumeration and bounded phase reduction preserve lattice periodicity",
    async () => {
      const box = qvec([4, 6, 8]),
        mode = [1, -2, 3],
        position = qvec([0.25, 0.5, 0.75]);
      const original = plain(
        await reciprocal.structureFactorTerm(position, q(-0.5), mode, box),
      );
      const shifted = plain(
        await reciprocal.structureFactorTerm(
          qvec([0.25 + 4 * 100, 0.5 - 6 * 79, 0.75 + 8 * 31]),
          q(-0.5),
          mode,
          box,
        ),
      );
      assert.deepEqual(shifted, original);
      await assert.rejects(reciprocal.waveVector([0, 0, 0], box, q(1), q(1)));
      await assert.rejects(reciprocal.waveVector([-1, 0, 0], box, q(1), q(1)));
      await assert.rejects(reciprocal.waveVector([33, 0, 0], box, q(1), q(1)));
      await assert.rejects(
        reciprocal.waveVector([32, 0, 0], qvec([1, 1, 1]), q(0.125), q(1)),
      );
      await assert.rejects(
        reciprocal.structureFactorTerm(
          qvec([4 * (2 ** 32 + 1), 0, 0]),
          q(1),
          [1, 0, 0],
          qvec([4, 4, 4]),
        ),
      );
    },
  );
  await t.test(
    "invalid numerical domains and mismatched dependencies fail explicitly",
    async () => {
      await assert.rejects(
        real.evaluate(qvec([0, 0, 0]), q(0), q(1), q(1), q(2)),
      );
      await assert.rejects(
        real.evaluate(qvec([1, 0, 0]), q(1), q(1), q(17), q(1)),
      );
      await assert.rejects(
        real.evaluate(qvec([1, 0, 0]), q(1), q(-1), q(1), q(2)),
      );
      await assert.rejects(
        corrections.exception(qvec([0, 0, 0]), q(1), q(1), q(1), q(1)),
      );
      await assert.rejects(
        corrections.exception(
          ["0x00000000000000000000000000000001", q(0), q(0)],
          q(1),
          q(0),
          q(1),
          q(1),
        ),
      );
      await assert.rejects(
        corrections.backgroundEnergy(q(1), qvec([0, 4, 4]), q(1), q(1)),
      );
      const maximum = "0x7ffeffffffffffffffffffffffffffff";
      await assert.rejects(corrections.selfEnergy(maximum, q(1), q(1)));
      await assert.rejects(reciprocal.modeEnergy(q(1), maximum, q(0)));
      await assert.rejects(
        real.evaluate(qvec([1, 0, 0]), maximum, maximum, q(1), q(2)),
      );
      await assert.rejects(
        real.evaluate([maximum, q(0), q(0)], q(1), q(1), q(1), q(2)),
      );
      const secondMath = await deploy("FloatMath", owner);
      await assert.rejects(
        deploy("EwaldRealSpaceKernel", owner, [
          secondMath.target,
          scalar.target,
        ]),
      );
      await assert.rejects(
        deploy("EwaldReciprocalKernel", owner, [
          math.target,
          scalar.target,
          secondMath.target,
        ]),
      );
      const bg = await corrections.backgroundEnergy(
        q(1.5),
        qvec([4, 4, 4]),
        q(0.75),
        q(1),
      );
      observations.background = bg;
      verify(observations);
    },
  );

  const base = await deploy("DatasetCatalog", owner, [
    await owner.getAddress(),
  ]);
  const dyn = await deploy("DynamicsDataset", owner, [
    await owner.getAddress(),
    base.target,
  ]);
  const data = await deploy("PeriodicDataset", owner, [
    await owner.getAddress(),
    dyn.target,
  ]);
  const registry = await deploy("ExperimentRegistry", owner, [
    await owner.getAddress(),
  ]);
  const modules = [
    registry.target,
    data.target,
    math.target,
    scalar.target,
    elementary.target,
    geometry.target,
    real.target,
    reciprocal.target,
    corrections.target,
  ];
  const evaluator = await deploy("EwaldForceEvaluator", owner, [
    await owner.getAddress(),
    modules,
  ]);
  const output = await deploy("WorkingStatePage", owner, [evaluator.target]);
  await transact(evaluator.bindOutputPage(output.target));
  const writer = await deploy("WorkingStateWriterHarness", owner);
  const receipt = await transact(evaluator.createSnapshotPage(writer.target));
  const snapshotAddress = receipt.logs
    .map((x) => {
      try {
        return evaluator.interface.parseLog(x);
      } catch {
        return null;
      }
    })
    .find((x) => x?.name === "SnapshotPageCreated").args.page;
  const snapshot = new Contract(
    snapshotAddress,
    artifacts.WorkingStatePage.abi,
    owner,
  );
  const snapshotId = id("ewald-immutable-source");
  const source = reference.fixture.input;
  const positionWords = source.positions.flat().map(word);
  await transact(
    writer.forward(
      snapshot.target,
      snapshot.interface.encodeFunctionData("createNamespace", [
        snapshotId,
        positionWords.length,
      ]),
    ),
  );
  await transact(
    writer.forward(
      snapshot.target,
      snapshot.interface.encodeFunctionData("writeWords", [
        snapshotId,
        0,
        positionWords,
      ]),
    ),
  );
  const protocolId = id("orvia-ewald-test-protocol");
  await transact(
    registry.registerProtocol(protocolId, id("Ewald explicit finite test"), [
      ...modules,
      evaluator.target,
      output.target,
    ]),
  );
  async function makePage(catalog, role, values) {
    const receipt = await transact(catalog.createPage(role, values.length));
    const address = receipt.logs
      .map((x) => {
        try {
          return catalog.interface.parseLog(x);
        } catch {
          return null;
        }
      })
      .find((x) => x?.name === "PageCreated").args.page;
    const page = new Contract(address, artifacts.DataPage.abi, owner);
    await transact(page.append(values.map(word)));
    await transact(page.seal(await page.rollingDigest()));
    return address;
  }
  const baseId = id("ewald-base");
  const pp = await makePage(
    base,
    await base.POSITION_ROLE(),
    source.positions.flat(),
  );
  const bp = await makePage(base, await base.BOND_ROLE(), [0, 1, q(0), q(1)]);
  await transact(base.registerDataset(baseId, [pp], [bp], 2, 1));
  const particles = await makePage(dyn, await dyn.PARTICLE_ROLE(), [
    q(1),
    q(0),
    q(0),
    q(0),
    q(1),
    q(0),
    q(0),
    q(0),
  ]);
  const dynamicsId = id("ewald-dynamics");
  await transact(
    dyn.registerDataset(dynamicsId, [baseId, [particles], [], [], [], 0, 0, 0]),
  );
  let datasetCounter = 0;
  async function makeDataset(exceptions = []) {
    const datasetId = id("ewald-periodic-" + datasetCounter++);
    const nb = await makePage(
      data,
      await data.NONBONDED_ROLE(),
      source.charges.flatMap((charge) => [q(0.5), q(0), charge]),
    );
    const ep = exceptions.length
      ? [await makePage(data, await data.EXCEPTION_ROLE(), exceptions.flat())]
      : [];
    await transact(
      data.registerDataset(datasetId, [
        dynamicsId,
        [nb],
        ep,
        exceptions.length,
        source.box,
        q(1),
        source.cutoff,
        source.prefactor,
      ]),
    );
    return datasetId;
  }
  const ordinaryId = await makeDataset();
  function registration(datasetId, overrides = {}) {
    return {
      datasetId,
      sourcePage: snapshot.target,
      sourceNamespace: snapshotId,
      positionOffset: 0,
      positionStride: 3,
      alpha: source.alpha,
      maxMode: source.max_mode,
      ...overrides,
    };
  }
  async function register(datasetId, overrides = {}) {
    const n = await evaluator.nextRunId();
    await transact(
      evaluator.registerRun(protocolId, registration(datasetId, overrides)),
    );
    return n;
  }
  const gas = [];
  async function advance(run, work) {
    const before = plain(await evaluator.runInfo(run));
    const tx = await transact(
      evaluator.connect(contributor).advance(run, work, { gasLimit }),
    );
    gas.push({
      runId: run.toString(),
      stage: Number(before[0]),
      cursor: Number(before[1]),
      modeIndex: Number(before[2]),
      work,
      gasUsed: tx.gasUsed.toString(),
    });
  }
  async function complete(run, schedule) {
    let i = 0;
    while ((await evaluator.runInfo(run))[0] !== 9n) {
      if (i > 1000) throw Error("not completing");
      await advance(run, schedule[i++ % schedule.length]);
    }
    return {
      energy: (await evaluator.energies(run))[0],
      forces: [
        plain(await evaluator.forceAt(run, 0)),
        plain(await evaluator.forceAt(run, 1)),
      ],
    };
  }

  await t.test(
    "unsealed, foreign and out-of-range source snapshots cannot be registered",
    async () => {
      await assert.rejects(
        evaluator.registerRun(protocolId, registration(ordinaryId)),
      );
      await transact(
        writer.forward(
          snapshot.target,
          snapshot.interface.encodeFunctionData("sealNamespace", [snapshotId]),
        ),
      );
      const foreign = await deploy("WorkingStatePage", owner, [writer.target]);
      await assert.rejects(
        evaluator.registerRun(
          protocolId,
          registration(ordinaryId, { sourcePage: foreign.target }),
        ),
      );
      await assert.rejects(
        evaluator.registerRun(
          protocolId,
          registration(ordinaryId, { positionStride: 2 }),
        ),
      );
      await assert.rejects(
        evaluator.registerRun(
          protocolId,
          registration(ordinaryId, { positionOffset: 1 }),
        ),
      );
      await assert.rejects(
        evaluator
          .connect(contributor)
          .registerRun(protocolId, registration(ordinaryId)),
      );
      await assert.rejects(
        evaluator.connect(contributor).createSnapshotPage(writer.target),
      );
      await assert.rejects(
        evaluator.registerRun(
          protocolId,
          registration(ordinaryId, { maxMode: 0 }),
        ),
      );
      await assert.rejects(
        evaluator.registerRun(
          protocolId,
          registration(ordinaryId, { alpha: q(1 / 1024) }),
        ),
      );
    },
  );
  let first;
  await t.test(
    "full Ewald sums and all particle forces execute across bounded transactions on-chain",
    async () => {
      const run = await register(ordinaryId);
      first = run;
      await assert.rejects(evaluator.energies(run));
      await assert.rejects(evaluator.forceAt(run, 0));
      assert.equal(await evaluator.modeCount(1), 13n);
      for (let i = 0; i < 13; i++)
        assert.deepEqual(
          plain(await evaluator.modeAt(i, 1)).map(Number),
          reference.fixture.modes[i],
        );
      await assert.rejects(evaluator.modeAt(13, 1));
      const result = await complete(run, [8]);
      observations.evaluations.push({ kind: "ordinary", ...result });
      verify(observations);
      const info = await evaluator.runInfo(run);
      assert.equal((await output.namespaceInfo(info[5]))[1], true);
      await assert.rejects(evaluator.advance(run, 1));
    },
  );
  await t.test(
    "different transaction partitions give identical completed Ewald bytes",
    async () => {
      const run = await register(ordinaryId);
      const result = await complete(run, [1, 4, 3, 2, 8]);
      assert.equal(result.energy, (await evaluator.energies(first))[0]);
      for (let i = 0; i < 2; i++)
        assert.deepEqual(
          result.forces[i],
          plain(await evaluator.forceAt(first, i)),
        );
    },
  );
  await t.test(
    "explicit exception cancels reciprocal intracell interaction and inserts direct parameters",
    async () => {
      const datasetId = await makeDataset([
        [
          0,
          1,
          2,
          q(0.5),
          q(0),
          reference.fixture.exception.desired_charge_product,
        ],
      ]);
      const result = await complete(await register(datasetId), [8]);
      observations.evaluations.push({ kind: "exception", ...result });
      verify(observations);
    },
  );
  await t.test(
    "invalid work and input failure roll back all writes within their transaction",
    async () => {
      await assert.rejects(evaluator.advance(first, 0));
      await assert.rejects(evaluator.advance(first, 9));
      const badId = await makeDataset([[1, 0, 1, q(0), q(0), q(0)]]);
      const run = await register(badId);
      const before = plain(await evaluator.runInfo(run));
      const raw = plain(await output.readWords(before[5], 0, 12));
      await assert.rejects(transact(evaluator.advance(run, 3, { gasLimit })));
      assert.deepEqual(plain(await evaluator.runInfo(run)), before);
      assert.deepEqual(plain(await output.readWords(before[5], 0, 12)), raw);
    },
  );
  await t.test(
    "independent commitment construction binds source range, dataset and all executable identities",
    async () => {
      const coder = AbiCoder.defaultAbiCoder();
      const modulesType =
        "tuple(address registry,address dataset,address math,address scalar,address elementary,address geometry,address realSpace,address reciprocal,address corrections)";
      const hashes = await Promise.all(
        modules.map(async (x) => keccak256(await provider.getCode(x))),
      );
      const core = keccak256(
        coder.encode([modulesType, "bytes32[9]"], [modules, hashes]),
      );
      assert.equal(await evaluator.coreConfigurationHash(), core);
      const configuration = keccak256(
        coder.encode(
          ["bytes32", "address", "bytes32"],
          [
            core,
            output.target,
            keccak256(await provider.getCode(output.target)),
          ],
        ),
      );
      assert.equal(await evaluator.configurationHash(), configuration);
      const inputType =
        "tuple(bytes32 datasetId,address sourcePage,bytes32 sourceNamespace,uint32 positionOffset,uint32 positionStride,bytes16 alpha,uint32 maxMode)";
      const snapshotHash = keccak256(
        coder.encode(
          [inputType, "bytes32", "address", "bytes32"],
          [
            registration(ordinaryId),
            keccak256(await provider.getCode(snapshot.target)),
            writer.target,
            keccak256(await provider.getCode(writer.target)),
          ],
        ),
      );
      const manifest = await registry.assertProtocol(protocolId),
        dataHash = await data.assertDataset(ordinaryId);
      const commitment = keccak256(
        coder.encode(
          [
            "bytes32",
            "uint256",
            "address",
            "uint256",
            "bytes32",
            "bytes32",
            "bytes32",
            "bytes32",
          ],
          [
            encodeBytes32String("ORVIA-EWALD-RUN-v1"),
            31337,
            evaluator.target,
            first,
            manifest,
            dataHash,
            configuration,
            snapshotHash,
          ],
        ),
      );
      assert.equal((await evaluator.runInfo(first))[6], commitment);
    },
  );
  fs.writeFileSync(
    "reports/ewald_execution_gas.json",
    JSON.stringify(
      {
        scope:
          "Complete on-chain electrostatic snapshot fixture; 2 atoms, 13 canonical reciprocal modes; deployment/uploads/registration excluded; not target-chain fees",
        chainId: 31337,
        transactions: gas,
      },
      null,
      2,
    ) + "\n",
  );
});

function verify(observations) {
  const code = String.raw`
import sys,json
from decimal import Decimal,localcontext
v=json.load(sys.stdin);ref=v['reference'];got=v['observations']
def quad(h):
 b=int(h,16);e=(b>>112)&32767;f=b&((1<<112)-1);s=-1 if b>>127 else 1
 if e==32767:raise AssertionError('nonfinite result')
 return Decimal(s)*Decimal(f if e==0 else (1<<112)+f)*(Decimal(2)**((1-16383-112) if e==0 else e-16383-112))
errors=[]
def check(h,value,label,tail=False):
 a=quad(h);b=Decimal(value);error=abs(a-b);limit=Decimal('1e-27')+abs(b)*Decimal('1e-26')
 if tail and b!=0:limit=abs(b)*Decimal('1e-25')
 assert error<=limit,(label,str(a),str(b),str(error),str(limit))
 errors.append({'label':label,'absolute_error':str(error)})
with localcontext() as c:
 c.prec=110
 for group,target in [('real','real_pairs'),('exceptions','exceptions')]:
  for i,row in enumerate(got[group]):
   expected=ref[target][i];check(row['energy'],expected['energy'],f'{group}{i}.energy',group=='real' and i==5)
   for j,x in enumerate(row['force']):check(x,expected['force'][j],f'{group}{i}.force{j}',group=='real' and i==5)
 if 'background' in got:
  import mpmath as mp;mp.mp.dps=100
  check(got['background'],str(-mp.pi*mp.mpf('1.5')**2/(2*mp.mpf('.75')**2*64)),'background')
 for i,row in enumerate(got['evaluations']):
  expected=ref['fixture'][row['kind']];check(row['energy'],expected['energy'],f'evaluation{i}.energy')
  for atom,force in enumerate(row['forces']):
   for axis,x in enumerate(force):check(x,expected['forces'][atom][axis],f'evaluation{i}.force{atom}.{axis}')
 print(json.dumps({'scope':'Finite Ewald component and complete sealed-snapshot force evaluation, not PME or a converged protein model','absolute_tolerance':'1e-27','relative_tolerance':'1e-26','tail_relative_tolerance':'1e-25','values_checked':len(errors),'maximum_absolute_error':str(max((Decimal(x['absolute_error']) for x in errors),default=Decimal(0))),'checks':errors,'passed':True},indent=2))
`;
  const output = execFileSync(
    process.env.ORVIA_RESEARCH_PYTHON ||
      process.env.CODEX_PRIMARY_RUNTIME_PYTHON ||
      "python3",
    ["-c", code],
    { input: JSON.stringify({ reference, observations }), encoding: "utf8" },
  );
  fs.writeFileSync("reports/ewald_validation.json", output);
}
