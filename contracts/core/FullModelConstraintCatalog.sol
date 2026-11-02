// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FloatMath} from "../math/FloatMath.sol";
import {AlchemicalTopologyCatalog} from "./AlchemicalTopologyCatalog.sol";

interface IConstraintInputStreams {
    function assertStream(bytes32 id) external view returns (bytes32 commitment, uint64 words);
    function readWord(bytes32 id, uint64 index) external view returns (bytes32);
    function streamInfo(bytes32 id) external view returns
        (bytes32 role, uint64 words, uint64 appended, uint64 pages, bool isSealed, bytes32 commitment);
}

/// @notice Canonical distance constraints backed by an existing sealed input stream.
/// @dev This binds declared constraints to a validated hybrid topology; it does
///      not decide which chemical bonds should be constrained. No child contracts.
contract FullModelConstraintCatalog {
    error Unauthorized(); error InvalidInput(); error DependencyChanged(); error WrongStage();
    enum Stage { Missing, Validating, Complete }
    struct Constraint { uint32 a; uint32 b; bytes16 distance; }
    struct Info {
        Stage stage; bytes32 topologyId; bytes32 topologyCommitment; bytes32 streamId;
        bytes32 streamCommitment; bytes32 policyHash; bytes32 commitment;
        uint32 atoms; uint64 count; uint64 cursor; uint64 lastKey;
    }
    address public immutable owner;
    AlchemicalTopologyCatalog public immutable topology;
    FloatMath public immutable numericalMath;
    IConstraintInputStreams public immutable inputs;
    bytes32 public immutable topologyCodeHash;
    bytes32 public immutable mathCodeHash;
    bytes32 public immutable inputsCodeHash;
    bytes32 public constant CONSTRAINT_STREAM_ROLE = keccak256("ORVIA.FullModelConstraintTriples.v1");
    uint256 public constant MAX_WORK = 8;
    mapping(bytes32 => Info) private sets;
    event SetCreated(bytes32 indexed id, bytes32 indexed topologyId, bytes32 indexed streamId);
    event SetSealed(bytes32 indexed id, bytes32 commitment);

    constructor(address owner_, address topology_, address math_) {
        if (owner_ == address(0) || topology_.code.length == 0 || math_.code.length == 0
            || address(AlchemicalTopologyCatalog(topology_).numericalMath()) != math_) revert InvalidInput();
        address inputs_ = address(AlchemicalTopologyCatalog(topology_).inputs());
        if (inputs_.code.length == 0) revert InvalidInput();
        owner = owner_; topology = AlchemicalTopologyCatalog(topology_); numericalMath = FloatMath(math_);
        inputs = IConstraintInputStreams(inputs_);
        topologyCodeHash = topology_.codehash; mathCodeHash = math_.codehash; inputsCodeHash = inputs_.codehash;
    }

    function createSet(bytes32 id, bytes32 topologyId, bytes32 streamId, uint64 count, bytes32 policyHash) external {
        if (msg.sender != owner) revert Unauthorized(); _dependencies();
        if (id == bytes32(0) || sets[id].stage != Stage.Missing || policyHash == bytes32(0)) revert InvalidInput();
        bytes32 topologyCommitment = topology.assertTopology(topologyId);
        uint32 atoms = topology.definition(topologyId).atoms;
        if (count == 0 || count > type(uint64).max / 3 || uint256(count) > uint256(atoms) * (atoms - 1) / 2)
            revert InvalidInput();
        bytes32 streamCommitment = _validateStream(streamId, count);
        sets[id] = Info(Stage.Validating, topologyId, topologyCommitment, streamId, streamCommitment,
            policyHash, bytes32(0), atoms, count, 0, 0);
        emit SetCreated(id, topologyId, streamId);
    }

    function advance(bytes32 id, uint256 work) external returns (uint256 processed, bool complete) {
        if (work == 0 || work > MAX_WORK) revert InvalidInput();
        Info storage s = _get(id); _source(s);
        if (s.stage != Stage.Validating) revert WrongStage();
        while (processed < work && s.cursor < s.count) {
            Constraint memory c = _read(s, s.cursor);
            uint64 key = uint64(c.a) * s.atoms + c.b;
            if (s.cursor != 0 && key <= s.lastKey) revert InvalidInput();
            s.lastKey = key; ++s.cursor; ++processed;
        }
        complete = s.cursor == s.count;
        if (complete) {
            s.stage = Stage.Complete;
            bytes32 dependencies = keccak256(abi.encode(address(topology), address(inputs),
                topologyCodeHash, mathCodeHash, inputsCodeHash, CONSTRAINT_STREAM_ROLE));
            s.commitment = keccak256(abi.encode(bytes32("ORVIA-FULL-CONSTRAINTS-v1"), block.chainid,
                address(this), id, s, dependencies));
            emit SetSealed(id, s.commitment);
        }
    }

    function info(bytes32 id) external view returns (Info memory) { return _get(id); }
    function assertSet(bytes32 id) external view returns (bytes32) {
        Info storage s = _get(id); _source(s);
        if (s.stage != Stage.Complete) revert WrongStage(); return s.commitment;
    }
    function constraintAt(bytes32 id, uint64 index) external view returns (Constraint memory) {
        Info storage s = _get(id); _source(s);
        if (s.stage != Stage.Complete || index >= s.count) revert WrongStage(); return _read(s, index);
    }
    function _read(Info storage s, uint64 index) private view returns (Constraint memory c) {
        uint64 offset = index * 3;
        uint256 a = uint256(inputs.readWord(s.streamId, offset));
        uint256 b = uint256(inputs.readWord(s.streamId, offset + 1));
        uint256 distance = uint256(inputs.readWord(s.streamId, offset + 2));
        if (a >= b || b >= s.atoms || distance > type(uint128).max) revert InvalidInput();
        c = Constraint(uint32(a), uint32(b), bytes16(uint128(distance)));
        if (!numericalMath.isFinite(c.distance) || numericalMath.compare(c.distance, bytes16(0)) <= 0) revert InvalidInput();
    }
    function _source(Info storage s) private view {
        _dependencies();
        if (topology.assertTopology(s.topologyId) != s.topologyCommitment) revert DependencyChanged();
        (bytes32 commitment, uint64 words) = inputs.assertStream(s.streamId);
        if (commitment != s.streamCommitment || words != s.count * 3) revert DependencyChanged();
    }
    function _validateStream(bytes32 id, uint64 count) private view returns (bytes32 commitment) {
        uint64 words; (commitment, words) = inputs.assertStream(id);
        (bytes32 role, uint64 total, uint64 appended,, bool isSealed, bytes32 infoCommitment) = inputs.streamInfo(id);
        if (role != CONSTRAINT_STREAM_ROLE || !isSealed || words != count * 3 || total != words || appended != words
            || commitment == bytes32(0) || infoCommitment != commitment) revert InvalidInput();
    }
    function _dependencies() private view {
        if (address(topology).codehash != topologyCodeHash || address(numericalMath).codehash != mathCodeHash
            || address(inputs).codehash != inputsCodeHash) revert DependencyChanged();
    }
    function _get(bytes32 id) private view returns (Info storage s) {
        s = sets[id]; if (s.stage == Stage.Missing) revert InvalidInput();
    }
}
