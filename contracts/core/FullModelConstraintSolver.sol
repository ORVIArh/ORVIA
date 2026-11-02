// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FloatMath} from "../math/FloatMath.sol";
import {DistanceConstraintKernel} from "../kernels/DistanceConstraintKernel.sol";
import {FullModelConstraintCatalog} from "./FullModelConstraintCatalog.sol";
import {AlchemicalTopologyCatalog} from "./AlchemicalTopologyCatalog.sol";

interface IConstraintState {
    function writer() external view returns (address);
    function readWord(bytes32 id, uint256 index) external view returns (bytes32);
    function readWords(bytes32 id, uint256 start, uint256 count) external view returns (bytes32[] memory);
    function namespaceInfo(bytes32 id) external view returns (uint32 capacity, bool isSealed);
    function snapshotInfo(bytes32 id) external view returns
        (bytes32 source, uint64 epoch, uint32 capacity, bytes32 writeDigest, bytes32 commitment);
}
interface IConstraintPipeline { function statePage() external view returns (address); }

/// @notice Bounded coupled SHAKE/RATTLE projection of authenticated frozen frames.
/// @dev Raw, consistently unwrapped pair displacements must lie strictly inside
///      each half box. This component does not select images or integrate a step.
///      Outputs are internal mappings, imported only after convergence by the
///      pinned pipeline. It cannot write state storage or create child contracts.
contract FullModelConstraintSolver {
    error Unauthorized(); error InvalidInput(); error InvalidDependency(); error DependencyChanged();
    error WrongStage(); error InvalidGeometry(); error SolutionUnavailable();
    enum Mode { Position, Velocity }
    enum Status { Missing, Correcting, Checking, Converged, Failed }
    struct Params {
        bytes32 setId; Mode mode; address sourcePage; bytes32 anchorSnapshot; bytes32 trialSnapshot;
        bytes32 sourceProtocolHash; bytes16 positionTolerance; bytes16 velocityTolerance; uint32 maxSweeps;
    }
    struct Info {
        Status status; Mode mode; uint32 atoms; uint64 count; uint64 cursor; uint32 sweeps;
        bytes16 maximumResidual; bytes4 failure; bytes32 inputCommitment; bytes32 outputCommitment;
    }
    struct Atom { bool loaded; bytes16[3] anchor; bytes16[3] current; bytes16 mass; }
    struct Problem {
        Params params; Info info; bytes32 sourceCodeHash; bytes32 anchorCommitment; bytes32 trialCommitment;
        bytes32 setCommitment; bytes32 massStream; bytes16[3] box; bytes32 transcript;
        mapping(uint32 => Atom) atoms;
    }
    address public immutable writer;
    FloatMath public immutable numericalMath;
    DistanceConstraintKernel public immutable kernel;
    FullModelConstraintCatalog public immutable catalog;
    AlchemicalTopologyCatalog public immutable topology;
    bytes32 public immutable writerCodeHash;
    bytes32 public immutable mathCodeHash;
    bytes32 public immutable kernelCodeHash;
    bytes32 public immutable catalogCodeHash;
    bytes32 public immutable configurationHash;
    uint256 public constant MAX_WORK = 8;
    uint32 public constant MAX_SWEEPS = 4096;
    bytes16 private constant ONE = 0x3fff0000000000000000000000000000;
    bytes16 private constant TWO = 0x40000000000000000000000000000000;
    mapping(bytes32 => Problem) private problems;
    event Registered(bytes32 indexed id, bytes32 inputCommitment);
    event Advanced(bytes32 indexed id, uint256 processed, Status status, uint64 cursor, uint32 sweeps);
    event Finished(bytes32 indexed id, Status status, bytes32 outputCommitment, bytes4 failure);

    constructor(address writer_, address math_, address kernel_, address catalog_) {
        if (writer_.code.length == 0 || math_.code.length == 0 || kernel_.code.length == 0 || catalog_.code.length == 0
            || address(DistanceConstraintKernel(kernel_).numericalMath()) != math_
            || address(FullModelConstraintCatalog(catalog_).numericalMath()) != math_) revert InvalidDependency();
        writer = writer_; numericalMath = FloatMath(math_); kernel = DistanceConstraintKernel(kernel_);
        catalog = FullModelConstraintCatalog(catalog_); topology = catalog.topology();
        writerCodeHash = writer_.codehash; mathCodeHash = math_.codehash;
        kernelCodeHash = kernel_.codehash; catalogCodeHash = catalog_.codehash;
        configurationHash = keccak256(abi.encode(bytes32("ORVIA-FULL-PROJECTION-v1"), writer_, math_, kernel_, catalog_,
            writerCodeHash, mathCodeHash, kernelCodeHash, catalogCodeHash));
    }

    function registerProblem(bytes32 id, Params calldata params) external {
        if (msg.sender != writer) revert Unauthorized(); _dependencies();
        if (id == bytes32(0) || problems[id].info.status != Status.Missing || params.sourceProtocolHash == bytes32(0)
            || params.maxSweeps == 0 || params.maxSweeps > MAX_SWEEPS) revert InvalidInput();
        _positive(params.positionTolerance); _positive(params.velocityTolerance);
        if (numericalMath.compare(params.positionTolerance, ONE) >= 0) revert InvalidInput();
        if (params.sourcePage.code.length == 0 || IConstraintPipeline(writer).statePage() != params.sourcePage
            || IConstraintState(params.sourcePage).writer() != writer) revert InvalidDependency();
        if (params.mode == Mode.Velocity && params.anchorSnapshot != params.trialSnapshot) revert InvalidInput();
        bytes32 setCommitment = catalog.assertSet(params.setId);
        FullModelConstraintCatalog.Info memory s = catalog.info(params.setId);
        AlchemicalTopologyCatalog.Definition memory d = topology.definition(s.topologyId);
        uint32 capacity = uint32(uint256(s.atoms) * 9 + 1);
        bytes32 anchor = _snapshot(params.sourcePage, params.anchorSnapshot, capacity);
        bytes32 trial = _snapshot(params.sourcePage, params.trialSnapshot, capacity);
        Problem storage p = problems[id]; p.params = params;
        p.sourceCodeHash = params.sourcePage.codehash; p.anchorCommitment = anchor; p.trialCommitment = trial;
        p.setCommitment = setCommitment; p.massStream = d.a.particles; p.box = d.box;
        p.info.status = Status.Correcting; p.info.mode = params.mode; p.info.atoms = s.atoms; p.info.count = s.count;
        p.info.inputCommitment = keccak256(abi.encode(configurationHash, block.chainid, address(this), id,
            params, setCommitment, p.sourceCodeHash, anchor, trial));
        p.transcript = keccak256(abi.encode(bytes32("ORVIA-CONSTRAINT-TRACE-v1"), p.info.inputCommitment));
        emit Registered(id, p.info.inputCommitment);
    }

    /// @notice Any payer may execute ordered work; no caller supplies atom values.
    function advance(bytes32 id, uint256 work) external returns (uint256 processed, Status status) {
        if (work == 0 || work > MAX_WORK) revert InvalidInput();
        Problem storage p = _get(id); _source(p);
        if (p.info.status != Status.Correcting && p.info.status != Status.Checking) revert WrongStage();
        while (processed < work && (p.info.status == Status.Correcting || p.info.status == Status.Checking)) {
            // Storage/dependency reads remain outside the numerical catch. Bank or
            // topology tampering reverts the transaction, never reports convergence failure.
            FullModelConstraintCatalog.Constraint memory c = catalog.constraintAt(p.params.setId, p.info.cursor);
            _load(p, c.a); _load(p, c.b);
            try this.processRecord(id, c) { }
            catch (bytes memory reason) {
                bytes4 selector;
                if (reason.length >= 4) assembly { selector := mload(add(reason, 32)) }
                if (!_domainError(selector)) assembly { revert(add(reason, 32), mload(reason)) }
                p.info.status = Status.Failed; p.info.failure = selector;
                emit Finished(id, Status.Failed, bytes32(0), selector); ++processed; break;
            }
            ++processed; ++p.info.cursor;
            if (p.info.cursor == p.info.count) _finishPass(id, p);
        }
        status = p.info.status;
        emit Advanced(id, processed, status, p.info.cursor, p.info.sweeps);
    }

    /// @dev Self-only numerical unit. A failed unit rolls back its atom updates.
    ///      Empty/unknown revert data (including insufficient gas) is propagated.
    function processRecord(bytes32 id, FullModelConstraintCatalog.Constraint calldata c) external {
        if (msg.sender != address(this)) revert Unauthorized();
        Problem storage p = problems[id]; Atom storage a = p.atoms[c.a]; Atom storage b = p.atoms[c.b];
        _positive(a.mass); _positive(b.mass);
        bytes16[3] memory anchor = _difference(a.anchor, b.anchor);
        bytes16[3] memory current = _difference(a.current, b.current);
        _image(anchor, p.box);
        if (numericalMath.compare(_positionResidual(anchor, c.distance), p.params.positionTolerance) > 0) revert InvalidGeometry();
        if (p.info.mode == Mode.Position) {
            _image(current, p.box);
            // The local SHAKE branch applies even when the distance residual is
            // already small: an exactly reversed bond must not bypass the kernel.
            if (numericalMath.compare(_dot(anchor, current), bytes16(0)) <= 0)
                revert DistanceConstraintKernel.NoLocalSolution();
        }
        bytes16 residual = p.info.mode == Mode.Position ? _positionResidual(current, c.distance)
            : _velocityResidual(anchor, current);
        if (p.info.status == Status.Checking) {
            if (numericalMath.compare(residual, p.info.maximumResidual) > 0) p.info.maximumResidual = residual;
            return;
        }
        if (numericalMath.compare(residual, _tolerance(p)) > 0) {
            bytes16[3] memory ca; bytes16[3] memory cb;
            if (p.info.mode == Mode.Position) (ca, cb,) = kernel.positionCorrection(
                DistanceConstraintKernel.PositionInput(anchor, current, a.mass, b.mass, c.distance));
            else (ca, cb,) = kernel.velocityCorrection(
                DistanceConstraintKernel.VelocityInput(anchor, current, a.mass, b.mass));
            for (uint256 axis; axis < 3; ++axis) {
                a.current[axis] = numericalMath.add(a.current[axis], ca[axis]);
                b.current[axis] = numericalMath.add(b.current[axis], cb[axis]);
            }
            if (p.info.mode == Mode.Position) _image(_difference(a.current, b.current), p.box);
        }
        p.transcript = keccak256(abi.encode(p.transcript, p.info.sweeps, p.info.cursor, a.current, b.current));
    }

    function problemInfo(bytes32 id) external view returns (Info memory) { return _get(id).info; }
    function problemParams(bytes32 id) external view returns (Params memory) { return _get(id).params; }
    function assertSolution(bytes32 id) external view returns (bytes32) {
        Problem storage p = _get(id); _source(p); _converged(p); return p.info.outputCommitment;
    }
    function solutionAt(bytes32 id, uint32 atom) external view returns (bytes16[3] memory) {
        Problem storage p = _get(id); _source(p); _converged(p); return _solution(p, atom);
    }
    function correctionAt(bytes32 id, uint32 atom) external view returns (bytes16[3] memory correction) {
        Problem storage p = _get(id); _source(p); _converged(p);
        bytes16[3] memory solution = _solution(p, atom);
        bytes16[3] memory original = _vector(p, p.params.trialSnapshot, atom, p.info.mode == Mode.Position ? 0 : 3);
        for (uint256 axis; axis < 3; ++axis) correction[axis] = numericalMath.sub(solution[axis], original[axis]);
    }
    function _solution(Problem storage p, uint32 atom) private view returns (bytes16[3] memory) {
        if (atom >= p.info.atoms) revert InvalidInput();
        bytes16[3] memory original = _vector(p, p.params.trialSnapshot, atom, p.info.mode == Mode.Position ? 0 : 3);
        if (p.atoms[atom].loaded) return p.atoms[atom].current;
        return original;
    }
    function _load(Problem storage p, uint32 atom) private {
        // Re-read touched storage even after caching, retaining each router's
        // bank-code checks without an unbounded scan of the complete atom set.
        bytes16[3] memory anchor = _vector(p, p.params.anchorSnapshot, atom, 0);
        bytes16[3] memory current = _vector(p, p.params.trialSnapshot, atom, p.info.mode == Mode.Position ? 0 : 3);
        bytes16 mass = _decode(topology.word(p.massStream, uint64(atom) * 4));
        Atom storage a = p.atoms[atom]; if (a.loaded) return;
        a.anchor = anchor; a.current = current; a.mass = mass; a.loaded = true;
    }
    function _vector(Problem storage p, bytes32 snapshot, uint32 atom, uint256 offset) private view returns (bytes16[3] memory v) {
        bytes32[] memory words = IConstraintState(p.params.sourcePage).readWords(snapshot, uint256(atom) * 9 + offset, 3);
        if (words.length != 3) revert InvalidInput();
        for (uint256 axis; axis < 3; ++axis)
            v[axis] = _decode(words[axis]);
    }
    function _finishPass(bytes32 id, Problem storage p) private {
        p.info.cursor = 0;
        if (p.info.status == Status.Correcting) { p.info.status = Status.Checking; p.info.maximumResidual = bytes16(0); return; }
        ++p.info.sweeps;
        if (numericalMath.compare(p.info.maximumResidual, _tolerance(p)) <= 0) {
            p.info.status = Status.Converged;
            p.info.outputCommitment = keccak256(abi.encode(bytes32("ORVIA-CONSTRAINT-SOLUTION-v1"),
                p.info.inputCommitment, p.transcript, p.info.sweeps, p.info.maximumResidual));
        } else if (p.info.sweeps == p.params.maxSweeps) p.info.status = Status.Failed;
        else { p.info.status = Status.Correcting; return; }
        emit Finished(id, p.info.status, p.info.outputCommitment, p.info.failure);
    }
    function _positionResidual(bytes16[3] memory displacement, bytes16 target) private view returns (bytes16) {
        bytes16 squared = numericalMath.mul(target, target); _positive(squared);
        return numericalMath.div(numericalMath.abs(numericalMath.sub(_dot(displacement, displacement), squared)), squared);
    }
    function _velocityResidual(bytes16[3] memory displacement, bytes16[3] memory velocity) private view returns (bytes16) {
        bytes16 squared = _dot(displacement, displacement); _positive(squared);
        return numericalMath.abs(numericalMath.div(_dot(displacement, velocity), squared));
    }
    function _image(bytes16[3] memory d, bytes16[3] memory box) private view {
        for (uint256 axis; axis < 3; ++axis)
            if (numericalMath.compare(numericalMath.abs(d[axis]), numericalMath.div(box[axis], TWO)) >= 0) revert InvalidGeometry();
    }
    function _difference(bytes16[3] memory a, bytes16[3] memory b) private view returns (bytes16[3] memory d) {
        for (uint256 axis; axis < 3; ++axis) d[axis] = numericalMath.sub(b[axis], a[axis]);
    }
    function _dot(bytes16[3] memory a, bytes16[3] memory b) private view returns (bytes16 result) {
        for (uint256 axis; axis < 3; ++axis) result = numericalMath.add(result, numericalMath.mul(a[axis], b[axis]));
    }
    function _tolerance(Problem storage p) private view returns (bytes16) {
        return p.info.mode == Mode.Position ? p.params.positionTolerance : p.params.velocityTolerance;
    }
    function _snapshot(address source, bytes32 snapshot, uint32 expected) private view returns (bytes32 commitment) {
        (uint32 capacity, bool isSealed) = IConstraintState(source).namespaceInfo(snapshot);
        (bytes32 origin, uint64 epoch, uint32 snapshotCapacity,, bytes32 binding) = IConstraintState(source).snapshotInfo(snapshot);
        if (!isSealed || capacity != expected || snapshotCapacity != expected || origin == bytes32(0)
            || epoch == 0 || binding == bytes32(0)) revert InvalidInput(); return binding;
    }
    function _source(Problem storage p) private view {
        _dependencies();
        if (p.params.sourcePage.codehash != p.sourceCodeHash || IConstraintPipeline(writer).statePage() != p.params.sourcePage
            || IConstraintState(p.params.sourcePage).writer() != writer || catalog.assertSet(p.params.setId) != p.setCommitment)
            revert DependencyChanged();
        uint32 capacity = uint32(uint256(p.info.atoms) * 9 + 1);
        if (_snapshot(p.params.sourcePage, p.params.anchorSnapshot, capacity) != p.anchorCommitment
            || _snapshot(p.params.sourcePage, p.params.trialSnapshot, capacity) != p.trialCommitment) revert DependencyChanged();
    }
    function _dependencies() private view {
        if (writer.codehash != writerCodeHash || address(numericalMath).codehash != mathCodeHash
            || address(kernel).codehash != kernelCodeHash || address(catalog).codehash != catalogCodeHash) revert DependencyChanged();
    }
    function _converged(Problem storage p) private view { if (p.info.status != Status.Converged) revert SolutionUnavailable(); }
    function _get(bytes32 id) private view returns (Problem storage p) {
        p = problems[id]; if (p.info.status == Status.Missing) revert InvalidInput();
    }
    function _positive(bytes16 x) private view {
        if (!numericalMath.isFinite(x) || numericalMath.compare(x, bytes16(0)) <= 0) revert InvalidInput();
    }
    function _decode(bytes32 word_) private pure returns (bytes16 value) {
        if (uint256(word_) > type(uint128).max) revert InvalidInput();
        value = bytes16(uint128(uint256(word_)));
        if (((uint128(value) >> 112) & 0x7fff) == 0x7fff) revert InvalidInput();
        if ((uint128(value) & 0x7fffffffffffffffffffffffffffffff) == 0) value = bytes16(0);
    }
    function _domainError(bytes4 selector) private pure returns (bool) {
        return selector == InvalidGeometry.selector || selector == InvalidInput.selector
            || selector == DistanceConstraintKernel.NoLocalSolution.selector
            || selector == FloatMath.NonFinite.selector || selector == FloatMath.DivisionByZero.selector
            || selector == FloatMath.NegativeSquareRoot.selector;
    }
}
