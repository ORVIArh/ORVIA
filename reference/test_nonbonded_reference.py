"""Independent oracle checks; these do not replace EVM execution tests."""
import json
from pathlib import Path
import unittest
from decimal import Decimal, localcontext

from generate_nonbonded_vectors import (
    COULOMB_CASES, LJ_CASES, evaluate_coulomb, evaluate_lj, payload,
)


class NonbondedReferenceTests(unittest.TestCase):
    def test_fixture_is_reproducible(self):
        stored = json.loads(Path(__file__).with_name('nonbonded_vectors.json').read_text())
        self.assertEqual(stored, payload())

    def test_input_values_are_exact_binary128(self):
        # Compare the rational value of each input to its encoded binary128;
        # this catches a reference silently evaluating pre-rounded operands.
        for group in ('lj_vectors', 'coulomb_vectors'):
            for vector in payload()[group]:
                for key, raw in vector['input_decimal'].items():
                    decimals = raw if isinstance(raw, list) else [raw]
                    encoded = vector[key] if isinstance(raw, list) else [vector[key]]
                    for source, bits_hex in zip(decimals, encoded):
                        numerator, denominator = Decimal(source).as_integer_ratio()
                        bits = int(bits_hex, 16)
                        exponent = (bits >> 112) & 0x7fff
                        fraction = bits & ((1 << 112) - 1)
                        if numerator == 0:
                            self.assertEqual(bits & ((1 << 127) - 1), 0)
                            continue
                        significand = ((1 << 112) | fraction) * (-1 if bits >> 127 else 1)
                        power = exponent - 16383 - 112
                        encoded_num, encoded_den = (significand << power, 1) if power >= 0 else (significand, 1 << -power)
                        self.assertEqual(numerator * encoded_den, encoded_num * denominator, (vector['name'], key))

    def test_exact_axis_values_and_force_sign(self):
        energy, force = evaluate_lj(['0', '0', '0'], ['1', '0', '0'], '1', '1')
        self.assertEqual(Decimal(energy), 0)
        self.assertEqual([Decimal(x) for x in force], [Decimal(-24), Decimal(0), Decimal(0)])
        for product, expected_energy, expected_force in [('2', '3', '-1.5'), ('-2', '-3', '1.5')]:
            energy, force = evaluate_coulomb(['0', '0', '0'], ['2', '0', '0'], product, '3')
            self.assertEqual(Decimal(energy), Decimal(expected_energy))
            self.assertEqual([Decimal(x) for x in force], [Decimal(expected_force), Decimal(0), Decimal(0)])

    def test_lj_minimum(self):
        with localcontext() as ctx:
            ctx.prec = 100
            minimum = Decimal(2) ** (Decimal(1) / 6)
            energy, force = evaluate_lj(['0', '0', '0'], [minimum, '0', '0'], '1', '1')
            self.assertLess(abs(Decimal(energy) + 1), Decimal('1e-95'))
            self.assertLess(abs(Decimal(force[0])), Decimal('1e-95'))
            _, a, b, sigma, epsilon = LJ_CASES[4]
            energy, force = evaluate_lj(a, b, sigma, epsilon)
            self.assertLess(abs(Decimal(energy) + 1), Decimal('1e-60'))
            self.assertLess(abs(Decimal(force[0])), Decimal('1e-30'))

    def test_zero_strengths(self):
        a, b = ['0.25', '-0.5', '1'], ['1.25', '1.5', '4']
        for evaluate, p, q in [(evaluate_lj, '1', '0'), (evaluate_coulomb, '0', '1'), (evaluate_coulomb, '1', '0')]:
            energy, force = evaluate(a, b, p, q)
            self.assertEqual(Decimal(energy), 0)
            self.assertTrue(all(Decimal(x) == 0 for x in force))

    def test_exchange_and_translation(self):
        with localcontext() as ctx:
            ctx.prec = 160
            for cases, evaluate in [(LJ_CASES, evaluate_lj), (COULOMB_CASES, evaluate_coulomb)]:
                for name, a, b, p, q in cases:
                    energy, force = evaluate(a, b, p, q)
                    reverse_energy, reverse_force = evaluate(b, a, p, q)
                    self.assertEqual(Decimal(energy), Decimal(reverse_energy), name)
                    self.assertEqual([Decimal(x) for x in force], [-Decimal(x) for x in reverse_force], name)
                    shift = [Decimal('1.25'), Decimal('-0.5'), Decimal('2')]
                    shifted_a = [str(Decimal(x) + t) for x, t in zip(a, shift)]
                    shifted_b = [str(Decimal(x) + t) for x, t in zip(b, shift)]
                    moved_energy, moved_force = evaluate(shifted_a, shifted_b, p, q)
                    self.assertEqual(Decimal(energy), Decimal(moved_energy), name)
                    self.assertEqual([Decimal(x) for x in force], [Decimal(x) for x in moved_force], name)

    def test_force_is_negative_energy_gradient(self):
        with localcontext() as ctx:
            ctx.prec = 160
            step = Decimal('1e-30')
            for cases, evaluate in [(LJ_CASES, evaluate_lj), (COULOMB_CASES, evaluate_coulomb)]:
                for name, a, b, p, q in cases:
                    _, force = evaluate(a, b, p, q)
                    for axis in range(3):
                        minus, plus = list(a), list(a)
                        minus[axis] = str(Decimal(a[axis]) - step)
                        plus[axis] = str(Decimal(a[axis]) + step)
                        energy_minus, _ = evaluate(minus, b, p, q)
                        energy_plus, _ = evaluate(plus, b, p, q)
                        gradient_force = -(Decimal(energy_plus) - Decimal(energy_minus)) / (2 * step)
                        expected_force = Decimal(force[axis])
                        tolerance = Decimal('1e-50') * (1 + abs(expected_force))
                        self.assertLess(abs(gradient_force - expected_force), tolerance, (name, axis))

    def test_invalid_oracle_domains(self):
        a, b = ['0', '0', '0'], ['1', '0', '0']
        for evaluate, p, q in [(evaluate_lj, '0', '1'), (evaluate_lj, '1', '-1'), (evaluate_coulomb, '1', '-1')]:
            with self.assertRaises(ValueError):
                evaluate(a, b, p, q)
        for evaluate in [evaluate_lj, evaluate_coulomb]:
            with self.assertRaises(ValueError):
                evaluate(a, a, '1', '1')


if __name__ == '__main__':
    unittest.main()
