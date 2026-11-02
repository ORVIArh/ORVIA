"""Independent decimal SHAKE/RATTLE iteration and conservation checks.

Input contains exact binary128 words. The SHAKE reference uses the direct
quadratic root, independent of the contract's cancellation-resistant formula.
This validates synthetic projections, not a constrained production integrator.
"""
import json
import sys
import mpmath as mp

mp.mp.dps = 110


def q(word):
    bits = int(word, 16)
    sign = -1 if bits >> 127 else 1
    exponent = (bits >> 112) & 32767
    assert exponent != 32767
    fraction = bits & ((1 << 112) - 1)
    return sign * mp.mpf((1 << 112) + fraction if exponent else fraction) * mp.power(2, (exponent or 1) - 16383 - 112)


def vector(words):
    return [q(word) for word in words]


def dot(a, b):
    return mp.fsum(x * y for x, y in zip(a, b))


def difference(a, b):
    return [y - x for x, y in zip(a, b)]


def check(case):
    anchor = [vector(v) for v in case['anchor']]
    current = [vector(v) for v in case['trial']]
    original = [v[:] for v in current]
    actual = [vector(v) for v in case['solution']]
    masses = [q(v) for v in case['masses']]
    constraints = [(a, b, q(d)) for a, b, d in case['constraints']]
    tolerance = q(case['tolerance'])
    velocity = case['mode'] == 'velocity'

    def residual(a, b, distance):
        d = difference(anchor[a], anchor[b])
        v = difference(current[a], current[b])
        return abs(dot(d, v) / dot(d, d)) if velocity else abs(dot(v, v) / distance**2 - 1)

    for sweep in range(case['maxSweeps']):
        for a, b, distance in constraints:
            if residual(a, b, distance) <= tolerance:
                continue
            d = difference(anchor[a], anchor[b])
            v = difference(current[a], current[b])
            if velocity:
                x = dot(d, v) / dot(d, d)
            else:
                cross = dot(d, v)
                defect = dot(v, v) - distance**2
                x = (cross - mp.sqrt(cross**2 - dot(d, d) * defect)) / dot(d, d)
            for axis in range(3):
                current[a][axis] += x * masses[b] / (masses[a] + masses[b]) * d[axis]
                current[b][axis] -= x * masses[a] / (masses[a] + masses[b]) * d[axis]
        maximum = max(residual(a, b, d) for a, b, d in constraints)
        if maximum <= tolerance:
            break
    assert sweep + 1 == case['sweeps'], (case['name'], 'sweep count', sweep + 1, case['sweeps'])
    error = max(abs(actual[a][axis] - current[a][axis]) for a in range(len(actual)) for axis in range(3))
    assert error < mp.mpf('1e-27'), (case['name'], 'solution', str(error))
    conservation = max(abs(mp.fsum(masses[a] * (actual[a][axis] - original[a][axis]) for a in range(len(actual)))) for axis in range(3))
    assert conservation < mp.mpf('1e-27'), (case['name'], 'mass weighted conservation', str(conservation))
    current = actual
    actual_residual = max(residual(a, b, d) for a, b, d in constraints)
    assert actual_residual <= tolerance
    reported = q(case['maximumResidual'])
    assert abs(reported - actual_residual) < mp.mpf('1e-30')
    return {'name': case['name'], 'sweeps': sweep + 1, 'maximumResidual': str(actual_residual),
            'maximumAbsoluteReferenceError': str(error), 'massWeightedConservationError': str(conservation)}


if __name__ == '__main__':
    data = json.load(sys.stdin)
    print(json.dumps({'precisionDigits': mp.mp.dps, 'mpmathVersion': mp.__version__, 'cases': [check(case) for case in data]}))
