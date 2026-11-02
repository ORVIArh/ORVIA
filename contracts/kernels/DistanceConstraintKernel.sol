// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FloatMath} from "../math/FloatMath.sol";

/// @notice One mass-weighted SHAKE position or RATTLE velocity correction.
/// @dev A coordinator must iterate coupled constraints to a registered tolerance
///      and reject nonconvergence before committing a timestep.
contract DistanceConstraintKernel {
    error InvalidDependency();
    error InvalidInput();
    error NoLocalSolution();
    FloatMath public immutable numericalMath;
    bytes32 public constant KERNEL_ID = keccak256("ORVIA.DistanceConstraintKernel.v1");

    struct PositionInput {
        bytes16[3] oldDisplacement;
        bytes16[3] trialDisplacement;
        bytes16 massA;
        bytes16 massB;
        bytes16 target;
    }
    struct VelocityInput {
        bytes16[3] displacement;
        bytes16[3] relativeVelocity;
        bytes16 massA;
        bytes16 massB;
    }

    constructor(address math_) {
        if (math_.code.length == 0) revert InvalidDependency();
        numericalMath = FloatMath(math_);
    }

    /// @notice Corrections are added to A and B; displacements use B-A.
    function positionCorrection(PositionInput calldata p) external view
        returns (bytes16[3] memory correctionA, bytes16[3] memory correctionB, bytes16 relativeResidual)
    {
        FloatMath m = numericalMath;
        _positive(p.massA); _positive(p.massB); _positive(p.target);
        bytes16 oldSquared = _dot(p.oldDisplacement, p.oldDisplacement);
        _positive(oldSquared);
        bytes16 dot = _dot(p.oldDisplacement, p.trialDisplacement);
        // Restrict to the continuous local SHAKE root, not a bond orientation flip.
        if (m.compare(dot, bytes16(0)) <= 0) revert NoLocalSolution();
        bytes16 targetSquared = m.mul(p.target, p.target);
        _positive(targetSquared);
        bytes16 defect = m.sub(_dot(p.trialDisplacement, p.trialDisplacement), targetSquared);
        relativeResidual = m.div(m.abs(defect), targetSquared);
        bytes16 discriminant = m.sub(m.mul(dot, dot), m.mul(oldSquared, defect));
        if (m.compare(discriminant, bytes16(0)) < 0) revert NoLocalSolution();
        // x=defect/(dot+sqrt(dot^2-oldSquared*defect)) avoids subtractive cancellation.
        bytes16 x = m.div(defect, m.add(dot, m.sqrt(discriminant)));
        (correctionA, correctionB) = _corrections(p.oldDisplacement, x, p.massA, p.massB);
    }

    function velocityCorrection(VelocityInput calldata p) external view
        returns (bytes16[3] memory correctionA, bytes16[3] memory correctionB, bytes16 relativeResidual)
    {
        _positive(p.massA); _positive(p.massB);
        FloatMath m = numericalMath;
        bytes16 squared = _dot(p.displacement, p.displacement);
        _positive(squared);
        bytes16 x = m.div(_dot(p.displacement, p.relativeVelocity), squared);
        // Residual has units inverse time; it is distinct from position tolerance.
        relativeResidual = m.abs(x);
        (correctionA, correctionB) = _corrections(p.displacement, x, p.massA, p.massB);
    }

    function _corrections(bytes16[3] memory direction, bytes16 x, bytes16 massA, bytes16 massB)
        private view returns (bytes16[3] memory a, bytes16[3] memory b)
    {
        FloatMath m = numericalMath;
        bytes16 totalMass = m.add(massA, massB);
        bytes16 shareA = m.mul(x, m.div(massB, totalMass));
        bytes16 shareB = m.neg(m.mul(x, m.div(massA, totalMass)));
        for (uint256 axis; axis < 3; ++axis) {
            a[axis] = m.mul(shareA, direction[axis]);
            b[axis] = m.mul(shareB, direction[axis]);
        }
    }

    function _dot(bytes16[3] memory a, bytes16[3] memory b) private view returns (bytes16 sum) {
        for (uint256 axis; axis < 3; ++axis) {
            if (!numericalMath.isFinite(a[axis]) || !numericalMath.isFinite(b[axis])) revert InvalidInput();
            sum = numericalMath.add(sum, numericalMath.mul(a[axis], b[axis]));
        }
    }

    function _positive(bytes16 value) private view {
        if (!numericalMath.isFinite(value) || numericalMath.compare(value, bytes16(0)) <= 0) revert InvalidInput();
    }
}
