#!/usr/bin/env python3
"""Exact rational checks for the documented bounded-domain cell-error argument.

This checks the algebra after the source-audited basic-operation envelopes. It is
not a machine-checked proof of every branch of ABDKMathQuad or the EVM.
"""
from fractions import Fraction as F
import json


def power(exponent):
    return F(2**exponent) if exponent >= 0 else F(1, 2**-exponent)


def audit():
    eps = power(-110)  # Four 113-significand-bit ulps, not nearest rounding u.
    eta = power(-16462)  # min-subnormal quantum / smallest supported box.
    image = power(30)
    x_bound = (image + eta) / (1 - eps)
    # Truncating toInt is exact on the represented quotient. A changed integer
    # image represents a whole lattice shift; compare errors on the periodic torus.
    point_raw = eps * image + eps * max(x_bound, image * (1 + eps)) + 8 * eps + 16 * eta
    delta_error = eps * x_bound + eta
    delta_bound = 2 * x_bound + delta_error
    pair_image = 2 * image + 2
    pair_raw = delta_error + eps * pair_image + eps * max(delta_bound, pair_image * (1 + eps)) + 8 * eps + 32 * eta
    assert point_raw < power(-72)
    assert pair_raw < power(-71)
    combined = 2 * power(-72) + power(-71)
    assert combined == power(-70)

    guard = 1 + power(-32)
    width_over_cutoff = guard * (1 - eps) / (1 + eps)
    assert width_over_cutoff > 1 + power(-33)
    margin_over_box = (1 - 1 / width_over_cutoff) / 64
    assert margin_over_box > power(-40)
    # A non-neighboring cell is at least one exact width away on an axis.
    distance_over_cutoff = width_over_cutoff * (1 - 64 * combined)
    assert distance_over_cutoff > 1 + power(-34)

    # ABDK sqrt normalizes the integer radicand into [2^224,2^226). The
    # first Newton step from 2^112 has <=1/4 relative error. Six further
    # steps include conservative integer-division/shift losses.
    newton_error = F(1, 4) + eps
    for _ in range(6):
        newton_error = newton_error**2 / (2 * (1 - newton_error)) + eps
    final_sqrt_error = newton_error / (1 - newton_error) + power(-112)
    assert final_sqrt_error < power(-100)
    # Positive ordered sums cannot fall below their largest represented term.
    # Squaring a component has the audited eps bound. Check squared inequalities
    # to avoid assuming a correctly rounded real square root in this script.
    norm_factor_squared = distance_over_cutoff**2 * (1 - eps) * (1 - power(-100))**2
    assert norm_factor_squared > 1
    return {
        "passed": True,
        "scope": "Exact rational algebra for the source-audited restricted-domain candidate-completeness argument; not universal ABDK/EVM formal verification.",
        "roundToNearestAssumed": False,
        "basicOperationEnvelope": "2^-110 times operand scale plus min-subnormal quantum",
        "boxDomain": "2^-32 <= each box length <= 2^32",
        "cutoffDomain": "2^-64 <= cutoff < every half box length",
        "coordinateDomain": "abs(fl(coordinate/boxLength)) <= 2^30",
        "maximumAxisCells": 64,
        "pointWrappingAndBinningErrorOverBoxLessThan": "2^-72",
        "pairMinimumImageErrorOverBoxLessThan": "2^-71",
        "combinedErrorOverBoxAtMost": "2^-70",
        "cellWidthMinusCutoffOverBoxGreaterThan": "2^-40",
        "nonNeighborEvmComponentOverCutoffGreaterThan": "1+2^-34",
        "sqrtRelativeErrorLessThan": "2^-100 (restricted normal radicands)",
        "exactRationalNormLowerBoundSquaredExceedsCutoffSquared": True,
        "manualPinnedImplementationEnvelopeAuditRequired": True,
    }


if __name__ == "__main__":
    print(json.dumps(audit(), indent=2))
