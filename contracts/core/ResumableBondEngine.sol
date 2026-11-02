// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ExperimentRegistry} from "./ExperimentRegistry.sol";

interface IOrviaFloatMath {
    function add(bytes16 a, bytes16 b) external view returns (bytes16);
    function sub(bytes16 a, bytes16 b) external view returns (bytes16);
}

interface IOrviaBondKernel {
    function numericalMath() external view returns (address);
    function evaluate(bytes16[3] calldata a, bytes16[3] calldata b, bytes16 k, bytes16 r0)
        external view returns (bytes16 energy, bytes16[3] memory forceOnA);
}

/// @notice Component-validation engine: resumable harmonic-bond force/energy accumulation.
/// @dev This is not the complete ORVIA molecular dynamics or binding free-energy engine.
/// Coordinates are fixed for the entire force evaluation and outputs are committed transactionally.
contract ResumableBondEngine {
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidInput();
    error NonFiniteNumber();
    error UnknownExperiment();
    error InvalidWorkLimit();
    error ExperimentCompleted();
    error ModuleCodeChanged();

    uint256 public constant MAX_WORK = 16;
    uint256 public constant MAX_ATOMS = 128;
    uint256 public constant MAX_BONDS = 256;
    address public immutable owner;
    IOrviaFloatMath public immutable numericalMath;
    IOrviaBondKernel public immutable bondKernel;
    ExperimentRegistry public immutable registry;
    bytes32 public immutable mathCodeHash;
    bytes32 public immutable kernelCodeHash;
    bytes32 public immutable registryCodeHash;
    uint256 public nextExperimentId = 1;

    enum Status { Missing, Ready, Running, Completed }

    struct Bond { uint32 a; uint32 b; bytes16 k; bytes16 r0; }
    struct Run {
        bytes32 protocolId;
        bytes32 inputHash;
        bytes32 commitment;
        uint32 cursor;
        Status status;
        bytes16 totalEnergy;
        bytes16[3][] positions;
        bytes16[3][] forces;
        Bond[] bonds;
    }
    mapping(uint256 => Run) private _runs;

    event ExperimentRegistered(uint256 indexed experimentId, bytes32 indexed protocolId, bytes32 commitment, uint256 atoms, uint256 bonds);
    event ExperimentAdvanced(uint256 indexed experimentId, uint256 processed, uint256 cursor, bytes16 totalEnergy, Status status);

    constructor(address owner_, address math_, address kernel_, address registry_) {
        if (owner_ == address(0) || math_.code.length == 0 || kernel_.code.length == 0 || registry_.code.length == 0) {
            revert InvalidConfiguration();
        }
        if (IOrviaBondKernel(kernel_).numericalMath() != math_) revert InvalidConfiguration();
        owner = owner_;
        numericalMath = IOrviaFloatMath(math_);
        bondKernel = IOrviaBondKernel(kernel_);
        registry = ExperimentRegistry(registry_);
        mathCodeHash = math_.codehash;
        kernelCodeHash = kernel_.codehash;
        registryCodeHash = registry_.codehash;
    }

    /// @notice Atomically register and seal a complete component-test input.
    /// @dev The declared protocol must contain this engine, its math module and its kernel.
    function registerExperiment(bytes32 protocolId, bytes16[3][] calldata positions, Bond[] calldata bonds)
        external returns (uint256 experimentId)
    {
        if (msg.sender != owner) revert Unauthorized();
        if (positions.length < 2 || positions.length > MAX_ATOMS || bonds.length == 0 || bonds.length > MAX_BONDS) {
            revert InvalidInput();
        }
        bytes32 protocolManifest = _assertDependencies(protocolId);
        for (uint256 i; i < positions.length; ++i) {
            for (uint256 d; d < 3; ++d) _requireFinite(positions[i][d]);
        }
        for (uint256 i; i < bonds.length; ++i) {
            Bond calldata bond = bonds[i];
            if (bond.a >= positions.length || bond.b >= positions.length || bond.a == bond.b) revert InvalidInput();
            _requireFinite(bond.k);
            _requireFinite(bond.r0);
            if (_negativeNonzero(bond.k) || _negativeNonzero(bond.r0)) revert InvalidInput();
        }

        experimentId = nextExperimentId++;
        Run storage run = _runs[experimentId];
        run.protocolId = protocolId;
        run.inputHash = keccak256(abi.encode(positions, bonds));
        run.commitment = keccak256(abi.encode(
            bytes32("ORVIA-BOND-FIXTURE-v1"), block.chainid, address(this), experimentId,
            protocolManifest, run.inputHash, address(numericalMath), mathCodeHash,
            address(bondKernel), kernelCodeHash, address(registry), registryCodeHash
        ));
        run.status = Status.Ready;
        for (uint256 i; i < positions.length; ++i) {
            run.positions.push(positions[i]);
            run.forces.push();
        }
        for (uint256 i; i < bonds.length; ++i) run.bonds.push(bonds[i]);
        emit ExperimentRegistered(experimentId, protocolId, run.commitment, positions.length, bonds.length);
    }

    /// @notice Anyone may fund a bounded batch; inputs and the operation order are fixed.
    /// @dev Any failing kernel/math call reverts the whole transaction, including earlier work in this batch.
    function advanceExperiment(uint256 experimentId, uint256 workLimit)
        external returns (uint256 processed, bool completed)
    {
        if (workLimit == 0 || workLimit > MAX_WORK) revert InvalidWorkLimit();
        Run storage run = _get(experimentId);
        if (run.status == Status.Completed) revert ExperimentCompleted();
        _assertDependencies(run.protocolId);
        uint256 start = run.cursor;
        uint256 end = start + workLimit;
        if (end > run.bonds.length) end = run.bonds.length;
        for (uint256 i = start; i < end; ++i) {
            Bond storage bond = run.bonds[i];
            (bytes16 energy, bytes16[3] memory forceA) = bondKernel.evaluate(
                run.positions[bond.a], run.positions[bond.b], bond.k, bond.r0
            );
            _requireFinite(energy);
            run.totalEnergy = numericalMath.add(run.totalEnergy, energy);
            _requireFinite(run.totalEnergy);
            for (uint256 d; d < 3; ++d) {
                _requireFinite(forceA[d]);
                run.forces[bond.a][d] = numericalMath.add(run.forces[bond.a][d], forceA[d]);
                run.forces[bond.b][d] = numericalMath.sub(run.forces[bond.b][d], forceA[d]);
                _requireFinite(run.forces[bond.a][d]);
                _requireFinite(run.forces[bond.b][d]);
            }
        }
        processed = end - start;
        run.cursor = uint32(end);
        completed = end == run.bonds.length;
        run.status = completed ? Status.Completed : Status.Running;
        emit ExperimentAdvanced(experimentId, processed, end, run.totalEnergy, run.status);
    }

    function runInfo(uint256 experimentId) external view returns (
        bytes32 protocolId, bytes32 inputHash, bytes32 commitment, uint256 cursor,
        uint256 bondCount, uint256 atomCount, Status status, bytes16 totalEnergy
    ) {
        Run storage run = _get(experimentId);
        return (run.protocolId, run.inputHash, run.commitment, run.cursor,
            run.bonds.length, run.positions.length, run.status, run.totalEnergy);
    }

    function positionAt(uint256 experimentId, uint256 index) external view returns (bytes16[3] memory) {
        return _get(experimentId).positions[index];
    }

    function forceAt(uint256 experimentId, uint256 index) external view returns (bytes16[3] memory) {
        return _get(experimentId).forces[index];
    }

    function bondAt(uint256 experimentId, uint256 index) external view returns (Bond memory) {
        return _get(experimentId).bonds[index];
    }

    function _assertDependencies(bytes32 protocolId) private view returns (bytes32 manifest) {
        if (address(numericalMath).codehash != mathCodeHash || address(bondKernel).codehash != kernelCodeHash ||
            address(registry).codehash != registryCodeHash) revert ModuleCodeChanged();
        manifest = registry.assertProtocol(protocolId);
        registry.assertModule(protocolId, address(numericalMath), mathCodeHash);
        registry.assertModule(protocolId, address(bondKernel), kernelCodeHash);
        registry.assertModule(protocolId, address(this), address(this).codehash);
    }

    function _get(uint256 experimentId) private view returns (Run storage run) {
        run = _runs[experimentId];
        if (run.status == Status.Missing) revert UnknownExperiment();
    }

    function _requireFinite(bytes16 value) private pure {
        if (((uint128(value) >> 112) & 0x7fff) == 0x7fff) revert NonFiniteNumber();
    }

    function _negativeNonzero(bytes16 value) private pure returns (bool) {
        uint128 bits = uint128(value);
        return (bits >> 127) != 0 && (bits & 0x7fffffffffffffffffffffffffffffff) != 0;
    }
}
