// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FloatMath} from "../math/FloatMath.sol";

interface IEwaldScalarMath {
    function numericalMath() external view returns (address);
    function exp(bytes16 x) external view returns (bytes16);
    function erf(bytes16 x) external view returns (bytes16);
    function erfc(bytes16 x) external view returns (bytes16);
}

/// @dev Shared finite-domain validation, not a separately deployed component.
abstract contract EwaldKernelBase {
    error InvalidDependency();
    error InvalidParameter();
    error NonFiniteNumber();
    error ZeroSeparation();
    error OutsideDomain();

    FloatMath public immutable numericalMath;
    IEwaldScalarMath public immutable scalarMath;
    bytes16 internal constant ONE = 0x3fff0000000000000000000000000000;
    bytes16 internal constant TWO = 0x40000000000000000000000000000000;
    bytes16 internal constant FOUR = 0x40010000000000000000000000000000;
    bytes16 internal constant SIXTEEN = 0x40030000000000000000000000000000;
    bytes16 internal constant PI = 0x4000921fb54442d18469898cc51701b8;
    bytes16 internal constant INV_SQRT_PI = 0x3ffe20dd750429b6d11ae3a914fed7fe;

    constructor(address math_, address scalar_) {
        if (
            math_.code.length == 0 ||
            scalar_.code.length == 0 ||
            IEwaldScalarMath(scalar_).numericalMath() != math_
        ) revert InvalidDependency();
        numericalMath = FloatMath(math_);
        scalarMath = IEwaldScalarMath(scalar_);
    }

    function _finite(bytes16 value) internal view {
        if (!numericalMath.isFinite(value)) revert NonFiniteNumber();
    }
    function _nonnegative(bytes16 value) internal view {
        _finite(value);
        if (numericalMath.compare(value, bytes16(0)) < 0)
            revert InvalidParameter();
    }
    function _positive(bytes16 value) internal view {
        _finite(value);
        if (numericalMath.compare(value, bytes16(0)) <= 0)
            revert InvalidParameter();
    }
    function _normSquared(
        bytes16[3] memory displacement
    ) internal view returns (bytes16 r2) {
        for (uint256 axis; axis < 3; ++axis) {
            _finite(displacement[axis]);
            r2 = numericalMath.add(
                r2,
                numericalMath.mul(displacement[axis], displacement[axis])
            );
        }
        _finite(r2);
    }
    function _volume(
        bytes16[3] memory box
    ) internal view returns (bytes16 volume) {
        volume = ONE;
        for (uint256 axis; axis < 3; ++axis) {
            _positive(box[axis]);
            volume = numericalMath.mul(volume, box[axis]);
        }
        _positive(volume);
    }
}
