// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FloatMath} from "../math/FloatMath.sol";

/// @notice Velocity-Verlet drift/half-kick and final half-kick for one atom.
/// @dev The coordinator owns stage barriers and chooses forces from complete
///      old/new force evaluations. This kernel does not implement a thermostat,
///      constraints, periodic wrapping or force accumulation.
contract VelocityVerletKernel {
    error InvalidMathContract();
    error NonFiniteInput();
    error NonPositiveMass();
    error NonPositiveTimestep();

    FloatMath public immutable numericalMath;
    bytes32 public constant KERNEL_ID = keccak256("ORVIA.VelocityVerletKernel.v0.3");

    constructor(address numericalMath_) {
        if (numericalMath_.code.length == 0) revert InvalidMathContract();
        numericalMath = FloatMath(numericalMath_);
    }

    function drift(
        bytes16[3] calldata position,
        bytes16[3] calldata velocity,
        bytes16[3] calldata force,
        bytes16 mass,
        bytes16 dt
    ) external view returns (bytes16[3] memory nextPosition, bytes16[3] memory halfVelocity) {
        FloatMath m = numericalMath;
        bytes16 scale = _halfKickScale(mass, dt);
        for (uint256 axis; axis < 3; ++axis) {
            _requireFinite(position[axis]);
            _requireFinite(velocity[axis]);
            _requireFinite(force[axis]);
            halfVelocity[axis] = m.add(velocity[axis], m.mul(scale, force[axis]));
            nextPosition[axis] = m.add(position[axis], m.mul(dt, halfVelocity[axis]));
        }
    }

    function kick(
        bytes16[3] calldata halfVelocity,
        bytes16[3] calldata newForce,
        bytes16 mass,
        bytes16 dt
    ) external view returns (bytes16[3] memory nextVelocity) {
        FloatMath m = numericalMath;
        bytes16 scale = _halfKickScale(mass, dt);
        for (uint256 axis; axis < 3; ++axis) {
            _requireFinite(halfVelocity[axis]);
            _requireFinite(newForce[axis]);
            nextVelocity[axis] = m.add(halfVelocity[axis], m.mul(scale, newForce[axis]));
        }
    }

    function _halfKickScale(bytes16 mass, bytes16 dt) private view returns (bytes16) {
        FloatMath m = numericalMath;
        _requireFinite(mass);
        _requireFinite(dt);
        if (m.isNegative(mass) || m.isZero(mass)) revert NonPositiveMass();
        if (m.isNegative(dt) || m.isZero(dt)) revert NonPositiveTimestep();
        return m.div(m.mul(bytes16(0x3ffe0000000000000000000000000000), dt), mass);
    }

    function _requireFinite(bytes16 value) private view {
        if (!numericalMath.isFinite(value)) revert NonFiniteInput();
    }
}
