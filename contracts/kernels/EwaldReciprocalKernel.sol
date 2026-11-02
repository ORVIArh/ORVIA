// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {EwaldKernelBase} from "./EwaldKernelBase.sol";
import {FloatMath} from "../math/FloatMath.sol";
import {ElementaryMath} from "../math/ElementaryMath.sol";
import {ABDKMathQuad} from "../math/vendor/ABDKMathQuad.sol";

/// @notice Bounded structure-factor Ewald operations for one reciprocal ±mode pair.
/// @dev A coordinator must enumerate every registered canonical mode exactly once,
///      finish C/S accumulation before forces, and apply self/background corrections.
contract EwaldReciprocalKernel is EwaldKernelBase {
    bytes32 public constant KERNEL_ID =
        keccak256("ORVIA.EwaldReciprocalKernel.v0.5.HalfSpace");
    ElementaryMath public immutable elementaryMath;
    int32 public constant MAX_MODE = 32;
    bytes16 public constant MAX_IMAGE_RATIO =
        0x401f0000000000000000000000000000;
    bytes16 private constant HALF = 0x3ffe0000000000000000000000000000;
    bytes16 private constant TWO_PI = 0x4001921fb54442d18469898cc51701b8;
    struct ModeParameters {
        int32[3] mode;
        bytes16[3] box;
        bytes16 alpha;
        bytes16 prefactor;
    }
    struct TermParameters {
        bytes16[3] position;
        bytes16 charge;
        int32[3] mode;
        bytes16[3] box;
    }

    constructor(
        address math_,
        address scalar_,
        address elementary_
    ) EwaldKernelBase(math_, scalar_) {
        if (
            elementary_.code.length == 0 ||
            address(ElementaryMath(elementary_).numericalMath()) != math_
        ) revert InvalidDependency();
        elementaryMath = ElementaryMath(elementary_);
    }

    /// @notice k=2*pi*n/L and A=4*pi*K/V*exp(-k²/(4*alpha²))/k².
    /// @dev A includes both +n and -n; do not pass both signs. Finite modes are
    ///      a truncation: their completeness/error criterion belongs to the protocol.
    function waveVector(
        int32[3] calldata mode,
        bytes16[3] calldata box,
        bytes16 alpha,
        bytes16 prefactor
    ) external view returns (bytes16[3] memory k, bytes16 coefficient) {
        return _waveVector(ModeParameters(mode, box, alpha, prefactor));
    }

    function _waveVector(
        ModeParameters memory p
    ) private view returns (bytes16[3] memory k, bytes16 coefficient) {
        _mode(p.mode);
        _positive(p.alpha);
        _nonnegative(p.prefactor);
        FloatMath m = numericalMath;
        bytes16 volume = _volume(p.box);
        bytes16 k2;
        for (uint256 axis; axis < 3; ++axis) {
            k[axis] = m.fromInt(p.mode[axis]);
            k[axis] = m.mul(TWO_PI, k[axis]);
            k[axis] = m.div(k[axis], p.box[axis]);
            k2 = m.add(k2, m.mul(k[axis], k[axis]));
        }
        _positive(k2);
        bytes16 decay = m.mul(p.alpha, p.alpha);
        decay = m.mul(FOUR, decay);
        decay = m.neg(m.div(k2, decay));
        decay = scalarMath.exp(decay);
        coefficient = m.mul(p.prefactor, decay);
        coefficient = m.mul(m.mul(FOUR, PI), coefficient);
        coefficient = m.div(coefficient, m.mul(volume, k2));
        _nonnegative(coefficient);
    }

    /// @notice Per-atom q*cos(k.r), q*sin(k.r), with bounded fractional reduction.
    function structureFactorTerm(
        bytes16[3] calldata position,
        bytes16 charge,
        int32[3] calldata mode,
        bytes16[3] calldata box
    ) external view returns (bytes16 cosineTerm, bytes16 sineTerm) {
        return
            _structureFactorTerm(TermParameters(position, charge, mode, box));
    }
    function _structureFactorTerm(
        TermParameters memory p
    ) private view returns (bytes16 cosineTerm, bytes16 sineTerm) {
        _mode(p.mode);
        _finite(p.charge);
        FloatMath m = numericalMath;
        bytes16 cycles;
        for (uint256 axis; axis < 3; ++axis) {
            _finite(p.position[axis]);
            _positive(p.box[axis]);
            bytes16 fractional = _fractionalPosition(
                p.position[axis],
                p.box[axis]
            );
            cycles = m.add(cycles, m.mul(m.fromInt(p.mode[axis]), fractional));
        }
        bytes16 angle = m.mul(TWO_PI, _reduceCycles(cycles));
        (bytes16 sine, bytes16 cosine) = elementaryMath.sinCos(angle);
        return (m.mul(p.charge, cosine), m.mul(p.charge, sine));
    }

    function modeEnergy(
        bytes16 coefficient,
        bytes16 totalCosine,
        bytes16 totalSine
    ) external view returns (bytes16) {
        _nonnegative(coefficient);
        _finite(totalCosine);
        _finite(totalSine);
        FloatMath m = numericalMath;
        bytes16 result = m.mul(
            coefficient,
            m.add(m.mul(totalCosine, totalCosine), m.mul(totalSine, totalSine))
        );
        _finite(result);
        return result;
    }

    /// @notice 2*A*k*(C*q*sin(k.r)-S*q*cos(k.r)) for one atom and ±mode pair.
    function forceContribution(
        bytes16[3] calldata k,
        bytes16 coefficient,
        bytes16 cosineTerm,
        bytes16 sineTerm,
        bytes16 totalCosine,
        bytes16 totalSine
    ) external view returns (bytes16[3] memory force) {
        _nonnegative(coefficient);
        _finite(cosineTerm);
        _finite(sineTerm);
        _finite(totalCosine);
        _finite(totalSine);
        FloatMath m = numericalMath;
        bytes16 amplitude = m.mul(totalCosine, sineTerm);
        amplitude = m.sub(amplitude, m.mul(totalSine, cosineTerm));
        amplitude = m.mul(amplitude, coefficient);
        amplitude = m.mul(TWO, amplitude);
        for (uint256 axis; axis < 3; ++axis) {
            _finite(k[axis]);
            force[axis] = m.mul(k[axis], amplitude);
            _finite(force[axis]);
        }
    }

    function _reduceCycles(
        bytes16 value
    ) private view returns (bytes16 remainder) {
        FloatMath m = numericalMath;
        if (m.compare(m.abs(value), MAX_IMAGE_RATIO) > 0)
            revert OutsideDomain();
        remainder = m.sub(value, m.fromInt(ABDKMathQuad.toInt(value)));
        if (m.compare(remainder, HALF) > 0) remainder = m.sub(remainder, ONE);
        else if (m.compare(remainder, m.neg(HALF)) < 0)
            remainder = m.add(remainder, ONE);
        if (m.compare(m.abs(remainder), HALF) > 0) revert OutsideDomain();
    }

    /// @dev Reduce in coordinate units before division, avoiding cancellation
    ///      of a large integer part from a rounded fractional coordinate.
    function _fractionalPosition(
        bytes16 position,
        bytes16 length
    ) private view returns (bytes16) {
        FloatMath m = numericalMath;
        bytes16 ratio = m.div(position, length);
        if (m.compare(m.abs(ratio), MAX_IMAGE_RATIO) > 0)
            revert OutsideDomain();
        bytes16 image = m.fromInt(ABDKMathQuad.toInt(ratio));
        bytes16 remainder = m.sub(position, m.mul(image, length));
        bytes16 halfLength = m.mul(HALF, length);
        if (m.compare(remainder, halfLength) > 0)
            remainder = m.sub(remainder, length);
        else if (m.compare(remainder, m.neg(halfLength)) < 0)
            remainder = m.add(remainder, length);
        if (m.compare(m.abs(remainder), halfLength) > 0) revert OutsideDomain();
        return m.div(remainder, length);
    }

    function _mode(int32[3] memory mode) private pure {
        bool nonzero;
        for (uint256 axis; axis < 3; ++axis) {
            int32 value = mode[axis];
            if (value < -MAX_MODE || value > MAX_MODE) revert OutsideDomain();
            if (!nonzero && value != 0) {
                if (value < 0) revert InvalidParameter();
                nonzero = true;
            }
        }
        if (!nonzero) revert InvalidParameter();
    }
}
