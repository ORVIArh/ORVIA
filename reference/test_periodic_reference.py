"""Independent oracle sanity checks; contract behavior is tested separately."""
from copy import deepcopy
import json
from pathlib import Path
import unittest

import mpmath as mp

from generate_periodic_reference import (
    INPUT, PRECISION, displacement, encode_inputs, energy_terms, forces,
    generate_payload, initial_state, pair_energy, pair_records, potential, simulate,
)


class PeriodicReferenceTests(unittest.TestCase):
    def setUp(self):
        self.precision_context = mp.workdps(PRECISION)
        self.precision_context.__enter__()

    def tearDown(self):
        self.precision_context.__exit__(None, None, None)

    def test_inputs_are_exact_binary128(self):
        def decode(value):
            bits = int(value, 16)
            exponent, fraction = (bits >> 112) & 32767, bits & ((1 << 112) - 1)
            sign = -1 if bits >> 127 else 1
            if not exponent:
                return sign*mp.mpf(fraction)*mp.power(2, -16494)
            return sign*(1 + mp.mpf(fraction)/mp.power(2,112))*mp.power(2, exponent - 16383)
        encoded = encode_inputs()
        for stream, start in (("positions", 0), ("particles", 0), ("bonds", 2), ("angles", 3),
                              ("torsions", 5), ("nonbonded", 0), ("exceptions", 3)):
            for raw, row in zip(INPUT[stream], encoded[stream]):
                for expected, actual in zip(raw[start:], row[start:]):
                    self.assertEqual(decode(actual), mp.mpf(expected))
        for name in ("dt", "switchDistance", "cutoff", "prefactor"):
            self.assertEqual(decode(encoded[name]), mp.mpf(INPUT[name]))
        for raw, value in zip(INPUT["box"], encoded["box"]):
            self.assertEqual(decode(value), mp.mpf(raw))

    def test_all_energy_families_and_pair_branches(self):
        x, _, _ = initial_state()
        for name, value in energy_terms(x).items():
            self.assertNotEqual(value, 0, name)
            self.assertTrue(mp.isfinite(value), name)
        pairs = pair_records(x)
        self.assertEqual([row["atoms"] for row in pairs], [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]])
        self.assertEqual([row["kind"] for row in pairs],
                         ["excluded", "inside_switch", "outside_cutoff", "exception", "switching", "inside_switch"])
        self.assertEqual(pairs[0]["lennard_jones"], 0)
        self.assertEqual(pairs[2]["coulomb"], 0)

    def test_gradient_with_independent_centered_difference(self):
        x, _, _ = initial_state()
        reference_force = forces(x)
        h = mp.mpf("1e-20")
        for atom in range(4):
            for axis in range(3):
                plus, minus = [list(row) for row in x], [list(row) for row in x]
                plus[atom][axis] += h
                minus[atom][axis] -= h
                centered = -(potential(plus)-potential(minus))/(2*h)
                self.assertLess(abs(centered-reference_force[atom][axis]), mp.mpf("1e-35"))

    def test_periodic_image_translation_invariance(self):
        x, _, _ = initial_state()
        shifts = [[2,-3,1],[-1,2,4],[3,1,-2],[-4,-2,3]]
        shifted = [[x[i][axis]+shifts[i][axis]*mp.mpf(INPUT["box"][axis]) for axis in range(3)] for i in range(4)]
        self.assertLess(abs(potential(x)-potential(shifted)), mp.mpf("1e-80"))
        original_forces, shifted_forces = forces(x), forces(shifted)
        for a in range(4):
            for axis in range(3):
                self.assertLess(abs(original_forces[a][axis]-shifted_forces[a][axis]), mp.mpf("1e-80"))

    def test_half_box_ties_and_multiple_images(self):
        zero = [mp.mpf(0)]*3
        box = [mp.mpf(8)]*3
        self.assertEqual(displacement(zero,[mp.mpf(4),mp.mpf(-12),mp.mpf(25)],box), [4,-4,1])
        forward = displacement(zero,[mp.mpf(12),mp.mpf(-4),mp.mpf(-17)],box)
        reverse = displacement([mp.mpf(12),mp.mpf(-4),mp.mpf(-17)],zero,box)
        self.assertEqual(forward, [-v for v in reverse])

    def test_bonded_and_direct_exception_half_box_images_are_rejected(self):
        source = deepcopy(INPUT)
        source.update(positions=[["0","0","0"],["4","0","0"]],
                      particles=[["12","0","0","0"],["12","0","0","0"]],
                      bonds=[[0,1,"2","1"]],angles=[],torsions=[],exceptions=[],
                      nonbonded=[["0.5","0.125","0.5"],["0.5","0.125","-0.5"]])
        positions,_,_ = initial_state(source)
        with self.assertRaisesRegex(ValueError,"ambiguous"):
            potential(positions,source)
        source["bonds"] = []
        # A normal pair is outside the strict half-box cutoff and contributes zero.
        self.assertEqual(potential(positions,source),0)
        source["exceptions"] = [[0,1,2,"0.5","0.125","-0.25"]]
        with self.assertRaisesRegex(ValueError,"ambiguous"):
            potential(positions,source)

    def test_internal_force_momentum_and_unwrapped_center_of_mass(self):
        history = simulate()
        total_mass = mp.fsum(mp.mpf(row[0]) for row in INPUT["particles"])
        dt = mp.mpf(INPUT["dt"])
        for state in history:
            for axis in range(3):
                self.assertLess(abs(mp.fsum(row[axis] for row in state["forces"])), mp.mpf("1e-80"))
                momentum = history[0]["linear_momentum"][axis]
                self.assertLess(abs(state["linear_momentum"][axis]-momentum), mp.mpf("1e-80"))
                expected = history[0]["center_of_mass"][axis]+momentum*state["step"]*dt/total_mass
                self.assertLess(abs(state["center_of_mass"][axis]-expected), mp.mpf("1e-80"))

    def test_velocity_verlet_reversal(self):
        forward = simulate()
        backward = simulate(positions=forward[-1]["positions"],
                            velocities=[[-v for v in row] for row in forward[-1]["velocities"]])
        for atom in range(4):
            for axis in range(3):
                self.assertLess(abs(backward[-1]["positions"][atom][axis]-forward[0]["positions"][atom][axis]), mp.mpf("1e-80"))
                self.assertLess(abs(backward[-1]["velocities"][atom][axis]+forward[0]["velocities"][atom][axis]), mp.mpf("1e-80"))

    def test_timestep_refinement(self):
        coarse = simulate()
        fine = simulate(dt=mp.mpf(INPUT["dt"])/2, steps=2*INPUT["steps"])
        coarse_error = abs(coarse[-1]["total_energy"]-coarse[0]["total_energy"])
        fine_error = abs(fine[-1]["total_energy"]-fine[0]["total_energy"])
        self.assertGreater(coarse_error, 0)
        self.assertLess(coarse_error, mp.mpf("3e-9"))
        self.assertGreater(fine_error/coarse_error, mp.mpf("0.249"))
        self.assertLess(fine_error/coarse_error, mp.mpf("0.251"))

    def test_switch_and_cutoff_energy_force_continuity(self):
        # Distinct one-sided probes, including the product derivative of the LJ switch.
        args = tuple(map(mp.mpf, ("0.75", "0.125", "-0.25")))
        h = mp.mpf("1e-22")
        rs, rc = mp.mpf(INPUT["switchDistance"]), mp.mpf(INPUT["cutoff"])
        for term in range(2):
            energy = lambda r: pair_energy(r,*args)[term]
            self.assertLess(abs(energy(rs-h)-energy(rs+h)), mp.mpf("1e-21"))
            self.assertLess(abs(mp.diff(energy,rs-h)-mp.diff(energy,rs+h)), mp.mpf("1e-21"))
            self.assertEqual(energy(rc), 0)
            self.assertEqual(energy(rc+h), 0)
            self.assertLess(abs(energy(rc-h)), mp.mpf("1e-43"))
            self.assertLess(abs(mp.diff(energy,rc-h)), mp.mpf("1e-22"))

    def test_exceptions_remain_active_beyond_cutoff(self):
        radius = mp.mpf("3.5")
        params = (mp.mpf("0.5"),mp.mpf("0.125"),mp.mpf("-0.25"))
        self.assertEqual(pair_energy(radius,*params), (0,0))
        lj,coulomb = pair_energy(radius,*params,exception=True)
        self.assertNotEqual(lj,0)
        self.assertEqual(coulomb,-mp.mpf("0.25")/radius)
        # An excluded pair is ignored even if it is coincident, at the pair layer.
        source = deepcopy(INPUT)
        positions,_,_ = initial_state()
        positions[1] = list(positions[0])
        excluded = pair_records(positions,source)[0]
        self.assertEqual(excluded["kind"],"excluded")
        self.assertEqual(excluded["lennard_jones"],0)

    def test_face_crossing_and_separate_cutoff_crossing(self):
        history = simulate()
        self.assertLess(history[0]["positions"][0][0],8)
        self.assertGreater(history[-1]["positions"][0][0],8)
        self.assertEqual([p["kind"] for p in pair_records(history[0]["positions"])],
                         [p["kind"] for p in pair_records(history[-1]["positions"])])
        source = deepcopy(INPUT)
        source.update(positions=[["0","0","0"],["2.99609375","0","0"]],
                      particles=[["12","-0.5","0","0"],["12","0.5","0","0"]],
                      bonds=[[0,1,"0","1"]],angles=[],torsions=[],exceptions=[],
                      nonbonded=[["0.5","0.125","0.5"],["0.5","0.125","-0.5"]],steps=2)
        crossing = simulate(source=source)
        self.assertEqual(pair_records(crossing[0]["positions"],source)[0]["kind"],"switching")
        self.assertEqual(pair_records(crossing[1]["positions"],source)[0]["kind"],"outside_cutoff")
        self.assertTrue(all(value == 0 for row in crossing[1]["forces"] for value in row))
        self.assertEqual(crossing[1]["potential_energy"],0)

    def test_saved_reference_reproduces(self):
        saved = json.loads(Path(__file__).with_name("periodic_reference.json").read_text())
        self.assertEqual(generate_payload(),saved)


if __name__ == "__main__":
    unittest.main()
