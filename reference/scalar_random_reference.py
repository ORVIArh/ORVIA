#!/usr/bin/env python3
"""Compare decoded EVM scalars against independent mpmath functions at 110 digits."""
import json
import sys
import mpmath as mp

mp.mp.dps = 110


def quad(h):
    n = int(h, 16)
    sign = -1 if n >> 127 else 1
    e = (n >> 112) & 32767
    f = n & ((1 << 112)-1)
    if e == 32767:
        raise ValueError('Nonfinite encoding')
    return sign * (mp.mpf(f) * mp.power(2, -16494) if e == 0
                   else (1 + mp.mpf(f) / 2**112) * mp.power(2, e-16383))


def compare(payload):
    records = []

    def check(label, actual_hex, expected):
        actual = quad(actual_hex)
        error = abs(actual-expected)
        tolerance = mp.mpf('1e-150') + abs(expected)*mp.mpf('1e-28')
        if error > tolerance:
            raise AssertionError(f'{label}: {mp.nstr(actual, 45)} != {mp.nstr(expected,45)}; error={error}; tolerance={tolerance}')
        records.append({'label': label, 'absolute_error': str(error),
                        'relative_error': str(error/abs(expected)) if expected else '0', 'passed': True})

    methods = {'ln': mp.log, 'exp': mp.exp, 'expm1': mp.expm1,
               'log1p': mp.log1p, 'erf': mp.erf, 'erfc': mp.erfc}
    for i, row in enumerate(payload['scalar']):
        check(f"{row['method']}[{i}]", row['output'], methods[row['method']](quad(row['input'])))
    for i, row in enumerate(payload.get('normal', [])):
        u, v = map(quad, row['uniform'])
        radius = mp.sqrt(-2*mp.log(u))
        check(f'normal[{i}].cos', row['output'][0], radius*mp.cos(2*mp.pi*v))
        check(f'normal[{i}].sin', row['output'][1], radius*mp.sin(2*mp.pi*v))
    for i, row in enumerate(payload.get('baoab', [])):
        a = row['input']
        mass, dt, gamma, kt = map(quad, a['parameters'])
        x, v, f, normal, fn = [list(map(quad, a[k])) for k in ['position','velocity','force','normal','newForce']]
        decay = mp.exp(-gamma*dt)
        noise = mp.sqrt(kt/mass * -mp.expm1(-2*gamma*dt))
        check(f'baoab[{i}].decay', row['coefficients'][0], decay)
        check(f'baoab[{i}].noise', row['coefficients'][1], noise)
        for d in range(3):
            half = v[d] + dt*f[d]/(2*mass)
            thermal = decay*half+noise*normal[d]
            next_x = x[d] + dt*(half+thermal)/2
            next_v = thermal + dt*fn[d]/(2*mass)
            check(f'baoab[{i}].x{d}', row['begin'][0][d], next_x)
            check(f'baoab[{i}].thermal{d}', row['begin'][1][d], thermal)
            check(f'baoab[{i}].v{d}', row['finish'][d], next_v)
    return {'scope': 'Bounded scalar, deterministic normal-transform and one-atom BAOAB primitive validation; not integrated ensemble validation.',
            'reference': 'mpmath 1.3.0 at 110 decimal digits',
            'relative_tolerance': '1e-28', 'absolute_floor': '1e-150',
            'scalar_values_checked': len(records),
            'maximum_relative_error': str(max(mp.mpf(r['relative_error']) for r in records)),
            'values': records}


if __name__ == '__main__':
    print(json.dumps(compare(json.load(sys.stdin)), indent=2))
