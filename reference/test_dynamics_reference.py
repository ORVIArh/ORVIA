"""Oracle sanity checks; separate EVM tests establish contract behavior."""

import json
from pathlib import Path
import unittest

import mpmath as mp

from generate_dynamics_reference import (
    INPUT, PRECISION, cross, dot, encode_inputs, energy_terms, forces,
    generate_payload, initial_state, potential, simulate,
)


class DynamicsReferenceTests(unittest.TestCase):
    def setUp(self):
        self.precision_context = mp.workdps(PRECISION)
        self.precision_context.__enter__()

    def tearDown(self):
        self.precision_context.__exit__(None, None, None)

    def test_inputs_are_exactly_representable_binary128(self):
        def decode(value):
            bits = int(value, 16)
            exponent, fraction = (bits >> 112) & 32767, bits & ((1 << 112) - 1)
            sign = -1 if bits >> 127 else 1
            if not exponent:
                return sign * mp.mpf(fraction) * mp.power(2, -16494)
            return sign * (1 + mp.mpf(fraction) / mp.power(2, 112)) * mp.power(2, exponent - 16383)

        encoded = encode_inputs()
        for stream, start in (("positions", 0), ("particles", 0), ("bonds", 2),
                              ("angles", 3), ("torsions", 5), ("pairs", 2)):
            for source, row in zip(INPUT[stream], encoded[stream]):
                for expected, actual in zip(source[start:], row[start:]):
                    self.assertEqual(decode(actual), mp.mpf(expected))
        self.assertEqual(decode(encoded["dt"]), mp.mpf(INPUT["dt"]))

    def test_every_energy_family_is_exercised(self):
        x, _, _ = initial_state()
        terms = energy_terms(x)
        self.assertEqual(set(terms), {"bonds", "angles", "torsions", "lennard_jones", "coulomb"})
        for name, value in terms.items():
            self.assertNotEqual(value, 0, name)
            self.assertTrue(mp.isfinite(value), name)

    def test_gradient_against_explicit_centered_difference(self):
        x, _, _ = initial_state()
        analytical_reference = forces(x)
        h = mp.mpf("1e-20")
        for atom in range(4):
            for axis in range(3):
                plus, minus = [list(row) for row in x], [list(row) for row in x]
                plus[atom][axis] += h
                minus[atom][axis] -= h
                centered = -(potential(plus) - potential(minus)) / (2 * h)
                self.assertLess(abs(centered - analytical_reference[atom][axis]), mp.mpf("1e-35"))

    def test_internal_force_and_torque_conservation(self):
        x, _, _ = initial_state()
        f = forces(x)
        torque = [cross(position, force) for position, force in zip(x, f)]
        for axis in range(3):
            self.assertLess(abs(mp.fsum(force[axis] for force in f)), mp.mpf("1e-80"))
            self.assertLess(abs(mp.fsum(value[axis] for value in torque)), mp.mpf("1e-80"))

    def test_momentum_and_center_of_mass_motion(self):
        history = simulate()
        total_mass = mp.fsum(mp.mpf(row[0]) for row in INPUT["particles"])
        dt = mp.mpf(INPUT["dt"])
        for state in history:
            for axis in range(3):
                momentum = history[0]["linear_momentum"][axis]
                self.assertLess(abs(state["linear_momentum"][axis] - momentum), mp.mpf("1e-80"))
                expected = history[0]["center_of_mass"][axis] + momentum * state["step"] * dt / total_mass
                self.assertLess(abs(state["center_of_mass"][axis] - expected), mp.mpf("1e-80"))

    def test_velocity_verlet_time_reversal(self):
        forward = simulate()
        backward = simulate(positions=forward[-1]["positions"],
                            velocities=[[-value for value in row] for row in forward[-1]["velocities"]])
        for atom in range(4):
            for axis in range(3):
                self.assertLess(abs(backward[-1]["positions"][atom][axis] - forward[0]["positions"][atom][axis]), mp.mpf("1e-80"))
                self.assertLess(abs(backward[-1]["velocities"][atom][axis] + forward[0]["velocities"][atom][axis]), mp.mpf("1e-80"))

    def test_energy_error_is_second_order_under_timestep_refinement(self):
        coarse = simulate()
        fine = simulate(dt=mp.mpf(INPUT["dt"]) / 2, steps=2 * INPUT["steps"])
        coarse_error = abs(coarse[-1]["total_energy"] - coarse[0]["total_energy"])
        fine_error = abs(fine[-1]["total_energy"] - fine[0]["total_energy"])
        self.assertGreater(coarse_error, 0)
        self.assertLess(coarse_error, mp.mpf("2e-9"))
        self.assertGreater(fine_error / coarse_error, mp.mpf("0.249"))
        self.assertLess(fine_error / coarse_error, mp.mpf("0.251"))

    def test_committed_reference_reproduces(self):
        saved = json.loads(Path(__file__).with_name("dynamics_reference.json").read_text())
        self.assertEqual(generate_payload(), saved)


if __name__ == "__main__":
    unittest.main()
