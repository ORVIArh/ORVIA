// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FloatMath} from "../math/FloatMath.sol";

interface IConstraintDataset {
    function assertDataset(bytes32 id) external view returns (bytes32);
    function datasetInfo(bytes32 id) external view returns (bytes32, bytes32, uint32, uint32, uint32, uint32, uint32);
}

/// @notice Owner-authored append-only constraint streams bound to a sealed dataset.
contract ConstraintCatalog {
    error Unauthorized(); error InvalidInput(); error WrongStage(); error DependencyChanged();
    uint256 public constant MAX_UPLOAD = 8;
    address public immutable owner;
    IConstraintDataset public immutable dataset;
    FloatMath public immutable numericalMath;
    bytes32 public immutable datasetCodeHash;
    bytes32 public immutable mathCodeHash;
    struct Constraint { uint32 a; uint32 b; bytes16 distance; }
    struct Info { bytes32 datasetId; bytes32 datasetCommitment; bytes32 commitment; uint32 atomCount; uint32 constraintCount; uint32 loaded; bool isSealed; }
    struct Set { Info info; bytes32 digest; uint256 lastKey; mapping(uint256 => Constraint) constraints; }
    mapping(bytes32 => Set) private _sets;
    event Created(bytes32 indexed id, bytes32 indexed datasetId);
    event Sealed(bytes32 indexed id, bytes32 commitment);
    constructor(address owner_, address dataset_, address math_) {
        if (owner_ == address(0) || dataset_.code.length == 0 || math_.code.length == 0) revert InvalidInput();
        owner = owner_; dataset = IConstraintDataset(dataset_); numericalMath = FloatMath(math_);
        datasetCodeHash = dataset_.codehash; mathCodeHash = math_.codehash;
    }
    function createSet(bytes32 id, bytes32 datasetId, uint32 count) external {
        _onlyOwner();
        if (id == bytes32(0) || _sets[id].info.atomCount != 0) revert InvalidInput();
        bytes32 commitment = dataset.assertDataset(datasetId);
        (,, uint32 atoms,,,,) = dataset.datasetInfo(datasetId);
        if (atoms < 2 || atoms > 1024 || count == 0 || count > 16384 || uint256(count) > uint256(atoms)*(atoms-1)/2) revert InvalidInput();
        Set storage s = _sets[id];
        s.info = Info(datasetId, commitment, bytes32(0), atoms, count, 0, false);
        s.digest = keccak256(abi.encode(bytes32("ORVIA-CONSTRAINT-SET-v1"), block.chainid, address(this), id,
            datasetId, commitment, atoms, count, datasetCodeHash, mathCodeHash));
        emit Created(id, datasetId);
    }
    function append(bytes32 id, Constraint[] calldata entries) external {
        _onlyOwner(); Set storage s = _sets[id];
        if (s.info.atomCount == 0 || s.info.isSealed) revert WrongStage();
        if (entries.length == 0 || entries.length > MAX_UPLOAD || entries.length > s.info.constraintCount-s.info.loaded) revert InvalidInput();
        for (uint256 j; j < entries.length; ++j) {
            Constraint memory c = entries[j];
            if (c.a >= c.b || c.b >= s.info.atomCount || !numericalMath.isFinite(c.distance) || numericalMath.compare(c.distance, bytes16(0)) <= 0) revert InvalidInput();
            uint256 key = uint256(c.a)*s.info.atomCount+c.b;
            if (s.info.loaded != 0 && key <= s.lastKey) revert InvalidInput();
            s.lastKey = key; uint256 index = s.info.loaded++;
            s.constraints[index] = c;
            s.digest = keccak256(abi.encode(s.digest, index, c));
        }
    }
    function seal(bytes32 id) external {
        _onlyOwner(); Set storage s = _sets[id];
        if (s.info.atomCount == 0 || s.info.isSealed || s.info.loaded != s.info.constraintCount) revert WrongStage();
        if (dataset.assertDataset(s.info.datasetId) != s.info.datasetCommitment) revert DependencyChanged();
        s.info.isSealed = true;
        s.info.commitment = keccak256(abi.encode(s.digest, s.info.constraintCount));
        emit Sealed(id, s.info.commitment);
    }
    function setInfo(bytes32 id) external view returns (Info memory) { return _sets[id].info; }
    function assertSet(bytes32 id) external view returns (bytes32) {
        _dependencies(); Info storage i = _sets[id].info;
        if (!i.isSealed) revert WrongStage();
        if (dataset.assertDataset(i.datasetId) != i.datasetCommitment) revert DependencyChanged();
        return i.commitment;
    }
    function constraintAt(bytes32 id, uint256 index) external view returns (Constraint memory) {
        if (!_sets[id].info.isSealed || index >= _sets[id].info.constraintCount) revert InvalidInput();
        return _sets[id].constraints[index];
    }
    function _onlyOwner() private view { if (msg.sender != owner) revert Unauthorized(); _dependencies(); }
    function _dependencies() private view {
        if (address(dataset).codehash != datasetCodeHash || address(numericalMath).codehash != mathCodeHash) revert DependencyChanged();
    }
}
