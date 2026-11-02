// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FloatMath} from "../math/FloatMath.sol";
import {LennardJonesKernel} from "./LennardJonesKernel.sol";
import {CoulombPairKernel} from "./CoulombPairKernel.sol";

/// @notice Quintic-switched LJ plus conducting-limit reaction-field Coulomb.
/// @dev The caller supplies d = nearest-image(b-a). Exceptions use direct,
///      unswitched, uncut LJ+Coulomb. This is not Ewald or PME electrostatics.
contract SwitchedNonbondedKernel {
    error InvalidDependency();
    error NonFiniteInput();
    error InvalidParameter();
    error ZeroSeparation();

    FloatMath public immutable numericalMath;
    LennardJonesKernel public immutable ljKernel;
    CoulombPairKernel public immutable coulombKernel;
    bytes32 public constant KERNEL_ID = keccak256("ORVIA.SwitchedNonbondedKernel.v0.4.ConductingRF");

    bytes16 private constant ONE = 0x3fff0000000000000000000000000000;
    bytes16 private constant TWO = 0x40000000000000000000000000000000;
    bytes16 private constant SIX = 0x40018000000000000000000000000000;
    bytes16 private constant TEN = 0x40024000000000000000000000000000;
    bytes16 private constant FIFTEEN = 0x4002e000000000000000000000000000;
    bytes16 private constant THIRTY = 0x4003e000000000000000000000000000;

    struct Parameters {
        bytes16 sigma;
        bytes16 epsilon;
        bytes16 chargeProduct;
        bytes16 prefactor;
        bytes16 switchDistance;
        bytes16 cutoff;
        bool exception;
    }

    constructor(address math_, address lj_, address coulomb_) {
        if (math_.code.length == 0 || lj_.code.length == 0 || coulomb_.code.length == 0) revert InvalidDependency();
        if (address(LennardJonesKernel(lj_).numericalMath()) != math_
            || address(CoulombPairKernel(coulomb_).numericalMath()) != math_) revert InvalidDependency();
        numericalMath = FloatMath(math_);
        ljKernel = LennardJonesKernel(lj_);
        coulombKernel = CoulombPairKernel(coulomb_);
    }

    function evaluate(
        bytes16[3] calldata displacement,
        bytes16 sigma,
        bytes16 epsilon,
        bytes16 chargeProduct,
        bytes16 prefactor,
        bytes16 switchDistance,
        bytes16 cutoff,
        bool exception
    ) external view returns (bytes16 energy, bytes16[3] memory forceOnA) {
        Parameters memory p = Parameters(sigma, epsilon, chargeProduct, prefactor, switchDistance, cutoff, exception);
        return _evaluate(displacement, p);
    }

    function _evaluate(bytes16[3] memory d, Parameters memory p)
        private view returns (bytes16 energy, bytes16[3] memory forceOnA)
    {
        FloatMath m = numericalMath;
        _validate(p);
        bytes16 r = _distance(d);
        if (!p.exception && m.compare(r, p.cutoff) >= 0) return (energy, forceOnA);

        {
            bytes16[3] memory origin;
            (energy, forceOnA) = ljKernel.evaluate(origin, d, p.sigma, p.epsilon);
            if (p.exception) {
                (bytes16 ec, bytes16[3] memory fc) = coulombKernel.evaluate(origin, d, p.chargeProduct, p.prefactor);
                energy = m.add(energy, ec);
                for (uint256 axis; axis < 3; ++axis) forceOnA[axis] = m.add(forceOnA[axis], fc[axis]);
                return (energy, forceOnA);
            }
        }

        if (m.compare(r, p.switchDistance) > 0) {
            (energy, forceOnA) = _applySwitch(d, r, p, energy, forceOnA);
        }
        (bytes16 rfEnergy, bytes16 rfScale) = _reactionField(r, p.cutoff, m.mul(p.chargeProduct, p.prefactor));
        energy = m.add(energy, rfEnergy);
        for (uint256 axis; axis < 3; ++axis) forceOnA[axis] = m.add(forceOnA[axis], m.mul(rfScale, d[axis]));
    }

    function _distance(bytes16[3] memory d) private view returns (bytes16) {
        FloatMath m = numericalMath;
        bytes16 rSquared;
        for (uint256 axis; axis < 3; ++axis) {
            if (!m.isFinite(d[axis])) revert NonFiniteInput();
            rSquared = m.add(rSquared, m.mul(d[axis], d[axis]));
        }
        if (m.isZero(rSquared)) revert ZeroSeparation();
        return m.sqrt(rSquared);
    }

    function _applySwitch(bytes16[3] memory d, bytes16 r, Parameters memory p, bytes16 energy, bytes16[3] memory force)
        private view returns (bytes16, bytes16[3] memory)
    {
        FloatMath m = numericalMath;
        (bytes16 switching, bytes16 derivative) = _switch(r, p.switchDistance, p.cutoff);
        // F_A = S*F_LJ + U_LJ*(dS/dr)*d/r; preserve unswitched energy here.
        bytes16 correction = m.div(m.mul(energy, derivative), r);
        force = _combine(force, d, switching, correction);
        return (m.mul(switching, energy), force);
    }

    function _combine(bytes16[3] memory force, bytes16[3] memory d, bytes16 scale, bytes16 correction)
        private view returns (bytes16[3] memory)
    {
        FloatMath m = numericalMath;
        for (uint256 axis; axis < 3; ++axis) {
            force[axis] = m.add(m.mul(scale, force[axis]), m.mul(correction, d[axis]));
        }
        return force;
    }

    function _switch(bytes16 r, bytes16 rs, bytes16 rc) private view returns (bytes16 value, bytes16 derivative) {
        FloatMath m = numericalMath;
        bytes16 width = m.sub(rc, rs);
        bytes16 x = m.div(m.sub(r, rs), width);
        bytes16 t = m.div(m.sub(rc, r), width);
        // S=t^3*(10-15t+6t^2), algebraically 1-10x^3+15x^4-6x^5.
        // This form avoids subtracting nearly equal O(1) terms near the cutoff.
        bytes16 t2 = m.mul(t, t);
        value = m.mul(m.mul(t2, t), m.add(m.sub(TEN, m.mul(FIFTEEN, t)), m.mul(SIX, t2)));
        derivative = m.neg(m.div(m.mul(THIRTY, m.mul(m.mul(x, x), t2)), width));
    }

    function _reactionField(bytes16 r, bytes16 rc, bytes16 strength)
        private view returns (bytes16 energy, bytes16 forceScale)
    {
        FloatMath m = numericalMath;
        if (m.isZero(strength)) return (energy, forceScale);
        bytes16 t = m.div(r, rc);
        bytes16 gap = m.div(m.sub(rc, r), rc);
        // U = K*(1/r + r^2/(2rc^3) - 3/(2rc)), stably factored at r=rc.
        energy = m.mul(gap, gap);
        energy = m.mul(energy, m.add(t, TWO));
        energy = m.div(m.div(energy, r), TWO);
        energy = m.mul(strength, energy);
        // F_A = K*(-1/r^3 + 1/rc^3)*d, likewise factored.
        forceScale = m.mul(t, t);
        forceScale = m.add(ONE, m.add(t, forceScale));
        forceScale = m.mul(gap, forceScale);
        forceScale = m.div(m.div(m.div(forceScale, r), r), r);
        forceScale = m.neg(m.mul(strength, forceScale));
    }

    function _validate(Parameters memory p) private view {
        FloatMath m = numericalMath;
        if (!m.isFinite(p.sigma) || !m.isFinite(p.epsilon) || !m.isFinite(p.chargeProduct)
            || !m.isFinite(p.prefactor) || !m.isFinite(p.switchDistance) || !m.isFinite(p.cutoff)) revert NonFiniteInput();
        if (m.compare(p.sigma, bytes16(0)) <= 0 || m.compare(p.epsilon, bytes16(0)) < 0
            || m.compare(p.prefactor, bytes16(0)) < 0 || m.compare(p.switchDistance, bytes16(0)) <= 0
            || m.compare(p.cutoff, p.switchDistance) <= 0) revert InvalidParameter();
    }
}
