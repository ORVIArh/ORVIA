#!/usr/bin/env python3
"""Independent 100-digit Decimal harmonic-bond references; no Solidity imports."""
from decimal import Decimal, localcontext
from pathlib import Path
import json


def binary128_nearest(value):
    """Encode a finite Decimal as binary128, round nearest ties even.

    Used to prepare exactly representable dyadic inputs and report rounded
    expected values. Solidity output is compared numerically, not presumed to
    share this reference's rounding policy.
    """
    x = Decimal(value)
    sign = int(x.is_signed())
    if not x:
        return '0x' + f'{sign << 127:032x}'
    p, q = x.copy_abs().as_integer_ratio()
    exponent = p.bit_length() - q.bit_length()
    if exponent >= 0:
        if p < (q << exponent):
            exponent -= 1
    elif (p << -exponent) < q:
        exponent -= 1
    if not -16382 <= exponent <= 16383:
        raise ValueError('Reference inputs must be normal binary128 numbers')
    shift = 112 - exponent
    if shift >= 0:
        p <<= shift
    else:
        q <<= -shift
    mantissa, rem = divmod(p, q)
    if 2 * rem > q or (2 * rem == q and mantissa & 1):
        mantissa += 1
    if mantissa == 1 << 113:
        mantissa >>= 1
        exponent += 1
    bits = (sign << 127) | ((exponent + 16383) << 112) | (mantissa - (1 << 112))
    return '0x' + f'{bits:032x}'


def evaluate(a, b, k, r0):
    with localcontext() as ctx:
        ctx.prec = 100
        a, b = [Decimal(x) for x in a], [Decimal(x) for x in b]
        k, r0 = Decimal(k), Decimal(r0)
        d = [bb - aa for aa, bb in zip(a, b)]
        r = sum(x*x for x in d).sqrt()
        dr = r-r0
        energy = k*dr*dr/Decimal(2)
        force = [k*dr*x/r for x in d]
        return str(energy), [str(x) for x in force]


CASES = [
    ('axis_extension', ['0','0','0'], ['2','0','0'], '3', '1'),
    ('translated_3_4_extension', ['1','-2','0.5'], ['4','2','0.5'], '2', '4'),
    ('three_axis_compression', ['-1','2','3'], ['1','5','9'], '3', '8'),
    ('irrational_distance', ['0.125','-0.75','2'], ['-1.25','0.5','3.5'], '0.75', '1.5'),
    ('three_axis_equilibrium', ['-2','3','-1'], ['1','7','11'], '10', '13'),
    ('weak_compression', ['0.5','0.25','-0.5'], ['1.5','2.25','1.5'], '0.125', '4'),
    ('zero_spring_constant', ['0','0','0'], ['1','2','3'], '0', '1'),
]


def main():
    vectors = []
    for name,a,b,k,r0 in CASES:
        e, f = evaluate(a,b,k,r0)
        vectors.append({
            'name': name,
            'input_decimal': {'a': a, 'b': b, 'k': k, 'r0': r0},
            'a': [binary128_nearest(x) for x in a],
            'b': [binary128_nearest(x) for x in b],
            'k': binary128_nearest(k), 'r0': binary128_nearest(r0),
            'expected': {'energy_decimal': e, 'force_on_a_decimal': f,
                         'energy_nearest_binary128': binary128_nearest(e),
                         'force_on_a_nearest_binary128': [binary128_nearest(x) for x in f]},
        })
    payload = {
        'schema_version': 1,
        'generator': 'Python Decimal at 100 digits with independent analytic bond equations',
        'units': {'position':'nm','k':'kJ mol^-1 nm^-2','energy':'kJ mol^-1','force':'kJ mol^-1 nm^-1'},
        'comparison': {'relative_tolerance':'1e-28','absolute_tolerance':'1e-30',
                       'note':'Engineering tolerance for this primitive only; not a production MD error budget.'},
        'vectors': vectors,
    }
    dest=Path(__file__).with_name('harmonic_bond_vectors.json')
    dest.write_text(json.dumps(payload,indent=2)+'\n')
    print(f'Wrote {len(vectors)} independent reference vectors to {dest}')

if __name__=='__main__':
    main()
