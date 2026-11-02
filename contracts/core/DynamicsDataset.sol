// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DataPage} from "./DataPage.sol";
import {DatasetCatalog} from "./DatasetCatalog.sol";

/// @notice Frozen paged mass, velocity and interaction inputs for dynamics fixtures.
/// @dev The base catalog owns initial positions/bonds. Numerical validity is the
///      consuming coordinator's responsibility; registration fixes schema/identity.
contract DynamicsDataset {
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
    error BaseCatalogChanged();
    error BaseDatasetChanged();
    error InvalidCoverage();
    error InvalidRead();
    error NoncanonicalWord();

    bytes32 public constant PARTICLE_ROLE = keccak256("ORVIA.PARTICLES.v1");
    bytes32 public constant ANGLE_ROLE = keccak256("ORVIA.ANGLES.v1");
    bytes32 public constant TORSION_ROLE = keccak256("ORVIA.TORSIONS.v1");
    bytes32 public constant PAIR_ROLE = keccak256("ORVIA.PAIRS.v1");
    bytes32 public constant DATASET_DOMAIN = keccak256("ORVIA.DYNAMICS.DATASET.v1");
    uint256 public constant MAX_PAGES_PER_STREAM = 16;
    uint32 public constant MAX_INTERACTIONS = 4096;
    address public immutable owner;
    DatasetCatalog public immutable baseCatalog;
    bytes32 public immutable baseCatalogCodeHash;

    struct PageRecord { address page; bytes32 codeHash; bytes32 digest; uint32 wordCount; }
    struct Registration {
        bytes32 baseDatasetId;
        address[] particlePages;
        address[] anglePages;
        address[] torsionPages;
        address[] pairPages;
        uint32 angleCount;
        uint32 torsionCount;
        uint32 pairCount;
    }
    struct Dataset {
        bytes32 commitment;
        bytes32 baseDatasetId;
        bytes32 baseCommitment;
        uint32 bondCount;
        // particles/atoms, angles, torsions, pairs in that order
        uint32[4] counts;
        bytes32[4] streamCommitments;
        bool exists;
        PageRecord[][4] streams;
        mapping(address => bool) usedPages;
    }
    mapping(address => bool) public isCatalogPage;
    mapping(bytes32 => Dataset) private _datasets;

    event PageCreated(address indexed page, bytes32 indexed role, uint32 capacityWords);
    event DatasetRegistered(bytes32 indexed datasetId, bytes32 indexed baseDatasetId, bytes32 commitment);

    constructor(address owner_, address baseCatalog_) {
        if (owner_ == address(0) || baseCatalog_.code.length == 0) revert InvalidConfiguration();
        owner = owner_;
        baseCatalog = DatasetCatalog(baseCatalog_);
        baseCatalogCodeHash = baseCatalog_.codehash;
    }

    function createPage(bytes32 role, uint32 capacityWords) external returns (address page) {
        if (msg.sender != owner) revert Unauthorized();
        if (role != PARTICLE_ROLE && role != ANGLE_ROLE && role != TORSION_ROLE && role != PAIR_ROLE) revert InvalidRole();
        page = address(new DataPage(owner, role, capacityWords));
        isCatalogPage[page] = true;
        emit PageCreated(page, role, capacityWords);
    }

    function registerDataset(bytes32 id, Registration calldata input) external returns (bytes32 commitment) {
        if (msg.sender != owner) revert Unauthorized();
        _begin(id, input.baseDatasetId, input.angleCount, input.torsionCount, input.pairCount);
        _freezeStream(id, 0, input.particlePages);
        _freezeStream(id, 1, input.anglePages);
        _freezeStream(id, 2, input.torsionPages);
        _freezeStream(id, 3, input.pairPages);
        commitment = _finish(id);
    }

    function datasetInfo(bytes32 id) external view returns (
        bytes32 commitment, bytes32 baseDatasetId, uint32 atomCount, uint32 bondCount,
        uint32 angleCount, uint32 torsionCount, uint32 pairCount
    ) {
        Dataset storage d = _get(id);
        return (d.commitment, d.baseDatasetId, d.counts[0], d.bondCount, d.counts[1], d.counts[2], d.counts[3]);
    }

    function assertDataset(bytes32 id) external view returns (bytes32 commitment) {
        Dataset storage d = _get(id);
        _assertBase(d);
        for (uint256 s; s < 4; ++s) {
            for (uint256 i; i < d.streams[s].length; ++i) _assertPage(d.streams[s][i]);
        }
        return d.commitment;
    }

    function readPositionWord(bytes32 id, uint256 index) external view returns (bytes32) {
        Dataset storage d = _get(id);
        _checkBaseCode();
        return baseCatalog.readPositionWord(d.baseDatasetId, index);
    }
    function readBondWord(bytes32 id, uint256 index) external view returns (bytes32) {
        Dataset storage d = _get(id);
        _checkBaseCode();
        return baseCatalog.readBondWord(d.baseDatasetId, index);
    }
    function readParticleWord(bytes32 id, uint256 index) external view returns (bytes32) { return _read(_get(id), 0, index); }
    function readAngleWord(bytes32 id, uint256 index) external view returns (bytes32) { return _read(_get(id), 1, index); }
    function readTorsionWord(bytes32 id, uint256 index) external view returns (bytes32) { return _read(_get(id), 2, index); }
    function readPairWord(bytes32 id, uint256 index) external view returns (bytes32) { return _read(_get(id), 3, index); }

    function pageCount(bytes32 id, uint8 stream) external view returns (uint256) {
        if (stream > 3) revert InvalidRead();
        return _get(id).streams[stream].length;
    }
    function pageInfo(bytes32 id, uint8 stream, uint256 index)
        external view returns (address page, bytes32 codeHash, bytes32 digest, uint32 wordCount)
    {
        if (stream > 3) revert InvalidRead();
        PageRecord[] storage pages = _get(id).streams[stream];
        if (index >= pages.length) revert InvalidRead();
        PageRecord storage p = pages[index];
        return (p.page, p.codeHash, p.digest, p.wordCount);
    }

    function _begin(bytes32 id, bytes32 baseId, uint32 angles, uint32 torsions, uint32 pairs) private {
        if (id == bytes32(0) || angles > MAX_INTERACTIONS || torsions > MAX_INTERACTIONS || pairs > MAX_INTERACTIONS) {
            revert InvalidDataset();
        }
        if (_datasets[id].exists) revert AlreadyRegistered();
        _checkBaseCode();
        bytes32 frozenBase = baseCatalog.assertDataset(baseId);
        (bytes32 reportedBase, uint32 atoms, uint32 bonds) = baseCatalog.datasetInfo(baseId);
        if (atoms < 2 || atoms > 4096 || bonds == 0 || reportedBase != frozenBase) revert InvalidDataset();
        Dataset storage d = _datasets[id];
        d.baseDatasetId = baseId;
        d.baseCommitment = frozenBase;
        d.bondCount = bonds;
        d.counts = [atoms, angles, torsions, pairs];
    }

    function _freezeStream(bytes32 id, uint8 stream, address[] calldata pages) private {
        Dataset storage d = _datasets[id];
        uint256 count = d.counts[stream];
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
        bytes32 baseHeader = keccak256(abi.encode(
            address(baseCatalog), baseCatalogCodeHash, d.baseDatasetId, d.baseCommitment, d.counts[0], d.bondCount
        ));
        commitment = keccak256(abi.encode(DATASET_DOMAIN, block.chainid, address(this), id,
            baseHeader, d.counts, d.streamCommitments));
        d.commitment = commitment;
        d.exists = true;
        emit DatasetRegistered(id, d.baseDatasetId, commitment);
    }

    function _read(Dataset storage d, uint8 stream, uint256 index) private view returns (bytes32 word) {
        uint256 width = _width(stream);
        if (index >= uint256(d.counts[stream]) * width) revert InvalidRead();
        uint256 globalOffset = index % width;
        PageRecord[] storage pages = d.streams[stream];
        for (uint256 i; i < pages.length; ++i) {
            PageRecord storage p = pages[i];
            if (index < p.wordCount) {
                _assertPage(p);
                word = DataPage(p.page).readWord(index);
                uint256 indexFields = stream == 0 ? 0 : stream == 1 ? 3 : stream == 2 ? 5 : 2;
                if (uint256(word) >> (globalOffset < indexFields ? 32 : 128) != 0) revert NoncanonicalWord();
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
    function _checkBaseCode() private view {
        if (address(baseCatalog).codehash != baseCatalogCodeHash) revert BaseCatalogChanged();
    }
    function _assertBase(Dataset storage d) private view {
        _checkBaseCode();
        if (baseCatalog.assertDataset(d.baseDatasetId) != d.baseCommitment) revert BaseDatasetChanged();
    }
    function _role(uint8 stream) private pure returns (bytes32) {
        if (stream == 0) return PARTICLE_ROLE;
        if (stream == 1) return ANGLE_ROLE;
        if (stream == 2) return TORSION_ROLE;
        return PAIR_ROLE;
    }
    function _width(uint8 stream) private pure returns (uint256) {
        if (stream == 0) return 4;
        if (stream == 1) return 5;
        if (stream == 2) return 7;
        return 6;
    }
    function _get(bytes32 id) private view returns (Dataset storage d) {
        d = _datasets[id];
        if (!d.exists) revert UnknownDataset();
    }
}
