// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FloatMath} from "./FloatMath.sol";
import {ABDKMathQuad} from "./vendor/ABDKMathQuad.sol";

/// @notice Bounded scalar functions for stochastic dynamics and electrostatics.
/// @dev Pinned binary128-format arithmetic; not a correctly-rounded IEEE claim.
contract ScalarMath {
    error InvalidMathContract();
    error NonFiniteInput();
    error OutsideDomain();

    FloatMath public immutable numericalMath;
    bytes32 public constant IMPLEMENTATION_ID = keccak256("ORVIA.ScalarMath.v0.5.ABDK-and-DLMF7.9.2");
    bytes16 public constant INV_SQRT_PI = 0x3ffe20dd750429b6d11ae3a914fed7fe;
    bytes16 public constant MAX_EXP_ARGUMENT = 0x40070000000000000000000000000000; // 256
    bytes16 public constant MAX_ERF_ARGUMENT = 0x40030000000000000000000000000000; // 16
    bytes16 private constant ONE = 0x3fff0000000000000000000000000000;
    bytes16 private constant TWO = 0x40000000000000000000000000000000;
    bytes16 private constant HALF = 0x3ffe0000000000000000000000000000;

    constructor(address math_) {
        if (math_.code.length == 0) revert InvalidMathContract();
        numericalMath = FloatMath(math_);
    }

    function ln(bytes16 x) public view returns (bytes16) {
        _finite(x);
        FloatMath m = numericalMath;
        if (m.compare(x, bytes16(0)) <= 0) revert OutsideDomain();
        // The upstream logarithm loses relative accuracy arbitrarily close to
        // one. Retain the exact small increment and evaluate its atanh series.
        if (m.compare(x, HALF) >= 0 && m.compare(x, m.add(ONE, HALF)) <= 0) {
            return _log1pSmall(m.sub(x, ONE));
        }
        return _result(ABDKMathQuad.ln(x));
    }

    function exp(bytes16 x) public view returns (bytes16) {
        _expDomain(x);
        return _result(ABDKMathQuad.exp(x));
    }

    /// @notice exp(x)-1 without losing a small nonzero x to subtraction.
    function expm1(bytes16 x) external view returns (bytes16) {
        _expDomain(x);
        FloatMath m = numericalMath;
        if (m.compare(m.abs(x), HALF) > 0) return m.sub(exp(x), ONE);
        bytes16 term = x;
        bytes16 sum = x;
        for (uint256 n = 2; n <= 64; ++n) {
            term = ABDKMathQuad.div(ABDKMathQuad.mul(term, x), ABDKMathQuad.fromUInt(n));
            sum = ABDKMathQuad.add(sum, term);
        }
        return _result(sum);
    }

    /// @notice ln(1+x), x>-1, retaining small positive and negative inputs.
    function log1p(bytes16 x) external view returns (bytes16) {
        _finite(x);
        FloatMath m = numericalMath;
        if (m.compare(x, m.neg(ONE)) <= 0) revert OutsideDomain();
        if (m.compare(m.abs(x), HALF) > 0) return ln(m.add(ONE, x));
        return _log1pSmall(x);
    }

    function _log1pSmall(bytes16 x) private view returns (bytes16) {
        bytes16 t = ABDKMathQuad.div(x, ABDKMathQuad.add(TWO, x));
        bytes16 t2 = ABDKMathQuad.mul(t, t);
        bytes16 term = t;
        bytes16 sum = t;
        for (uint256 n = 1; n < 64; ++n) {
            term = ABDKMathQuad.mul(term, t2);
            sum = ABDKMathQuad.add(sum, ABDKMathQuad.div(term, ABDKMathQuad.fromUInt(2 * n + 1)));
        }
        return _result(ABDKMathQuad.mul(TWO, sum));
    }

    function erf(bytes16 x) external view returns (bytes16) {
        _erfDomain(x);
        FloatMath m = numericalMath;
        bytes16 ax = m.abs(x);
        bytes16 value = m.compare(ax, TWO) <= 0 ? _erfSmall(ax) : m.sub(ONE, _erfcTail(ax));
        return m.isNegative(x) ? m.neg(value) : value;
    }

    function erfc(bytes16 x) external view returns (bytes16) {
        _erfDomain(x);
        FloatMath m = numericalMath;
        bytes16 ax = m.abs(x);
        bytes16 value = m.compare(ax, TWO) < 0 ? m.sub(ONE, _erfSmall(ax)) : _erfcTail(ax);
        return m.isNegative(x) ? m.sub(TWO, value) : value;
    }

    // erf(x)=(2/sqrt(pi))*exp(-x*x)*x*sum[(2*x*x)^n/(3*5*...*(2n+1))].
    // Positive series avoids alternating cancellation for 0<=x<=2.
    function _erfSmall(bytes16 x) private view returns (bytes16) {
        bytes16 z = ABDKMathQuad.mul(x, x);
        bytes16 twiceZ = ABDKMathQuad.mul(TWO, z);
        bytes16 term = x;
        bytes16 sum = x;
        for (uint256 n = 1; n < 64; ++n) {
            term = ABDKMathQuad.div(ABDKMathQuad.mul(term, twiceZ), ABDKMathQuad.fromUInt(2 * n + 1));
            sum = ABDKMathQuad.add(sum, term);
        }
        return ABDKMathQuad.mul(ABDKMathQuad.mul(ABDKMathQuad.mul(TWO, INV_SQRT_PI), exp(ABDKMathQuad.neg(z))), sum);
    }

    // DLMF 7.9.2, evaluated backward with 128 numerator levels.
    // Equivalent gamma continued fraction: b_n=x*x+1/2+2n, a_n=n(n-1/2).
    function _erfcTail(bytes16 x) private view returns (bytes16) {
        bytes16 z = ABDKMathQuad.mul(x, x);
        bytes16 base = ABDKMathQuad.add(z, HALF);
        bytes16 tail;
        for (uint256 n = 128; n > 0; --n) {
            bytes16 numerator = ABDKMathQuad.mul(ABDKMathQuad.fromUInt(n * (2 * n - 1)), HALF);
            bytes16 denominator = ABDKMathQuad.sub(ABDKMathQuad.add(base, ABDKMathQuad.fromUInt(2 * n)), tail);
            tail = ABDKMathQuad.div(numerator, denominator);
        }
        return ABDKMathQuad.div(ABDKMathQuad.mul(ABDKMathQuad.mul(x, exp(ABDKMathQuad.neg(z))), INV_SQRT_PI), ABDKMathQuad.sub(base, tail));
    }

    function _expDomain(bytes16 x) private view {
        _finite(x);
        if (numericalMath.compare(numericalMath.abs(x), MAX_EXP_ARGUMENT) > 0) revert OutsideDomain();
    }
    function _erfDomain(bytes16 x) private view {
        _finite(x);
        if (numericalMath.compare(numericalMath.abs(x), MAX_ERF_ARGUMENT) > 0) revert OutsideDomain();
    }
    function _finite(bytes16 x) private view {
        if (!numericalMath.isFinite(x)) revert NonFiniteInput();
    }
    function _result(bytes16 x) private view returns (bytes16) {
        _finite(x);
        return numericalMath.isZero(x) ? bytes16(0) : x;
    }
}
