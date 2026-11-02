#!/usr/bin/env python3
"""Independent 100-digit direct-pair references, using Python Decimal only.

These are unswitched, nonperiodic Lennard-Jones and Coulomb pair equations.
No Solidity calculation or molecular simulator supplies the expected values.
The shared encoder only serializes independent inputs and expected values.
"""
from decimal import Decimal, localcontext
from pathlib import Path
import json

from generate_bond_vectors import binary128_nearest


def binary128_decimal(encoded):
    """Decode one finite normal binary128 value exactly for fixture creation."""
    bits = int(encoded, 16)
    exponent = (bits >> 112) & 0x7fff
    fraction = bits & ((1 << 112) - 1)
    if exponent in (0, 0x7fff):
        raise ValueError('Fixture decoder requires a finite normal value')
    power = exponent - 16383 - 112
    significand = (1 << 112) | fraction
    with localcontext() as ctx:
        ctx.prec = 200
        value = Decimal(significand) * Decimal(2) ** power
        return str(-value if bits >> 127 else value)


def _geometry(a, b):
    a, b = [Decimal(x) for x in a], [Decimal(x) for x in b]
    if len(a) != 3 or len(b) != 3 or not all(x.is_finite() for x in a + b):
        raise ValueError('Expected finite three-dimensional coordinates')
    displacement = [bb - aa for aa, bb in zip(a, b)]
    distance_squared = sum(x * x for x in displacement)
    if not distance_squared:
        raise ValueError('Zero separation')
    return displacement, distance_squared, distance_squared.sqrt()


def evaluate_lj(a, b, sigma, epsilon):
    """Return U and -gradient_A U for U=4 epsilon [(sigma/r)^12-(sigma/r)^6]."""
    with localcontext() as ctx:
        ctx.prec = 100
        sigma, epsilon = Decimal(sigma), Decimal(epsilon)
        if not sigma.is_finite() or not epsilon.is_finite() or sigma <= 0 or epsilon < 0:
            raise ValueError('Require finite sigma > 0 and epsilon >= 0')
        d, r_squared, r = _geometry(a, b)
        ratio = sigma / r
        energy = 4 * epsilon * (ratio ** 12 - ratio ** 6)
        # Differentiating U(r) with r=|b-a| gives F_A = (dU/dr) (b-a)/r.
        radial_derivative = 24 * epsilon * (ratio ** 6 - 2 * ratio ** 12) / r
        force = [radial_derivative * x / r for x in d]
        return str(energy), [str(x) for x in force]


def evaluate_coulomb(a, b, charge_product, prefactor):
    """Return U and -gradient_A U for U=prefactor*charge_product/r."""
    with localcontext() as ctx:
        ctx.prec = 100
        charge_product, prefactor = Decimal(charge_product), Decimal(prefactor)
        if not charge_product.is_finite() or not prefactor.is_finite() or prefactor < 0:
            raise ValueError('Require finite charge product and prefactor >= 0')
        d, r_squared, r = _geometry(a, b)
        strength = prefactor * charge_product
        energy = strength / r
        force = [-strength * x / r ** 3 for x in d]
        return str(energy), [str(x) for x in force]


with localcontext() as _ctx:
    _ctx.prec = 100
    # The exact LJ minimum is irrational. This fixture uses the closest
    # binary128 separation, with its small nonzero force retained in the oracle.
    NEAREST_LJ_MINIMUM = binary128_decimal(binary128_nearest(Decimal(2) ** (Decimal(1) / 6)))


LJ_CASES = [
    ('axis_sigma_repulsion', ['0', '0', '0'], ['1', '0', '0'], '1', '1'),
    ('translated_nonaxis_repulsion', ['1', '-2', '0.5'], ['1.5', '-1.5', '1'], '1', '0.5'),
    ('three_axis_attraction', ['-1', '2', '3'], ['1', '5', '9'], '4', '0.75'),
    ('irrational_distance', ['0.125', '-0.75', '2'], ['-1.25', '0.5', '3.5'], '1.25', '0.75'),
    ('near_minimum_binary128', ['0', '0', '0'], [NEAREST_LJ_MINIMUM, '0', '0'], '1', '1'),
    ('zero_epsilon', ['0.25', '-0.5', '1'], ['1.25', '1.5', '4'], '1.5', '0'),
    ('long_range_attraction', ['-2', '3', '-1'], ['1', '7', '11'], '2', '0.125'),
]

COULOMB_CASES = [
    ('axis_like_charge_repulsion', ['0', '0', '0'], ['2', '0', '0'], '2', '3'),
    ('axis_opposite_charge_attraction', ['0', '0', '0'], ['2', '0', '0'], '-2', '3'),
    ('translated_3_4_attraction', ['1', '-2', '0.5'], ['4', '2', '0.5'], '-0.5', '2'),
    ('three_axis_repulsion', ['-1', '2', '3'], ['1', '5', '9'], '1.5', '0.75'),
    ('irrational_distance', ['0.125', '-0.75', '2'], ['-1.25', '0.5', '3.5'], '-0.75', '2.5'),
    ('neutral_pair', ['0.25', '-0.5', '1'], ['1.25', '1.5', '4'], '0', '4'),
    ('zero_prefactor', ['-2', '3', '-1'], ['1', '7', '11'], '2', '0'),
]


def _vectors(cases, evaluate, parameter_names):
    vectors = []
    for name, a, b, p, q in cases:
        energy, force = evaluate(a, b, p, q)
        vector = {
            'name': name,
            'input_decimal': {'a': a, 'b': b, parameter_names[0]: p, parameter_names[1]: q},
            'a': [binary128_nearest(x) for x in a],
            'b': [binary128_nearest(x) for x in b],
            parameter_names[0]: binary128_nearest(p),
            parameter_names[1]: binary128_nearest(q),
            'expected': {
                'energy_decimal': energy,
                'force_on_a_decimal': force,
                'energy_nearest_binary128': binary128_nearest(energy),
                'force_on_a_nearest_binary128': [binary128_nearest(x) for x in force],
            },
        }
        vectors.append(vector)
    return vectors


def payload():
    return {
        'schema_version': 1,
        'generator': 'Independent analytic pair equations evaluated with Python Decimal at 100 digits',
        'scope': 'Unswitched nonperiodic direct pairs; no cutoff, minimum image, PME, softcore, MD or free-energy result.',
        'units': {
            'position_and_sigma': 'Any one consistently declared length unit',
            'epsilon_and_energy': 'Any one consistently declared energy unit',
            'chargeProduct': 'Product of charges in the declared charge unit squared',
            'prefactor': 'Energy times length divided by the declared charge unit squared',
            'force': 'Declared energy unit divided by declared length unit',
        },
        'comparison': {
            'relative_tolerance': '1e-28',
            'absolute_tolerance': '1e-30',
            'note': 'Primitive engineering tolerance, not a production MD error budget. Near-minimum LJ force is small but not mathematically zero.',
        },
        'lj_vectors': _vectors(LJ_CASES, evaluate_lj, ('sigma', 'epsilon')),
        'coulomb_vectors': _vectors(COULOMB_CASES, evaluate_coulomb, ('chargeProduct', 'prefactor')),
    }


def main():
    result = payload()
    destination = Path(__file__).with_name('nonbonded_vectors.json')
    destination.write_text(json.dumps(result, indent=2) + '\n')
    print(f'Wrote {len(result["lj_vectors"])} LJ and {len(result["coulomb_vectors"])} Coulomb vectors to {destination}')


if __name__ == '__main__':
    main()
