// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ShardedWorkingState} from "../../contracts/core/ShardedWorkingState.sol";
import {HarmonicBondKernel} from "../../contracts/kernels/HarmonicBondKernel.sol";

/// @dev Test-only real-kernel consumer, not a production molecular coordinator.
///      Exercises global atom addressing, atomic cross-shard forces and snapshots.
contract ShardedStateForceHarness {
    ShardedWorkingState public state;
    HarmonicBondKernel public kernel;
    uint64 public completedSteps;
    uint64 public targetSteps;
    uint32 public atoms;
    bytes32 public namespace;
    function configure(address state_, address kernel_, uint32 atoms_, uint64 startStep, uint64 target) external {
        require(address(state) == address(0) && atoms_ > 1 && target > startStep);
        state = ShardedWorkingState(state_); kernel = HarmonicBondKernel(kernel_);
        atoms = atoms_; completedSteps = startStep; targetSteps = target;
        namespace = keccak256(abi.encode("cross-shard-real-bond", address(this), atoms_));
        state.createNamespace(namespace, atoms_ * 9 + 1);
    }
    function setParticle(uint32 atom, bytes16[3] calldata position, bytes16[3] calldata velocity) external {
        require(atom < atoms);
        bytes32[] memory words = new bytes32[](6);
        for (uint256 i; i < 3; ++i) { words[i] = bytes32(uint256(uint128(position[i]))); words[3+i] = bytes32(uint256(uint128(velocity[i]))); }
        state.writeWords(namespace, uint256(atom) * 9, words);
    }
    function evaluateBond(uint32 a, uint32 b, bytes16 k, bytes16 r0) external {
        require(a < atoms && b < atoms && a != b);
        bytes16[3] memory pa; bytes16[3] memory pb;
        bytes32[] memory wa = state.readWords(namespace, uint256(a) * 9, 3);
        bytes32[] memory wb = state.readWords(namespace, uint256(b) * 9, 3);
        for (uint256 i; i < 3; ++i) { pa[i] = bytes16(uint128(uint256(wa[i]))); pb[i] = bytes16(uint128(uint256(wb[i]))); }
        (bytes16 energy, bytes16[3] memory force) = kernel.evaluate(pa, pb, k, r0);
        bytes32[] memory fa = new bytes32[](3); bytes32[] memory fb = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            fa[i] = bytes32(uint256(uint128(force[i])));
            // IEEE binary128 opposite sign, preserving +0 for both zero forces.
            uint128 bits = uint128(force[i]);
            fb[i] = bytes32(uint256(bits & 0x7fffffffffffffffffffffffffffffff == 0 ? 0 : bits ^ (uint128(1) << 127)));
        }
        state.writeWords(namespace, uint256(a) * 9 + 6, fa);
        state.writeWords(namespace, uint256(b) * 9 + 6, fb);
        state.writeWord(namespace, uint256(atoms) * 9, bytes32(uint256(uint128(energy))));
    }
    function commitStep() external returns (bytes32 snapshot) {
        require(completedSteps < targetSteps);
        ++completedSteps;
        snapshot = keccak256(abi.encode(namespace, completedSteps));
        state.snapshotNamespace(namespace, snapshot);
    }
}
