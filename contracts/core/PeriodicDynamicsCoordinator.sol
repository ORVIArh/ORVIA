// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ExperimentRegistry} from "./ExperimentRegistry.sol";
import {WorkingStatePage} from "./WorkingStatePage.sol";
import {FloatMath} from "../math/FloatMath.sol";

interface IPeriodicDynamicsData {
    function datasetInfo(bytes32 id) external view returns (bytes32, bytes32, uint32, uint32, uint32, uint32, uint32);
    function assertDataset(bytes32 id) external view returns (bytes32);
    function readPositionWord(bytes32 id, uint256 index) external view returns (bytes32);
    function readBondWord(bytes32 id, uint256 index) external view returns (bytes32);
    function readParticleWord(bytes32 id, uint256 index) external view returns (bytes32);
    function readAngleWord(bytes32 id, uint256 index) external view returns (bytes32);
    function readTorsionWord(bytes32 id, uint256 index) external view returns (bytes32);
    function readNonbondedWord(bytes32 id, uint256 index) external view returns (bytes32);
    function readExceptionWord(bytes32 id, uint256 index) external view returns (bytes32);
    function periodicInfo(bytes32 id) external view returns (bytes16[3] memory, bytes16, bytes16, bytes16, uint32);
}
interface IPeriodicDynamicsMathIdentity { function numericalMath() external view returns (address); }
interface IPeriodicDynamicsAngularIdentity { function elementaryMath() external view returns (address); }
interface IPeriodicDynamicsElementary {
    function PI() external view returns (bytes16);
    function TWO_PI() external view returns (bytes16);
}
interface IPeriodicDynamicsPairKernel {
    function evaluate(bytes16[3] calldata a, bytes16[3] calldata b, bytes16 p, bytes16 q)
        external view returns (bytes16 energy, bytes16[3] memory forceA);
}
interface IPeriodicDynamicsAngleKernel {
    function evaluate(bytes16[3] calldata a, bytes16[3] calldata b, bytes16[3] calldata c, bytes16 k, bytes16 theta0)
        external view returns (bytes16 energy, bytes16[3] memory forceA, bytes16[3] memory forceB, bytes16[3] memory forceC);
}
interface IPeriodicDynamicsTorsionKernel {
    function evaluate(bytes16[3] calldata a, bytes16[3] calldata b, bytes16[3] calldata c, bytes16[3] calldata d,
        uint32 periodicity, bytes16 k, bytes16 phase) external view returns
        (bytes16 energy, bytes16[3] memory forceA, bytes16[3] memory forceB, bytes16[3] memory forceC, bytes16[3] memory forceD);
}
interface IPeriodicDynamicsIntegrator {
    function drift(bytes16[3] calldata position, bytes16[3] calldata velocity, bytes16[3] calldata force, bytes16 mass, bytes16 dt)
        external view returns (bytes16[3] memory nextPosition, bytes16[3] memory halfVelocity);
    function kick(bytes16[3] calldata halfVelocity, bytes16[3] calldata newForce, bytes16 mass, bytes16 dt)
        external view returns (bytes16[3] memory nextVelocity);
}

interface IPeriodicGeometry {
    function displacement(bytes16[3] calldata a, bytes16[3] calldata b, bytes16[3] calldata box)
        external view returns (bytes16[3] memory);
    function validateBox(bytes16[3] calldata box, bytes16 cutoff) external view;
}
interface IPeriodicNonbonded {
    function ljKernel() external view returns (address);
    function coulombKernel() external view returns (address);
    function evaluate(bytes16[3] calldata displacement, bytes16 sigma, bytes16 epsilon,
        bytes16 chargeProduct, bytes16 prefactor, bytes16 switchDistance, bytes16 cutoff, bool exception)
        external view returns (bytes16 energy, bytes16[3] memory forceA);
}

/// @notice Bounded, double-buffered velocity Verlet with orthorhombic minimum images.
/// @dev All unordered pairs are enumerated on-chain. Regular interactions use
///      switched LJ and conducting-limit reaction field; exceptions are explicit.
///      No Ewald/PME, neighbor-list cache, thermostat or free-energy estimator.
contract PeriodicDynamicsCoordinator {
    error Unauthorized();
    error InvalidConfiguration();
    error AlreadyConfigured();
    error NotConfigured();
    error ModuleCodeChanged();
    error DatasetChanged();
    error InvalidInput();
    error NonFiniteNumber();
    error UnknownExperiment();
    error InvalidWorkLimit();
    error ExperimentCompleted();

    uint256 public constant MAX_WORK = 8;
    uint256 public constant MAX_ATOMS = 1024;
    uint256 public constant MAX_STEPS = 4096;
    address public immutable owner;
    bytes32 public immutable coreConfigurationHash;

    struct Modules {
        address registry;
        address dataset;
        address math;
        address integrator;
        address bond;
        address angle;
        address torsion;
        address lj;
        address coulomb;
        address elementary;
        address geometry;
        address nonbonded;
    }
    Modules public modules;
    bytes32[12] public moduleCodeHashes;
    WorkingStatePage public statePage;
    bytes32 public statePageCodeHash;
    bytes32 public configurationHash;
    uint256 public nextExperimentId = 1;

    enum Status {
        Missing, Loading, ValidatingBonds, ValidatingAngles, ValidatingTorsions,
        ValidatingExceptions, InitialBonds, InitialAngles, InitialTorsions, InitialPairs,
        Drift, NextBonds, NextAngles, NextTorsions, NextPairs, Kick, Completed
    }
    struct Run {
        bytes32 protocolId;
        bytes32 datasetId;
        bytes32 datasetCommitment;
        bytes32 commitment;
        bytes32 stateNamespace;
        bytes16 dt;
        bytes16[3] box;
        bytes16 switchDistance;
        bytes16 cutoff;
        bytes16 prefactor;
        uint32 exceptionCount;
        uint32 lastExceptionKey;
        uint32 cursor;
        uint32 completedSteps;
        uint32 targetSteps;
        uint32 atomCount;
        uint32 bondCount;
        uint32 angleCount;
        uint32 torsionCount;
        uint32 pairCount;
        uint8 activeBuffer;
        Status status;
    }
    struct Bond { uint32 a; uint32 b; bytes16 k; bytes16 r0; }
    struct Angle { uint32 a; uint32 b; uint32 c; bytes16 k; bytes16 theta0; }
    struct Torsion { uint32 a; uint32 b; uint32 c; uint32 d; uint32 periodicity; bytes16 k; bytes16 phase; }
    struct Pair { uint32 a; uint32 b; uint32 kind; bytes16 sigma; bytes16 epsilon; bytes16 chargeProduct; }
    struct ParticleParameters { bytes16 sigma; bytes16 epsilon; bytes16 charge; }
    struct FourEvaluation { bytes16 energy; bytes16[3][4] force; }
    mapping(uint256 => Run) private _runs;
    mapping(bytes32 => mapping(uint256 => uint256)) private _exceptionIndex;

    event WorkingPageBound(address indexed page, bytes32 configurationHash);
    event ExperimentRegistered(uint256 indexed experimentId, bytes32 indexed datasetId, bytes32 commitment);
    event ExperimentAdvanced(uint256 indexed experimentId, uint256 processed, Status status, uint256 cursor);
    event StepCommitted(uint256 indexed experimentId, uint256 completedSteps, uint256 activeBuffer);

    constructor(address owner_, Modules memory modules_) {
        if (owner_ == address(0)) revert InvalidConfiguration();
        owner = owner_;
        modules = modules_;
        address[12] memory addresses = _moduleAddresses(modules_);
        bytes32[12] memory hashes;
        for (uint256 i; i < 12; ++i) {
            if (addresses[i].code.length == 0) revert InvalidConfiguration();
            hashes[i] = addresses[i].codehash;
            moduleCodeHashes[i] = hashes[i];
        }
        for (uint256 i = 3; i < 12; ++i) {
            if (IPeriodicDynamicsMathIdentity(addresses[i]).numericalMath() != modules_.math) revert InvalidConfiguration();
        }
        if (IPeriodicDynamicsAngularIdentity(modules_.angle).elementaryMath() != modules_.elementary ||
            IPeriodicDynamicsAngularIdentity(modules_.torsion).elementaryMath() != modules_.elementary) revert InvalidConfiguration();
        if (IPeriodicNonbonded(modules_.nonbonded).ljKernel() != modules_.lj ||
            IPeriodicNonbonded(modules_.nonbonded).coulombKernel() != modules_.coulomb) revert InvalidConfiguration();
        coreConfigurationHash = keccak256(abi.encode(modules_, hashes));
    }

    function bindWorkingPage(address page) external {
        if (msg.sender != owner) revert Unauthorized();
        if (address(statePage) != address(0)) revert AlreadyConfigured();
        if (page.code.length == 0 || WorkingStatePage(page).writer() != address(this)) revert InvalidConfiguration();
        statePage = WorkingStatePage(page);
        statePageCodeHash = page.codehash;
        configurationHash = keccak256(abi.encode(coreConfigurationHash, page, page.codehash));
        emit WorkingPageBound(page, configurationHash);
    }

    function registerExperiment(bytes32 protocolId, bytes32 datasetId, bytes16 dt, uint32 steps)
        external returns (uint256 experimentId)
    {
        if (msg.sender != owner) revert Unauthorized();
        _requirePositive(dt);
        if (steps == 0 || steps > MAX_STEPS) revert InvalidInput();
        bytes32 manifest = _assertDependencies(protocolId);
        bytes32 datasetCommitment = IPeriodicDynamicsData(modules.dataset).assertDataset(datasetId);
        experimentId = nextExperimentId++;
        Run storage r = _runs[experimentId];
        (,, r.atomCount, r.bondCount, r.angleCount, r.torsionCount, r.pairCount) = IPeriodicDynamicsData(modules.dataset).datasetInfo(datasetId);
        if (r.atomCount < 2 || r.atomCount > MAX_ATOMS || r.bondCount == 0 || r.bondCount > 16384 ||
            r.angleCount > 4096 || r.torsionCount > 4096 ||
            r.pairCount != uint256(r.atomCount) * (r.atomCount - 1) / 2) revert InvalidInput();
        (r.box, r.switchDistance, r.cutoff, r.prefactor, r.exceptionCount) =
            IPeriodicDynamicsData(modules.dataset).periodicInfo(datasetId);
        if (r.exceptionCount > 4096 || r.exceptionCount > r.pairCount) revert InvalidInput();
        _requirePositive(r.switchDistance); _requirePositive(r.cutoff); _requireNonnegative(r.prefactor);
        if (FloatMath(modules.math).compare(r.switchDistance, r.cutoff) >= 0) revert InvalidInput();
        IPeriodicGeometry(modules.geometry).validateBox(r.box, r.cutoff);
        r.protocolId = protocolId;
        r.datasetId = datasetId;
        r.datasetCommitment = datasetCommitment;
        r.dt = dt;
        r.targetSteps = steps;
        r.status = Status.Loading;
        r.stateNamespace = keccak256(abi.encode(bytes32("ORVIA-PERIODIC-STATE-v1"), block.chainid, address(this), experimentId));
        r.commitment = keccak256(abi.encode(bytes32("ORVIA-PERIODIC-RUN-v1"), block.chainid, address(this),
            experimentId, manifest, datasetId, datasetCommitment, configurationHash, dt, steps, r.stateNamespace));
        statePage.createNamespace(r.stateNamespace, r.atomCount * 18 + 2);
        emit ExperimentRegistered(experimentId, datasetId, r.commitment);
    }

    function advanceExperiment(uint256 experimentId, uint256 workLimit)
        external returns (uint256 processed, bool completed)
    {
        if (workLimit == 0 || workLimit > MAX_WORK) revert InvalidWorkLimit();
        Run storage r = _get(experimentId);
        if (r.status == Status.Completed) revert ExperimentCompleted();
        _assertDependencies(r.protocolId);
        if (IPeriodicDynamicsData(modules.dataset).assertDataset(r.datasetId) != r.datasetCommitment) revert DatasetChanged();
        while (processed < workLimit && r.status != Status.Completed) {
            _process(r);
            ++processed;
            ++r.cursor;
            if (r.cursor == _stageCount(r)) _finishStage(r, experimentId);
        }
        completed = r.status == Status.Completed;
        emit ExperimentAdvanced(experimentId, processed, r.status, r.cursor);
    }

    function runInfo(uint256 experimentId) external view returns (
        bytes32 protocolId, bytes32 datasetId, bytes32 commitment, bytes32 stateNamespace,
        uint256 cursor, uint256 completedSteps, uint256 targetSteps, uint256 atomCount,
        uint256 activeBuffer, Status status, bytes16 potentialEnergy
    ) {
        Run storage r = _get(experimentId);
        protocolId = r.protocolId;
        datasetId = r.datasetId;
        commitment = r.commitment;
        stateNamespace = r.stateNamespace;
        cursor = r.cursor;
        completedSteps = r.completedSteps;
        targetSteps = r.targetSteps;
        atomCount = r.atomCount;
        activeBuffer = r.activeBuffer;
        status = r.status;
        potentialEnergy = _decode(statePage.readWord(r.stateNamespace, _energyIndex(r, r.activeBuffer)));
    }

    function stateAt(uint256 experimentId, uint256 atom) external view returns (
        bytes16[3] memory position, bytes16[3] memory velocity, bytes16[3] memory force
    ) {
        Run storage r = _get(experimentId);
        if (atom >= r.atomCount) revert InvalidInput();
        position = _readVector(r, r.activeBuffer, atom, 0);
        velocity = _readVector(r, r.activeBuffer, atom, 3);
        force = _readVector(r, r.activeBuffer, atom, 6);
    }

    function experimentParameters(uint256 experimentId) external view returns (
        bytes16 dt, uint32 bondCount, uint32 angleCount, uint32 torsionCount, uint32 pairCount, bytes32 datasetCommitment
    ) {
        Run storage r = _get(experimentId);
        return (r.dt, r.bondCount, r.angleCount, r.torsionCount, r.pairCount, r.datasetCommitment);
    }

    function periodicParameters(uint256 experimentId) external view returns (
        bytes16[3] memory box, bytes16 switchDistance, bytes16 cutoff, bytes16 prefactor, uint32 exceptionCount
    ) {
        Run storage r = _get(experimentId);
        return (r.box, r.switchDistance, r.cutoff, r.prefactor, r.exceptionCount);
    }

    function _process(Run storage r) private {
        if (r.status == Status.Loading) _load(r);
        else if (r.status <= Status.ValidatingExceptions) _validate(r, _kind(r.status), r.cursor);
        else if (r.status <= Status.InitialPairs) _calculate(r, r.activeBuffer, _kind(r.status), r.cursor);
        else if (r.status == Status.Drift) _drift(r);
        else if (r.status <= Status.NextPairs) _calculate(r, 1 - r.activeBuffer, _kind(r.status), r.cursor);
        else if (r.status == Status.Kick) _kick(r);
        else revert InvalidInput();
    }

    function _finishStage(Run storage r, uint256 experimentId) private {
        if (r.status == Status.Kick) {
            r.activeBuffer = 1 - r.activeBuffer;
            ++r.completedSteps;
            emit StepCommitted(experimentId, r.completedSteps, r.activeBuffer);
            if (r.completedSteps == r.targetSteps) {
                statePage.sealNamespace(r.stateNamespace);
                r.status = Status.Completed;
                return;
            }
            r.status = Status.Drift;
        } else r.status = Status(uint8(r.status) + 1);
        r.cursor = 0;
        // Empty optional interaction streams consume no artificial work units.
        while (_stageCount(r) == 0) r.status = Status(uint8(r.status) + 1);
    }

    function _stageCount(Run storage r) private view returns (uint256) {
        if (r.status == Status.ValidatingExceptions) return r.exceptionCount;
        if (r.status == Status.Loading || r.status == Status.Drift || r.status == Status.Kick) return r.atomCount;
        uint256 kind = _kind(r.status);
        if (kind == 0) return r.bondCount;
        if (kind == 1) return r.angleCount;
        if (kind == 2) return r.torsionCount;
        return r.pairCount;
    }
    function _kind(Status status) private pure returns (uint256) {
        if (status >= Status.ValidatingBonds && status <= Status.ValidatingExceptions) return uint8(status) - 2;
        if (status >= Status.InitialBonds && status <= Status.InitialPairs) return uint8(status) - 6;
        if (status >= Status.NextBonds && status <= Status.NextPairs) return uint8(status) - 11;
        revert InvalidInput();
    }

    function _load(Run storage r) private {
        uint256 atom = r.cursor;
        IPeriodicDynamicsData data = IPeriodicDynamicsData(modules.dataset);
        bytes16 mass = _decode(data.readParticleWord(r.datasetId, atom * 4));
        _requirePositive(mass);
        _parameters(r, atom);
        bytes32[] memory words = new bytes32[](6);
        for (uint256 d; d < 3; ++d) {
            words[d] = _encode(_decode(data.readPositionWord(r.datasetId, atom * 3 + d)));
            words[d + 3] = _encode(_decode(data.readParticleWord(r.datasetId, atom * 4 + d + 1)));
        }
        statePage.writeWords(r.stateNamespace, atom * 9, words);
    }

    function _drift(Run storage r) private {
        uint256 next = 1 - r.activeBuffer;
        if (r.cursor == 0) statePage.writeWord(r.stateNamespace, _energyIndex(r, next), bytes32(0));
        (bytes16[3] memory position, bytes16[3] memory halfVelocity) = IPeriodicDynamicsIntegrator(modules.integrator).drift(
            _readVector(r, r.activeBuffer, r.cursor, 0), _readVector(r, r.activeBuffer, r.cursor, 3),
            _readVector(r, r.activeBuffer, r.cursor, 6), _mass(r, r.cursor), r.dt
        );
        bytes32[] memory words = new bytes32[](9);
        for (uint256 d; d < 3; ++d) {
            _requireFinite(position[d]);
            _requireFinite(halfVelocity[d]);
            words[d] = _encode(position[d]);
            words[d + 3] = _encode(halfVelocity[d]);
            // Remaining three words deliberately clear old inactive-buffer forces.
        }
        statePage.writeWords(r.stateNamespace, _vectorIndex(r, next, r.cursor, 0), words);
    }

    function _kick(Run storage r) private {
        uint256 next = 1 - r.activeBuffer;
        bytes16[3] memory velocity = IPeriodicDynamicsIntegrator(modules.integrator).kick(
            _readVector(r, next, r.cursor, 3), _readVector(r, next, r.cursor, 6), _mass(r, r.cursor), r.dt
        );
        bytes32[] memory words = new bytes32[](3);
        for (uint256 d; d < 3; ++d) { _requireFinite(velocity[d]); words[d] = _encode(velocity[d]); }
        statePage.writeWords(r.stateNamespace, _vectorIndex(r, next, r.cursor, 3), words);
    }

    function _validate(Run storage r, uint256 kind, uint256 index) private {
        if (kind == 0) _bond(r, index);
        else if (kind == 1) _angle(r, index);
        else if (kind == 2) _torsion(r, index);
        else _validateException(r, index);
    }
    function _calculate(Run storage r, uint256 buffer, uint256 kind, uint256 index) private {
        if (kind == 0) _calculateBond(r, buffer, index);
        else if (kind == 1) _calculateAngle(r, buffer, index);
        else if (kind == 2) _calculateTorsion(r, buffer, index);
        else _calculatePair(r, buffer, index);
    }

    function _calculateBond(Run storage r, uint256 buffer, uint256 index) private {
        Bond memory b = _bond(r, index);
        bytes16[3] memory zero;
        (bytes16 energy, bytes16[3] memory force) = IPeriodicDynamicsPairKernel(modules.bond).evaluate(
            zero, _bondedDisplacement(r, buffer, b.a, b.b), b.k, b.r0);
        _addEnergy(r, buffer, energy);
        _addForce(r, buffer, b.a, force, false);
        _addForce(r, buffer, b.b, force, true);
    }
    function _calculateAngle(Run storage r, uint256 buffer, uint256 index) private {
        Angle memory a = _angle(r, index);
        bytes16[3] memory zero;
        (bytes16 energy, bytes16[3] memory fa, bytes16[3] memory fb, bytes16[3] memory fc) =
            IPeriodicDynamicsAngleKernel(modules.angle).evaluate(_bondedDisplacement(r, buffer, a.b, a.a),
                zero, _bondedDisplacement(r, buffer, a.b, a.c), a.k, a.theta0);
        _addEnergy(r, buffer, energy);
        _addForce(r, buffer, a.a, fa, false);
        _addForce(r, buffer, a.b, fb, false);
        _addForce(r, buffer, a.c, fc, false);
    }
    function _calculateTorsion(Run storage r, uint256 buffer, uint256 index) private {
        Torsion memory t = _torsion(r, index);
        FourEvaluation memory result = _evaluateTorsion(r, buffer, t);
        _addEnergy(r, buffer, result.energy);
        _addForce(r, buffer, t.a, result.force[0], false);
        _addForce(r, buffer, t.b, result.force[1], false);
        _addForce(r, buffer, t.c, result.force[2], false);
        _addForce(r, buffer, t.d, result.force[3], false);
    }
    function _evaluateTorsion(Run storage r, uint256 buffer, Torsion memory t)
        private view returns (FourEvaluation memory result)
    {
        bytes16[3][4] memory positions;
        positions[1] = _bondedDisplacement(r, buffer, t.a, t.b);
        bytes16[3] memory bc = _bondedDisplacement(r, buffer, t.b, t.c);
        bytes16[3] memory cd = _bondedDisplacement(r, buffer, t.c, t.d);
        FloatMath m = FloatMath(modules.math);
        for (uint256 d; d < 3; ++d) {
            positions[2][d] = m.add(positions[1][d], bc[d]);
            positions[3][d] = m.add(positions[2][d], cd[d]);
        }
        (result.energy, result.force[0], result.force[1], result.force[2], result.force[3]) =
            IPeriodicDynamicsTorsionKernel(modules.torsion).evaluate(positions[0], positions[1], positions[2], positions[3],
                t.periodicity, t.k, t.phase);
    }
    function _calculatePair(Run storage r, uint256 buffer, uint256 index) private {
        Pair memory p = _pair(r, index);
        if (p.kind == 1) return; // Declared exclusions perform no geometric evaluation.
        bytes16[3] memory displacement = _displacement(r, buffer, p.a, p.b);
        if (p.kind == 2) _requireUniqueImage(r, displacement);
        (bytes16 energy, bytes16[3] memory force) = IPeriodicNonbonded(modules.nonbonded).evaluate(
            displacement, p.sigma, p.epsilon, p.chargeProduct,
            r.prefactor, r.switchDistance, r.cutoff, p.kind == 2);
        _addEnergy(r, buffer, energy);
        _addForce(r, buffer, p.a, force, false);
        _addForce(r, buffer, p.b, force, true);
    }

    function _displacement(Run storage r, uint256 buffer, uint256 a, uint256 b)
        private view returns (bytes16[3] memory)
    {
        return IPeriodicGeometry(modules.geometry).displacement(
            _readVector(r, buffer, a, 0), _readVector(r, buffer, b, 0), r.box);
    }

    function _bondedDisplacement(Run storage r, uint256 buffer, uint256 a, uint256 b)
        private view returns (bytes16[3] memory displacement)
    {
        displacement = _displacement(r, buffer, a, b);
        _requireUniqueImage(r, displacement);
    }

    /// @dev A nearest image is nonunique at an exact half-box component. Bonded
    ///      terms and uncut exceptions reject that nondifferentiable geometry.
    function _requireUniqueImage(Run storage r, bytes16[3] memory displacement) private view {
        FloatMath m = FloatMath(modules.math);
        bytes16 two = m.fromUInt(2);
        for (uint256 axis; axis < 3; ++axis) {
            if (m.compare(m.abs(displacement[axis]), m.div(r.box[axis], two)) == 0) revert InvalidInput();
        }
    }

    function _bond(Run storage r, uint256 index) private view returns (Bond memory b) {
        IPeriodicDynamicsData data = IPeriodicDynamicsData(modules.dataset);
        uint256 offset = index * 4;
        b.a = _atom(data.readBondWord(r.datasetId, offset), r.atomCount);
        b.b = _atom(data.readBondWord(r.datasetId, offset + 1), r.atomCount);
        if (b.a == b.b) revert InvalidInput();
        b.k = _decode(data.readBondWord(r.datasetId, offset + 2));
        b.r0 = _decode(data.readBondWord(r.datasetId, offset + 3));
        _requireNonnegative(b.k); _requireNonnegative(b.r0);
    }
    function _angle(Run storage r, uint256 index) private view returns (Angle memory a) {
        IPeriodicDynamicsData data = IPeriodicDynamicsData(modules.dataset);
        uint256 offset = index * 5;
        a.a = _atom(data.readAngleWord(r.datasetId, offset), r.atomCount);
        a.b = _atom(data.readAngleWord(r.datasetId, offset + 1), r.atomCount);
        a.c = _atom(data.readAngleWord(r.datasetId, offset + 2), r.atomCount);
        if (a.a == a.b || a.a == a.c || a.b == a.c) revert InvalidInput();
        a.k = _decode(data.readAngleWord(r.datasetId, offset + 3));
        a.theta0 = _decode(data.readAngleWord(r.datasetId, offset + 4));
        _requireNonnegative(a.k); _requireNonnegative(a.theta0);
        if (FloatMath(modules.math).compare(a.theta0, IPeriodicDynamicsElementary(modules.elementary).PI()) > 0) revert InvalidInput();
    }
    function _torsion(Run storage r, uint256 index) private view returns (Torsion memory t) {
        IPeriodicDynamicsData data = IPeriodicDynamicsData(modules.dataset);
        uint256 offset = index * 7;
        t.a = _atom(data.readTorsionWord(r.datasetId, offset), r.atomCount);
        t.b = _atom(data.readTorsionWord(r.datasetId, offset + 1), r.atomCount);
        t.c = _atom(data.readTorsionWord(r.datasetId, offset + 2), r.atomCount);
        t.d = _atom(data.readTorsionWord(r.datasetId, offset + 3), r.atomCount);
        if (t.a == t.b || t.a == t.c || t.a == t.d || t.b == t.c || t.b == t.d || t.c == t.d) revert InvalidInput();
        uint256 n = uint256(data.readTorsionWord(r.datasetId, offset + 4));
        if (n == 0 || n > 6) revert InvalidInput();
        t.periodicity = uint32(n);
        t.k = _decode(data.readTorsionWord(r.datasetId, offset + 5));
        t.phase = _decode(data.readTorsionWord(r.datasetId, offset + 6));
        _requireNonnegative(t.k);
        FloatMath m = FloatMath(modules.math);
        bytes16 twoPi = IPeriodicDynamicsElementary(modules.elementary).TWO_PI();
        if (m.compare(t.phase, m.neg(twoPi)) < 0 || m.compare(t.phase, twoPi) > 0) revert InvalidInput();
    }
    function _parameters(Run storage r, uint256 atom) private view returns (ParticleParameters memory p) {
        IPeriodicDynamicsData data = IPeriodicDynamicsData(modules.dataset);
        p.sigma = _decode(data.readNonbondedWord(r.datasetId, atom * 3));
        p.epsilon = _decode(data.readNonbondedWord(r.datasetId, atom * 3 + 1));
        p.charge = _decode(data.readNonbondedWord(r.datasetId, atom * 3 + 2));
        _requirePositive(p.sigma); _requireNonnegative(p.epsilon);
    }

    function _exception(Run storage r, uint256 index) private view returns (Pair memory p) {
        IPeriodicDynamicsData data = IPeriodicDynamicsData(modules.dataset);
        uint256 offset = index * 6;
        p.a = _atom(data.readExceptionWord(r.datasetId, offset), r.atomCount);
        p.b = _atom(data.readExceptionWord(r.datasetId, offset + 1), r.atomCount);
        uint256 kind = uint256(data.readExceptionWord(r.datasetId, offset + 2));
        if (p.a >= p.b || kind < 1 || kind > 2) revert InvalidInput();
        p.kind = uint32(kind);
        p.sigma = _decode(data.readExceptionWord(r.datasetId, offset + 3));
        p.epsilon = _decode(data.readExceptionWord(r.datasetId, offset + 4));
        p.chargeProduct = _decode(data.readExceptionWord(r.datasetId, offset + 5));
        if (p.kind == 1) {
            if (p.sigma != bytes16(0) || p.epsilon != bytes16(0) || p.chargeProduct != bytes16(0)) revert InvalidInput();
        } else { _requirePositive(p.sigma); _requireNonnegative(p.epsilon); }
    }

    function _validateException(Run storage r, uint256 index) private {
        Pair memory p = _exception(r, index);
        uint32 key = p.a * r.atomCount + p.b;
        if (index != 0 && key <= r.lastExceptionKey) revert InvalidInput();
        r.lastExceptionKey = key;
        _exceptionIndex[r.stateNamespace][key] = index + 1;
    }

    function _pair(Run storage r, uint256 index) private view returns (Pair memory p) {
        (p.a, p.b) = _pairIndices(index, r.atomCount);
        uint256 exceptionIndex = _exceptionIndex[r.stateNamespace][uint256(p.a) * r.atomCount + p.b];
        if (exceptionIndex != 0) return _exception(r, exceptionIndex - 1);
        ParticleParameters memory a = _parameters(r, p.a);
        ParticleParameters memory b = _parameters(r, p.b);
        FloatMath m = FloatMath(modules.math);
        p.sigma = m.div(m.add(a.sigma, b.sigma), m.fromUInt(2));
        p.epsilon = m.sqrt(m.mul(a.epsilon, b.epsilon));
        p.chargeProduct = m.mul(a.charge, b.charge);
    }

    /// @dev Lexicographic unordered-pair inversion, at most ten iterations for N<=1024.
    function _pairIndices(uint256 index, uint256 count) private pure returns (uint32 a, uint32 b) {
        uint256 low;
        uint256 high = count - 1;
        while (low + 1 < high) {
            uint256 mid = (low + high) / 2;
            if (mid * (2 * count - mid - 1) / 2 <= index) low = mid;
            else high = mid;
        }
        a = uint32(low);
        b = uint32(low + 1 + index - low * (2 * count - low - 1) / 2);
    }

    function _mass(Run storage r, uint256 atom) private view returns (bytes16 mass) {
        mass = _decode(IPeriodicDynamicsData(modules.dataset).readParticleWord(r.datasetId, atom * 4));
        _requirePositive(mass);
    }
    function _readVector(Run storage r, uint256 buffer, uint256 atom, uint256 field)
        private view returns (bytes16[3] memory result)
    {
        bytes32[] memory words = statePage.readWords(r.stateNamespace, _vectorIndex(r, buffer, atom, field), 3);
        for (uint256 d; d < 3; ++d) result[d] = _decode(words[d]);
    }
    function _addForce(Run storage r, uint256 buffer, uint256 atom, bytes16[3] memory force, bool subtract) private {
        uint256 offset = _vectorIndex(r, buffer, atom, 6);
        bytes32[] memory words = statePage.readWords(r.stateNamespace, offset, 3);
        FloatMath m = FloatMath(modules.math);
        for (uint256 d; d < 3; ++d) {
            _requireFinite(force[d]);
            bytes16 previous = _decode(words[d]);
            bytes16 next = subtract ? m.sub(previous, force[d]) : m.add(previous, force[d]);
            _requireFinite(next);
            words[d] = _encode(next);
        }
        statePage.writeWords(r.stateNamespace, offset, words);
    }
    function _addEnergy(Run storage r, uint256 buffer, bytes16 energy) private {
        _requireFinite(energy);
        uint256 offset = _energyIndex(r, buffer);
        bytes16 next = FloatMath(modules.math).add(_decode(statePage.readWord(r.stateNamespace, offset)), energy);
        _requireFinite(next);
        statePage.writeWord(r.stateNamespace, offset, _encode(next));
    }
    function _vectorIndex(Run storage r, uint256 buffer, uint256 atom, uint256 field) private view returns (uint256) {
        return buffer * 9 * uint256(r.atomCount) + atom * 9 + field;
    }
    function _energyIndex(Run storage r, uint256 buffer) private view returns (uint256) {
        return uint256(r.atomCount) * 18 + buffer;
    }

    function _assertDependencies(bytes32 protocolId) private view returns (bytes32 manifest) {
        if (address(statePage) == address(0)) revert NotConfigured();
        address[12] memory addresses = _moduleAddresses(modules);
        for (uint256 i; i < 12; ++i) if (addresses[i].codehash != moduleCodeHashes[i]) revert ModuleCodeChanged();
        if (address(statePage).codehash != statePageCodeHash) revert ModuleCodeChanged();
        ExperimentRegistry registry = ExperimentRegistry(modules.registry);
        manifest = registry.assertProtocol(protocolId);
        for (uint256 i = 1; i < 12; ++i) registry.assertModule(protocolId, addresses[i], moduleCodeHashes[i]);
        registry.assertModule(protocolId, address(statePage), statePageCodeHash);
        registry.assertModule(protocolId, address(this), address(this).codehash);
    }
    function _moduleAddresses(Modules memory m) private pure returns (address[12] memory) {
        return [m.registry, m.dataset, m.math, m.integrator, m.bond, m.angle, m.torsion, m.lj, m.coulomb, m.elementary, m.geometry, m.nonbonded];
    }
    function _get(uint256 experimentId) private view returns (Run storage r) {
        r = _runs[experimentId];
        if (r.status == Status.Missing) revert UnknownExperiment();
    }
    function _atom(bytes32 word, uint256 count) private pure returns (uint32) {
        uint256 value = uint256(word);
        if (value >= count) revert InvalidInput();
        return uint32(value);
    }
    function _decode(bytes32 word) private pure returns (bytes16 value) {
        if (uint256(word) >> 128 != 0) revert InvalidInput();
        value = bytes16(uint128(uint256(word)));
        _requireFinite(value);
    }
    function _encode(bytes16 value) private pure returns (bytes32) { return bytes32(uint256(uint128(value))); }
    function _requireFinite(bytes16 value) private pure {
        if (((uint128(value) >> 112) & 0x7fff) == 0x7fff) revert NonFiniteNumber();
    }
    function _requireNonnegative(bytes16 value) private pure {
        _requireFinite(value);
        uint128 bits = uint128(value);
        if ((bits >> 127) != 0 && (bits & 0x7fffffffffffffffffffffffffffffff) != 0) revert InvalidInput();
    }
    function _requirePositive(bytes16 value) private pure {
        _requireNonnegative(value);
        if ((uint128(value) & 0x7fffffffffffffffffffffffffffffff) == 0) revert InvalidInput();
    }
}
