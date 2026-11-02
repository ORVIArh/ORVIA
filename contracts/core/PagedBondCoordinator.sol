// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ExperimentRegistry} from "./ExperimentRegistry.sol";
import {DatasetCatalog} from "./DatasetCatalog.sol";
import {WorkingStatePage} from "./WorkingStatePage.sol";
import {IOrviaFloatMath, IOrviaBondKernel} from "./ResumableBondEngine.sol";

/// @notice Paged, resumable harmonic-force validation component.
/// @dev All operands and outputs are on-chain. This is not a dynamics integrator.
contract PagedBondCoordinator {
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

    uint256 public constant MAX_WORK = 16;
    address public immutable owner;
    IOrviaFloatMath public immutable numericalMath;
    IOrviaBondKernel public immutable bondKernel;
    ExperimentRegistry public immutable registry;
    DatasetCatalog public immutable catalog;
    bytes32 public immutable mathCodeHash;
    bytes32 public immutable kernelCodeHash;
    bytes32 public immutable registryCodeHash;
    bytes32 public immutable catalogCodeHash;
    bytes32 public immutable coreConfigurationHash;
    WorkingStatePage public statePage;
    bytes32 public statePageCodeHash;
    bytes32 public configurationHash;
    uint256 public nextExperimentId = 1;

    enum Status { Missing, ValidatingAtoms, ValidatingBonds, Running, Completed }
    struct Run {
        bytes32 protocolId;
        bytes32 datasetId;
        bytes32 datasetCommitment;
        bytes32 commitment;
        bytes32 stateNamespace;
        uint32 cursor;
        uint32 atomCount;
        uint32 bondCount;
        Status status;
    }
    struct Bond { uint32 a; uint32 b; bytes16 k; bytes16 r0; }
    mapping(uint256 => Run) private _runs;

    event WorkingPageBound(address indexed page, bytes32 configurationHash);
    event ExperimentRegistered(uint256 indexed experimentId, bytes32 indexed datasetId, bytes32 commitment);
    event ExperimentAdvanced(uint256 indexed experimentId, uint256 processed, Status status, uint256 cursor);

    constructor(address owner_, address math_, address kernel_, address registry_, address catalog_) {
        if (owner_ == address(0) || math_.code.length == 0 || kernel_.code.length == 0 ||
            registry_.code.length == 0 || catalog_.code.length == 0) revert InvalidConfiguration();
        if (IOrviaBondKernel(kernel_).numericalMath() != math_) revert InvalidConfiguration();
        owner = owner_;
        numericalMath = IOrviaFloatMath(math_);
        bondKernel = IOrviaBondKernel(kernel_);
        registry = ExperimentRegistry(registry_);
        catalog = DatasetCatalog(catalog_);
        mathCodeHash = math_.codehash;
        kernelCodeHash = kernel_.codehash;
        registryCodeHash = registry_.codehash;
        catalogCodeHash = catalog_.codehash;
        coreConfigurationHash = keccak256(abi.encode(
            math_, math_.codehash, kernel_, kernel_.codehash,
            registry_, registry_.codehash, catalog_, catalog_.codehash
        ));
    }

    /// @notice Resolve the writer/page deployment dependency exactly once.
    function bindWorkingPage(address page) external {
        if (msg.sender != owner) revert Unauthorized();
        if (address(statePage) != address(0)) revert AlreadyConfigured();
        if (page.code.length == 0 || WorkingStatePage(page).writer() != address(this)) revert InvalidConfiguration();
        statePage = WorkingStatePage(page);
        statePageCodeHash = page.codehash;
        configurationHash = keccak256(abi.encode(coreConfigurationHash, page, page.codehash));
        emit WorkingPageBound(page, configurationHash);
    }

    /// @notice Bind a frozen dataset. Numerical validation is a resumable stage.
    function registerExperiment(bytes32 protocolId, bytes32 datasetId) external returns (uint256 experimentId) {
        if (msg.sender != owner) revert Unauthorized();
        bytes32 protocolManifest = _assertDependencies(protocolId);
        bytes32 datasetCommitment = catalog.assertDataset(datasetId);
        (, uint32 atomCount, uint32 bondCount) = catalog.datasetInfo(datasetId);
        // Defense in depth for the schema this component actually supports.
        if (atomCount < 2 || atomCount > 4096 || bondCount == 0 || bondCount > 16384) revert InvalidInput();
        experimentId = nextExperimentId++;
        Run storage run = _runs[experimentId];
        run.protocolId = protocolId;
        run.datasetId = datasetId;
        run.datasetCommitment = datasetCommitment;
        run.atomCount = atomCount;
        run.bondCount = bondCount;
        run.status = Status.ValidatingAtoms;
        run.stateNamespace = keccak256(abi.encode(bytes32("ORVIA-PAGED-STATE-v1"), block.chainid, address(this), experimentId));
        run.commitment = keccak256(abi.encode(
            bytes32("ORVIA-PAGED-BOND-v1"), block.chainid, address(this), experimentId,
            protocolManifest, datasetId, datasetCommitment, configurationHash, run.stateNamespace
        ));
        statePage.createNamespace(run.stateNamespace, atomCount * 3 + 1);
        emit ExperimentRegistered(experimentId, datasetId, run.commitment);
    }

    /// @notice Validate or calculate up to workLimit records, in a fixed order.
    /// @dev A revert rolls back both coordinator and working-page changes.
    function advanceExperiment(uint256 experimentId, uint256 workLimit)
        external returns (uint256 processed, bool completed)
    {
        if (workLimit == 0 || workLimit > MAX_WORK) revert InvalidWorkLimit();
        Run storage run = _get(experimentId);
        if (run.status == Status.Completed) revert ExperimentCompleted();
        _assertDependencies(run.protocolId);
        if (catalog.assertDataset(run.datasetId) != run.datasetCommitment) revert DatasetChanged();
        while (processed < workLimit && run.status != Status.Completed) {
            if (run.status == Status.ValidatingAtoms) {
                _readPosition(run.datasetId, run.cursor); // validates every finite coordinate
                if (++run.cursor == run.atomCount) { run.cursor = 0; run.status = Status.ValidatingBonds; }
            } else if (run.status == Status.ValidatingBonds) {
                _readBond(run, run.cursor); // validates indices and parameters before any forces
                if (++run.cursor == run.bondCount) { run.cursor = 0; run.status = Status.Running; }
            } else {
                _accumulate(run, run.cursor);
                if (++run.cursor == run.bondCount) {
                    statePage.sealNamespace(run.stateNamespace);
                    run.status = Status.Completed;
                }
            }
            ++processed;
        }
        completed = run.status == Status.Completed;
        emit ExperimentAdvanced(experimentId, processed, run.status, run.cursor);
    }

    function runInfo(uint256 experimentId) external view returns (
        bytes32 protocolId, bytes32 datasetId, bytes32 commitment, bytes32 stateNamespace,
        uint256 cursor, uint256 atomCount, uint256 bondCount, Status status, bytes16 totalEnergy
    ) {
        Run storage r = _get(experimentId);
        return (r.protocolId, r.datasetId, r.commitment, r.stateNamespace, r.cursor,
            r.atomCount, r.bondCount, r.status, _decodeFloat(statePage.readWord(r.stateNamespace, uint256(r.atomCount) * 3)));
    }

    function forceAt(uint256 experimentId, uint256 atom) external view returns (bytes16[3] memory value) {
        Run storage r = _get(experimentId);
        if (atom >= r.atomCount) revert InvalidInput();
        for (uint256 d; d < 3; ++d) value[d] = _decodeFloat(statePage.readWord(r.stateNamespace, 3 * atom + d));
    }

    function positionAt(uint256 experimentId, uint256 atom) external view returns (bytes16[3] memory) {
        Run storage r = _get(experimentId);
        if (atom >= r.atomCount) revert InvalidInput();
        return _readPosition(r.datasetId, atom);
    }

    function _accumulate(Run storage r, uint256 index) private {
        Bond memory b = _readBond(r, index);
        (bytes16 energy, bytes16[3] memory force) = bondKernel.evaluate(
            _readPosition(r.datasetId, b.a), _readPosition(r.datasetId, b.b), b.k, b.r0
        );
        _requireFinite(energy);
        uint256 energyIndex = uint256(r.atomCount) * 3;
        _addToWord(r.stateNamespace, energyIndex, energy, false);
        for (uint256 d; d < 3; ++d) {
            _requireFinite(force[d]);
            _addToWord(r.stateNamespace, uint256(b.a) * 3 + d, force[d], false);
            _addToWord(r.stateNamespace, uint256(b.b) * 3 + d, force[d], true);
        }
    }

    function _addToWord(bytes32 ns, uint256 index, bytes16 value, bool subtract) private {
        bytes16 previous = _decodeFloat(statePage.readWord(ns, index));
        bytes16 next = subtract ? numericalMath.sub(previous, value) : numericalMath.add(previous, value);
        _requireFinite(next);
        statePage.writeWord(ns, index, bytes32(uint256(uint128(next))));
    }

    function _readPosition(bytes32 datasetId, uint256 atom) private view returns (bytes16[3] memory p) {
        for (uint256 d; d < 3; ++d) p[d] = _decodeFloat(catalog.readPositionWord(datasetId, atom * 3 + d));
    }

    function _readBond(Run storage r, uint256 index) private view returns (Bond memory b) {
        uint256 start = index * 4;
        uint256 a = uint256(catalog.readBondWord(r.datasetId, start));
        uint256 other = uint256(catalog.readBondWord(r.datasetId, start + 1));
        if (a >= r.atomCount || other >= r.atomCount || a == other) revert InvalidInput();
        b.a = uint32(a);
        b.b = uint32(other);
        b.k = _decodeFloat(catalog.readBondWord(r.datasetId, start + 2));
        b.r0 = _decodeFloat(catalog.readBondWord(r.datasetId, start + 3));
        if (_negativeNonzero(b.k) || _negativeNonzero(b.r0)) revert InvalidInput();
    }

    function _assertDependencies(bytes32 protocolId) private view returns (bytes32 manifest) {
        if (address(statePage) == address(0)) revert NotConfigured();
        if (address(numericalMath).codehash != mathCodeHash || address(bondKernel).codehash != kernelCodeHash ||
            address(registry).codehash != registryCodeHash || address(catalog).codehash != catalogCodeHash ||
            address(statePage).codehash != statePageCodeHash) revert ModuleCodeChanged();
        manifest = registry.assertProtocol(protocolId);
        registry.assertModule(protocolId, address(numericalMath), mathCodeHash);
        registry.assertModule(protocolId, address(bondKernel), kernelCodeHash);
        registry.assertModule(protocolId, address(catalog), catalogCodeHash);
        registry.assertModule(protocolId, address(statePage), statePageCodeHash);
        registry.assertModule(protocolId, address(this), address(this).codehash);
    }

    function _get(uint256 experimentId) private view returns (Run storage r) {
        r = _runs[experimentId];
        if (r.status == Status.Missing) revert UnknownExperiment();
    }
    function _decodeFloat(bytes32 word) private pure returns (bytes16 value) {
        if (uint256(word) >> 128 != 0) revert InvalidInput();
        value = bytes16(uint128(uint256(word)));
        _requireFinite(value);
    }
    function _requireFinite(bytes16 value) private pure {
        if (((uint128(value) >> 112) & 0x7fff) == 0x7fff) revert NonFiniteNumber();
    }
    function _negativeNonzero(bytes16 value) private pure returns (bool) {
        uint128 bits = uint128(value);
        return (bits >> 127) != 0 && (bits & 0x7fffffffffffffffffffffffffffffff) != 0;
    }
}
