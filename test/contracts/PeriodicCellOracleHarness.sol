// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FloatMath} from "../../contracts/math/FloatMath.sol";
import {OrthorhombicGeometry} from "../../contracts/kernels/OrthorhombicGeometry.sol";

/// @dev Test-only brute force: same ordered EVM distance as the full Hamiltonian.
///      It supplies no membership, force, energy or scientific result to production.
contract PeriodicCellOracleHarness {
    function bruteNeighbors(address math_, address geometry_, bytes16[3][] calldata positions,
        uint32 atom, bytes16[3] calldata box, bytes16 cutoff) external view returns (uint32[] memory neighbors)
    {
        require(positions.length <= 64 && atom < positions.length);
        FloatMath m = FloatMath(math_); neighbors = new uint32[](positions.length); uint256 used;
        for (uint256 b; b < positions.length; ++b) {
            bytes16[3] memory d = OrthorhombicGeometry(geometry_).displacement(positions[atom],positions[b],box);
            bytes16 squared;
            for (uint256 axis; axis < 3; ++axis) squared = m.add(squared,m.mul(d[axis],d[axis]));
            if (m.compare(m.sqrt(squared),cutoff) < 0) neighbors[used++] = uint32(b);
        }
        assembly { mstore(neighbors,used) }
    }
}
