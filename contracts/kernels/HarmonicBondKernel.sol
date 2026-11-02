// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FloatMath} from "../math/FloatMath.sol";

/// @notice One harmonic bond, U = k/2 * (r-r0)^2, in OpenMM-style nm/kJ units.
/// @dev This kernel uses an unwrapped displacement. Periodic boundary images,
///      topology, force accumulation and all other force terms belong to the
///      calling engine. No claim of a complete molecular model is made here.
contract HarmonicBondKernel {
    error InvalidMathContract();
    error NonFiniteInput();
    error NegativeParameter();
    error ZeroSeparation();

    FloatMath public immutable numericalMath;
    bytes32 public constant KERNEL_ID = keccak256("ORVIA.HarmonicBondKernel.v0.1");

    constructor(address numericalMath_) {
        if (numericalMath_.code.length == 0) revert InvalidMathContract();
        numericalMath = FloatMath(numericalMath_);
    }

    function evaluate(bytes16[3] calldata a, bytes16[3] calldata b, bytes16 k, bytes16 r0)
        external
        view
        returns (bytes16 energy, bytes16[3] memory forceOnA)
    {
        FloatMath m = numericalMath;
        if (!m.isFinite(k) || !m.isFinite(r0)) revert NonFiniteInput();
        if (m.isNegative(k) || m.isNegative(r0)) revert NegativeParameter();

        bytes16[3] memory displacement;
        bytes16 rSquared;
        for (uint256 axis; axis < 3; ++axis) {
            if (!m.isFinite(a[axis]) || !m.isFinite(b[axis])) revert NonFiniteInput();
            displacement[axis] = m.sub(b[axis], a[axis]);
            rSquared = m.add(rSquared, m.mul(displacement[axis], displacement[axis]));
        }
        if (m.isZero(rSquared)) revert ZeroSeparation();

        bytes16 r = m.sqrt(rSquared);
        bytes16 extension = m.sub(r, r0);
        bytes16 radialForce = m.mul(k, extension);
        // 0.5 is exactly representable as binary128.
        energy = m.mul(bytes16(0x3ffe0000000000000000000000000000), m.mul(radialForce, extension));
        bytes16 scale = m.div(radialForce, r);
        for (uint256 axis; axis < 3; ++axis) {
            forceOnA[axis] = m.mul(scale, displacement[axis]);
        }
    }
}
