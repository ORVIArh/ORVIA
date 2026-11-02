// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FloatMath} from "../math/FloatMath.sol";

/// @notice One direct Coulomb pair, U = prefactor*chargeProduct/r.
/// @dev The caller supplies the signed charge product and a nonnegative unit-
///      consistent prefactor. No dielectric convention or force field is chosen
///      here. There is no cutoff, reaction field, periodic image or Ewald/PME sum.
contract CoulombPairKernel {
    error InvalidMathContract();
    error NonFiniteInput();
    error NegativePrefactor();
    error ZeroSeparation();

    FloatMath public immutable numericalMath;
    bytes32 public constant KERNEL_ID = keccak256("ORVIA.CoulombPairKernel.v0.2");

    constructor(address numericalMath_) {
        if (numericalMath_.code.length == 0) revert InvalidMathContract();
        numericalMath = FloatMath(numericalMath_);
    }

    function evaluate(bytes16[3] calldata a, bytes16[3] calldata b, bytes16 chargeProduct, bytes16 prefactor)
        external
        view
        returns (bytes16 energy, bytes16[3] memory forceOnA)
    {
        FloatMath m = numericalMath;
        if (!m.isFinite(chargeProduct) || !m.isFinite(prefactor)) revert NonFiniteInput();
        if (m.isNegative(prefactor)) revert NegativePrefactor();

        bytes16[3] memory displacement;
        bytes16 rSquared;
        for (uint256 axis; axis < 3; ++axis) {
            if (!m.isFinite(a[axis]) || !m.isFinite(b[axis])) revert NonFiniteInput();
            displacement[axis] = m.sub(b[axis], a[axis]);
            rSquared = m.add(rSquared, m.mul(displacement[axis], displacement[axis]));
        }
        if (m.isZero(rSquared)) revert ZeroSeparation();
        // Zero strength still requires valid, nonsingular geometry.
        if (m.isZero(prefactor) || m.isZero(chargeProduct)) return (energy, forceOnA);

        bytes16 r = m.sqrt(rSquared);
        energy = m.div(m.mul(prefactor, chargeProduct), r);
        // For d = b-a, like charges repel: F_A = -U*d/r^2.
        bytes16 scale = m.neg(m.div(energy, rSquared));
        for (uint256 axis; axis < 3; ++axis) {
            forceOnA[axis] = m.mul(scale, displacement[axis]);
        }
    }
}
