// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FloatMath} from "../math/FloatMath.sol";
import {ScalarMath} from "../math/ScalarMath.sol";

/// @notice One-atom BAOAB Langevin update with on-step velocities.
/// @dev The coordinator must supply complete old/new forces and deterministic
///      standard-normal draws. This primitive does not implement constraints.
contract LangevinBAOABKernel {
    error InvalidDependency();
    error InvalidParameter();
    error NonFiniteInput();

    FloatMath public immutable numericalMath;
    ScalarMath public immutable scalarMath;
    bytes32 public constant KERNEL_ID = keccak256("ORVIA.LangevinBAOABKernel.v0.5");
    bytes16 private constant ONE = 0x3fff0000000000000000000000000000;
    bytes16 private constant HALF = 0x3ffe0000000000000000000000000000;
    bytes16 private constant QUARTER = 0x3ffd0000000000000000000000000000;

    struct Update {
        bytes16[3] position;
        bytes16[3] velocity;
        bytes16[3] force;
        bytes16[3] normal;
        bytes16 mass;
        bytes16 dt;
        bytes16 friction;
        bytes16 kT;
    }
    struct Coefficients { bytes16 decay; bytes16 noise; bytes16 halfDt; bytes16 halfKick; }

    constructor(address math_, address scalar_) {
        if (math_.code.length == 0 || scalar_.code.length == 0) revert InvalidDependency();
        if (address(ScalarMath(scalar_).numericalMath()) != math_) revert InvalidDependency();
        numericalMath = FloatMath(math_);
        scalarMath = ScalarMath(scalar_);
    }

    /// @param kT Thermal energy in the same units as the potential (not Kelvin).
    function coefficients(bytes16 mass, bytes16 dt, bytes16 friction, bytes16 kT)
        public view returns (bytes16 decay, bytes16 noiseScale)
    {
        _positive(mass); _positive(dt); _positive(kT); _nonnegative(friction);
        FloatMath m = numericalMath;
        bytes16 z = m.mul(friction, dt);
        decay = scalarMath.exp(m.neg(z)); // Reverts if gamma*dt exceeds 256.
        bytes16 varianceFactor;
        if (m.compare(z, QUARTER) <= 0) {
            varianceFactor = m.neg(scalarMath.expm1(m.mul(m.fromInt(-2), z)));
        } else {
            varianceFactor = m.mul(m.sub(ONE, decay), m.add(ONE, decay));
        }
        noiseScale = m.sqrt(m.mul(m.div(kT, mass), varianceFactor));
    }

    /// @notice B half-kick, A half-drift, O thermostat, A half-drift.
    function begin(
        bytes16[3] calldata position, bytes16[3] calldata velocity, bytes16[3] calldata force,
        bytes16 mass, bytes16 dt, bytes16 friction, bytes16 kT, bytes16[3] calldata normal
    ) external view returns (bytes16[3] memory nextPosition, bytes16[3] memory thermalVelocity) {
        Update memory input;
        input.position = position; input.velocity = velocity; input.force = force; input.normal = normal;
        input.mass = mass; input.dt = dt; input.friction = friction; input.kT = kT;
        return _begin(input);
    }

    function _begin(Update memory input) private view
        returns (bytes16[3] memory nextPosition, bytes16[3] memory thermalVelocity)
    {
        Coefficients memory c;
        (c.decay, c.noise) = coefficients(input.mass, input.dt, input.friction, input.kT);
        FloatMath m = numericalMath;
        c.halfDt = m.mul(HALF, input.dt);
        c.halfKick = m.div(c.halfDt, input.mass);
        for (uint256 axis; axis < 3; ++axis) {
            _finite(input.position[axis]); _finite(input.velocity[axis]); _finite(input.force[axis]); _finite(input.normal[axis]);
            bytes16 halfVelocity = m.add(input.velocity[axis], m.mul(c.halfKick, input.force[axis]));
            thermalVelocity[axis] = m.add(m.mul(c.decay, halfVelocity), m.mul(c.noise, input.normal[axis]));
            nextPosition[axis] = m.add(input.position[axis], m.mul(c.halfDt, m.add(halfVelocity, thermalVelocity[axis])));
        }
    }

    /// @notice Final B half-kick after the complete next-position force pass.
    function finish(bytes16[3] calldata thermalVelocity, bytes16[3] calldata newForce, bytes16 mass, bytes16 dt)
        external view returns (bytes16[3] memory nextVelocity)
    {
        _positive(mass); _positive(dt);
        FloatMath m = numericalMath;
        bytes16 scale = m.div(m.mul(HALF, dt), mass);
        for (uint256 axis; axis < 3; ++axis) {
            _finite(thermalVelocity[axis]); _finite(newForce[axis]);
            nextVelocity[axis] = m.add(thermalVelocity[axis], m.mul(scale, newForce[axis]));
        }
    }

    function _finite(bytes16 value) private view {
        if (!numericalMath.isFinite(value)) revert NonFiniteInput();
    }
    function _positive(bytes16 value) private view {
        _finite(value);
        if (numericalMath.compare(value, bytes16(0)) <= 0) revert InvalidParameter();
    }
    function _nonnegative(bytes16 value) private view {
        _finite(value);
        if (numericalMath.compare(value, bytes16(0)) < 0) revert InvalidParameter();
    }
}
