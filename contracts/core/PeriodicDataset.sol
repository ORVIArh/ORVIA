// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DataPage} from "./DataPage.sol";
import {DynamicsDataset} from "./DynamicsDataset.sol";

/// @notice Frozen periodic configuration and nonbonded inputs, layered over dynamics data.
/// @dev Stream values are schema-checked when read. Numerical particle/exception
///      validity and sorted canonical exception pairs are checked by the coordinator.
contract PeriodicDataset {
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidRole();
    error InvalidDataset();
    error AlreadyRegistered();
    error UnknownDataset();
    error InvalidPageList();
    error DuplicatePage(address page);
    error UntrustedPage(address page);
    error InvalidPage(address page);
    error PageChanged(address page);
    error DynamicsCatalogChanged();
    error DynamicsDatasetChanged();
    error InvalidCoverage();
    error InvalidRead();
    error NoncanonicalWord();

    bytes32 public constant NONBONDED_ROLE = keccak256("ORVIA.NONBONDED.v1");
    bytes32 public constant EXCEPTION_ROLE = keccak256("ORVIA.EXCEPTIONS.v1");
    bytes32 public constant DATASET_DOMAIN = keccak256("ORVIA.PERIODIC.DATASET.v1");
    uint256 public constant MAX_PAGES_PER_STREAM = 16;
    uint32 public constant MAX_EXCEPTIONS = 4096;
    address public immutable owner;
    DynamicsDataset public immutable dynamicsCatalog;
    bytes32 public immutable dynamicsCatalogCodeHash;

    struct PageRecord { address page; bytes32 codeHash; bytes32 digest; uint32 wordCount; }
    struct Registration {
        bytes32 dynamicsDatasetId;
        address[] nonbondedPages;
        address[] exceptionPages;
        uint32 exceptionCount;
        bytes16[3] box;
        bytes16 switchDistance;
        bytes16 cutoff;
        bytes16 prefactor;
    }
    struct Dataset {
        bytes32 commitment;
        bytes32 dynamicsDatasetId;
        bytes32 dynamicsCommitment;
        // atoms, bonds, angles, torsions, exceptions
        uint32[5] counts;
        bytes16[3] box;
        bytes16 switchDistance;
        bytes16 cutoff;
        bytes16 prefactor;
        bytes32[2] streamCommitments;
        bool exists;
        PageRecord[][2] streams;
        mapping(address => bool) usedPages;
    }
    mapping(address => bool) public isCatalogPage;
    mapping(bytes32 => Dataset) private _datasets;

    event PageCreated(address indexed page, bytes32 indexed role, uint32 capacityWords);
    event DatasetRegistered(bytes32 indexed datasetId, bytes32 indexed dynamicsDatasetId, bytes32 commitment);

    constructor(address owner_, address dynamicsCatalog_) {
        if (owner_ == address(0) || dynamicsCatalog_.code.length == 0) revert InvalidConfiguration();
        owner = owner_;
        dynamicsCatalog = DynamicsDataset(dynamicsCatalog_);
        dynamicsCatalogCodeHash = dynamicsCatalog_.codehash;
    }

    function createPage(bytes32 role, uint32 capacityWords) external returns (address page) {
        if (msg.sender != owner) revert Unauthorized();
        if (role != NONBONDED_ROLE && role != EXCEPTION_ROLE) revert InvalidRole();
        page = address(new DataPage(owner, role, capacityWords));
        isCatalogPage[page] = true;
        emit PageCreated(page, role, capacityWords);
    }

    function registerDataset(bytes32 id, Registration calldata input) external returns (bytes32 commitment) {
        if (msg.sender != owner) revert Unauthorized();
        _begin(id, input);
        _freezeStream(id, 0, input.nonbondedPages);
        _freezeStream(id, 1, input.exceptionPages);
        commitment = _finish(id);
    }

    function datasetInfo(bytes32 id) external view returns (
        bytes32 commitment, bytes32 dynamicsDatasetId, uint32 atomCount, uint32 bondCount,
        uint32 angleCount, uint32 torsionCount, uint32 pairCount
    ) {
        Dataset storage d = _get(id);
        uint32 n = d.counts[0];
        return (d.commitment, d.dynamicsDatasetId, n, d.counts[1], d.counts[2], d.counts[3], n * (n - 1) / 2);
    }

    function periodicInfo(bytes32 id) external view returns (
        bytes16[3] memory box, bytes16 switchDistance, bytes16 cutoff, bytes16 prefactor, uint32 exceptionCount
    ) {
        Dataset storage d = _get(id);
        return (d.box, d.switchDistance, d.cutoff, d.prefactor, d.counts[4]);
    }

    function assertDataset(bytes32 id) external view returns (bytes32 commitment) {
        Dataset storage d = _get(id);
        _assertDynamics(d);
        for (uint256 s; s < 2; ++s) {
            for (uint256 i; i < d.streams[s].length; ++i) _assertPage(d.streams[s][i]);
        }
        return d.commitment;
    }

    function readPositionWord(bytes32 id, uint256 index) external view returns (bytes32) {
        Dataset storage d = _get(id); _checkDynamicsCode();
        return dynamicsCatalog.readPositionWord(d.dynamicsDatasetId, index);
    }
    function readBondWord(bytes32 id, uint256 index) external view returns (bytes32) {
        Dataset storage d = _get(id); _checkDynamicsCode();
        return dynamicsCatalog.readBondWord(d.dynamicsDatasetId, index);
    }
    function readParticleWord(bytes32 id, uint256 index) external view returns (bytes32) {
        Dataset storage d = _get(id); _checkDynamicsCode();
        return dynamicsCatalog.readParticleWord(d.dynamicsDatasetId, index);
    }
    function readAngleWord(bytes32 id, uint256 index) external view returns (bytes32) {
        Dataset storage d = _get(id); _checkDynamicsCode();
        return dynamicsCatalog.readAngleWord(d.dynamicsDatasetId, index);
    }
    function readTorsionWord(bytes32 id, uint256 index) external view returns (bytes32) {
        Dataset storage d = _get(id); _checkDynamicsCode();
        return dynamicsCatalog.readTorsionWord(d.dynamicsDatasetId, index);
    }
    function readNonbondedWord(bytes32 id, uint256 index) external view returns (bytes32) { return _read(_get(id), 0, index); }
    function readExceptionWord(bytes32 id, uint256 index) external view returns (bytes32) { return _read(_get(id), 1, index); }

    function pageCount(bytes32 id, uint8 stream) external view returns (uint256) {
        if (stream > 1) revert InvalidRead();
        return _get(id).streams[stream].length;
    }
    function pageInfo(bytes32 id, uint8 stream, uint256 index)
        external view returns (address page, bytes32 codeHash, bytes32 digest, uint32 wordCount)
    {
        if (stream > 1) revert InvalidRead();
        PageRecord[] storage pages = _get(id).streams[stream];
        if (index >= pages.length) revert InvalidRead();
        PageRecord storage p = pages[index];
        return (p.page, p.codeHash, p.digest, p.wordCount);
    }

    function _begin(bytes32 id, Registration calldata input) private {
        if (id == bytes32(0) || input.exceptionCount > MAX_EXCEPTIONS) revert InvalidDataset();
        if (_datasets[id].exists) revert AlreadyRegistered();
        _checkConfiguration(input);
        _checkDynamicsCode();
        bytes32 frozen = dynamicsCatalog.assertDataset(input.dynamicsDatasetId);
        (bytes32 reported,, uint32 atoms, uint32 bonds, uint32 angles, uint32 torsions, uint32 pairs) =
            dynamicsCatalog.datasetInfo(input.dynamicsDatasetId);
        if (atoms < 2 || atoms > 4096 || bonds == 0 || pairs != 0 || reported != frozen) revert InvalidDataset();
        if (input.exceptionCount > uint256(atoms) * (atoms - 1) / 2) revert InvalidDataset();
        Dataset storage d = _datasets[id];
        d.dynamicsDatasetId = input.dynamicsDatasetId;
        d.dynamicsCommitment = frozen;
        d.counts = [atoms, bonds, angles, torsions, input.exceptionCount];
        d.box = input.box;
        d.switchDistance = input.switchDistance;
        d.cutoff = input.cutoff;
        d.prefactor = input.prefactor;
    }

    function _checkConfiguration(Registration calldata input) private pure {
        uint128 rs = uint128(input.switchDistance);
        uint128 rc = uint128(input.cutoff);
        if (!_positiveFinite(rs) || !_positiveFinite(rc) || rs >= rc) revert InvalidConfiguration();
        // 2*cutoff < box is equivalent to cutoff < box/2. Doubling a positive
        // binary128 value is exact, including subnormals, unless it overflows.
        uint128 exponent = rc >> 112;
        if (exponent == 0x7ffe) revert InvalidConfiguration();
        uint128 twiceCutoff = exponent == 0 ? rc << 1 : rc + (uint128(1) << 112);
        for (uint256 axis; axis < 3; ++axis) {
            uint128 length = uint128(input.box[axis]);
            if (!_positiveFinite(length) || twiceCutoff >= length) revert InvalidConfiguration();
        }
        uint128 p = uint128(input.prefactor);
        uint128 magnitude = p & 0x7fffffffffffffffffffffffffffffff;
        if ((magnitude >> 112) == 0x7fff || (p >> 127 != 0 && magnitude != 0)) revert InvalidConfiguration();
    }
    function _positiveFinite(uint128 bits) private pure returns (bool) {
        return bits != 0 && bits >> 127 == 0 && bits >> 112 != 0x7fff;
    }

    function _freezeStream(bytes32 id, uint8 stream, address[] calldata pages) private {
        Dataset storage d = _datasets[id];
        uint256 count = stream == 0 ? d.counts[0] : d.counts[4];
        if (pages.length > MAX_PAGES_PER_STREAM || (count == 0 ? pages.length != 0 : pages.length == 0)) revert InvalidPageList();
        bytes32 role = _role(stream);
        bytes32 digest = keccak256(abi.encode(role, pages.length));
        uint256 words;
        for (uint256 i; i < pages.length; ++i) {
            address page = pages[i];
            if (d.usedPages[page]) revert DuplicatePage(page);
            if (!isCatalogPage[page]) revert UntrustedPage(page);
            DataPage inputPage = DataPage(page);
            if (page.code.length == 0 || inputPage.role() != role || !inputPage.isSealed()) revert InvalidPage(page);
            uint256 size = inputPage.wordCount();
            if (size == 0 || size > inputPage.capacityWords()) revert InvalidPage(page);
            d.usedPages[page] = true;
            PageRecord memory p = PageRecord(page, page.codehash, inputPage.rollingDigest(), uint32(size));
            d.streams[stream].push(p);
            words += size;
            digest = keccak256(abi.encode(digest, i, p.page, p.codeHash, p.wordCount, p.digest));
        }
        if (words != count * _width(stream)) revert InvalidCoverage();
        d.streamCommitments[stream] = digest;
    }

    function _finish(bytes32 id) private returns (bytes32 commitment) {
        Dataset storage d = _datasets[id];
        bytes32 dynamicsHeader = keccak256(abi.encode(
            address(dynamicsCatalog), dynamicsCatalogCodeHash, d.dynamicsDatasetId, d.dynamicsCommitment, d.counts
        ));
        bytes32 configuration = keccak256(abi.encode(d.box, d.switchDistance, d.cutoff, d.prefactor));
        commitment = keccak256(abi.encode(DATASET_DOMAIN, block.chainid, address(this), id,
            dynamicsHeader, configuration, d.streamCommitments));
        d.commitment = commitment;
        d.exists = true;
        emit DatasetRegistered(id, d.dynamicsDatasetId, commitment);
    }

    function _read(Dataset storage d, uint8 stream, uint256 index) private view returns (bytes32 word) {
        uint256 width = _width(stream);
        uint256 count = stream == 0 ? d.counts[0] : d.counts[4];
        if (index >= count * width) revert InvalidRead();
        uint256 globalOffset = index % width;
        PageRecord[] storage pages = d.streams[stream];
        for (uint256 i; i < pages.length; ++i) {
            PageRecord storage p = pages[i];
            if (index < p.wordCount) {
                _assertPage(p);
                word = DataPage(p.page).readWord(index);
                uint256 bits = stream == 1 && globalOffset < 3 ? 32 : 128;
                if (uint256(word) >> bits != 0) revert NoncanonicalWord();
                return word;
            }
            index -= p.wordCount;
        }
        revert InvalidRead();
    }
    function _assertPage(PageRecord storage p) private view {
        if (p.page.code.length == 0 || p.page.codehash != p.codeHash) revert PageChanged(p.page);
        DataPage page = DataPage(p.page);
        if (!page.isSealed() || page.rollingDigest() != p.digest || page.wordCount() != p.wordCount) revert PageChanged(p.page);
    }
    function _checkDynamicsCode() private view {
        if (address(dynamicsCatalog).codehash != dynamicsCatalogCodeHash) revert DynamicsCatalogChanged();
    }
    function _assertDynamics(Dataset storage d) private view {
        _checkDynamicsCode();
        if (dynamicsCatalog.assertDataset(d.dynamicsDatasetId) != d.dynamicsCommitment) revert DynamicsDatasetChanged();
    }
    function _role(uint8 stream) private pure returns (bytes32) { return stream == 0 ? NONBONDED_ROLE : EXCEPTION_ROLE; }
    function _width(uint8 stream) private pure returns (uint256) { return stream == 0 ? 3 : 6; }
    function _get(bytes32 id) private view returns (Dataset storage d) {
        d = _datasets[id];
        if (!d.exists) revert UnknownDataset();
    }
}
