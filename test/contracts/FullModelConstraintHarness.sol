// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {BankedWorkingState} from "../../contracts/core/BankedWorkingState.sol";
import {FullModelConstraintSolver} from "../../contracts/core/FullModelConstraintSolver.sol";
import {AlchemicalTopologyCatalog, IAlchemicalInputStreams} from "../../contracts/core/AlchemicalTopologyCatalog.sol";

/// @dev Synthetic test writer only. Production pipelines expose no arbitrary
///      frame upload or generic register forwarding entry points.
contract FullModelConstraintHarness {
    error Unauthorized();
    address public immutable owner;
    BankedWorkingState public statePage;
    constructor() { owner = msg.sender; }
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    function configure(address page) external onlyOwner { statePage = BankedWorkingState(page); }
    function frame(bytes32 id, bytes32 snapshot, bytes32[] calldata words) external onlyOwner {
        statePage.createNamespace(id, uint32(words.length));
        statePage.writeWords(id, 0, words);
        statePage.snapshotNamespace(id, snapshot);
    }
    function write(bytes32 id, uint256 offset, bytes32[] calldata words) external onlyOwner { statePage.writeWords(id, offset, words); }
    function sparseFrame(bytes32 id, bytes32 snapshot, uint32 capacity, uint32 atom, bytes32[] calldata words) external onlyOwner {
        statePage.createNamespace(id, capacity);
        statePage.writeWords(id, uint256(atom) * 9, words);
        statePage.snapshotNamespace(id, snapshot);
    }
    function register(address solver, bytes32 id, FullModelConstraintSolver.Params calldata params) external onlyOwner {
        FullModelConstraintSolver(solver).registerProblem(id, params);
    }
}

/// @dev INDEX-RANGE TEST ONLY: deliberately synthetic topology metadata, never
///      evidence of a fully uploaded/validated 132936-atom chemical model.
contract FullModelConstraintMetadataHarness {
    address public immutable numericalMath;
    IAlchemicalInputStreams public immutable inputs;
    constructor(address math_, address inputs_) { numericalMath = math_; inputs = IAlchemicalInputStreams(inputs_); }
    function assertTopology(bytes32 id) external pure returns (bytes32) { return keccak256(abi.encode("SYNTHETIC-INDEX-ONLY", id)); }
    function definition(bytes32) external pure returns (AlchemicalTopologyCatalog.Definition memory d) {
        d.atoms = 132936; d.a.particles = bytes32("SYNTHETIC-MASSES");
        d.box = [bytes16(0x40024000000000000000000000000000), bytes16(0x40024000000000000000000000000000), bytes16(0x40024000000000000000000000000000)];
    }
    function word(bytes32, uint64 index) external pure returns (bytes32) {
        require(index < uint64(132936) * 4 && index % 4 == 0);
        return bytes32(uint256(uint128(bytes16(0x3fff0000000000000000000000000000))));
    }
}
