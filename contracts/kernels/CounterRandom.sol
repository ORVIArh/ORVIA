// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FloatMath} from "../math/FloatMath.sol";
import {ScalarMath} from "../math/ScalarMath.sol";
import {ElementaryMath} from "../math/ElementaryMath.sol";

/// @notice Stateless, reproducible scientific random streams from registered counters.
/// @dev No block entropy, sender, address or mutable draw counter enters the stream.
contract CounterRandom {
    error InvalidDependency();

    FloatMath public immutable numericalMath;
    ScalarMath public immutable scalarMath;
    ElementaryMath public immutable elementaryMath;
    bytes32 public constant DOMAIN = keccak256("ORVIA.CounterRandom.v1");
    bytes32 public constant GENERATOR_ID = keccak256("ORVIA.CounterRandom.v0.5.Keccak112midpoint.BoxMuller");
    bytes16 private constant TWO_TO_MINUS_113 = 0x3f8e0000000000000000000000000000;

    constructor(address math_, address scalar_, address elementary_) {
        if (math_.code.length == 0 || scalar_.code.length == 0 || elementary_.code.length == 0) revert InvalidDependency();
        if (address(ScalarMath(scalar_).numericalMath()) != math_
            || address(ElementaryMath(elementary_).numericalMath()) != math_) revert InvalidDependency();
        numericalMath = FloatMath(math_);
        scalarMath = ScalarMath(scalar_);
        elementaryMath = ElementaryMath(elementary_);
    }

    function word(bytes32 seed, bytes32 experiment, uint32 replica, uint64 step, uint64 draw, uint8 lane)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(DOMAIN, seed, experiment, replica, step, draw, lane));
    }

    function uniform(bytes32 seed, bytes32 experiment, uint32 replica, uint64 step, uint64 draw)
        external view returns (bytes16)
    {
        return _uniform(word(seed, experiment, replica, step, draw, 0));
    }

    /// @notice Two standard-normal approximations from two independent hash lanes.
    function normalPair(bytes32 seed, bytes32 experiment, uint32 replica, uint64 step, uint64 draw)
        external view returns (bytes16 first, bytes16 second)
    {
        FloatMath m = numericalMath;
        bytes16 u = _uniform(word(seed, experiment, replica, step, draw, 0));
        bytes16 v = _uniform(word(seed, experiment, replica, step, draw, 1));
        bytes16 radius = m.sqrt(m.mul(m.fromInt(-2), scalarMath.ln(u)));
        (bytes16 sine, bytes16 cosine) = elementaryMath.sinCos(m.mul(elementaryMath.TWO_PI(), v));
        first = m.mul(radius, cosine);
        second = m.mul(radius, sine);
    }

    function _uniform(bytes32 bits) private view returns (bytes16) {
        // Odd integer/2^113 is exactly representable, and always strictly in (0,1).
        uint256 midpointNumerator = 2 * (uint256(bits) >> 144) + 1;
        return numericalMath.mul(numericalMath.fromUInt(midpointNumerator), TWO_TO_MINUS_113);
    }
}
