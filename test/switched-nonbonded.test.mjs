import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { environment, deploy, qvec, quadFromNumber as q, quadToNumber } from './helpers.mjs';

test('Switched LJ and conducting reaction-field numerical component', async t => {
  const env = await environment();
  t.after(() => env.transport.disconnect());
  const math = await deploy('FloatMath', env.owner);
  const lj = await deploy('LennardJonesKernel', env.owner, [await math.getAddress()]);
  const coulomb = await deploy('CoulombPairKernel', env.owner, [await math.getAddress()]);
  const kernel = await deploy('SwitchedNonbondedKernel', env.owner,
    [await math.getAddress(), await lj.getAddress(), await coulomb.getAddress()]);
  const evaluate = (d, parameters = [0.75, 0.5, -0.25, 2, 2, 4], exception = false) =>
    kernel.evaluate(qvec(d), ...parameters.map(q), exception);

  await t.test('matches independent 90-digit scalar-energy differentiation in all branches', async () => {
    const cases = [
      ['repulsive_core', [0.5, 0, 0]],
      ['below_switch', [1.5, 0, 0]],
      ['at_switch', [2, 0, 0]],
      ['switch_middle', [3, 0, 0]],
      ['nonaxis_switch', [1.25, -2.5, 0.75]],
      ['near_cutoff', [4 - 2 ** -20, 0, 0]],
      ['at_cutoff', [4, 0, 0]],
      ['above_cutoff', [4.5, 0, 0]],
      ['like_charge', [0.5, 1.5, -0.25], [0.75, 0.5, 0.25, 2, 2, 4]],
      ['neutral', [1.25, 2, 0.5], [0.75, 0.5, 0, 2, 2, 4]],
      ['no_lj', [-1, 2, 1], [0.75, 0, -0.25, 2, 2, 4]],
      ['all_zero_strength', [1, 2, 1], [0.75, 0, -0.25, 0, 2, 4]],
      ['exception_inside', [1, 0.5, 0.25], undefined, true],
      ['exception_outside', [5, -1, 2], undefined, true]
    ];
    const actual = [];
    for (const [name, d, parameters = [0.75, 0.5, -0.25, 2, 2, 4], exception = false] of cases) {
      const [energy, force] = await evaluate(d, parameters, exception);
      actual.push({ name, displacement: qvec(d), parameters: parameters.map(q), exception,
        energy, force: [...force] });
    }
    // The reference differentiates only the scalar potential. It does not use
    // the contract's force, switch-derivative or factored-RF implementation.
    const python = String.raw`
import json, sys
import mpmath as mp
mp.mp.dps = 90
def decode(h):
 b=int(h,16); e=(b>>112)&32767; f=b&((1<<112)-1)
 if e==32767: raise ValueError('nonfinite')
 v=mp.mpf(f if not e else (1<<112)+f)*mp.power(2,(-16382 if not e else e-16383)-112)
 return -v if b>>127 else v
records=[]
for case in json.load(sys.stdin):
 d=list(map(decode,case['displacement']))
 sigma,epsilon,charge,prefactor,rs,rc=map(decode,case['parameters'])
 def potential(v):
  r=mp.sqrt(sum(x*x for x in v))
  lj=4*epsilon*((sigma/r)**12-(sigma/r)**6)
  if case['exception']: return lj+charge*prefactor/r
  if r>=rc: return mp.mpf(0)
  if r>rs:
   x=(r-rs)/(rc-rs)
   lj*=1-10*x**3+15*x**4-6*x**5
  return lj+charge*prefactor*(1/r+r*r/(2*rc**3)-3/(2*rc))
 expected=[potential(d)]
 for axis in range(3):
  def varied(x):
   v=d[:]; v[axis]=x; return potential(v)
  # Since d=b-a, F_A = +gradient_d U.
  expected.append(mp.diff(varied,d[axis]))
 errors=[]
 for encoded,wanted in zip([case['energy']]+case['force'],expected):
  observed=decode(encoded); error=abs(observed-wanted)
  tolerance=mp.mpf('1e-30')+mp.mpf('1e-28')*abs(wanted)
  if error>tolerance: raise AssertionError((case['name'],mp.nstr(observed,90),mp.nstr(wanted,90),mp.nstr(error,90)))
  errors.append(mp.nstr(error,90))
 records.append({'name':case['name'],'absolute_errors':errors,'passed':True})
print(json.dumps({'scope':'Standalone cutoff pair component; no PME or full-system scientific validation',
 'reference':'mpmath 90-digit differentiation of scalar potential from exact decoded binary128 inputs',
 'absolute_tolerance':'1e-30','relative_tolerance':'1e-28','vectors':records},indent=2))
`;
    const report = execFileSync(process.env.ORVIA_RESEARCH_PYTHON || process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3',
      ['-c', python], { input: JSON.stringify(actual), encoding: 'utf8' });
    fs.writeFileSync('reports/switched_nonbonded_validation.json', report);
    assert.equal(JSON.parse(report).vectors.length, cases.length);
  });

  await t.test('applies the switch derivative and approaches zero energy and force at cutoff', async () => {
    const h = 2 ** -16;
    for (const radius of [2, 2.5, 3.5]) {
      const center = await evaluate([radius, 0, 0]);
      const plus = quadToNumber((await evaluate([radius + h, 0, 0]))[0]);
      const minus = quadToNumber((await evaluate([radius - h, 0, 0]))[0]);
      assert.ok(Math.abs((plus - minus) / (2 * h) - quadToNumber(center[1][0])) < 2e-9);
    }
    const near = await evaluate([4 - h, 0, 0]);
    assert.ok(Math.abs(quadToNumber(near[0])) < 1e-10);
    assert.ok(Math.abs(quadToNumber(near[1][0])) < 1e-6);
    for (const radius of [4, 5]) {
      const [energy, force] = await evaluate([radius, 0, 0]);
      assert.equal(energy, q(0));
      assert.deepEqual([...force], qvec([0, 0, 0]));
    }
  });

  await t.test('exceptions match the direct kernels even beyond the normal cutoff', async () => {
    for (const d of [[1.5, 0, 0], [3, 1, -0.5], [5, 0, 0]]) {
      const [energy, force] = await evaluate(d, undefined, true);
      const l = await lj.evaluate(qvec([0, 0, 0]), qvec(d), q(0.75), q(0.5));
      const c = await coulomb.evaluate(qvec([0, 0, 0]), qvec(d), q(-0.25), q(2));
      assert.equal(energy, await math.add(l[0], c[0]));
      for (let axis = 0; axis < 3; ++axis) assert.equal(force[axis], await math.add(l[1][axis], c[1][axis]));
    }
  });

  await t.test('particle exchange reverses force and signed zero stays canonical', async () => {
    for (const exception of [false, true]) {
      const d = [1.25, -2.5, 0.75];
      const forward = await evaluate(d, undefined, exception);
      const reverse = await evaluate(d.map(x => -x), undefined, exception);
      assert.equal(forward[0], reverse[0]);
      for (let axis = 0; axis < 3; ++axis) assert.equal(reverse[1][axis], await math.neg(forward[1][axis]));
      const zero = await kernel.evaluate(qvec(d), q(0.75), '0x80000000000000000000000000000000',
        '0x80000000000000000000000000000000', q(2), q(2), q(4), exception);
      assert.equal(zero[0], q(0));
      assert.deepEqual([...zero[1]], qvec([0, 0, 0]));
    }
  });

  await t.test('rejects invalid and nonfinite inputs before cutoff and exception shortcuts', async () => {
    const good = [q(0.75), q(0.5), q(-0.25), q(2), q(2), q(4)];
    const infinity = '0x7fff0000000000000000000000000000';
    const nan = '0x7fff8000000000000000000000000000';
    for (const exception of [false, true]) {
      for (let parameter = 0; parameter < good.length; ++parameter) {
        const invalid = [...good]; invalid[parameter] = parameter % 2 ? infinity : nan;
        await assert.rejects(kernel.evaluate(qvec([5, 0, 0]), ...invalid, exception));
      }
      for (const parameters of [[0, 0.5, -0.25, 2, 2, 4], [-1, 0.5, -0.25, 2, 2, 4],
        [0.75, -1, -0.25, 2, 2, 4], [0.75, 0.5, -0.25, -1, 2, 4],
        [0.75, 0.5, -0.25, 2, 0, 4], [0.75, 0.5, -0.25, 2, 4, 4],
        [0.75, 0.5, -0.25, 2, 5, 4]]) {
        await assert.rejects(evaluate([5, 0, 0], parameters, exception));
      }
      await assert.rejects(kernel.evaluate([infinity, q(0), q(0)], ...good, exception));
      await assert.rejects(evaluate([0, 0, 0], [0.75, 0, 0, 0, 2, 4], exception));
    }
  });

  await t.test('constructor binds the same deployed arithmetic dependency for both primitives', async () => {
    assert.equal(await kernel.numericalMath(), await math.getAddress());
    assert.equal(await kernel.ljKernel(), await lj.getAddress());
    assert.equal(await kernel.coulombKernel(), await coulomb.getAddress());
    const otherMath = await deploy('FloatMath', env.owner);
    await assert.rejects(deploy('SwitchedNonbondedKernel', env.owner,
      [await otherMath.getAddress(), await lj.getAddress(), await coulomb.getAddress()]));
    for (let index = 0; index < 3; ++index) {
      const addresses = [await math.getAddress(), await lj.getAddress(), await coulomb.getAddress()];
      addresses[index] = await env.owner.getAddress();
      await assert.rejects(deploy('SwitchedNonbondedKernel', env.owner, addresses));
    }
  });
});
