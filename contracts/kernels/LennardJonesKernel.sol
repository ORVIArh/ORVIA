// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FloatMath} from "../math/FloatMath.sol";

/// @notice One unswitched Lennard-Jones pair, U = 4*epsilon*((sigma/r)^12-(sigma/r)^6).
/// @dev Uses the supplied pair parameters and unwrapped displacement. There is
///      no cutoff, mixing rule, exclusion, periodic image or tail correction.
contract LennardJonesKernel {
    error InvalidMathContract();
    error NonFiniteInput();
    error NonPositiveSigma();
    error NegativeEpsilon();
    error ZeroSeparation();

    FloatMath public immutable numericalMath;
    bytes32 public constant KERNEL_ID = keccak256("ORVIA.LennardJonesKernel.v0.2");

    constructor(address numericalMath_) {
        if (numericalMath_.code.length == 0) revert InvalidMathContract();
        numericalMath = FloatMath(numericalMath_);
    }

    function evaluate(bytes16[3] calldata a, bytes16[3] calldata b, bytes16 sigma, bytes16 epsilon)
        external
        view
        returns (bytes16 energy, bytes16[3] memory forceOnA)
    {
        FloatMath m = numericalMath;
        if (!m.isFinite(sigma) || !m.isFinite(epsilon)) revert NonFiniteInput();
        if (m.isNegative(sigma) || m.isZero(sigma)) revert NonPositiveSigma();
        if (m.isNegative(epsilon)) revert NegativeEpsilon();

        bytes16[3] memory displacement;
        bytes16 rSquared;
        for (uint256 axis; axis < 3; ++axis) {
            if (!m.isFinite(a[axis]) || !m.isFinite(b[axis])) revert NonFiniteInput();
            displacement[axis] = m.sub(b[axis], a[axis]);
            rSquared = m.add(rSquared, m.mul(displacement[axis], displacement[axis]));
        }
        if (m.isZero(rSquared)) revert ZeroSeparation();
        // Zero strength still requires valid, nonsingular geometry.
        if (m.isZero(epsilon)) return (energy, forceOnA);

        bytes16 ratioSquared = m.div(m.mul(sigma, sigma), rSquared);
        bytes16 ratioSixth = m.mul(m.mul(ratioSquared, ratioSquared), ratioSquared);
        bytes16 ratioTwelfth = m.mul(ratioSixth, ratioSixth);
        // The constants 2, 4 and 24 have exact binary128 representations.
        bytes16 fourEpsilon = m.mul(bytes16(0x40010000000000000000000000000000), epsilon);
        energy = m.mul(fourEpsilon, m.sub(ratioTwelfth, ratioSixth));
        bytes16 radialNumerator = m.mul(
            m.mul(bytes16(0x40038000000000000000000000000000), epsilon),
            m.sub(ratioSixth, m.mul(bytes16(0x40000000000000000000000000000000), ratioTwelfth))
        );
        // For d = b-a, F_A = (dU/dr)*d/r. F_B is the negative of F_A.
        bytes16 scale = m.div(radialNumerator, rSquared);
        for (uint256 axis; axis < 3; ++axis) {
            forceOnA[axis] = m.mul(scale, displacement[axis]);
        }
    }
}
