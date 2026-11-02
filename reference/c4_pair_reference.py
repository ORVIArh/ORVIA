#!/usr/bin/env python3
"""Independent 110-digit scalar-potential and numerical-derivative C4 oracle.

No Solidity operations are replayed. Decode exact submitted binary128 values,
evaluate the scalar distance potential, and differentiate with respect to atom A.
Extra derivative guard bits resolve tiny transverse components without silently
accepting a zero derivative from subtractive cancellation.
"""
import json
import sys
import mpmath as mp

mp.mp.dps = 110


def quad(encoded):
    value = int(encoded, 16)
    sign = -1 if value >> 127 else 1
    exponent = (value >> 112) & 32767
    fraction = value & ((1 << 112) - 1)
    if exponent == 32767:
        raise ValueError('Nonfinite binary128 output')
    if exponent == 0:
        return sign * mp.mpf(fraction) * mp.power(2, -16494)
    return sign * (1 + mp.mpf(fraction) / 2**112) * mp.power(2, exponent - 16383)


def potential(a, b, coefficient):
    distance = mp.sqrt(sum((right - left)**2 for left, right in zip(a, b)))
    return -coefficient / distance**4


def compare(payload):
    records = []
    derivative_records = []
    relative_tolerance = mp.mpf('1e-29')
    absolute_floor = mp.mpf('1e-1000')
    for row in payload['observations']:
        displacement = list(map(quad, row['displacement']))
        coefficient = quad(row['c4'])
        origin = [mp.mpf(0)] * 3
        expected_energy = potential(origin, displacement, coefficient)
        r2 = sum(value**2 for value in displacement)
        analytic_force = [4 * coefficient * value / r2**3 for value in displacement]
        derivative_force = []
        for axis in range(3):
            def displaced_potential(coordinate):
                a = origin.copy()
                a[axis] = coordinate
                return potential(a, displacement, coefficient)
            derivative = -mp.diff(displaced_potential, mp.mpf(0), addprec=2048)
            derivative_force.append(derivative)
            error = abs(derivative - analytic_force[axis])
            tolerance = mp.mpf('1e-95') * abs(analytic_force[axis]) + mp.mpf('1e-1000')
            if error > tolerance:
                raise AssertionError(f"{row['name']} derivative axis {axis} failed")
            derivative_records.append({'label': f"{row['name']}.dU_dA{axis}",
                'absolute_error': mp.nstr(error, 20), 'passed': True})
        expected = [expected_energy, *derivative_force]
        actual = [row['energy'], *row['forceOnA']]
        for label, encoded, target in zip(['energy', 'forceX', 'forceY', 'forceZ'], actual, expected):
            result = quad(encoded)
            error = abs(result - target)
            tolerance = absolute_floor + relative_tolerance * abs(target)
            if error > tolerance:
                raise AssertionError(f"{row['name']}.{label}: error={error}; tolerance={tolerance}")
            records.append({'label': f"{row['name']}.{label}", 'passed': True,
                'absolute_error': mp.nstr(error, 20),
                'relative_error': mp.nstr(error / abs(target), 20) if target else '0'})
    return {'passed': True, 'reference': f'mpmath {mp.__version__} at110 decimaldigits',
        'decimal_precision': 110, 'derivative_method': 'mp.diff of scalar U with respect to each atom-A coordinate',
        'derivative_guard_bits': 2048, 'relative_tolerance': str(relative_tolerance),
        'absolute_floor': str(absolute_floor), 'pairs_checked': len(payload['observations']),
        'values_checked': len(records), 'derivatives_checked': len(derivative_records),
        'maximum_relative_error': str(max(mp.mpf(record['relative_error']) for record in records)),
        'values': records, 'derivatives': derivative_records,
        'scope': 'Raw unswitched numerical pair primitive only; no production method or parameter acceptance.'}


if __name__ == '__main__':
    print(json.dumps(compare(json.load(sys.stdin)), indent=2))
