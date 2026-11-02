// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ABDKMathQuad} from "./vendor/ABDKMathQuad.sol";

/// @notice Finite-domain wrapper for pinned ABDK binary128-format operations.
/// @dev This is an engineering component, not a validated molecular dynamics
///      platform. Upstream rounding/approximation behavior is retained.
contract FloatMath {
    error NonFinite();
    error DivisionByZero();
    error NegativeSquareRoot();
    error DoubleOverflow();

    bytes32 public constant IMPLEMENTATION_ID =
        keccak256("ORVIA.FloatMath.v0.1.ABDKMathQuad.5e1e7c11b35f8313d3f7ce11c1b86320d7c0b554");

    uint128 private constant EXPONENT_MASK = 0x7fff0000000000000000000000000000;
    uint128 private constant MAGNITUDE_MASK = 0x7fffffffffffffffffffffffffffffff;
    uint128 private constant SIGN_MASK = 0x80000000000000000000000000000000;

    function isFinite(bytes16 x) public pure returns (bool) {
        return (uint128(x) & EXPONENT_MASK) != EXPONENT_MASK;
    }

    function isNegative(bytes16 x) external pure returns (bool) {
        _requireFinite(x);
        return (uint128(x) & SIGN_MASK) != 0 && !_isZero(x);
    }

    function isZero(bytes16 x) external pure returns (bool) {
        _requireFinite(x);
        return _isZero(x);
    }

    function fromInt(int256 x) external pure returns (bytes16) {
        return _finiteResult(ABDKMathQuad.fromInt(x));
    }

    function fromUInt(uint256 x) external pure returns (bytes16) {
        return _finiteResult(ABDKMathQuad.fromUInt(x));
    }

    function fromDouble(bytes8 x) external pure returns (bytes16) {
        return _finiteResult(ABDKMathQuad.fromDouble(x));
    }

    /// @notice Binary64 conversion is for inspection, not scientific storage.
    function toDouble(bytes16 x) external pure returns (bytes8 value) {
        _requireFinite(x);
        value = ABDKMathQuad.toDouble(x);
        if ((uint64(value) & 0x7ff0000000000000) == 0x7ff0000000000000) revert DoubleOverflow();
    }

    function add(bytes16 x, bytes16 y) external pure returns (bytes16) {
        _requireFinite(x);
        _requireFinite(y);
        return _finiteResult(ABDKMathQuad.add(x, y));
    }

    function sub(bytes16 x, bytes16 y) external pure returns (bytes16) {
        _requireFinite(x);
        _requireFinite(y);
        return _finiteResult(ABDKMathQuad.sub(x, y));
    }

    function mul(bytes16 x, bytes16 y) external pure returns (bytes16) {
        _requireFinite(x);
        _requireFinite(y);
        return _finiteResult(ABDKMathQuad.mul(x, y));
    }

    function div(bytes16 x, bytes16 y) external pure returns (bytes16) {
        _requireFinite(x);
        _requireFinite(y);
        if (_isZero(y)) revert DivisionByZero();
        return _finiteResult(ABDKMathQuad.div(x, y));
    }

    function sqrt(bytes16 x) external pure returns (bytes16) {
        _requireFinite(x);
        if ((uint128(x) & SIGN_MASK) != 0 && !_isZero(x)) revert NegativeSquareRoot();
        return _finiteResult(ABDKMathQuad.sqrt(x));
    }

    function neg(bytes16 x) external pure returns (bytes16) {
        _requireFinite(x);
        return _finiteResult(ABDKMathQuad.neg(x));
    }

    function abs(bytes16 x) external pure returns (bytes16) {
        _requireFinite(x);
        return _finiteResult(ABDKMathQuad.abs(x));
    }

    function compare(bytes16 x, bytes16 y) external pure returns (int8) {
        _requireFinite(x);
        _requireFinite(y);
        // Numerical zero compares equal regardless of its input sign bit.
        return ABDKMathQuad.cmp(_isZero(x) ? bytes16(0) : x, _isZero(y) ? bytes16(0) : y);
    }

    function _requireFinite(bytes16 x) private pure {
        if (!isFinite(x)) revert NonFinite();
    }

    function _isZero(bytes16 x) private pure returns (bool) {
        return (uint128(x) & MAGNITUDE_MASK) == 0;
    }

    function _finiteResult(bytes16 x) private pure returns (bytes16) {
        _requireFinite(x);
        // A canonical positive zero removes irrelevant sign-of-zero variation.
        return _isZero(x) ? bytes16(0) : x;
    }
}
