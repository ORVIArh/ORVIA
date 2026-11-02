// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FloatMath} from "../math/FloatMath.sol";
import {DistanceConstraintKernel} from "../kernels/DistanceConstraintKernel.sol";

/// @notice Bounded coupled SHAKE or RATTLE projection from immutable inputs.
/// @dev Uses consistently unwrapped whole-molecule coordinates. Periodic image
///      selection, timestep integration and velocity correction after SHAKE are
///      responsibilities of the consuming coordinator, not implemented here.
contract ConstraintSolver {
    error Unauthorized();
    error InvalidDependency();
    error DependencyChanged();
    error InvalidInput();
    error ProblemExists();
    error UnknownProblem();
    error WrongStage();
    error IncompleteInput();
    error OutOfBounds();
    error InvalidWorkLimit();
    error SolutionUnavailable();

    enum Mode { Position, Velocity }
    enum Status { Missing, Uploading, Correcting, Checking, Converged, Failed }
    struct AtomInput { bytes16[3] anchor; bytes16[3] current; bytes16 mass; }
    struct Constraint { uint32 a; uint32 b; bytes16 distance; }
    struct Info {
        bytes32 sourceCommitment;
        bytes32 commitment;
        Mode mode;
        Status status;
        uint32 atomCount;
        uint32 constraintCount;
        uint32 loadedAtoms;
        uint32 loadedConstraints;
        uint32 cursor;
        uint32 iterations;
        uint32 maxIterations;
        bytes16 tolerance;
        bytes16 maximumResidual;
    }
    struct Problem {
        Info info;
        bytes32 inputDigest;
        uint256 lastConstraintKey;
        mapping(uint256 => AtomInput) atoms;
        mapping(uint256 => Constraint) constraints;
    }

    address public immutable writer;
    FloatMath public immutable numericalMath;
    DistanceConstraintKernel public immutable kernel;
    bytes32 public immutable writerCodeHash;
    bytes32 public immutable mathCodeHash;
    bytes32 public immutable kernelCodeHash;
    bytes32 public immutable configurationHash;
    uint32 public constant MAX_ATOMS = 65536;
    uint32 public constant MAX_CONSTRAINTS = 262144;
    uint32 public constant MAX_ITERATIONS = 4096;
    uint256 public constant MAX_UPLOAD = 8;
    uint256 public constant MAX_WORK = 8;
    mapping(bytes32 => Problem) private _problems;

    event ProblemCreated(bytes32 indexed id, bytes32 sourceCommitment, Mode mode);
    event ProblemSealed(bytes32 indexed id, bytes32 commitment);
    event Advanced(bytes32 indexed id, uint256 processed, Status status, uint32 cursor, uint32 iterations);
    event Finished(bytes32 indexed id, Status status, uint32 iterations, bytes16 maximumResidual);

    constructor(address writer_, address math_, address kernel_) {
        if (writer_.code.length == 0 || math_.code.length == 0 || kernel_.code.length == 0)
            revert InvalidDependency();
        if (address(DistanceConstraintKernel(kernel_).numericalMath()) != math_) revert InvalidDependency();
        writer = writer_;
        numericalMath = FloatMath(math_);
        kernel = DistanceConstraintKernel(kernel_);
        writerCodeHash = writer_.codehash;
        mathCodeHash = math_.codehash;
        kernelCodeHash = kernel_.codehash;
        configurationHash = keccak256(abi.encode(writer_, math_, kernel_,
            writer_.codehash, math_.codehash, kernel_.codehash));
    }

    function createProblem(bytes32 id, bytes32 sourceCommitment, Mode mode,
        uint32 atomCount, uint32 constraintCount, bytes16 tolerance, uint32 maxIterations) external
    {
        _onlyWriter();
        if (id == bytes32(0) || sourceCommitment == bytes32(0)) revert InvalidInput();
        if (_problems[id].info.status != Status.Missing) revert ProblemExists();
        if (atomCount < 2 || atomCount > MAX_ATOMS || constraintCount == 0 ||
            constraintCount > MAX_CONSTRAINTS || uint256(constraintCount) > uint256(atomCount) * (atomCount - 1) / 2 ||
            maxIterations == 0 || maxIterations > MAX_ITERATIONS) revert InvalidInput();
        _positive(tolerance);
        Problem storage p = _problems[id];
        p.info.sourceCommitment = sourceCommitment;
        p.info.mode = mode;
        p.info.status = Status.Uploading;
        p.info.atomCount = atomCount;
        p.info.constraintCount = constraintCount;
        p.info.tolerance = tolerance;
        p.info.maxIterations = maxIterations;
        p.inputDigest = keccak256(abi.encode(bytes32("ORVIA-CONSTRAINT-INPUT-v1"),
            block.chainid, address(this), id, sourceCommitment, mode,
            atomCount, constraintCount, tolerance, maxIterations, configurationHash));
        emit ProblemCreated(id, sourceCommitment, mode);
    }

    function appendAtoms(bytes32 id, AtomInput[] calldata atoms) external {
        _onlyWriter();
        Problem storage p = _get(id);
        if (p.info.status != Status.Uploading) revert WrongStage();
        if (atoms.length == 0 || atoms.length > MAX_UPLOAD ||
            atoms.length > uint256(p.info.atomCount) - p.info.loadedAtoms) revert InvalidInput();
        // Atom and constraint streams have one canonical order in the digest.
        if (p.info.loadedConstraints != 0) revert WrongStage();
        for (uint256 j; j < atoms.length; ++j) {
            _positive(atoms[j].mass);
            for (uint256 axis; axis < 3; ++axis) {
                _finite(atoms[j].anchor[axis]); _finite(atoms[j].current[axis]);
            }
            uint256 index = p.info.loadedAtoms++;
            p.atoms[index] = atoms[j];
            p.inputDigest = keccak256(abi.encode(p.inputDigest, bytes32("ATOM"), index, atoms[j]));
        }
    }

    function appendConstraints(bytes32 id, Constraint[] calldata constraints) external {
        _onlyWriter();
        Problem storage p = _get(id);
        if (p.info.status != Status.Uploading) revert WrongStage();
        if (p.info.loadedAtoms != p.info.atomCount) revert IncompleteInput();
        if (constraints.length == 0 || constraints.length > MAX_UPLOAD ||
            constraints.length > uint256(p.info.constraintCount) - p.info.loadedConstraints) revert InvalidInput();
        for (uint256 j; j < constraints.length; ++j) {
            Constraint memory c = constraints[j];
            if (c.a >= c.b || c.b >= p.info.atomCount) revert InvalidInput();
            if (p.info.mode == Mode.Position) _positive(c.distance);
            else if (c.distance != bytes16(0)) revert InvalidInput();
            uint256 key = uint256(c.a) * p.info.atomCount + c.b;
            if (p.info.loadedConstraints != 0 && key <= p.lastConstraintKey) revert InvalidInput();
            p.lastConstraintKey = key;
            uint256 index = p.info.loadedConstraints++;
            p.constraints[index] = c;
            p.inputDigest = keccak256(abi.encode(p.inputDigest, bytes32("CONSTRAINT"), index, c));
        }
    }

    function sealProblem(bytes32 id) external {
        _onlyWriter();
        Problem storage p = _get(id);
        if (p.info.status != Status.Uploading) revert WrongStage();
        if (p.info.loadedAtoms != p.info.atomCount || p.info.loadedConstraints != p.info.constraintCount)
            revert IncompleteInput();
        p.info.commitment = keccak256(abi.encode(bytes32("ORVIA-CONSTRAINT-PROBLEM-v1"),
            p.inputDigest, p.info.atomCount, p.info.constraintCount));
        p.info.status = Status.Correcting;
        emit ProblemSealed(id, p.info.commitment);
    }

    /// @notice Anyone may execute the next bounded records, but cannot supply results.
    function advance(bytes32 id, uint256 workLimit) external returns (uint256 processed, Status status) {
        if (workLimit == 0 || workLimit > MAX_WORK) revert InvalidWorkLimit();
        _assertDependencies();
        Problem storage p = _get(id);
        if (p.info.status != Status.Correcting && p.info.status != Status.Checking) revert WrongStage();
        while (processed < workLimit &&
               (p.info.status == Status.Correcting || p.info.status == Status.Checking)) {
            if (p.info.status == Status.Correcting) _correct(p);
            else {
                bytes16 residual = _residual(p, p.info.cursor);
                if (numericalMath.compare(residual, p.info.maximumResidual) > 0)
                    p.info.maximumResidual = residual;
            }
            ++processed;
            ++p.info.cursor;
            if (p.info.cursor == p.info.constraintCount) _finishPass(id, p);
        }
        status = p.info.status;
        emit Advanced(id, processed, status, p.info.cursor, p.info.iterations);
    }

    function _finishPass(bytes32 id, Problem storage p) private {
        p.info.cursor = 0;
        if (p.info.status == Status.Correcting) {
            p.info.status = Status.Checking;
            p.info.maximumResidual = bytes16(0);
            return;
        }
        ++p.info.iterations;
        if (numericalMath.compare(p.info.maximumResidual, p.info.tolerance) <= 0)
            p.info.status = Status.Converged;
        else if (p.info.iterations == p.info.maxIterations) p.info.status = Status.Failed;
        else p.info.status = Status.Correcting;
        if (p.info.status == Status.Converged || p.info.status == Status.Failed)
            emit Finished(id, p.info.status, p.info.iterations, p.info.maximumResidual);
    }

    function _correct(Problem storage p) private {
        Constraint memory c = p.constraints[p.info.cursor];
        AtomInput storage a = p.atoms[c.a];
        AtomInput storage b = p.atoms[c.b];
        bytes16[3] memory anchor = _difference(a.anchor, b.anchor);
        bytes16[3] memory current = _difference(a.current, b.current);
        bytes16[3] memory correctionA;
        bytes16[3] memory correctionB;
        bytes16 residual;
        if (p.info.mode == Mode.Position) {
            (correctionA, correctionB, residual) = kernel.positionCorrection(
                DistanceConstraintKernel.PositionInput(anchor, current, a.mass, b.mass, c.distance));
        } else {
            (correctionA, correctionB, residual) = kernel.velocityCorrection(
                DistanceConstraintKernel.VelocityInput(anchor, current, a.mass, b.mass));
        }
        // Keep already acceptable constraints unchanged; final checking still
        // assesses all constraints against the same completed correction pass.
        if (numericalMath.compare(residual, p.info.tolerance) <= 0) return;
        for (uint256 axis; axis < 3; ++axis) {
            a.current[axis] = numericalMath.add(a.current[axis], correctionA[axis]);
            b.current[axis] = numericalMath.add(b.current[axis], correctionB[axis]);
        }
    }

    function _residual(Problem storage p, uint256 index) private view returns (bytes16) {
        Constraint memory c = p.constraints[index];
        bytes16[3] memory current = _difference(p.atoms[c.a].current, p.atoms[c.b].current);
        FloatMath m = numericalMath;
        if (p.info.mode == Mode.Position) {
            bytes16 targetSquared = m.mul(c.distance, c.distance);
            _positive(targetSquared);
            return m.div(m.abs(m.sub(_dot(current, current), targetSquared)), targetSquared);
        }
        bytes16[3] memory anchor = _difference(p.atoms[c.a].anchor, p.atoms[c.b].anchor);
        bytes16 squared = _dot(anchor, anchor);
        _positive(squared);
        return m.abs(m.div(_dot(anchor, current), squared));
    }

    function problemInfo(bytes32 id) external view returns (Info memory) { return _get(id).info; }
    function inputDigest(bytes32 id) external view returns (bytes32) { return _get(id).inputDigest; }
    function atomAt(bytes32 id, uint256 index) external view returns (AtomInput memory) {
        Problem storage p = _get(id);
        if (index >= p.info.loadedAtoms) revert OutOfBounds();
        return p.atoms[index];
    }
    function solutionAt(bytes32 id, uint256 index) external view returns (bytes16[3] memory) {
        Problem storage p = _get(id);
        if (p.info.status != Status.Converged) revert SolutionUnavailable();
        if (index >= p.info.atomCount) revert OutOfBounds();
        return p.atoms[index].current;
    }
    function constraintAt(bytes32 id, uint256 index) external view returns (Constraint memory) {
        Problem storage p = _get(id);
        if (index >= p.info.loadedConstraints) revert OutOfBounds();
        return p.constraints[index];
    }
    function residualAt(bytes32 id, uint256 index) external view returns (bytes16) {
        Problem storage p = _get(id);
        if (p.info.status == Status.Uploading || index >= p.info.constraintCount) revert OutOfBounds();
        return _residual(p, index);
    }
    function _difference(bytes16[3] memory a, bytes16[3] memory b) private view returns (bytes16[3] memory d) {
        for (uint256 axis; axis < 3; ++axis) d[axis] = numericalMath.sub(b[axis], a[axis]);
    }
    function _dot(bytes16[3] memory a, bytes16[3] memory b) private view returns (bytes16 result) {
        for (uint256 axis; axis < 3; ++axis) result = numericalMath.add(result, numericalMath.mul(a[axis], b[axis]));
    }
    function _finite(bytes16 x) private view { if (!numericalMath.isFinite(x)) revert InvalidInput(); }
    function _positive(bytes16 x) private view {
        _finite(x); if (numericalMath.compare(x, bytes16(0)) <= 0) revert InvalidInput();
    }
    function _get(bytes32 id) private view returns (Problem storage p) {
        p = _problems[id]; if (p.info.status == Status.Missing) revert UnknownProblem();
    }
    function _onlyWriter() private view { if (msg.sender != writer) revert Unauthorized(); _assertDependencies(); }
    function _assertDependencies() private view {
        if (writer.codehash != writerCodeHash || address(numericalMath).codehash != mathCodeHash ||
            address(kernel).codehash != kernelCodeHash) revert DependencyChanged();
    }
}
