// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FloatMath} from "./FloatMath.sol";

/// @notice Bounded, deterministic binary128-format angular functions.
/// @dev Polynomial truncation and upstream arithmetic are not a correctly-rounded IEEE guarantee.
contract ElementaryMath {
    error InvalidMathContract();
    error NonFiniteInput();
    error UndefinedAngle();
    error OutsideDomain();

    FloatMath public immutable numericalMath;
    bytes16 public constant PI = 0x4000921fb54442d18469898cc51701b8;
    bytes16 public constant TWO_PI = 0x4001921fb54442d18469898cc51701b8;
    bytes16 public constant HALF_PI = 0x3fff921fb54442d18469898cc51701b8;
    bytes16 public constant MAX_TRIG_ARGUMENT = 0x4005921fb54442d18469898cc51701b8; // 32*pi
    bytes16 private constant ONE = 0x3fff0000000000000000000000000000;
    bytes16 private constant TWO = 0x40000000000000000000000000000000;

    constructor(address math_) {
        if (math_.code.length == 0) revert InvalidMathContract();
        numericalMath = FloatMath(math_);
    }

    /// @notice Principal angle in [-pi, pi]; signed zero is treated as numerical zero.
    function atan2(bytes16 y, bytes16 x) public view returns (bytes16 angle) {
        FloatMath m = numericalMath;
        _finite(x); _finite(y);
        if (m.isZero(x)) {
            if (m.isZero(y)) revert UndefinedAngle();
            return m.isNegative(y) ? m.neg(HALF_PI) : HALF_PI;
        }
        bytes16 ax = m.abs(x);
        bytes16 ay = m.abs(y);
        bool inverted = m.compare(ay, ax) > 0;
        bytes16 ratio = inverted ? m.div(ax, ay) : m.div(ay, ax);
        angle = _atanUnit(ratio);
        if (inverted) angle = m.sub(HALF_PI, angle);
        if (m.isNegative(x)) angle = m.sub(PI, angle);
        if (m.isNegative(y)) angle = m.neg(angle);
    }

    function _atanUnit(bytes16 ratio) private view returns (bytes16) {
        FloatMath m = numericalMath;
        // One half-angle reduction bounds the alternating-series argument by sqrt(2)-1.
        bytes16 t = m.mul(ratio, ratio);
        t = m.add(ONE, t);
        t = m.sqrt(t);
        t = m.add(ONE, t);
        t = m.div(ratio, t);
        bytes16 negativeSquared = m.neg(m.mul(t, t));
        bytes16 power = t;
        bytes16 sum = t;
        for (uint256 i = 1; i < 48; ++i) {
            power = m.mul(power, negativeSquared);
            bytes16 term = m.fromUInt(2 * i + 1);
            term = m.div(power, term);
            sum = m.add(sum, term);
        }
        return m.mul(TWO, sum);
    }

    /// @notice Sine and cosine for finite arguments with absolute value <= 32*pi.
    function sinCos(bytes16 angle) external view returns (bytes16 sine, bytes16 cosine) {
        FloatMath m = numericalMath;
        _finite(angle);
        if (m.compare(m.abs(angle), MAX_TRIG_ARGUMENT) > 0) revert OutsideDomain();
        bytes16 x = angle;
        bytes16 negativePi = m.neg(PI);
        // The explicit domain bounds reduction to at most 16 full turns.
        for (uint256 i; i < 16; ++i) {
            if (m.compare(x, PI) > 0) x = m.sub(x, TWO_PI);
            else if (m.compare(x, negativePi) < 0) x = m.add(x, TWO_PI);
            else break;
        }
        if (m.compare(x, PI) > 0 || m.compare(x, negativePi) < 0) revert OutsideDomain();
        bytes16 negativeSquared = m.neg(m.mul(x, x));
        bytes16 sineTerm = x;
        bytes16 cosineTerm = ONE;
        sine = x;
        cosine = ONE;
        for (uint256 i = 1; i <= 32; ++i) {
            sineTerm = m.mul(sineTerm, negativeSquared);
            sineTerm = m.div(sineTerm, m.fromUInt((2 * i) * (2 * i + 1)));
            cosineTerm = m.mul(cosineTerm, negativeSquared);
            cosineTerm = m.div(cosineTerm, m.fromUInt((2 * i - 1) * (2 * i)));
            sine = m.add(sine, sineTerm);
            cosine = m.add(cosine, cosineTerm);
        }
    }

    function acos(bytes16 x) external view returns (bytes16) {
        FloatMath m = numericalMath;
        _finite(x);
        if (m.compare(m.abs(x), ONE) > 0) revert OutsideDomain();
        bytes16 product = m.mul(m.sub(ONE, x), m.add(ONE, x));
        return atan2(m.sqrt(product), x);
    }

    function _finite(bytes16 x) private view {
        if (!numericalMath.isFinite(x)) revert NonFiniteInput();
    }
}
