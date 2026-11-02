// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PeriodicCellIndex} from "./PeriodicCellIndex.sol";

/// @notice Canonical i<j traversal of an authenticated periodic cell index.
/// @dev Only the immutable consumer can pull pairs. Its force operation and this
///      cursor update must share a transaction, so a failure rolls both back.
///      This module is not connected to AlchemicalHamiltonianEvaluator yet.
contract OrderedNeighborPairs {
    error Unauthorized();
    error InvalidInput();
    error DependencyChanged();

    uint256 public constant MAX_WORK = 32;
    bytes32 public constant POLICY_ID = keccak256("ORVIA.OrderedNeighborPairs.v1.Packed27Heads");
    address public immutable owner;
    bytes32 public immutable ownerCodeHash;
    PeriodicCellIndex public immutable cellIndex;
    bytes32 public immutable cellIndexCodeHash;
    uint256 public nextTraversal = 1;

    struct Traversal {
        uint256 index;
        bytes32 indexCommitment;
        bytes32 commitment;
        uint32 atoms;
        uint32 row;
        uint8 headCount;
        bool initialized;
        bool complete;
        uint64 visited;
        uint64 emitted;
        uint256[4] heads;
    }
    mapping(uint256 => Traversal) private _traversals;
    event TraversalRegistered(uint256 indexed traversal, uint256 indexed index, bytes32 commitment);
    event TraversalAdvanced(uint256 indexed traversal, uint256 processed, uint32 row, bool complete);

    constructor(address owner_, address cellIndex_) {
        if (owner_.code.length == 0 || cellIndex_.code.length == 0) revert InvalidInput();
        if (PeriodicCellIndex(cellIndex_).POLICY_ID()
            != keccak256("ORVIA.PeriodicCellIndex.v1.GuardedBinary128.Fixed64")) revert InvalidInput();
        owner = owner_; ownerCodeHash = owner_.codehash;
        cellIndex = PeriodicCellIndex(cellIndex_); cellIndexCodeHash = cellIndex_.codehash;
    }

    modifier onlyOwner() {
        if (msg.sender != owner || owner.codehash != ownerCodeHash) revert Unauthorized();
        _;
    }

    function registerTraversal(uint256 index) external onlyOwner returns (uint256 id) {
        _dependencies();
        (PeriodicCellIndex.Stage stage,,,,,bytes32 indexCommitment,PeriodicCellIndex.Input memory input) = cellIndex.indexInfo(index);
        if (stage != PeriodicCellIndex.Stage.Ready) revert InvalidInput();
        cellIndex.atomCell(index, 0); // Recheck source, snapshot and complete protocol identity.
        id = nextTraversal++; Traversal storage traversal = _traversals[id];
        traversal.index = index; traversal.atoms = input.atoms; traversal.indexCommitment = indexCommitment;
        traversal.commitment = keccak256(abi.encode(POLICY_ID,block.chainid,address(this),id,
            owner,ownerCodeHash,address(cellIndex),cellIndexCodeHash,index,indexCommitment,input.atoms));
        emit TraversalRegistered(id,index,traversal.commitment);
    }

    /// @notice Consume bounded setup/pop/skip work and return at most one pair.
    /// @dev No externally supplied cursor or pair can change coverage. Zero useful
    ///      pairs is a valid page, but every nonterminal call consumes work.
    function advance(uint256 id, uint256 work) external onlyOwner returns (
        uint256 processed, bool found, uint32 a, uint32 b, bool complete
    ) {
        if (work == 0 || work > MAX_WORK) revert InvalidInput();
        _dependencies(); Traversal storage traversal = _get(id);
        cellIndex.atomCell(traversal.index, 0); // Required even after terminal completion.
        if (traversal.complete) return (0,false,0,0,true);
        while (processed < work && !traversal.complete) {
            ++processed;
            if (!traversal.initialized) { _beginRow(traversal); continue; }
            (uint32 pointer,uint256 position) = _minimum(traversal);
            if (pointer == 0) {
                ++traversal.row; traversal.initialized = false;
                if (traversal.row == traversal.atoms) traversal.complete = true;
                continue;
            }
            uint32 atom = pointer - 1;
            _setHead(traversal,position,cellIndex.nextAtom(traversal.index,atom));
            ++traversal.visited;
            if (atom > traversal.row) {
                ++traversal.emitted;
                emit TraversalAdvanced(id,processed,traversal.row,false);
                return (processed,true,traversal.row,atom,false);
            }
        }
        complete = traversal.complete;
        emit TraversalAdvanced(id,processed,traversal.row,complete);
    }

    function traversalInfo(uint256 id) external view returns (
        uint256 index, bytes32 indexCommitment, bytes32 commitment, uint32 atoms, uint32 row,
        bool complete, uint64 visited, uint64 emitted
    ) {
        Traversal storage traversal = _get(id);
        return (traversal.index,traversal.indexCommitment,traversal.commitment,traversal.atoms,
            traversal.row,traversal.complete,traversal.visited,traversal.emitted);
    }

    function _beginRow(Traversal storage traversal) private {
        (,uint32[27] memory heads,uint8 count) = cellIndex.neighboringCells(traversal.index,traversal.row);
        uint256[4] memory packed;
        for (uint256 i; i < count; ++i) packed[i / 8] |= uint256(heads[i]) << ((i % 8) * 32);
        traversal.heads = packed; traversal.headCount = count; traversal.initialized = true;
    }
    function _minimum(Traversal storage traversal) private view returns (uint32 pointer,uint256 position) {
        for (uint256 i; i < traversal.headCount; ++i) {
            uint32 head = uint32(traversal.heads[i / 8] >> ((i % 8) * 32));
            if (head != 0 && (pointer == 0 || head < pointer)) { pointer = head; position = i; }
        }
    }
    function _setHead(Traversal storage traversal,uint256 position,uint32 next) private {
        uint256 shift = (position % 8) * 32;
        uint256 mask = uint256(type(uint32).max) << shift;
        uint256 slot = position / 8;
        traversal.heads[slot] = (traversal.heads[slot] & ~mask) | (uint256(next) << shift);
    }
    function _dependencies() private view {
        if (address(cellIndex).codehash != cellIndexCodeHash) revert DependencyChanged();
    }
    function _get(uint256 id) private view returns (Traversal storage traversal) {
        traversal = _traversals[id]; if (traversal.commitment == bytes32(0)) revert InvalidInput();
    }
}
