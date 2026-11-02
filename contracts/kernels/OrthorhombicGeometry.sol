// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FloatMath} from "../math/FloatMath.sol";
import {ABDKMathQuad} from "../math/vendor/ABDKMathQuad.sol";

/// @notice Bounded minimum-image displacement for a fixed orthorhombic box.
/// @dev All numeric inputs and results use binary128 format with pinned ABDK
///      arithmetic semantics. This is not a triclinic or variable-cell method.
contract OrthorhombicGeometry {
    error InvalidMathContract();
    error NonFiniteInput();
    error NonPositiveBox();
    error InvalidCutoff();
    error ImageRangeExceeded();
    error UnresolvedImage();

    FloatMath public immutable numericalMath;
    bytes32 public constant GEOMETRY_ID = keccak256("ORVIA.OrthorhombicGeometry.v0.4");
    bytes16 public constant MAX_IMAGE_RATIO = 0x401f0000000000000000000000000000; // 2^32
    bytes16 private constant TWO = 0x40000000000000000000000000000000;

    constructor(address numericalMath_) {
        if (numericalMath_.code.length == 0) revert InvalidMathContract();
        numericalMath = FloatMath(numericalMath_);
    }

    /// @notice Return the nearest periodic image of b-a, independently by axis.
    /// @dev Exact half-box ties retain the signed remainder: +L/2 and -L/2
    ///      are both valid. No iteration depends on the image count.
    function displacement(bytes16[3] calldata a, bytes16[3] calldata b, bytes16[3] calldata box)
        external view returns (bytes16[3] memory d)
    {
        FloatMath m = numericalMath;
        for (uint256 axis; axis < 3; ++axis) {
            _requireLength(box[axis]);
            if (!m.isFinite(a[axis]) || !m.isFinite(b[axis])) revert NonFiniteInput();
            bytes16 delta = m.sub(b[axis], a[axis]);
            bytes16 quotient = m.div(delta, box[axis]);
            if (m.compare(m.abs(quotient), MAX_IMAGE_RATIO) > 0) revert ImageRangeExceeded();

            // Conversion truncates toward zero. The bounded quotient guarantees
            // that this pinned integer conversion cannot overflow.
            int256 image = ABDKMathQuad.toInt(quotient);
            bytes16 remainder = m.sub(delta, m.mul(m.fromInt(image), box[axis]));
            bytes16 half = m.div(box[axis], TWO);
            if (m.compare(remainder, half) > 0) remainder = m.sub(remainder, box[axis]);
            else if (m.compare(remainder, m.neg(half)) < 0) remainder = m.add(remainder, box[axis]);

            // Fail closed if extreme finite arithmetic cannot resolve an image.
            if (m.compare(m.abs(remainder), half) > 0) revert UnresolvedImage();
            d[axis] = remainder; // FloatMath operations canonicalize signed zero.
        }
    }

    /// @notice Require a nonzero finite cutoff strictly below every half-length.
    /// @dev Strict inequality keeps an ordinary cutoff interaction away from
    ///      geometrically ambiguous half-box ties.
    function validateBox(bytes16[3] calldata box, bytes16 cutoff) external view {
        FloatMath m = numericalMath;
        if (!m.isFinite(cutoff)) revert NonFiniteInput();
        if (m.isNegative(cutoff) || m.isZero(cutoff)) revert InvalidCutoff();
        for (uint256 axis; axis < 3; ++axis) {
            _requireLength(box[axis]);
            if (m.compare(cutoff, m.div(box[axis], TWO)) >= 0) revert InvalidCutoff();
        }
    }

    function _requireLength(bytes16 value) private view {
        if (!numericalMath.isFinite(value)) revert NonFiniteInput();
        if (numericalMath.isNegative(value) || numericalMath.isZero(value)) revert NonPositiveBox();
    }
}
