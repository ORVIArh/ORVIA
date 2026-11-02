"""Exact-rational minimizer fixture from independently differentiated scalar energy."""
from fractions import Fraction as F
import json
from pathlib import Path


def energy(x):
    distances = [abs(x[i + 1] - x[i]) for i in range(2)]
    if any(r == 0 for r in distances):
        raise ValueError('singular bond')
    return sum((r - 1) ** 2 / 2 for r in distances)


def forces(x):
    # Exact centered differentiation: the potential is quadratic within each
    # non-singular ordering region, so its finite-difference derivative is exact.
    h = F(1, 2**40)
    out = []
    for i in range(3):
        plus, minus = list(x), list(x)
        plus[i] += h
        minus[i] -= h
        out.append(-(energy(plus) - energy(minus)) / (2 * h))
    return out


def simulate(initial=(0, 2, 4), initial_step=F(4), tolerance=F(1, 2**30), armijo=F(1, 4), max_iterations=10, max_trials=8):
    x = list(map(F, initial))
    steps, events = 0, []
    while True:
        current = energy(x)
        force = forces(x)
        gradient_squared = sum(f * f for f in force)
        if gradient_squared <= 3 * tolerance**2:
            return {'status': 'converged', 'iterations': steps, 'positions': x, 'energy': current, 'forces': force, 'events': events}
        if steps >= max_iterations:
            return {'status': 'iteration_limit', 'iterations': steps, 'positions': x, 'energy': current, 'forces': force, 'events': events}
        alpha = initial_step
        for trial in range(max_trials):
            proposed = [a + alpha * b for a, b in zip(x, force)]
            target = current - armijo * alpha * gradient_squared
            try:
                candidate = energy(proposed)
                valid = True
            except ValueError:
                candidate, valid = None, False
            accepted = valid and candidate <= target
            events.append({'step': alpha, 'positions': proposed, 'energy': candidate, 'armijo_target': target,
                           'valid_geometry': valid, 'accepted': accepted})
            if accepted:
                x = proposed
                steps += 1
                break
            alpha /= 2
        else:
            return {'status': 'line_search_limit', 'iterations': steps, 'positions': x, 'energy': current, 'forces': force, 'events': events}


def stringify(value):
    if isinstance(value, F):
        return str(value)
    if isinstance(value, dict):
        return {k: stringify(v) for k, v in value.items()}
    if isinstance(value, list):
        return [stringify(v) for v in value]
    return value


def fixture():
    return {'scope': 'Three-atom unit harmonic chain with all nonbonded pairs excluded; no general protein convergence claim',
            'method': 'Exact rational scalar energies and centered differentiation within quadratic regions',
            'cases': {'main': stringify(simulate()), 'iteration_limit': stringify(simulate(initial_step=F(1, 4), max_iterations=1)),
                      'line_search_limit': stringify(simulate(max_trials=1)), 'stationary': stringify(simulate(initial=(1, 2, 3)))}}


if __name__ == '__main__':
    Path(__file__).with_name('minimizer_reference.json').write_text(json.dumps(fixture(), indent=2) + '\n')
