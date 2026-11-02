// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ExperimentRegistry} from "./ExperimentRegistry.sol";
import {WorkingStatePage} from "./WorkingStatePage.sol";
import {FloatMath} from "../math/FloatMath.sol";

interface IDynamicsData {
    function datasetInfo(bytes32 id) external view returns (bytes32, bytes32, uint32, uint32, uint32, uint32, uint32);
    function assertDataset(bytes32 id) external view returns (bytes32);
    function readPositionWord(bytes32 id, uint256 index) external view returns (bytes32);
    function readBondWord(bytes32 id, uint256 index) external view returns (bytes32);
    function readParticleWord(bytes32 id, uint256 index) external view returns (bytes32);
    function readAngleWord(bytes32 id, uint256 index) external view returns (bytes32);
    function readTorsionWord(bytes32 id, uint256 index) external view returns (bytes32);
    function readPairWord(bytes32 id, uint256 index) external view returns (bytes32);
}
interface IDynamicsMathIdentity { function numericalMath() external view returns (address); }
interface IDynamicsAngularIdentity { function elementaryMath() external view returns (address); }
interface IDynamicsElementary {
    function PI() external view returns (bytes16);
    function TWO_PI() external view returns (bytes16);
}
interface IDynamicsPairKernel {
    function evaluate(bytes16[3] calldata a, bytes16[3] calldata b, bytes16 p, bytes16 q)
        external view returns (bytes16 energy, bytes16[3] memory forceA);
}
interface IDynamicsAngleKernel {
    function evaluate(bytes16[3] calldata a, bytes16[3] calldata b, bytes16[3] calldata c, bytes16 k, bytes16 theta0)
        external view returns (bytes16 energy, bytes16[3] memory forceA, bytes16[3] memory forceB, bytes16[3] memory forceC);
}
interface IDynamicsTorsionKernel {
    function evaluate(bytes16[3] calldata a, bytes16[3] calldata b, bytes16[3] calldata c, bytes16[3] calldata d,
        uint32 periodicity, bytes16 k, bytes16 phase) external view returns
        (bytes16 energy, bytes16[3] memory forceA, bytes16[3] memory forceB, bytes16[3] memory forceC, bytes16[3] memory forceD);
}
interface IDynamicsIntegrator {
    function drift(bytes16[3] calldata position, bytes16[3] calldata velocity, bytes16[3] calldata force, bytes16 mass, bytes16 dt)
        external view returns (bytes16[3] memory nextPosition, bytes16[3] memory halfVelocity);
    function kick(bytes16[3] calldata halfVelocity, bytes16[3] calldata newForce, bytes16 mass, bytes16 dt)
        external view returns (bytes16[3] memory nextVelocity);
}

/// @notice Resumable, double-buffered velocity-Verlet component for declared finite systems.
/// @dev Computes bonded and listed direct-pair forces on-chain. No thermostat,
///      constraints, periodic boundary, long-range solver or free-energy estimator.
contract DynamicsCoordinator {
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
    }
    Modules public modules;
    bytes32[10] public moduleCodeHashes;
    WorkingStatePage public statePage;
    bytes32 public statePageCodeHash;
    bytes32 public configurationHash;
    uint256 public nextExperimentId = 1;

    enum Status {
        Missing, Loading, ValidatingBonds, ValidatingAngles, ValidatingTorsions,
        ValidatingPairs, InitialBonds, InitialAngles, InitialTorsions, InitialPairs,
        Drift, NextBonds, NextAngles, NextTorsions, NextPairs, Kick, Completed
    }
    struct Run {
        bytes32 protocolId;
        bytes32 datasetId;
        bytes32 datasetCommitment;
        bytes32 commitment;
        bytes32 stateNamespace;
        bytes16 dt;
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
    struct Pair { uint32 a; uint32 b; bytes16 sigma; bytes16 epsilon; bytes16 chargeProduct; bytes16 prefactor; }
    struct FourEvaluation { bytes16 energy; bytes16[3][4] force; }
    mapping(uint256 => Run) private _runs;

    event WorkingPageBound(address indexed page, bytes32 configurationHash);
    event ExperimentRegistered(uint256 indexed experimentId, bytes32 indexed datasetId, bytes32 commitment);
    event ExperimentAdvanced(uint256 indexed experimentId, uint256 processed, Status status, uint256 cursor);
    event StepCommitted(uint256 indexed experimentId, uint256 completedSteps, uint256 activeBuffer);

    constructor(address owner_, Modules memory modules_) {
        if (owner_ == address(0)) revert InvalidConfiguration();
        owner = owner_;
        modules = modules_;
        address[10] memory addresses = _moduleAddresses(modules_);
        bytes32[10] memory hashes;
        for (uint256 i; i < 10; ++i) {
            if (addresses[i].code.length == 0) revert InvalidConfiguration();
            hashes[i] = addresses[i].codehash;
            moduleCodeHashes[i] = hashes[i];
        }
        for (uint256 i = 3; i < 10; ++i) {
            if (IDynamicsMathIdentity(addresses[i]).numericalMath() != modules_.math) revert InvalidConfiguration();
        }
        if (IDynamicsAngularIdentity(modules_.angle).elementaryMath() != modules_.elementary ||
            IDynamicsAngularIdentity(modules_.torsion).elementaryMath() != modules_.elementary) revert InvalidConfiguration();
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
        bytes32 datasetCommitment = IDynamicsData(modules.dataset).assertDataset(datasetId);
        experimentId = nextExperimentId++;
        Run storage r = _runs[experimentId];
        (,, r.atomCount, r.bondCount, r.angleCount, r.torsionCount, r.pairCount) = IDynamicsData(modules.dataset).datasetInfo(datasetId);
        if (r.atomCount < 2 || r.atomCount > MAX_ATOMS || r.bondCount == 0 || r.bondCount > 16384 ||
            r.angleCount > 4096 || r.torsionCount > 4096 || r.pairCount > 4096) revert InvalidInput();
        r.protocolId = protocolId;
        r.datasetId = datasetId;
        r.datasetCommitment = datasetCommitment;
        r.dt = dt;
        r.targetSteps = steps;
        r.status = Status.Loading;
        r.stateNamespace = keccak256(abi.encode(bytes32("ORVIA-DYNAMICS-STATE-v1"), block.chainid, address(this), experimentId));
        r.commitment = keccak256(abi.encode(bytes32("ORVIA-DYNAMICS-RUN-v1"), block.chainid, address(this),
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
        if (IDynamicsData(modules.dataset).assertDataset(r.datasetId) != r.datasetCommitment) revert DatasetChanged();
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

    function _process(Run storage r) private {
        if (r.status == Status.Loading) _load(r);
        else if (r.status <= Status.ValidatingPairs) _validate(r, _kind(r.status), r.cursor);
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
        if (r.status == Status.Loading || r.status == Status.Drift || r.status == Status.Kick) return r.atomCount;
        uint256 kind = _kind(r.status);
        if (kind == 0) return r.bondCount;
        if (kind == 1) return r.angleCount;
        if (kind == 2) return r.torsionCount;
        return r.pairCount;
    }
    function _kind(Status status) private pure returns (uint256) {
        if (status >= Status.ValidatingBonds && status <= Status.ValidatingPairs) return uint8(status) - 2;
        if (status >= Status.InitialBonds && status <= Status.InitialPairs) return uint8(status) - 6;
        if (status >= Status.NextBonds && status <= Status.NextPairs) return uint8(status) - 11;
        revert InvalidInput();
    }

    function _load(Run storage r) private {
        uint256 atom = r.cursor;
        IDynamicsData data = IDynamicsData(modules.dataset);
        bytes16 mass = _decode(data.readParticleWord(r.datasetId, atom * 4));
        _requirePositive(mass);
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
        (bytes16[3] memory position, bytes16[3] memory halfVelocity) = IDynamicsIntegrator(modules.integrator).drift(
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
        bytes16[3] memory velocity = IDynamicsIntegrator(modules.integrator).kick(
            _readVector(r, next, r.cursor, 3), _readVector(r, next, r.cursor, 6), _mass(r, r.cursor), r.dt
        );
        bytes32[] memory words = new bytes32[](3);
        for (uint256 d; d < 3; ++d) { _requireFinite(velocity[d]); words[d] = _encode(velocity[d]); }
        statePage.writeWords(r.stateNamespace, _vectorIndex(r, next, r.cursor, 3), words);
    }

    function _validate(Run storage r, uint256 kind, uint256 index) private view {
        if (kind == 0) _bond(r, index);
        else if (kind == 1) _angle(r, index);
        else if (kind == 2) _torsion(r, index);
        else _pair(r, index);
    }
    function _calculate(Run storage r, uint256 buffer, uint256 kind, uint256 index) private {
        if (kind == 0) _calculateBond(r, buffer, index);
        else if (kind == 1) _calculateAngle(r, buffer, index);
        else if (kind == 2) _calculateTorsion(r, buffer, index);
        else _calculatePair(r, buffer, index);
    }

    function _calculateBond(Run storage r, uint256 buffer, uint256 index) private {
        Bond memory b = _bond(r, index);
        (bytes16 energy, bytes16[3] memory force) = IDynamicsPairKernel(modules.bond).evaluate(
            _readVector(r, buffer, b.a, 0), _readVector(r, buffer, b.b, 0), b.k, b.r0);
        _addEnergy(r, buffer, energy);
        _addForce(r, buffer, b.a, force, false);
        _addForce(r, buffer, b.b, force, true);
    }
    function _calculateAngle(Run storage r, uint256 buffer, uint256 index) private {
        Angle memory a = _angle(r, index);
        (bytes16 energy, bytes16[3] memory fa, bytes16[3] memory fb, bytes16[3] memory fc) =
            IDynamicsAngleKernel(modules.angle).evaluate(_readVector(r, buffer, a.a, 0),
                _readVector(r, buffer, a.b, 0), _readVector(r, buffer, a.c, 0), a.k, a.theta0);
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
        positions[0] = _readVector(r, buffer, t.a, 0);
        positions[1] = _readVector(r, buffer, t.b, 0);
        positions[2] = _readVector(r, buffer, t.c, 0);
        positions[3] = _readVector(r, buffer, t.d, 0);
        (result.energy, result.force[0], result.force[1], result.force[2], result.force[3]) =
            IDynamicsTorsionKernel(modules.torsion).evaluate(positions[0], positions[1], positions[2], positions[3],
                t.periodicity, t.k, t.phase);
    }
    function _calculatePair(Run storage r, uint256 buffer, uint256 index) private {
        Pair memory p = _pair(r, index);
        bytes16[3] memory a = _readVector(r, buffer, p.a, 0);
        bytes16[3] memory b = _readVector(r, buffer, p.b, 0);
        (bytes16 ljEnergy, bytes16[3] memory ljForce) = IDynamicsPairKernel(modules.lj).evaluate(a, b, p.sigma, p.epsilon);
        (bytes16 cEnergy, bytes16[3] memory cForce) = IDynamicsPairKernel(modules.coulomb).evaluate(a, b, p.chargeProduct, p.prefactor);
        FloatMath m = FloatMath(modules.math);
        _addEnergy(r, buffer, m.add(ljEnergy, cEnergy));
        for (uint256 d; d < 3; ++d) ljForce[d] = m.add(ljForce[d], cForce[d]);
        _addForce(r, buffer, p.a, ljForce, false);
        _addForce(r, buffer, p.b, ljForce, true);
    }

    function _bond(Run storage r, uint256 index) private view returns (Bond memory b) {
        IDynamicsData data = IDynamicsData(modules.dataset);
        uint256 offset = index * 4;
        b.a = _atom(data.readBondWord(r.datasetId, offset), r.atomCount);
        b.b = _atom(data.readBondWord(r.datasetId, offset + 1), r.atomCount);
        if (b.a == b.b) revert InvalidInput();
        b.k = _decode(data.readBondWord(r.datasetId, offset + 2));
        b.r0 = _decode(data.readBondWord(r.datasetId, offset + 3));
        _requireNonnegative(b.k); _requireNonnegative(b.r0);
    }
    function _angle(Run storage r, uint256 index) private view returns (Angle memory a) {
        IDynamicsData data = IDynamicsData(modules.dataset);
        uint256 offset = index * 5;
        a.a = _atom(data.readAngleWord(r.datasetId, offset), r.atomCount);
        a.b = _atom(data.readAngleWord(r.datasetId, offset + 1), r.atomCount);
        a.c = _atom(data.readAngleWord(r.datasetId, offset + 2), r.atomCount);
        if (a.a == a.b || a.a == a.c || a.b == a.c) revert InvalidInput();
        a.k = _decode(data.readAngleWord(r.datasetId, offset + 3));
        a.theta0 = _decode(data.readAngleWord(r.datasetId, offset + 4));
        _requireNonnegative(a.k); _requireNonnegative(a.theta0);
        if (FloatMath(modules.math).compare(a.theta0, IDynamicsElementary(modules.elementary).PI()) > 0) revert InvalidInput();
    }
    function _torsion(Run storage r, uint256 index) private view returns (Torsion memory t) {
        IDynamicsData data = IDynamicsData(modules.dataset);
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
        bytes16 twoPi = IDynamicsElementary(modules.elementary).TWO_PI();
        if (m.compare(t.phase, m.neg(twoPi)) < 0 || m.compare(t.phase, twoPi) > 0) revert InvalidInput();
    }
    function _pair(Run storage r, uint256 index) private view returns (Pair memory p) {
        IDynamicsData data = IDynamicsData(modules.dataset);
        uint256 offset = index * 6;
        p.a = _atom(data.readPairWord(r.datasetId, offset), r.atomCount);
        p.b = _atom(data.readPairWord(r.datasetId, offset + 1), r.atomCount);
        if (p.a == p.b) revert InvalidInput();
        p.sigma = _decode(data.readPairWord(r.datasetId, offset + 2));
        p.epsilon = _decode(data.readPairWord(r.datasetId, offset + 3));
        p.chargeProduct = _decode(data.readPairWord(r.datasetId, offset + 4));
        p.prefactor = _decode(data.readPairWord(r.datasetId, offset + 5));
        _requirePositive(p.sigma); _requireNonnegative(p.epsilon); _requireNonnegative(p.prefactor);
    }

    function _mass(Run storage r, uint256 atom) private view returns (bytes16 mass) {
        mass = _decode(IDynamicsData(modules.dataset).readParticleWord(r.datasetId, atom * 4));
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
        address[10] memory addresses = _moduleAddresses(modules);
        for (uint256 i; i < 10; ++i) if (addresses[i].codehash != moduleCodeHashes[i]) revert ModuleCodeChanged();
        if (address(statePage).codehash != statePageCodeHash) revert ModuleCodeChanged();
        ExperimentRegistry registry = ExperimentRegistry(modules.registry);
        manifest = registry.assertProtocol(protocolId);
        for (uint256 i = 1; i < 10; ++i) registry.assertModule(protocolId, addresses[i], moduleCodeHashes[i]);
        registry.assertModule(protocolId, address(statePage), statePageCodeHash);
        registry.assertModule(protocolId, address(this), address(this).codehash);
    }
    function _moduleAddresses(Modules memory m) private pure returns (address[10] memory) {
        return [m.registry, m.dataset, m.math, m.integrator, m.bond, m.angle, m.torsion, m.lj, m.coulomb, m.elementary];
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
