import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { environment, deploy, qvec, quadFromNumber as q, quadToNumber } from './helpers.mjs';

test('Direct-pair Lennard-Jones and Coulomb numerical components', async t => {
  const env = await environment();
  t.after(() => env.transport.disconnect());
  const math = await deploy('FloatMath', env.owner);
  const lj = await deploy('LennardJonesKernel', env.owner, [await math.getAddress()]);
  const coulomb = await deploy('CoulombPairKernel', env.owner, [await math.getAddress()]);

  await t.test('matches independent 100-digit Decimal pair reference vectors', async () => {
    const reference = JSON.parse(fs.readFileSync('reference/nonbonded_vectors.json', 'utf8'));
    assert.ok(reference.lj_vectors.length >= 5);
    assert.ok(reference.coulomb_vectors.length >= 5);
    const actual = [];
    for (const [kind, kernel, vectors, parameterNames] of [
      ['Lennard-Jones', lj, reference.lj_vectors, ['sigma', 'epsilon']],
      ['Coulomb', coulomb, reference.coulomb_vectors, ['chargeProduct', 'prefactor']]
    ]) {
      for (const vector of vectors) {
        const [energy, force] = await kernel.evaluate(vector.a, vector.b,
          vector[parameterNames[0]], vector[parameterNames[1]]);
        actual.push({ kind, name: vector.name, energy, force: [...force], expected: vector.expected });
      }
    }
    // Decode binary128 directly; no binary64 conversion is used for this comparison.
    const python = String.raw`
import sys,json
from decimal import Decimal as D, localcontext
vectors=json.load(sys.stdin)
def decode(h):
 bits=int(h,16); exponent=(bits>>112)&32767; fraction=bits&((1<<112)-1)
 if exponent==32767: raise ValueError('nonfinite result')
 sign=-1 if bits>>127 else 1
 return sign*((D(1)+D(fraction)/D(2)**112)*D(2)**(exponent-16383) if exponent else D(fraction)*D(2)**(-16382-112))
report=[]
with localcontext() as ctx:
 ctx.prec=160
 for vector in vectors:
  actual=[vector['energy']]+vector['force']
  expected=[vector['expected']['energy_decimal']]+vector['expected']['force_on_a_decimal']
  errors=[]
  for encoded,decimal in zip(actual,expected):
   x=decode(encoded); y=D(decimal); error=abs(x-y); tolerance=D('1e-30')+D('1e-28')*abs(y)
   if error>tolerance: raise AssertionError((vector['kind'],vector['name'],str(x),decimal,str(error),str(tolerance)))
   errors.append(str(error))
  report.append({'kernel':vector['kind'],'name':vector['name'],'absolute_errors':errors,'passed':True})
print(json.dumps({'scope':'Standalone unwrapped direct pairs; no full-system nonbonded method',
 'reference':'Independent Python Decimal, 100 digits','arithmetic_format':'binary128, upstream ABDK semantics',
 'comparison_absolute_tolerance':'1e-30','comparison_relative_tolerance':'1e-28','vectors':report},indent=2))
`;
    const report = execFileSync(process.env.ORVIA_RESEARCH_PYTHON || process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3', ['-c', python], {
      input: JSON.stringify(actual), encoding: 'utf8'
    });
    fs.writeFileSync('reports/nonbonded_validation.json', report);
    assert.equal(JSON.parse(report).vectors.length, actual.length);
  });

  await t.test('force equals the negative coordinate gradient for both pair potentials', async () => {
    const a = [0.25, -0.5, 0.125], b = [1.125, 0.75, -0.625], h = 1e-5;
    for (const [kernel, parameters] of [[lj, [q(1.25), q(0.75)]], [coulomb, [q(-0.5), q(4.5)]]]) {
      const [, force] = await kernel.evaluate(qvec(a), qvec(b), ...parameters);
      for (let axis = 0; axis < 3; ++axis) {
        const plus = [...a], minus = [...a];
        plus[axis] += h;
        minus[axis] -= h;
        const ep = quadToNumber((await kernel.evaluate(qvec(plus), qvec(b), ...parameters))[0]);
        const em = quadToNumber((await kernel.evaluate(qvec(minus), qvec(b), ...parameters))[0]);
        const finiteDifference = -(ep - em) / (2 * h);
        const analytical = quadToNumber(force[axis]);
        assert.ok(Math.abs(finiteDifference - analytical) < 1e-8 + 1e-7 * Math.abs(analytical));
      }
    }
  });

  await t.test('translation and particle exchange preserve pair symmetries bit-for-bit', async () => {
    const a = [0.25, -0.5, 0.125], b = [1.125, 0.75, -0.625];
    for (const [kernel, parameters] of [[lj, [q(1.25), q(0.75)]], [coulomb, [q(0.5), q(4.5)]]]) {
      const [energy, force] = await kernel.evaluate(qvec(a), qvec(b), ...parameters);
      const translated = await kernel.evaluate(qvec(a.map(x => x + 4)), qvec(b.map(x => x + 4)), ...parameters);
      const exchanged = await kernel.evaluate(qvec(b), qvec(a), ...parameters);
      assert.equal(translated[0], energy);
      assert.deepEqual([...translated[1]], [...force]);
      assert.equal(exchanged[0], energy);
      for (let axis = 0; axis < 3; ++axis) assert.equal(exchanged[1][axis], await math.neg(force[axis]));
    }
  });

  await t.test('analytical force signs and exact simple values distinguish attraction from repulsion', async () => {
    const origin = qvec([0, 0, 0]);
    const contact = await lj.evaluate(origin, qvec([1, 0, 0]), q(1), q(0.5));
    assert.equal(contact[0], q(0)); // r=sigma is the energy zero, not the energy minimum.
    assert.deepEqual([...contact[1]], qvec([-12, 0, 0]));
    const attractive = await lj.evaluate(origin, qvec([2, 0, 0]), q(1), q(1));
    assert.equal(attractive[0], q(-63 / 1024));
    assert.deepEqual([...attractive[1]], qvec([93 / 512, 0, 0]));
    for (const sign of [1, -1]) {
      const pair = await coulomb.evaluate(origin, qvec([2, 0, 0]), q(sign * 2), q(3));
      assert.equal(pair[0], q(sign * 3));
      assert.deepEqual([...pair[1]], qvec([-sign * 1.5, 0, 0]));
    }
  });

  await t.test('finite zero strengths return canonical zero and singular geometry still rejects', async () => {
    const a = qvec([0, 0, 0]), b = qvec([1, 2, 3]);
    const minusZero = '0x80000000000000000000000000000000';
    for (const zero of [q(0), minusZero]) {
      for (const [kernel, parameters] of [[lj, [q(1), zero]], [coulomb, [zero, q(1)]], [coulomb, [q(-1), zero]]]) {
        const result = await kernel.evaluate(a, b, ...parameters);
        assert.equal(result[0], q(0));
        assert.deepEqual([...result[1]], qvec([0, 0, 0]));
        await assert.rejects(kernel.evaluate(a, a, ...parameters));
      }
    }
  });

  await t.test('rejects nonfinite operands, invalid parameter domains and missing math code', async () => {
    const a = qvec([0, 0, 0]), b = qvec([1, 2, 3]);
    const minusZero = '0x80000000000000000000000000000000';
    for (const invalid of ['0x7fff0000000000000000000000000000', '0xffff0000000000000000000000000000', '0x7fff8000000000000000000000000000']) {
      for (const kernel of [lj, coulomb]) {
        await assert.rejects(kernel.evaluate([invalid, a[1], a[2]], b, q(1), q(1)));
        await assert.rejects(kernel.evaluate(a, [b[0], invalid, b[2]], q(1), q(1)));
        await assert.rejects(kernel.evaluate(a, b, invalid, q(1)));
        await assert.rejects(kernel.evaluate(a, b, q(1), invalid));
      }
    }
    for (const sigma of [q(-1), q(0), minusZero]) await assert.rejects(lj.evaluate(a, b, sigma, q(1)));
    await assert.rejects(lj.evaluate(a, b, q(1), q(-1)));
    await assert.rejects(coulomb.evaluate(a, b, q(1), q(-1)));
    await assert.rejects(lj.evaluate(a, a, q(1), q(1)));
    await assert.rejects(coulomb.evaluate(a, a, q(-1), q(1)));
    await assert.rejects(deploy('LennardJonesKernel', env.owner, [await env.owner.getAddress()]));
    await assert.rejects(deploy('CoulombPairKernel', env.owner, [await env.owner.getAddress()]));
    assert.equal(await lj.numericalMath(), await math.getAddress());
    assert.equal(await coulomb.numericalMath(), await math.getAddress());
  });
});
