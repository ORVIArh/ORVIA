// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Test-only counterfeits: copied identifiers must not authorize inline execution.
contract ForgedInlineKernelIdentity {
    bytes32 public constant KERNEL_ID = keccak256("ORVIA.InlineNonbondedKernel.v0.5.ConductingRF.PinnedABDK");
    bytes32 public constant ARITHMETIC_IMPLEMENTATION_ID =
        keccak256("ORVIA.FloatMath.v0.1.ABDKMathQuad.5e1e7c11b35f8313d3f7ce11c1b86320d7c0b554");
}

contract ForgedFloatMathIdentity {
    bytes32 public constant IMPLEMENTATION_ID =
        keccak256("ORVIA.FloatMath.v0.1.ABDKMathQuad.5e1e7c11b35f8313d3f7ce11c1b86320d7c0b554");
}
