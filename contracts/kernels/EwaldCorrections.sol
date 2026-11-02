// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {EwaldKernelBase} from "./EwaldKernelBase.sol";
import {FloatMath} from "../math/FloatMath.sol";

/// @notice Tin-foil Ewald self, neutralizing-background and pair-exception terms.
contract EwaldCorrections is EwaldKernelBase {
    bytes32 public constant KERNEL_ID =
        keccak256("ORVIA.EwaldCorrections.v0.5");
    bytes16 private constant HALF = 0x3ffe0000000000000000000000000000;
    struct ExceptionParameters {
        bytes16 original;
        bytes16 desired;
        bytes16 prefactor;
        bytes16 alpha;
    }

    constructor(
        address math_,
        address scalar_
    ) EwaldKernelBase(math_, scalar_) {}

    function selfEnergy(
        bytes16 charge,
        bytes16 alpha,
        bytes16 prefactor
    ) external view returns (bytes16) {
        _finite(charge);
        _positive(alpha);
        _nonnegative(prefactor);
        FloatMath m = numericalMath;
        bytes16 result = m.mul(charge, charge);
        result = m.mul(result, INV_SQRT_PI);
        result = m.mul(result, alpha);
        result = m.neg(m.mul(result, prefactor));
        _finite(result);
        return result;
    }

    /// @notice Uniform neutralizing plasma: -K*pi*Q^2/(2*alpha^2*V).
    /// @dev Zero coordinate force at fixed volume; pressure derivatives are not returned.
    function backgroundEnergy(
        bytes16 totalCharge,
        bytes16[3] calldata box,
        bytes16 alpha,
        bytes16 prefactor
    ) external view returns (bytes16) {
        _finite(totalCharge);
        _positive(alpha);
        _nonnegative(prefactor);
        FloatMath m = numericalMath;
        bytes16 denominator = m.mul(alpha, alpha);
        denominator = m.mul(denominator, _volume(box));
        denominator = m.mul(TWO, denominator);
        bytes16 numerator = m.mul(totalCharge, totalCharge);
        numerator = m.mul(numerator, PI);
        numerator = m.mul(numerator, prefactor);
        bytes16 result = m.neg(m.div(numerator, denominator));
        _finite(result);
        return result;
    }

    /// @notice K*(desiredQ-originalQ*erf(alpha*r))/r, replacing an omitted real pair.
    /// @dev Reciprocal factors retain original atomic charges. Caller must omit this
    ///      pair's screened real term, then add this term once with no cutoff.
    function exception(
        bytes16[3] calldata displacement,
        bytes16 originalChargeProduct,
        bytes16 desiredChargeProduct,
        bytes16 prefactor,
        bytes16 alpha
    ) external view returns (bytes16 energy, bytes16[3] memory forceOnA) {
        return
            _exception(
                displacement,
                ExceptionParameters(
                    originalChargeProduct,
                    desiredChargeProduct,
                    prefactor,
                    alpha
                )
            );
    }

    function _exception(
        bytes16[3] memory displacement,
        ExceptionParameters memory p
    ) private view returns (bytes16 energy, bytes16[3] memory forceOnA) {
        _finite(p.original);
        _finite(p.desired);
        _nonnegative(p.prefactor);
        _positive(p.alpha);
        FloatMath m = numericalMath;
        bytes16 r2 = _normSquared(displacement);
        if (m.isZero(r2)) {
            for (uint256 axis; axis < 3; ++axis)
                if (!m.isZero(displacement[axis])) revert OutsideDomain();
            if (!m.isZero(p.desired)) revert ZeroSeparation();
            energy = m.mul(TWO, m.mul(p.alpha, INV_SQRT_PI));
            energy = m.mul(energy, p.original);
            energy = m.neg(m.mul(energy, p.prefactor));
            _finite(energy);
            return (energy, forceOnA);
        }
        bytes16 r = m.sqrt(r2);
        bytes16 x = m.mul(p.alpha, r);
        if (m.compare(x, SIXTEEN) > 0) revert OutsideDomain();
        bytes16 erfX = scalarMath.erf(x);
        energy = m.mul(p.original, erfX);
        energy = m.div(m.sub(p.desired, energy), r);
        energy = m.mul(p.prefactor, energy);
        bytes16 scale = m.mul(
            p.original,
            _gaussianForceScale(x, r, r2, p.alpha, erfX)
        );
        bytes16 direct = m.mul(r2, r);
        direct = m.div(p.desired, direct);
        scale = m.sub(scale, direct);
        scale = m.mul(p.prefactor, scale);
        _finite(energy);
        for (uint256 axis; axis < 3; ++axis) {
            forceOnA[axis] = m.mul(scale, displacement[axis]);
            _finite(forceOnA[axis]);
        }
    }

    /// @dev Stable (erf(x)-2*x*exp(-x*x)/sqrt(pi))/r^3 at small x.
    function _gaussianForceScale(
        bytes16 x,
        bytes16 r,
        bytes16 r2,
        bytes16 alpha,
        bytes16 erfX
    ) private view returns (bytes16) {
        FloatMath m = numericalMath;
        if (m.compare(x, HALF) <= 0) {
            bytes16 negativeSquared = m.neg(m.mul(x, x));
            bytes16 term = ONE;
            bytes16 sum = m.div(ONE, m.fromUInt(3));
            for (uint256 n = 1; n < 24; ++n) {
                term = m.div(m.mul(term, negativeSquared), m.fromUInt(n));
                sum = m.add(sum, m.div(term, m.fromUInt(2 * n + 3)));
            }
            bytes16 factor = m.mul(alpha, alpha);
            factor = m.mul(factor, alpha);
            factor = m.mul(factor, m.mul(FOUR, INV_SQRT_PI));
            return m.mul(factor, sum);
        }
        bytes16 gaussian = scalarMath.exp(m.neg(m.mul(x, x)));
        bytes16 numerator = m.mul(INV_SQRT_PI, gaussian);
        numerator = m.mul(numerator, x);
        numerator = m.mul(TWO, numerator);
        numerator = m.sub(erfX, numerator);
        return m.div(numerator, m.mul(r2, r));
    }
}
