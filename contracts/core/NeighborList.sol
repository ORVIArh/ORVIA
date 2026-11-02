// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FloatMath} from "../math/FloatMath.sol";
import {OrthorhombicGeometry} from "../kernels/OrthorhombicGeometry.sol";
import {WorkingStatePage} from "./WorkingStatePage.sol";

/// @notice Writer-bound, resumable Verlet candidate lists from on-chain positions.
/// @dev The writer must freeze the selected position buffer while preparing or
///      using a list. Included direct exceptions retain global pair ordering.
contract NeighborList {
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidInput();
    error UnknownList();
    error InvalidStage();
    error InvalidWork();
    error ChangedDependency();
    error OutOfBounds();

    uint256 public constant MAX_WORK = 8;
    uint256 public constant MAX_ATOMS = 1024;
    bytes16 private constant REUSE_FRACTION = 0x3ffdfc00000000000000000000000000; // 127/256 < 1/2
    address public immutable writer;
    FloatMath public immutable numericalMath;
    OrthorhombicGeometry public immutable geometry;
    WorkingStatePage public immutable statePage;
    bytes32 public immutable mathCodeHash;
    bytes32 public immutable geometryCodeHash;
    bytes32 public immutable pageCodeHash;

    enum Stage { Missing, Registered, Checking, Copying, Building, Ready }
    struct List {
        uint32 atomCount;
        uint32 cursor;
        uint32 candidateCount;
        uint32 generation;
        uint32 reuseCount;
        uint8 buffer;
        bool rebuild;
        Stage stage;
        bytes16[3] box;
        bytes16 cutoff;
        bytes16 skin;
        bytes16 listRadius;
        bytes16 radiusSquared;
        bytes16 thresholdSquared;
        mapping(uint256 => bytes16[3]) referencePosition;
        mapping(uint256 => uint32) candidates;
        mapping(uint256 => uint8) exceptionKind;
    }
    mapping(bytes32 => List) private _lists;

    event ListRegistered(bytes32 indexed namespace, uint32 atoms, bytes16 cutoff, bytes16 skin);
    event Prepared(bytes32 indexed namespace, uint32 generation, uint32 candidates, bool rebuilt);

    modifier onlyWriter() { if (msg.sender != writer) revert Unauthorized(); _; }

    constructor(address writer_, address math_, address geometry_, address page_) {
        if (writer_.code.length == 0 || math_.code.length == 0 || geometry_.code.length == 0 || page_.code.length == 0)
            revert InvalidConfiguration();
        if (WorkingStatePage(page_).writer() != writer_ || address(OrthorhombicGeometry(geometry_).numericalMath()) != math_)
            revert InvalidConfiguration();
        writer = writer_;
        numericalMath = FloatMath(math_);
        geometry = OrthorhombicGeometry(geometry_);
        statePage = WorkingStatePage(page_);
        mathCodeHash = math_.codehash;
        geometryCodeHash = geometry_.codehash;
        pageCodeHash = page_.codehash;
    }

    function registerList(bytes32 namespace, uint32 atoms, bytes16[3] calldata box, bytes16 cutoff, bytes16 skin)
        external onlyWriter
    {
        _assertDependencies();
        if (namespace == bytes32(0) || atoms < 2 || atoms > MAX_ATOMS || _lists[namespace].stage != Stage.Missing)
            revert InvalidInput();
        FloatMath m = numericalMath;
        if (m.compare(skin, bytes16(0)) <= 0 || m.compare(cutoff, bytes16(0)) <= 0) revert InvalidInput();
        bytes16 radius = m.add(cutoff, skin);
        if (m.compare(radius, cutoff) <= 0) revert InvalidInput();
        geometry.validateBox(box, radius);
        (uint32 capacity, bool frozen) = statePage.namespaceInfo(namespace);
        if (capacity < uint256(atoms) * 18 + 2 || frozen) revert InvalidInput();
        List storage l = _lists[namespace];
        l.atomCount = atoms; l.box = box; l.cutoff = cutoff; l.skin = skin; l.listRadius = radius;
        l.radiusSquared = m.mul(radius, radius);
        // Use the representable shell width, which can be smaller than the
        // requested skin after addition at very different magnitudes.
        bytes16 effectiveSkin = m.sub(radius, cutoff);
        if (m.compare(effectiveSkin, skin) > 0) effectiveSkin = skin;
        // Bound the skin against the box, not only the list radius: periodic
        // image reduction has an absolute error scale set by the box length.
        // This conservative floor also excludes extreme box/list anisotropy.
        for (uint256 axis; axis < 3; ++axis) {
            if (m.compare(effectiveSkin, m.div(box[axis], m.fromUInt(1 << 32))) < 0) revert InvalidInput();
        }
        bytes16 threshold = m.mul(effectiveSkin, REUSE_FRACTION);
        l.thresholdSquared = m.mul(threshold, threshold);
        if (m.isZero(l.thresholdSquared) || m.isZero(l.radiusSquared)) revert InvalidInput();
        l.stage = Stage.Registered;
        emit ListRegistered(namespace, atoms, cutoff, skin);
    }

    /// @notice Exclusions and direct exceptions are frozen before first preparation.
    function setException(bytes32 namespace, uint32 a, uint32 b, uint8 kind) external onlyWriter {
        List storage l = _get(namespace);
        if (l.stage != Stage.Registered || a >= b || b >= l.atomCount || kind == 0 || kind > 2) revert InvalidInput();
        uint256 key = uint256(a) * l.atomCount + b;
        if (l.exceptionKind[key] != 0) revert InvalidInput();
        l.exceptionKind[key] = kind;
    }

    function beginEvaluation(bytes32 namespace, uint8 buffer) external onlyWriter {
        _assertDependencies();
        List storage l = _get(namespace);
        if ((l.stage != Stage.Registered && l.stage != Stage.Ready) || buffer > 1) revert InvalidStage();
        l.buffer = buffer; l.cursor = 0; l.rebuild = false;
        if (l.generation == 0) { l.stage = Stage.Copying; l.candidateCount = 0; }
        else l.stage = Stage.Checking;
    }

    /// @notice One unit checks/copies one atom or screens one unordered pair.
    function advance(bytes32 namespace, uint256 work) external onlyWriter returns (uint256 processed, bool ready) {
        _assertDependencies();
        if (work == 0 || work > MAX_WORK) revert InvalidWork();
        List storage l = _get(namespace);
        if (l.stage < Stage.Checking || l.stage > Stage.Building) revert InvalidStage();
        while (processed < work && l.stage != Stage.Ready) {
            if (l.stage == Stage.Checking) _check(namespace, l);
            else if (l.stage == Stage.Copying) l.referencePosition[l.cursor] = _position(namespace, l, l.cursor);
            else _screen(l);
            ++processed; ++l.cursor;
            uint256 count = l.stage == Stage.Building ? uint256(l.atomCount) * (l.atomCount - 1) / 2 : l.atomCount;
            if (l.cursor == count) {
                l.cursor = 0;
                if (l.stage == Stage.Checking) {
                    if (l.rebuild) { l.stage = Stage.Copying; l.candidateCount = 0; }
                    else { l.stage = Stage.Ready; ++l.reuseCount; emit Prepared(namespace, l.generation, l.candidateCount, false); }
                } else if (l.stage == Stage.Copying) l.stage = Stage.Building;
                else { l.stage = Stage.Ready; ++l.generation; emit Prepared(namespace, l.generation, l.candidateCount, true); }
            }
        }
        ready = l.stage == Stage.Ready;
    }

    function listInfo(bytes32 namespace) external view returns (
        Stage stage, uint32 cursor, uint32 atomCount, uint32 candidateCount, uint32 generation,
        uint32 reuseCount, uint8 buffer, bool rebuild
    ) {
        List storage l = _get(namespace);
        return (l.stage, l.cursor, l.atomCount, l.candidateCount, l.generation, l.reuseCount, l.buffer, l.rebuild);
    }

    function parameters(bytes32 namespace) external view returns (bytes16[3] memory box, bytes16 cutoff, bytes16 skin, bytes16 radius, bytes16 thresholdSquared) {
        List storage l = _get(namespace);
        return (l.box, l.cutoff, l.skin, l.listRadius, l.thresholdSquared);
    }

    function pairIndexAt(bytes32 namespace, uint256 index) external view returns (uint32) {
        List storage l = _get(namespace);
        if (l.stage != Stage.Ready) revert InvalidStage();
        if (index >= l.candidateCount) revert OutOfBounds();
        return l.candidates[index];
    }

    function referenceAt(bytes32 namespace, uint256 atom) external view returns (bytes16[3] memory) {
        List storage l = _get(namespace);
        if (l.stage != Stage.Ready) revert InvalidStage();
        if (atom >= l.atomCount) revert OutOfBounds();
        return l.referencePosition[atom];
    }

    function _check(bytes32 namespace, List storage l) private {
        bytes16[3] memory current = _position(namespace, l, l.cursor);
        bytes16[3] storage previous = l.referencePosition[l.cursor];
        FloatMath m = numericalMath;
        bytes16 distanceSquared;
        // Unwrapped displacement is conservative even if an atom crosses many cells.
        for (uint256 axis; axis < 3; ++axis) {
            bytes16 delta = m.sub(current[axis], previous[axis]);
            distanceSquared = m.add(distanceSquared, m.mul(delta, delta));
        }
        if (m.compare(distanceSquared, l.thresholdSquared) >= 0) l.rebuild = true;
    }

    function _screen(List storage l) private {
        (uint32 a, uint32 b) = _pairIndices(l.cursor, l.atomCount);
        uint8 kind = l.exceptionKind[uint256(a) * l.atomCount + b];
        if (kind == 1) return;
        bool include = kind == 2;
        if (!include) {
            bytes16[3] memory displacement = geometry.displacement(l.referencePosition[a], l.referencePosition[b], l.box);
            bytes16 distanceSquared;
            for (uint256 axis; axis < 3; ++axis)
                distanceSquared = numericalMath.add(distanceSquared, numericalMath.mul(displacement[axis], displacement[axis]));
            // Boundary pairs are included; the reuse margin avoids a fragile equality criterion.
            include = numericalMath.compare(distanceSquared, l.radiusSquared) <= 0;
        }
        if (include) l.candidates[l.candidateCount++] = l.cursor;
    }

    function _position(bytes32 namespace, List storage l, uint256 atom) private view returns (bytes16[3] memory p) {
        bytes32[] memory words = statePage.readWords(namespace, uint256(l.buffer) * 9 * l.atomCount + atom * 9, 3);
        for (uint256 axis; axis < 3; ++axis) {
            if (uint256(words[axis]) >> 128 != 0) revert InvalidInput();
            p[axis] = bytes16(uint128(uint256(words[axis])));
            if (!numericalMath.isFinite(p[axis])) revert InvalidInput();
        }
    }

    function _pairIndices(uint256 index, uint256 count) private pure returns (uint32 a, uint32 b) {
        uint256 low; uint256 high = count - 1;
        while (low + 1 < high) {
            uint256 mid = (low + high) / 2;
            if (mid * (2 * count - mid - 1) / 2 <= index) low = mid; else high = mid;
        }
        a = uint32(low); b = uint32(low + 1 + index - low * (2 * count - low - 1) / 2);
    }
    function _get(bytes32 namespace) private view returns (List storage l) {
        l = _lists[namespace]; if (l.stage == Stage.Missing) revert UnknownList();
    }
    function _assertDependencies() private view {
        if (address(numericalMath).codehash != mathCodeHash || address(geometry).codehash != geometryCodeHash ||
            address(statePage).codehash != pageCodeHash) revert ChangedDependency();
    }
}
