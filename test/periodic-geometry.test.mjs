import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environment, deploy, qvec, quadFromNumber as q } from './helpers.mjs';

test('Orthorhombic minimum-image geometry', async t => {
  const env = await environment();
  t.after(() => env.transport.disconnect());
  const math = await deploy('FloatMath', env.owner);
  const geometry = await deploy('OrthorhombicGeometry', env.owner, [await math.getAddress()]);
  const zero = qvec([0, 0, 0]);

  await t.test('matches exact integer-grid references over positive and negative multiple images', async () => {
    // All inputs and expected outputs are exact multiples of 1/8. This oracle
    // uses signed integer remainder rather than reproducing binary128 division.
    const lengths = [56, 80, 104];
    for (let row = 0; row < 33; ++row) {
      const a = [row * 37 - 601, 991 - row * 61, row * 89 - 1171];
      const b = [701 - row * 73, row * 83 - 991, 397 - row * 53];
      const expected = a.map((value, axis) => {
        let remainder = (b[axis] - value) % lengths[axis];
        if (remainder > lengths[axis] / 2) remainder -= lengths[axis];
        if (remainder < -lengths[axis] / 2) remainder += lengths[axis];
        return remainder === 0 ? 0 : remainder / 8;
      });
      const actual = await geometry.displacement(qvec(a.map(x => x / 8)), qvec(b.map(x => x / 8)), qvec(lengths.map(x => x / 8)));
      assert.deepEqual([...actual], qvec(expected));
    }
  });

  await t.test('half-box ties preserve sign and swapping endpoints negates every component', async () => {
    const box = qvec([8, 12, 20]);
    for (const p of [[4, 6, 10], [-4, -6, -10], [28, -42, 70], [4.125, -5.875, 9.875]]) {
      const forward = await geometry.displacement(zero, qvec(p), box);
      const reverse = await geometry.displacement(qvec(p), zero, box);
      for (let axis = 0; axis < 3; ++axis) assert.equal(reverse[axis], await math.neg(forward[axis]));
    }
    assert.deepEqual([...(await geometry.displacement(zero, qvec([28, -42, 70]), box))], qvec([4, -6, 10]));
    assert.deepEqual([...(await geometry.displacement(zero, qvec([4.125, -6.125, 10.125]), box))], qvec([-3.875, 5.875, -9.875]));
  });

  await t.test('resolves adjacent binary128 half-box values without binary64 conversion', async () => {
    const encode = bits => '0x' + bits.toString(16).padStart(32, '0');
    const four = BigInt(q(4)), sign = 1n << 127n;
    const justBelow = encode(four - 1n), justAbove = encode(four + 1n);
    const box = qvec([8, 8, 8]);
    const below = await geometry.displacement(zero, [justBelow, q(0), q(0)], box);
    const above = await geometry.displacement(zero, [justAbove, q(0), q(0)], box);
    assert.equal(below[0], justBelow);
    // Above 4 the ULP is twice that below 4. Subtracting 8 gives
    // -(4 - 2^-110), hence two representable magnitude steps below 4.
    assert.equal(above[0], encode(sign | (four - 2n)));
    const reverse = await geometry.displacement([justAbove, q(0), q(0)], zero, box);
    assert.equal(reverse[0], encode(four - 2n));
  });

  await t.test('common translation and independent integer image shifts preserve non-tie displacements', async () => {
    const a = [0.125, -0.5, 1.75], b = [7.5, 13.25, -21.125], lengths = [8, 12, 20];
    const baseline = [...(await geometry.displacement(qvec(a), qvec(b), qvec(lengths)))];
    const translation = [107.5, -64.25, 15.875];
    assert.deepEqual([...(await geometry.displacement(qvec(a.map((x, i) => x + translation[i])), qvec(b.map((x, i) => x + translation[i])), qvec(lengths)))], baseline);
    assert.deepEqual([...(await geometry.displacement(qvec(a.map((x, i) => x - (i + 3) * lengths[i])), qvec(b.map((x, i) => x + (i + 7) * lengths[i])), qvec(lengths)))], baseline);
  });

  await t.test('accepts the exact image-count bound, rejects beyond it, and canonicalizes zero', async () => {
    assert.equal(await geometry.MAX_IMAGE_RATIO(), q(2 ** 32));
    for (const sign of [1, -1]) {
      assert.deepEqual([...(await geometry.displacement(zero, qvec([sign * 2 ** 32, 0, 0]), qvec([1, 2, 3])))], zero);
      const result = await geometry.displacement(zero, qvec([sign * (2 ** 32 - 0.25), 0, 0]), qvec([1, 2, 3]));
      assert.equal(result[0], q(-sign * 0.25));
      await assert.rejects(geometry.displacement(zero, qvec([sign * (2 ** 32 + 0.25), 0, 0]), qvec([1, 2, 3])));
    }
    const nextMagnitude = BigInt(q(2 ** 32)) + 1n;
    for (const signBit of [0n, 1n << 127n]) {
      const next = '0x' + (signBit | nextMagnitude).toString(16).padStart(32, '0');
      await assert.rejects(geometry.displacement(zero, [next, q(0), q(0)], qvec([1, 2, 3])));
    }
    const negativeZero = '0x80000000000000000000000000000000';
    assert.deepEqual([...(await geometry.displacement([negativeZero, q(0), negativeZero], [q(0), negativeZero, negativeZero], qvec([1, 2, 3])))], zero);
  });

  await t.test('validates a positive cutoff strictly below every half-box length', async () => {
    const box = qvec([4, 6, 8]);
    await geometry.validateBox(box, q(1.875));
    for (const cutoff of [q(0), q(-1), q(2), q(3), '0x80000000000000000000000000000000']) {
      await assert.rejects(geometry.validateBox(box, cutoff));
    }
    // Every axis is checked, not just the first or the shortest stored position.
    await assert.rejects(geometry.validateBox(qvec([8, 4, 6]), q(2)));
    await assert.rejects(geometry.validateBox(qvec([8, 6, 4]), q(2)));
    const smallestPositive = '0x00000000000000000000000000000001';
    // Its half-length underflows to zero, so no positive cutoff is admissible.
    await assert.rejects(geometry.validateBox([smallestPositive, q(6), q(8)], smallestPositive));
    assert.deepEqual([...(await geometry.displacement(zero, zero, [smallestPositive, q(6), q(8)]))], zero);
  });

  await t.test('rejects nonfinite, nonpositive, overflowing and missing-dependency inputs', async () => {
    const box = qvec([4, 6, 8]);
    for (const invalid of ['0x7fff0000000000000000000000000000', '0xffff0000000000000000000000000000', '0x7fff8000000000000000000000000000']) {
      await assert.rejects(geometry.displacement([invalid, q(0), q(0)], zero, box));
      await assert.rejects(geometry.displacement(zero, [q(0), invalid, q(0)], box));
      await assert.rejects(geometry.displacement(zero, zero, [q(4), q(6), invalid]));
      await assert.rejects(geometry.validateBox(box, invalid));
    }
    for (const invalid of [q(0), q(-1), '0x80000000000000000000000000000000']) {
      await assert.rejects(geometry.displacement(zero, zero, [invalid, q(6), q(8)]));
      await assert.rejects(geometry.validateBox([q(4), invalid, q(8)], q(1)));
    }
    const largest = '0x7ffeffffffffffffffffffffffffffff';
    const negativeLargest = '0xfffeffffffffffffffffffffffffffff';
    await assert.rejects(geometry.displacement([negativeLargest, q(0), q(0)], [largest, q(0), q(0)], box));
    await assert.rejects(deploy('OrthorhombicGeometry', env.owner, [await env.owner.getAddress()]));
    assert.equal(await geometry.numericalMath(), await math.getAddress());
  });
});
