// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FloatMath} from "../math/FloatMath.sol";

/// @notice Raw unswitched pair term U = -C4/r^4 for supplied nonnegative C4.
/// @dev d = b-a; F_A = +4*C4*d/r^6 and F_B = -F_A. The caller supplies a
///      unit-consistent pair coefficient and displacement. No mixing, cutoff,
///      switch, tail correction, exclusion or alchemical policy is selected.
contract C4PairKernel {
    error InvalidMathContract();
    error DependencyChanged();
    error NonFiniteInput();
    error NegativeC4();
    error CoefficientOutsideDomain();
    error DisplacementOutsideDomain();
    error ZeroSeparation();
    error SeparationOutsideDomain();

    FloatMath public immutable numericalMath;
    bytes32 public immutable numericalMathCodeHash;
    bytes32 public constant KERNEL_ID = keccak256("ORVIA.C4PairKernel.v1.RawUnswitched.BoundedBinary128");
    // Engineering bounds, not a physical cutoff or force-field parameter choice.
    // Positive C4 and nonzero |d_i| lie in [2^-256,2^256]. Computed r^2 also
    // lies in [2^-256,2^256], keeping active products/quotients normal and finite.
    bytes16 public constant MIN_POSITIVE_INPUT = 0x3eff0000000000000000000000000000;
    bytes16 public constant MAX_POSITIVE_INPUT = 0x40ff0000000000000000000000000000;
    bytes16 private constant FOUR = 0x40010000000000000000000000000000;

    constructor(address numericalMath_) {
        if (numericalMath_.code.length == 0) revert InvalidMathContract();
        numericalMath = FloatMath(numericalMath_);
        numericalMathCodeHash = numericalMath_.codehash;
    }

    function evaluate(bytes16[3] calldata displacement, bytes16 c4)
        external view returns (bytes16 energy, bytes16[3] memory forceOnA)
    {
        FloatMath math = numericalMath;
        if (address(math).codehash != numericalMathCodeHash) revert DependencyChanged();
        if (!math.isFinite(c4)) revert NonFiniteInput();
        if (math.isNegative(c4)) revert NegativeC4();
        bool zeroCoefficient = math.isZero(c4);
        if (!zeroCoefficient && (math.compare(c4, MIN_POSITIVE_INPUT) < 0
            || math.compare(c4, MAX_POSITIVE_INPUT) > 0)) revert CoefficientOutsideDomain();
        bytes16 rSquared;
        for (uint256 axis; axis < 3; ++axis) {
            bytes16 component = displacement[axis];
            if (!math.isFinite(component)) revert NonFiniteInput();
            bytes16 magnitude = math.abs(component);
            if (!math.isZero(magnitude) && (math.compare(magnitude, MIN_POSITIVE_INPUT) < 0
                || math.compare(magnitude, MAX_POSITIVE_INPUT) > 0)) revert DisplacementOutsideDomain();
            rSquared = math.add(rSquared, math.mul(component, component));
        }
        if (math.isZero(rSquared)) revert ZeroSeparation();
        if (math.compare(rSquared, MIN_POSITIVE_INPUT) < 0
            || math.compare(rSquared, MAX_POSITIVE_INPUT) > 0) revert SeparationOutsideDomain();
        // Zero strength still requires valid, nonsingular geometry.
        if (zeroCoefficient) return (energy, forceOnA);
        bytes16 magnitudeEnergy = math.div(math.div(c4, rSquared), rSquared);
        energy = math.neg(magnitudeEnergy);
        bytes16 forceScale = math.div(math.mul(FOUR, magnitudeEnergy), rSquared);
        for (uint256 axis; axis < 3; ++axis) forceOnA[axis] = math.mul(forceScale, displacement[axis]);
    }
}
