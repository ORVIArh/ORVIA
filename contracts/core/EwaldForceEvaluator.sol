// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FloatMath} from "../math/FloatMath.sol";
import {ElementaryMath} from "../math/ElementaryMath.sol";
import {OrthorhombicGeometry} from "../kernels/OrthorhombicGeometry.sol";
import {EwaldRealSpaceKernel} from "../kernels/EwaldRealSpaceKernel.sol";
import {EwaldReciprocalKernel} from "../kernels/EwaldReciprocalKernel.sol";
import {EwaldCorrections} from "../kernels/EwaldCorrections.sol";
import {IEwaldScalarMath} from "../kernels/EwaldKernelBase.sol";
import {WorkingStatePage} from "./WorkingStatePage.sol";
import {PeriodicDataset} from "./PeriodicDataset.sol";
import {ExperimentRegistry} from "./ExperimentRegistry.sol";

/// @notice Complete bounded Ewald electrostatic evaluation of a sealed on-chain snapshot.
/// @dev Finite real cutoff and integer reciprocal extent are explicit approximations.
///      No coordinate, charge, structure-factor or force result is supplied off-chain.
contract EwaldForceEvaluator {
    error Unauthorized();
    error InvalidConfiguration();
    error AlreadyConfigured();
    error InvalidInput();
    error NotConfigured();
    error UnknownRun();
    error InvalidWork();
    error DependencyChanged();
    error DatasetChanged();
    error SnapshotNotFrozen();
    error NotCompleted();
    error AlreadyCompleted();
    uint32 public constant MAX_ATOMS = 1024;
    uint32 public constant MAX_MODE = 32;
    uint32 public constant MAX_WORK = 8;
    bytes32 public constant IMPLEMENTATION_ID =
        keccak256("ORVIA.EwaldForceEvaluator.v0.5.SealedSnapshot");
    enum Status {
        Missing,
        Loading,
        ValidatingExceptions,
        RealPairs,
        Exceptions,
        ModeSetup,
        StructureFactor,
        ModeForces,
        Background,
        Completed
    }
    struct Modules {
        address registry;
        address dataset;
        address math;
        address scalar;
        address elementary;
        address geometry;
        address realSpace;
        address reciprocal;
        address corrections;
    }
    struct Registration {
        bytes32 datasetId;
        address sourcePage;
        bytes32 sourceNamespace;
        uint32 positionOffset;
        uint32 positionStride;
        bytes16 alpha;
        uint32 maxMode;
    }
    struct Run {
        Registration input;
        Status status;
        uint32 cursor;
        uint32 atomCount;
        uint32 pairCount;
        uint32 exceptionCount;
        uint32 modeIndex;
        uint32 modeCount;
        uint32 lastExceptionKey;
        bytes32 namespace;
        bytes32 commitment;
        bytes32 datasetCommitment;
        bytes32 protocolId;
        bytes32 sourceCodeHash;
        address sourceWriter;
        bytes32 sourceWriterCodeHash;
        bytes16[3] box;
        bytes16 cutoff;
        bytes16 prefactor;
        bytes16 totalCharge;
        int32[3] mode;
        bytes16[3] wave;
        bytes16 coefficient;
        bytes16 totalCosine;
        bytes16 totalSine;
    }
    struct PairException {
        uint32 a;
        uint32 b;
        uint32 kind;
        bytes16 desired;
    }
    address public immutable owner;
    Modules public modules;
    bytes32[9] public moduleCodeHashes;
    bytes32 public immutable coreConfigurationHash;
    WorkingStatePage public outputPage;
    bytes32 public outputPageCodeHash;
    bytes32 public configurationHash;
    uint256 public nextRunId = 1;
    mapping(uint256 => Run) private runs;
    mapping(address => bool) public isSnapshotPage;
    mapping(uint256 => mapping(uint256 => uint256)) private exceptionIndices;
    event SnapshotPageCreated(address indexed page, address indexed writer);
    event RunRegistered(
        uint256 indexed runId,
        bytes32 commitment,
        bytes32 outputNamespace
    );
    event Advanced(
        uint256 indexed runId,
        uint256 work,
        Status status,
        uint32 cursor,
        uint32 modeIndex
    );

    constructor(address owner_, Modules memory m) {
        if (owner_ == address(0)) revert InvalidConfiguration();
        owner = owner_;
        modules = m;
        address[9] memory addresses = _addresses(m);
        for (uint256 i; i < 9; ++i) {
            if (addresses[i].code.length == 0) revert InvalidConfiguration();
            moduleCodeHashes[i] = addresses[i].codehash;
        }
        if (
            IEwaldScalarMath(m.scalar).numericalMath() != m.math ||
            address(ElementaryMath(m.elementary).numericalMath()) != m.math ||
            address(OrthorhombicGeometry(m.geometry).numericalMath()) != m.math
        ) revert InvalidConfiguration();
        if (
            address(EwaldRealSpaceKernel(m.realSpace).numericalMath()) !=
                m.math ||
            address(EwaldRealSpaceKernel(m.realSpace).scalarMath()) != m.scalar
        ) revert InvalidConfiguration();
        if (
            address(EwaldReciprocalKernel(m.reciprocal).numericalMath()) !=
                m.math ||
            address(EwaldReciprocalKernel(m.reciprocal).scalarMath()) !=
                m.scalar ||
            address(EwaldReciprocalKernel(m.reciprocal).elementaryMath()) !=
                m.elementary
        ) revert InvalidConfiguration();
        if (
            address(EwaldCorrections(m.corrections).numericalMath()) !=
                m.math ||
            address(EwaldCorrections(m.corrections).scalarMath()) != m.scalar
        ) revert InvalidConfiguration();
        coreConfigurationHash = keccak256(abi.encode(m, moduleCodeHashes));
    }
    function bindOutputPage(address page) external {
        if (msg.sender != owner) revert Unauthorized();
        if (address(outputPage) != address(0)) revert AlreadyConfigured();
        if (
            page.code.length == 0 ||
            WorkingStatePage(page).writer() != address(this)
        ) revert InvalidConfiguration();
        outputPage = WorkingStatePage(page);
        outputPageCodeHash = page.codehash;
        configurationHash = keccak256(
            abi.encode(coreConfigurationHash, page, outputPageCodeHash)
        );
    }
    function createSnapshotPage(
        address writer
    ) external returns (address page) {
        if (msg.sender != owner) revert Unauthorized();
        page = address(new WorkingStatePage(writer));
        isSnapshotPage[page] = true;
        emit SnapshotPageCreated(page, writer);
    }
    function registerRun(
        bytes32 protocolId,
        Registration calldata input
    ) external returns (uint256 id) {
        if (msg.sender != owner) revert Unauthorized();
        _positive(input.alpha);
        if (
            input.maxMode == 0 ||
            input.maxMode > MAX_MODE ||
            !isSnapshotPage[input.sourcePage] ||
            input.positionStride < 3
        ) revert InvalidInput();
        bytes32 manifest = _dependencies(protocolId);
        id = nextRunId++;
        Run storage r = runs[id];
        r.input = input;
        r.protocolId = protocolId;
        PeriodicDataset data = PeriodicDataset(modules.dataset);
        r.datasetCommitment = data.assertDataset(input.datasetId);
        (, , r.atomCount, , , , r.pairCount) = data.datasetInfo(
            input.datasetId
        );
        if (
            r.atomCount < 2 ||
            r.atomCount > MAX_ATOMS ||
            r.pairCount != (uint256(r.atomCount) * (r.atomCount - 1)) / 2
        ) revert InvalidInput();
        (r.box, , r.cutoff, r.prefactor, r.exceptionCount) = data.periodicInfo(
            input.datasetId
        );
        OrthorhombicGeometry(modules.geometry).validateBox(r.box, r.cutoff);
        if (r.exceptionCount > 4096 || r.exceptionCount > r.pairCount)
            revert InvalidInput();
        int32 extent = int32(input.maxMode);
        EwaldReciprocalKernel(modules.reciprocal).waveVector(
            [extent, extent, extent],
            r.box,
            input.alpha,
            r.prefactor
        );
        FloatMath m = FloatMath(modules.math);
        if (m.compare(m.mul(input.alpha, r.cutoff), m.fromUInt(16)) > 0)
            revert InvalidInput();
        (uint32 capacity, bool isSealed) = WorkingStatePage(input.sourcePage)
            .namespaceInfo(input.sourceNamespace);
        if (!isSealed) revert SnapshotNotFrozen();
        if (
            uint256(input.positionOffset) +
                uint256(r.atomCount - 1) * input.positionStride +
                3 >
            capacity
        ) revert InvalidInput();
        r.sourceCodeHash = input.sourcePage.codehash;
        r.sourceWriter = WorkingStatePage(input.sourcePage).writer();
        r.sourceWriterCodeHash = r.sourceWriter.codehash;
        r.modeCount = modeCount(input.maxMode);
        r.status = Status.Loading;
        r.namespace = keccak256(
            abi.encode(
                bytes32("ORVIA-EWALD-STATE-v1"),
                block.chainid,
                address(this),
                id
            )
        );
        bytes32 snapshot = keccak256(
            abi.encode(
                input,
                r.sourceCodeHash,
                r.sourceWriter,
                r.sourceWriterCodeHash
            )
        );
        r.commitment = keccak256(
            abi.encode(
                bytes32("ORVIA-EWALD-RUN-v1"),
                block.chainid,
                address(this),
                id,
                manifest,
                r.datasetCommitment,
                configurationHash,
                snapshot
            )
        );
        outputPage.createNamespace(r.namespace, r.atomCount * 3 + 6);
        emit RunRegistered(id, r.commitment, r.namespace);
    }
    function advance(
        uint256 id,
        uint256 workLimit
    ) external returns (uint256 processed, bool completed) {
        if (workLimit == 0 || workLimit > MAX_WORK) revert InvalidWork();
        Run storage r = _get(id);
        if (r.status == Status.Completed) revert AlreadyCompleted();
        _dependencies(r.protocolId);
        _snapshot(r);
        if (
            PeriodicDataset(modules.dataset).assertDataset(r.input.datasetId) !=
            r.datasetCommitment
        ) revert DatasetChanged();
        while (processed < workLimit && r.status != Status.Completed) {
            _one(id, r);
            ++processed;
        }
        completed = r.status == Status.Completed;
        emit Advanced(id, processed, r.status, r.cursor, r.modeIndex);
    }
    function runInfo(
        uint256 id
    )
        external
        view
        returns (
            Status status,
            uint32 cursor,
            uint32 modeIndex,
            uint32 atomCount,
            uint32 modes,
            bytes32 stateNamespace,
            bytes32 commitment
        )
    {
        Run storage r = _get(id);
        return (
            r.status,
            r.cursor,
            r.modeIndex,
            r.atomCount,
            r.modeCount,
            r.namespace,
            r.commitment
        );
    }
    function moduleConfiguration() external view returns (Modules memory) {
        return modules;
    }
    function parameters(
        uint256 id
    ) external view returns (Registration memory) {
        return _get(id).input;
    }
    function forceAt(
        uint256 id,
        uint256 atom
    ) external view returns (bytes16[3] memory force) {
        Run storage r = _get(id);
        if (r.status != Status.Completed) revert NotCompleted();
        if (atom >= r.atomCount) revert InvalidInput();
        for (uint256 d; d < 3; ++d)
            force[d] = _decode(outputPage.readWord(r.namespace, atom * 3 + d));
    }
    /// @return values [total, real, reciprocal, self, background, exceptions].
    function energies(
        uint256 id
    ) external view returns (bytes16[6] memory values) {
        Run storage r = _get(id);
        if (r.status != Status.Completed) revert NotCompleted();
        for (uint256 i; i < 6; ++i)
            values[i] = _decode(
                outputPage.readWord(r.namespace, uint256(r.atomCount) * 3 + i)
            );
    }
    function modeCount(uint32 extent) public pure returns (uint32) {
        if (extent == 0 || extent > MAX_MODE) revert InvalidInput();
        uint32 width = extent * 2 + 1;
        return extent * (1 + width + width * width);
    }
    function modeAt(
        uint32 index,
        uint32 extent
    ) public pure returns (int32[3] memory mode) {
        if (index >= modeCount(extent)) revert InvalidInput();
        uint32 width = extent * 2 + 1;
        if (index < extent) {
            mode[2] = int32(index + 1);
            return mode;
        }
        index -= extent;
        if (index < extent * width) {
            mode[1] = int32(index / width + 1);
            mode[2] = int32(index % width) - int32(extent);
            return mode;
        }
        index -= extent * width;
        mode[0] = int32(index / (width * width) + 1);
        mode[1] = int32((index / width) % width) - int32(extent);
        mode[2] = int32(index % width) - int32(extent);
    }
    function _one(uint256 id, Run storage r) private {
        if (r.status == Status.Loading) {
            _position(r, r.cursor);
            bytes16 q = _charge(r, r.cursor);
            FloatMath m = FloatMath(modules.math);
            r.totalCharge = m.add(r.totalCharge, q);
            _energy(
                r,
                2,
                EwaldCorrections(modules.corrections).selfEnergy(
                    q,
                    r.input.alpha,
                    r.prefactor
                )
            );
            if (++r.cursor == r.atomCount) {
                r.cursor = 0;
                r.status = r.exceptionCount == 0
                    ? Status.RealPairs
                    : Status.ValidatingExceptions;
            }
        } else if (r.status == Status.ValidatingExceptions) {
            PairException memory p = _exception(r, r.cursor);
            uint32 key = p.a * r.atomCount + p.b;
            if (r.cursor != 0 && key <= r.lastExceptionKey)
                revert InvalidInput();
            r.lastExceptionKey = key;
            exceptionIndices[id][key] = r.cursor + 1;
            if (++r.cursor == r.exceptionCount) {
                r.cursor = 0;
                r.status = Status.RealPairs;
            }
        } else if (r.status == Status.RealPairs) {
            (uint32 a, uint32 b) = _pairIndices(r.cursor, r.atomCount);
            if (exceptionIndices[id][uint256(a) * r.atomCount + b] == 0)
                _realPair(r, a, b);
            if (++r.cursor == r.pairCount) {
                r.cursor = 0;
                r.status = r.exceptionCount == 0
                    ? Status.ModeSetup
                    : Status.Exceptions;
            }
        } else if (r.status == Status.Exceptions) {
            _exceptionPair(r, _exception(r, r.cursor));
            if (++r.cursor == r.exceptionCount) {
                r.cursor = 0;
                r.status = Status.ModeSetup;
            }
        } else if (r.status == Status.ModeSetup) {
            r.mode = modeAt(r.modeIndex, r.input.maxMode);
            (r.wave, r.coefficient) = EwaldReciprocalKernel(modules.reciprocal)
                .waveVector(r.mode, r.box, r.input.alpha, r.prefactor);
            r.totalCosine = bytes16(0);
            r.totalSine = bytes16(0);
            r.cursor = 0;
            r.status = Status.StructureFactor;
        } else if (r.status == Status.StructureFactor) {
            (bytes16 c, bytes16 s) = _term(r, r.cursor);
            FloatMath m = FloatMath(modules.math);
            r.totalCosine = m.add(r.totalCosine, c);
            r.totalSine = m.add(r.totalSine, s);
            if (++r.cursor == r.atomCount) {
                _energy(
                    r,
                    1,
                    EwaldReciprocalKernel(modules.reciprocal).modeEnergy(
                        r.coefficient,
                        r.totalCosine,
                        r.totalSine
                    )
                );
                r.cursor = 0;
                r.status = Status.ModeForces;
            }
        } else if (r.status == Status.ModeForces) {
            (bytes16 c, bytes16 s) = _term(r, r.cursor);
            bytes16[3] memory force = EwaldReciprocalKernel(modules.reciprocal)
                .forceContribution(
                    r.wave,
                    r.coefficient,
                    c,
                    s,
                    r.totalCosine,
                    r.totalSine
                );
            _force(r, r.cursor, force, false);
            if (++r.cursor == r.atomCount) {
                r.cursor = 0;
                ++r.modeIndex;
                r.status = r.modeIndex == r.modeCount
                    ? Status.Background
                    : Status.ModeSetup;
            }
        } else if (r.status == Status.Background) {
            _energy(
                r,
                3,
                EwaldCorrections(modules.corrections).backgroundEnergy(
                    r.totalCharge,
                    r.box,
                    r.input.alpha,
                    r.prefactor
                )
            );
            outputPage.sealNamespace(r.namespace);
            r.status = Status.Completed;
        } else revert InvalidInput();
    }
    function _realPair(Run storage r, uint32 a, uint32 b) private {
        bytes16 product = FloatMath(modules.math).mul(
            _charge(r, a),
            _charge(r, b)
        );
        (bytes16 energy, bytes16[3] memory force) = EwaldRealSpaceKernel(
            modules.realSpace
        ).evaluate(
                _displacement(r, a, b),
                product,
                r.prefactor,
                r.input.alpha,
                r.cutoff
            );
        _energy(r, 0, energy);
        _force(r, a, force, false);
        _force(r, b, force, true);
    }
    function _exceptionPair(Run storage r, PairException memory p) private {
        bytes16[3] memory d = _displacement(r, p.a, p.b);
        FloatMath m = FloatMath(modules.math);
        for (uint256 axis; axis < 3; ++axis)
            if (
                m.compare(m.abs(d[axis]), m.div(r.box[axis], m.fromUInt(2))) ==
                0
            ) revert InvalidInput();
        bytes16 product = m.mul(_charge(r, p.a), _charge(r, p.b));
        (bytes16 energy, bytes16[3] memory force) = EwaldCorrections(
            modules.corrections
        ).exception(d, product, p.desired, r.prefactor, r.input.alpha);
        _energy(r, 4, energy);
        _force(r, p.a, force, false);
        _force(r, p.b, force, true);
    }
    function _term(
        Run storage r,
        uint256 atom
    ) private view returns (bytes16, bytes16) {
        return
            EwaldReciprocalKernel(modules.reciprocal).structureFactorTerm(
                _position(r, atom),
                _charge(r, atom),
                r.mode,
                r.box
            );
    }
    function _position(
        Run storage r,
        uint256 atom
    ) private view returns (bytes16[3] memory p) {
        uint256 offset = uint256(r.input.positionOffset) +
            atom * r.input.positionStride;
        for (uint256 axis; axis < 3; ++axis)
            p[axis] = _decode(
                WorkingStatePage(r.input.sourcePage).readWord(
                    r.input.sourceNamespace,
                    offset + axis
                )
            );
    }
    function _displacement(
        Run storage r,
        uint256 a,
        uint256 b
    ) private view returns (bytes16[3] memory) {
        return
            OrthorhombicGeometry(modules.geometry).displacement(
                _position(r, a),
                _position(r, b),
                r.box
            );
    }
    function _charge(
        Run storage r,
        uint256 atom
    ) private view returns (bytes16) {
        return
            _decode(
                PeriodicDataset(modules.dataset).readNonbondedWord(
                    r.input.datasetId,
                    atom * 3 + 2
                )
            );
    }
    function _exception(
        Run storage r,
        uint256 index
    ) private view returns (PairException memory p) {
        PeriodicDataset data = PeriodicDataset(modules.dataset);
        uint256 start = index * 6;
        uint256 a = uint256(data.readExceptionWord(r.input.datasetId, start));
        uint256 b = uint256(
            data.readExceptionWord(r.input.datasetId, start + 1)
        );
        uint256 kind = uint256(
            data.readExceptionWord(r.input.datasetId, start + 2)
        );
        if (a >= b || b >= r.atomCount || kind < 1 || kind > 2)
            revert InvalidInput();
        p.a = uint32(a);
        p.b = uint32(b);
        p.kind = uint32(kind);
        bytes16 sigma = _decode(
            data.readExceptionWord(r.input.datasetId, start + 3)
        );
        bytes16 epsilon = _decode(
            data.readExceptionWord(r.input.datasetId, start + 4)
        );
        p.desired = _decode(
            data.readExceptionWord(r.input.datasetId, start + 5)
        );
        if (kind == 1) {
            if (
                sigma != bytes16(0) ||
                epsilon != bytes16(0) ||
                p.desired != bytes16(0)
            ) revert InvalidInput();
        } else {
            _positive(sigma);
            if (FloatMath(modules.math).compare(epsilon, bytes16(0)) < 0)
                revert InvalidInput();
        }
    }
    function _force(
        Run storage r,
        uint256 atom,
        bytes16[3] memory force,
        bool negative
    ) private {
        FloatMath m = FloatMath(modules.math);
        bytes32[] memory words = new bytes32[](3);
        for (uint256 axis; axis < 3; ++axis) {
            bytes16 old = _decode(
                outputPage.readWord(r.namespace, atom * 3 + axis)
            );
            words[axis] = _encode(
                negative ? m.sub(old, force[axis]) : m.add(old, force[axis])
            );
        }
        outputPage.writeWords(r.namespace, atom * 3, words);
    }
    function _energy(Run storage r, uint256 component, bytes16 value) private {
        uint256 start = uint256(r.atomCount) * 3;
        FloatMath m = FloatMath(modules.math);
        outputPage.writeWord(
            r.namespace,
            start,
            _encode(
                m.add(_decode(outputPage.readWord(r.namespace, start)), value)
            )
        );
        outputPage.writeWord(
            r.namespace,
            start + 1 + component,
            _encode(
                m.add(
                    _decode(
                        outputPage.readWord(r.namespace, start + 1 + component)
                    ),
                    value
                )
            )
        );
    }
    function _snapshot(Run storage r) private view {
        if (
            r.input.sourcePage.codehash != r.sourceCodeHash ||
            r.sourceWriter.codehash != r.sourceWriterCodeHash
        ) revert DependencyChanged();
        (, bool isSealed) = WorkingStatePage(r.input.sourcePage).namespaceInfo(
            r.input.sourceNamespace
        );
        if (!isSealed) revert SnapshotNotFrozen();
    }
    function _dependencies(bytes32 protocolId) private view returns (bytes32) {
        if (address(outputPage) == address(0)) revert NotConfigured();
        address[9] memory addresses = _addresses(modules);
        ExperimentRegistry registry = ExperimentRegistry(modules.registry);
        bytes32 manifest = registry.assertProtocol(protocolId);
        for (uint256 i; i < 9; ++i) {
            if (addresses[i].codehash != moduleCodeHashes[i])
                revert DependencyChanged();
            if (i != 0)
                registry.assertModule(
                    protocolId,
                    addresses[i],
                    moduleCodeHashes[i]
                );
        }
        if (address(outputPage).codehash != outputPageCodeHash)
            revert DependencyChanged();
        registry.assertModule(
            protocolId,
            address(outputPage),
            outputPageCodeHash
        );
        registry.assertModule(
            protocolId,
            address(this),
            address(this).codehash
        );
        return manifest;
    }
    function _addresses(
        Modules memory m
    ) private pure returns (address[9] memory) {
        return
            [
                m.registry,
                m.dataset,
                m.math,
                m.scalar,
                m.elementary,
                m.geometry,
                m.realSpace,
                m.reciprocal,
                m.corrections
            ];
    }
    function _pairIndices(
        uint256 index,
        uint256 count
    ) private pure returns (uint32 a, uint32 b) {
        uint256 low;
        uint256 high = count - 1;
        while (low + 1 < high) {
            uint256 mid = (low + high) / 2;
            if ((mid * (2 * count - mid - 1)) / 2 <= index) low = mid;
            else high = mid;
        }
        a = uint32(low);
        b = uint32(low + 1 + index - (low * (2 * count - low - 1)) / 2);
    }
    function _get(uint256 id) private view returns (Run storage r) {
        r = runs[id];
        if (r.status == Status.Missing) revert UnknownRun();
    }
    function _decode(bytes32 word) private pure returns (bytes16 value) {
        if (uint256(word) >> 128 != 0) revert InvalidInput();
        value = bytes16(uint128(uint256(word)));
        if (((uint128(value) >> 112) & 0x7fff) == 0x7fff) revert InvalidInput();
    }
    function _encode(bytes16 value) private pure returns (bytes32) {
        if (((uint128(value) >> 112) & 0x7fff) == 0x7fff) revert InvalidInput();
        return bytes32(uint256(uint128(value)));
    }
    function _positive(bytes16 value) private view {
        if (
            !FloatMath(modules.math).isFinite(value) ||
            FloatMath(modules.math).compare(value, bytes16(0)) <= 0
        ) revert InvalidInput();
    }
}
