// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {EwaldKernelBase} from "./EwaldKernelBase.sol";
import {FloatMath} from "../math/FloatMath.sol";

/// @notice One erfc-screened Ewald pair; caller supplies nearest-image b-a.
/// @dev This is the unshifted finite real-space truncation, not an Ewald sum alone.
contract EwaldRealSpaceKernel is EwaldKernelBase {
    bytes32 public constant KERNEL_ID =
        keccak256("ORVIA.EwaldRealSpaceKernel.v0.5");
    struct Parameters {
        bytes16 chargeProduct;
        bytes16 prefactor;
        bytes16 alpha;
        bytes16 cutoff;
    }

    constructor(
        address math_,
        address scalar_
    ) EwaldKernelBase(math_, scalar_) {}

    function evaluate(
        bytes16[3] calldata displacement,
        bytes16 chargeProduct,
        bytes16 prefactor,
        bytes16 alpha,
        bytes16 cutoff
    ) external view returns (bytes16 energy, bytes16[3] memory forceOnA) {
        return
            _evaluate(
                displacement,
                Parameters(chargeProduct, prefactor, alpha, cutoff)
            );
    }
    function _evaluate(
        bytes16[3] memory displacement,
        Parameters memory p
    ) private view returns (bytes16 energy, bytes16[3] memory forceOnA) {
        _finite(p.chargeProduct);
        _nonnegative(p.prefactor);
        _positive(p.alpha);
        _positive(p.cutoff);
        FloatMath m = numericalMath;
        if (m.compare(m.mul(p.alpha, p.cutoff), SIXTEEN) > 0)
            revert OutsideDomain();
        bytes16 r2 = _normSquared(displacement);
        if (m.isZero(r2)) revert ZeroSeparation();
        bytes16 r = m.sqrt(r2);
        if (m.compare(r, p.cutoff) >= 0) return (energy, forceOnA);
        bytes16 scale;
        (energy, scale) = _radial(r, r2, p);
        _finite(energy);
        for (uint256 axis; axis < 3; ++axis) {
            forceOnA[axis] = m.mul(scale, displacement[axis]);
            _finite(forceOnA[axis]);
        }
    }

    function _radial(
        bytes16 r,
        bytes16 r2,
        Parameters memory p
    ) private view returns (bytes16 energy, bytes16 scale) {
        FloatMath m = numericalMath;
        bytes16 strength = m.mul(p.prefactor, p.chargeProduct);
        bytes16 x = m.mul(p.alpha, r);
        bytes16 complement = scalarMath.erfc(x);
        energy = m.div(m.mul(strength, complement), r);
        bytes16 gaussian = scalarMath.exp(m.neg(m.mul(x, x)));
        bytes16 derivative = m.mul(INV_SQRT_PI, gaussian);
        derivative = m.mul(p.alpha, derivative);
        derivative = m.mul(TWO, derivative);
        scale = m.add(m.div(complement, r), derivative);
        scale = m.mul(strength, scale);
        scale = m.neg(m.div(scale, r2));
    }
}
