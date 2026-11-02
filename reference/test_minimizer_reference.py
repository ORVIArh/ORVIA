import json
from pathlib import Path
import unittest
from fractions import Fraction as F
from generate_minimizer_reference import energy, forces, simulate, fixture


class MinimizerReferenceTests(unittest.TestCase):
    def test_independent_gradient_and_stationary_minimum(self):
        self.assertEqual(energy([F(0), F(2), F(4)]), 1)
        self.assertEqual(forces([F(0), F(2), F(4)]), [1, 0, -1])
        self.assertEqual(forces([F(1), F(2), F(3)]), [0, 0, 0])

    def test_energy_rejection_singular_rejection_then_exact_minimum(self):
        result = simulate()
        self.assertEqual(result['status'], 'converged')
        self.assertEqual([e['step'] for e in result['events']], [4, 2, 1])
        self.assertEqual([e['accepted'] for e in result['events']], [False, False, True])
        self.assertEqual([e['valid_geometry'] for e in result['events']], [True, False, True])
        self.assertEqual(result['positions'], [1, 2, 3])
        self.assertEqual(result['energy'], 0)
        self.assertEqual(result['iterations'], 1)

    def test_explicit_limits(self):
        self.assertEqual(simulate(max_trials=1)['status'], 'line_search_limit')
        result = simulate(initial_step=F(1, 4), max_iterations=1)
        self.assertEqual(result['status'], 'iteration_limit')
        self.assertEqual(result['energy'], F(9, 16))
        self.assertEqual(result['positions'], [F(1, 4), 2, F(15, 4)])

    def test_translation_and_force_balance(self):
        x = [F(0), F(2), F(4)]
        self.assertEqual(energy(x), energy([a + 5 for a in x]))
        self.assertEqual(forces(x), forces([a + 5 for a in x]))
        self.assertEqual(sum(forces(x)), 0)

    def test_already_stationary_needs_no_trial(self):
        result = simulate(initial=(1, 2, 3))
        self.assertEqual(result['status'], 'converged')
        self.assertEqual(result['events'], [])

    def test_saved_fixture_reproduces_exactly(self):
        expected = json.loads(Path(__file__).with_name('minimizer_reference.json').read_text())
        self.assertEqual(fixture(), expected)
