// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ExperimentRegistry} from "./ExperimentRegistry.sol";
import {FloatMath} from "../math/FloatMath.sol";
import {OrthorhombicGeometry} from "../kernels/OrthorhombicGeometry.sol";
import {ABDKMathQuad} from "../math/vendor/ABDKMathQuad.sol";

interface ICellSnapshotWords {
    function writer() external view returns (address);
    function readWord(bytes32 namespace, uint256 index) external view returns (bytes32);
    function namespaceInfo(bytes32 namespace) external view returns (uint32 capacity, bool isSealed);
    function snapshotInfo(bytes32 namespace) external view returns (
        bytes32 source, uint64 epoch, uint32 capacity, bytes32 writeDigest, bytes32 commitment
    );
}

/// @notice Bounded on-chain periodic cell membership from an authenticated snapshot.
/// @dev Candidate generation only. No force evaluator uses this index yet. Cell
///      members retain ascending global atom order; callers must merge neighboring
///      lists in canonical order and retain the original exact pair cutoff test.
contract PeriodicCellIndex {
    error Unauthorized();
    error InvalidInput();
    error UnsupportedDomain();
    error DependencyChanged();
    error WrongStage();
    error InvalidCursor();

    uint256 public constant MAX_BUILD_WORK = 32;
    uint256 public constant MAX_QUERY_ATOMS = 128;
    uint256 public constant MAX_AXIS_CELLS = 64;
    bytes32 public constant POLICY_ID = keccak256("ORVIA.PeriodicCellIndex.v1.GuardedBinary128.Fixed64");
    bytes16 private constant TWO = 0x40000000000000000000000000000000;
    bytes16 private constant MIN_BOX = 0x3fdf0000000000000000000000000000; // 2^-32
    bytes16 private constant MAX_BOX = 0x401f0000000000000000000000000000; // 2^32
    bytes16 private constant MIN_CUTOFF = 0x3fbf0000000000000000000000000000; // 2^-64
    bytes16 private constant MAX_COORDINATE_RATIO = 0x401d0000000000000000000000000000; // 2^30
    bytes16 private constant GRID_GUARD = 0x3fff0000000100000000000000000000; // 1+2^-32

    address public immutable owner;
    ExperimentRegistry public immutable registry;
    FloatMath public immutable numericalMath;
    OrthorhombicGeometry public immutable geometry;
    bytes32 public immutable registryCodeHash;
    bytes32 public immutable mathCodeHash;
    bytes32 public immutable geometryCodeHash;
    uint256 public nextIndex = 1;

    enum Stage { Missing, Building, Ready }
    struct Input {
        bytes32 protocol;
        address sourcePage;
        bytes32 sourceNamespace;
        uint32 atoms;
        uint32 positionOffset;
        uint32 positionStride;
        bytes16[3] box;
        bytes16 cutoff;
    }
    struct Index {
        Input input;
        Stage stage;
        uint32 builtAtoms;
        uint8[3] dimensions;
        uint32 totalCells;
        bytes32 snapshotCommitment;
        bytes32 sourceCodeHash;
        address sourceWriter;
        bytes32 sourceWriterCodeHash;
        bytes32 manifestHash;
        bytes32 commitment;
    }
    struct Cell { uint32 head; uint32 tail; }
    mapping(uint256 => Index) private _indices;
    mapping(uint256 => mapping(uint32 => Cell)) private _cells;
    mapping(uint256 => mapping(uint32 => uint32)) private _atomCells;
    mapping(uint256 => mapping(uint32 => uint32)) private _next;

    event IndexRegistered(uint256 indexed id, bytes32 indexed snapshotCommitment, bytes32 commitment);
    event IndexAdvanced(uint256 indexed id, uint32 builtAtoms, bool complete);

    constructor(address owner_, address registry_, address math_, address geometry_) {
        if (owner_ == address(0) || registry_.code.length == 0 || geometry_.code.length == 0
            || math_.codehash != keccak256(type(FloatMath).runtimeCode)) revert InvalidInput();
        if (address(OrthorhombicGeometry(geometry_).numericalMath()) != math_
            || OrthorhombicGeometry(geometry_).GEOMETRY_ID() != keccak256("ORVIA.OrthorhombicGeometry.v0.4")) revert InvalidInput();
        owner = owner_; registry = ExperimentRegistry(registry_); numericalMath = FloatMath(math_);
        geometry = OrthorhombicGeometry(geometry_);
        registryCodeHash = registry_.codehash; mathCodeHash = math_.codehash; geometryCodeHash = geometry_.codehash;
    }

    function registerIndex(Input calldata input) external returns (uint256 id) {
        if (msg.sender != owner) revert Unauthorized();
        if (input.atoms == 0 || input.positionStride < 3 || input.sourcePage.code.length == 0) revert InvalidInput();
        _dependencies(input.protocol);
        geometry.validateBox(input.box, input.cutoff);
        if (numericalMath.compare(input.cutoff, MIN_CUTOFF) < 0) revert UnsupportedDomain();
        (uint32 capacity, bool isSealed) = ICellSnapshotWords(input.sourcePage).namespaceInfo(input.sourceNamespace);
        (,,,,bytes32 snapshot) = ICellSnapshotWords(input.sourcePage).snapshotInfo(input.sourceNamespace);
        if (!isSealed || snapshot == bytes32(0) || uint256(input.positionOffset)
            + uint256(input.atoms - 1) * input.positionStride + 3 > capacity) revert InvalidInput();
        address sourceWriter = ICellSnapshotWords(input.sourcePage).writer();
        registry.assertModule(input.protocol, input.sourcePage, input.sourcePage.codehash);
        registry.assertModule(input.protocol, sourceWriter, sourceWriter.codehash);
        id = nextIndex++; Index storage index = _indices[id];
        index.input = input; index.stage = Stage.Building;
        index.snapshotCommitment = snapshot; index.sourceCodeHash = input.sourcePage.codehash;
        index.sourceWriter = sourceWriter; index.sourceWriterCodeHash = sourceWriter.codehash;
        index.manifestHash = registry.assertProtocol(input.protocol);
        bytes16 guardedCutoff = numericalMath.mul(input.cutoff, GRID_GUARD);
        uint32 total = 1;
        for (uint256 axis; axis < 3; ++axis) {
            if (numericalMath.compare(input.box[axis], MIN_BOX) < 0
                || numericalMath.compare(input.box[axis], MAX_BOX) > 0) revert UnsupportedDomain();
            bytes16 ratio = numericalMath.div(input.box[axis], guardedCutoff);
            uint256 cells = numericalMath.compare(ratio, numericalMath.fromUInt(MAX_AXIS_CELLS)) >= 0
                ? MAX_AXIS_CELLS : ABDKMathQuad.toUInt(ratio);
            if (cells == 0) revert UnsupportedDomain();
            index.dimensions[axis] = uint8(cells); total *= uint32(cells);
        }
        index.totalCells = total;
        index.commitment = keccak256(abi.encode(POLICY_ID, block.chainid, address(this), id, input,
            index.dimensions, index.manifestHash, snapshot, index.sourceCodeHash, sourceWriter,
            index.sourceWriterCodeHash, registryCodeHash, mathCodeHash, geometryCodeHash));
        emit IndexRegistered(id, snapshot, index.commitment);
    }

    function advanceBuild(uint256 id, uint256 work) external returns (uint256 processed, bool complete) {
        if (work == 0 || work > MAX_BUILD_WORK) revert InvalidInput();
        Index storage index = _get(id); _assertIndex(index);
        if (index.stage == Stage.Ready) return (0, true);
        while (processed < work && index.builtAtoms < index.input.atoms) {
            uint32 atom = index.builtAtoms;
            uint32 cell = _cellOf(index, _position(index, atom));
            Cell storage entry = _cells[id][cell]; uint32 pointer = atom + 1;
            if (entry.tail == 0) entry.head = pointer;
            else _next[id][entry.tail - 1] = pointer;
            entry.tail = pointer; _atomCells[id][atom] = cell;
            ++index.builtAtoms; ++processed;
        }
        complete = index.builtAtoms == index.input.atoms;
        if (complete) index.stage = Stage.Ready;
        emit IndexAdvanced(id, index.builtAtoms, complete);
    }

    /// @notice Derive and deduplicate the <=27 neighboring cells on chain.
    /// @dev Heads are atom+1 pointers; zero means an empty list. This does not
    ///      filter self/coincident atoms, exclusions or distance-to-cutoff.
    function neighboringCells(uint256 id, uint32 atom) external view returns (
        uint32[27] memory cellIds, uint32[27] memory heads, uint8 count
    ) {
        Index storage index = _ready(id); if (atom >= index.input.atoms) revert InvalidInput();
        uint32 cell = _atomCells[id][atom];
        for (uint256 choice; choice < 27; ++choice) {
            uint32 neighbor = _neighbor(cell, index.dimensions, choice);
            bool seen;
            for (uint256 i; i < count; ++i) if (cellIds[i] == neighbor) { seen = true; break; }
            if (!seen) { cellIds[count] = neighbor; heads[count] = _cells[id][neighbor].head; ++count; }
        }
    }

    function _neighbor(uint32 cell, uint8[3] memory dimensions, uint256 choice) private pure returns (uint32) {
        uint256 nx = dimensions[0]; uint256 ny = dimensions[1]; uint256 nz = dimensions[2];
        uint256 x = cell % nx; uint256 y = (cell / nx) % ny; uint256 z = cell / (nx * ny);
        return uint32((x + nx + choice % 3 - 1) % nx
            + nx * (((y + ny + (choice / 3) % 3 - 1) % ny) + ny * ((z + nz + choice / 9 - 1) % nz)));
    }

    /// @notice Read <=128 ascending atom IDs from one cell, with bounded work.
    /// @dev cursor=0 starts at the head. Returned next=0 means complete; stop then.
    ///      A nonzero cursor must be a real atom+1 member of this exact cell/index.
    function cellAtoms(uint256 id, uint32 cell, uint32 cursor, uint256 count) external view returns (
        uint32[] memory atoms, uint32 next, bool complete
    ) {
        Index storage index = _ready(id);
        if (cell >= index.totalCells || count == 0 || count > MAX_QUERY_ATOMS) revert InvalidInput();
        uint32 pointer = cursor == 0 ? _cells[id][cell].head : cursor;
        if (pointer > index.input.atoms || (pointer != 0 && _atomCells[id][pointer - 1] != cell)) revert InvalidCursor();
        atoms = new uint32[](count); uint256 used;
        while (pointer != 0 && used < count) {
            atoms[used++] = pointer - 1; pointer = _next[id][pointer - 1];
        }
        assembly { mstore(atoms, used) }
        return (atoms, pointer, pointer == 0);
    }

    function atomCell(uint256 id, uint32 atom) external view returns (uint32) {
        Index storage index = _ready(id); if (atom >= index.input.atoms) revert InvalidInput();
        return _atomCells[id][atom];
    }
    /// @notice The next atom+1 pointer in this atom's sorted cell list, or zero.
    function nextAtom(uint256 id, uint32 atom) external view returns (uint32) {
        Index storage index = _ready(id); if (atom >= index.input.atoms) revert InvalidInput();
        return _next[id][atom];
    }
    function indexInfo(uint256 id) external view returns (
        Stage stage, uint32 builtAtoms, uint8[3] memory dimensions, uint32 totalCells,
        bytes32 snapshotCommitment, bytes32 commitment, Input memory input
    ) {
        Index storage index = _get(id);
        return (index.stage, index.builtAtoms, index.dimensions, index.totalCells,
            index.snapshotCommitment, index.commitment, index.input);
    }

    function _cellOf(Index storage index, bytes16[3] memory position) private view returns (uint32) {
        FloatMath m = numericalMath;
        for (uint256 axis; axis < 3; ++axis) {
            if (m.compare(m.div(m.abs(position[axis]), index.input.box[axis]), MAX_COORDINATE_RATIO) > 0) revert UnsupportedDomain();
        }
        bytes16[3] memory zero;
        bytes16[3] memory periodic = geometry.displacement(zero, position, index.input.box);
        uint32 cell; uint32 multiplier = 1;
        for (uint256 axis; axis < 3; ++axis) {
            cell += _bin(periodic[axis], index.input.box[axis], index.dimensions[axis]) * multiplier;
            multiplier *= index.dimensions[axis];
        }
        return cell;
    }
    function _bin(bytes16 periodic, bytes16 length, uint8 cells) private view returns (uint32) {
        FloatMath m = numericalMath;
        bytes16 wrapped = m.add(periodic, m.div(length, TWO));
        if (m.compare(wrapped, bytes16(0)) < 0) revert UnsupportedDomain();
        if (m.compare(wrapped, length) >= 0) wrapped = bytes16(0);
        bytes16 scaled = m.mul(wrapped, m.fromUInt(cells));
        uint256 coordinate = ABDKMathQuad.toUInt(m.div(scaled, length));
        // A final rounding at the periodic upper boundary is the same cell
        // as zero; the documented conservative margin covers this binning.
        if (coordinate == cells) coordinate = 0;
        if (coordinate >= cells) revert UnsupportedDomain();
        return uint32(coordinate);
    }
    function _position(Index storage index, uint32 atom) private view returns (bytes16[3] memory position) {
        uint256 start = uint256(index.input.positionOffset) + uint256(atom) * index.input.positionStride;
        for (uint256 axis; axis < 3; ++axis) {
            bytes32 word = ICellSnapshotWords(index.input.sourcePage).readWord(index.input.sourceNamespace, start + axis);
            if (uint256(word) >> 128 != 0) revert InvalidInput();
            bytes16 value = bytes16(uint128(uint256(word)));
            if (!numericalMath.isFinite(value)) revert InvalidInput();
            position[axis] = value;
        }
    }
    function _dependencies(bytes32 protocol) private view {
        if (address(registry).codehash != registryCodeHash || address(numericalMath).codehash != mathCodeHash
            || address(geometry).codehash != geometryCodeHash) revert DependencyChanged();
        registry.assertModule(protocol, address(this), address(this).codehash);
        registry.assertModule(protocol, address(numericalMath), mathCodeHash);
        registry.assertModule(protocol, address(geometry), geometryCodeHash);
    }
    function _assertIndex(Index storage index) private view {
        _dependencies(index.input.protocol);
        if (registry.assertProtocol(index.input.protocol) != index.manifestHash
            || index.input.sourcePage.codehash != index.sourceCodeHash
            || index.sourceWriter.codehash != index.sourceWriterCodeHash) revert DependencyChanged();
        registry.assertModule(index.input.protocol, index.input.sourcePage, index.sourceCodeHash);
        registry.assertModule(index.input.protocol, index.sourceWriter, index.sourceWriterCodeHash);
        (,,,,bytes32 snapshot) = ICellSnapshotWords(index.input.sourcePage).snapshotInfo(index.input.sourceNamespace);
        if (snapshot != index.snapshotCommitment) revert DependencyChanged();
    }
    function _get(uint256 id) private view returns (Index storage index) {
        index = _indices[id]; if (index.stage == Stage.Missing) revert InvalidInput();
    }
    function _ready(uint256 id) private view returns (Index storage index) {
        index = _get(id); _assertIndex(index); if (index.stage != Stage.Ready) revert WrongStage();
    }
}
