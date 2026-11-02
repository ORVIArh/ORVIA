// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ABDKMathQuad} from "../math/vendor/ABDKMathQuad.sol";

/// @notice Quintic-switched LJ plus conducting-limit reaction-field Coulomb.
/// @dev The caller supplies d = nearest-image(b-a). Exceptions use direct,
///      unswitched, uncut LJ+Coulomb. This is not Ewald or PME electrostatics.
///      No external arithmetic dependency. NeighborDynamicsCoordinator admits
///      this exact compiled runtime under its explicit pinned-inline policy.
///      Operation order and finite/canonical-zero guards match the v0.4 path.
///      This product includes software developed by ABDK Consulting.
///      Pinned upstream BSD-4-Clause license: ../math/vendor/LICENSE.md.
contract InlineNonbondedKernel {
    error NonFiniteInput();
    error InvalidParameter();
    error ZeroSeparation();

    bytes32 public constant KERNEL_ID = keccak256("ORVIA.InlineNonbondedKernel.v0.5.ConductingRF.PinnedABDK");


    bytes20 public constant ABDK_COMMIT = hex"5e1e7c11b35f8313d3f7ce11c1b86320d7c0b554";
    bytes32 public constant ABDK_SOURCE_SHA256 = 0xdd13f72bf828a699c94e96d1377daabce3dcc1d4b29af7215501a611d3cb7c9e;
    bytes32 public constant ARITHMETIC_IMPLEMENTATION_ID =
        keccak256("ORVIA.FloatMath.v0.1.ABDKMathQuad.5e1e7c11b35f8313d3f7ce11c1b86320d7c0b554");

    error NonFinite();
    error DivisionByZero();
    error NegativeSquareRoot();
    error NonPositiveSigma();
    error NegativeEpsilon();
    error NegativePrefactor();
    uint128 private constant EXPONENT_MASK = 0x7fff0000000000000000000000000000;
    uint128 private constant MAGNITUDE_MASK = 0x7fffffffffffffffffffffffffffffff;
    uint128 private constant SIGN_MASK = 0x80000000000000000000000000000000;

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

    function evaluate(
        bytes16[3] calldata displacement,
        bytes16 sigma,
        bytes16 epsilon,
        bytes16 chargeProduct,
        bytes16 prefactor,
        bytes16 switchDistance,
        bytes16 cutoff,
        bool exception
    ) external pure returns (bytes16 energy, bytes16[3] memory forceOnA) {
        Parameters memory p = Parameters(sigma, epsilon, chargeProduct, prefactor, switchDistance, cutoff, exception);
        return _evaluate(displacement, p);
    }

    function _evaluate(bytes16[3] memory d, Parameters memory p)
        private pure returns (bytes16 energy, bytes16[3] memory forceOnA)
    {
        _validate(p);
        bytes16 r = _distance(d);
        if (!p.exception && _compare(r, p.cutoff) >= 0) return (energy, forceOnA);

        {
            bytes16[3] memory origin;
            (energy, forceOnA) = _lj(origin, d, p.sigma, p.epsilon);
            if (p.exception) {
                (bytes16 ec, bytes16[3] memory fc) = _coulomb(origin, d, p.chargeProduct, p.prefactor);
                energy = _add(energy, ec);
                for (uint256 axis; axis < 3; ++axis) forceOnA[axis] = _add(forceOnA[axis], fc[axis]);
                return (energy, forceOnA);
            }
        }

        if (_compare(r, p.switchDistance) > 0) {
            (energy, forceOnA) = _applySwitch(d, r, p, energy, forceOnA);
        }
        (bytes16 rfEnergy, bytes16 rfScale) = _reactionField(r, p.cutoff, _mul(p.chargeProduct, p.prefactor));
        energy = _add(energy, rfEnergy);
        for (uint256 axis; axis < 3; ++axis) forceOnA[axis] = _add(forceOnA[axis], _mul(rfScale, d[axis]));
    }

    function _distance(bytes16[3] memory d) private pure returns (bytes16) {
        bytes16 rSquared;
        for (uint256 axis; axis < 3; ++axis) {
            if (!_isFinite(d[axis])) revert NonFiniteInput();
            rSquared = _add(rSquared, _mul(d[axis], d[axis]));
        }
        if (_checkedZero(rSquared)) revert ZeroSeparation();
        return _sqrt(rSquared);
    }

    function _applySwitch(bytes16[3] memory d, bytes16 r, Parameters memory p, bytes16 energy, bytes16[3] memory force)
        private pure returns (bytes16, bytes16[3] memory)
    {
        (bytes16 switching, bytes16 derivative) = _switch(r, p.switchDistance, p.cutoff);
        // F_A = S*F_LJ + U_LJ*(dS/dr)*d/r; preserve unswitched energy here.
        bytes16 correction = _div(_mul(energy, derivative), r);
        force = _combine(force, d, switching, correction);
        return (_mul(switching, energy), force);
    }

    function _combine(bytes16[3] memory force, bytes16[3] memory d, bytes16 scale, bytes16 correction)
        private pure returns (bytes16[3] memory)
    {
        for (uint256 axis; axis < 3; ++axis) {
            force[axis] = _add(_mul(scale, force[axis]), _mul(correction, d[axis]));
        }
        return force;
    }

    function _switch(bytes16 r, bytes16 rs, bytes16 rc) private pure returns (bytes16 value, bytes16 derivative) {
        bytes16 width = _sub(rc, rs);
        bytes16 x = _div(_sub(r, rs), width);
        bytes16 t = _div(_sub(rc, r), width);
        // S=t^3*(10-15t+6t^2), algebraically 1-10x^3+15x^4-6x^5.
        // This form avoids subtracting nearly equal O(1) terms near the cutoff.
        bytes16 t2 = _mul(t, t);
        value = _mul(_mul(t2, t), _add(_sub(TEN, _mul(FIFTEEN, t)), _mul(SIX, t2)));
        derivative = _neg(_div(_mul(THIRTY, _mul(_mul(x, x), t2)), width));
    }

    function _reactionField(bytes16 r, bytes16 rc, bytes16 strength)
        private pure returns (bytes16 energy, bytes16 forceScale)
    {
        if (_checkedZero(strength)) return (energy, forceScale);
        bytes16 t = _div(r, rc);
        bytes16 gap = _div(_sub(rc, r), rc);
        // U = K*(1/r + r^2/(2rc^3) - 3/(2rc)), stably factored at r=rc.
        energy = _mul(gap, gap);
        energy = _mul(energy, _add(t, TWO));
        energy = _div(_div(energy, r), TWO);
        energy = _mul(strength, energy);
        // F_A = K*(-1/r^3 + 1/rc^3)*d, likewise factored.
        forceScale = _mul(t, t);
        forceScale = _add(ONE, _add(t, forceScale));
        forceScale = _mul(gap, forceScale);
        forceScale = _div(_div(_div(forceScale, r), r), r);
        forceScale = _neg(_mul(strength, forceScale));
    }

    function _validate(Parameters memory p) private pure {
        if (!_isFinite(p.sigma) || !_isFinite(p.epsilon) || !_isFinite(p.chargeProduct)
            || !_isFinite(p.prefactor) || !_isFinite(p.switchDistance) || !_isFinite(p.cutoff)) revert NonFiniteInput();
        if (_compare(p.sigma, bytes16(0)) <= 0 || _compare(p.epsilon, bytes16(0)) < 0
            || _compare(p.prefactor, bytes16(0)) < 0 || _compare(p.switchDistance, bytes16(0)) <= 0
            || _compare(p.cutoff, p.switchDistance) <= 0) revert InvalidParameter();
    }

    function _lj(bytes16[3] memory a, bytes16[3] memory b, bytes16 sigma, bytes16 epsilon)
        private
        pure
        returns (bytes16 energy, bytes16[3] memory forceOnA)
    {
        if (!_isFinite(sigma) || !_isFinite(epsilon)) revert NonFiniteInput();
        if (_isNegative(sigma) || _checkedZero(sigma)) revert NonPositiveSigma();
        if (_isNegative(epsilon)) revert NegativeEpsilon();

        bytes16[3] memory displacement;
        bytes16 rSquared;
        for (uint256 axis; axis < 3; ++axis) {
            if (!_isFinite(a[axis]) || !_isFinite(b[axis])) revert NonFiniteInput();
            displacement[axis] = _sub(b[axis], a[axis]);
            rSquared = _add(rSquared, _mul(displacement[axis], displacement[axis]));
        }
        if (_checkedZero(rSquared)) revert ZeroSeparation();
        // Zero strength still requires valid, nonsingular geometry.
        if (_checkedZero(epsilon)) return (energy, forceOnA);

        bytes16 ratioSquared = _div(_mul(sigma, sigma), rSquared);
        bytes16 ratioSixth = _mul(_mul(ratioSquared, ratioSquared), ratioSquared);
        bytes16 ratioTwelfth = _mul(ratioSixth, ratioSixth);
        // The constants 2, 4 and 24 have exact binary128 representations.
        bytes16 fourEpsilon = _mul(bytes16(0x40010000000000000000000000000000), epsilon);
        energy = _mul(fourEpsilon, _sub(ratioTwelfth, ratioSixth));
        bytes16 radialNumerator = _mul(
            _mul(bytes16(0x40038000000000000000000000000000), epsilon),
            _sub(ratioSixth, _mul(bytes16(0x40000000000000000000000000000000), ratioTwelfth))
        );
        // For d = b-a, F_A = (dU/dr)*d/r. F_B is the negative of F_A.
        bytes16 scale = _div(radialNumerator, rSquared);
        for (uint256 axis; axis < 3; ++axis) {
            forceOnA[axis] = _mul(scale, displacement[axis]);
        }
    }

    function _coulomb(bytes16[3] memory a, bytes16[3] memory b, bytes16 chargeProduct, bytes16 prefactor)
        private
        pure
        returns (bytes16 energy, bytes16[3] memory forceOnA)
    {
        if (!_isFinite(chargeProduct) || !_isFinite(prefactor)) revert NonFiniteInput();
        if (_isNegative(prefactor)) revert NegativePrefactor();

        bytes16[3] memory displacement;
        bytes16 rSquared;
        for (uint256 axis; axis < 3; ++axis) {
            if (!_isFinite(a[axis]) || !_isFinite(b[axis])) revert NonFiniteInput();
            displacement[axis] = _sub(b[axis], a[axis]);
            rSquared = _add(rSquared, _mul(displacement[axis], displacement[axis]));
        }
        if (_checkedZero(rSquared)) revert ZeroSeparation();
        // Zero strength still requires valid, nonsingular geometry.
        if (_checkedZero(prefactor) || _checkedZero(chargeProduct)) return (energy, forceOnA);

        bytes16 r = _sqrt(rSquared);
        energy = _div(_mul(prefactor, chargeProduct), r);
        // For d = b-a, like charges repel: F_A = -U*d/r^2.
        bytes16 scale = _neg(_div(energy, rSquared));
        for (uint256 axis; axis < 3; ++axis) {
            forceOnA[axis] = _mul(scale, displacement[axis]);
        }
    }

    function _isFinite(bytes16 x) private pure returns (bool) {
        return (uint128(x) & EXPONENT_MASK) != EXPONENT_MASK;
    }

    function _isNegative(bytes16 x) private pure returns (bool) {
        _requireFinite(x);
        return (uint128(x) & SIGN_MASK) != 0 && !_isZero(x);
    }

    function _checkedZero(bytes16 x) private pure returns (bool) {
        _requireFinite(x);
        return _isZero(x);
    }

    function _add(bytes16 x, bytes16 y) private pure returns (bytes16) {
        _requireFinite(x);
        _requireFinite(y);
        return _finiteResult(ABDKMathQuad.add(x, y));
    }

    function _sub(bytes16 x, bytes16 y) private pure returns (bytes16) {
        _requireFinite(x);
        _requireFinite(y);
        return _finiteResult(ABDKMathQuad.sub(x, y));
    }

    function _mul(bytes16 x, bytes16 y) private pure returns (bytes16) {
        _requireFinite(x);
        _requireFinite(y);
        return _finiteResult(ABDKMathQuad.mul(x, y));
    }

    function _div(bytes16 x, bytes16 y) private pure returns (bytes16) {
        _requireFinite(x);
        _requireFinite(y);
        if (_isZero(y)) revert DivisionByZero();
        return _finiteResult(ABDKMathQuad.div(x, y));
    }

    function _sqrt(bytes16 x) private pure returns (bytes16) {
        _requireFinite(x);
        if ((uint128(x) & SIGN_MASK) != 0 && !_isZero(x)) revert NegativeSquareRoot();
        return _finiteResult(ABDKMathQuad.sqrt(x));
    }

    function _neg(bytes16 x) private pure returns (bytes16) {
        _requireFinite(x);
        return _finiteResult(ABDKMathQuad.neg(x));
    }

    function _compare(bytes16 x, bytes16 y) private pure returns (int8) {
        _requireFinite(x);
        _requireFinite(y);
        // Numerical zero compares equal regardless of its input sign bit.
        return ABDKMathQuad.cmp(_isZero(x) ? bytes16(0) : x, _isZero(y) ? bytes16(0) : y);
    }

    function _requireFinite(bytes16 x) private pure {
        if (!_isFinite(x)) revert NonFinite();
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
