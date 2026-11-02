// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DataPage} from "./DataPage.sol";

/// @notice Immutable, readable datasets assembled from trusted sealed input pages.
/// @dev Numerical validity is checked by the consuming engine. This contract fixes
///      provenance, schema coverage, canonical word encodings, and page identity.
contract DatasetCatalog {
    error Unauthorized();
    error InvalidOwner();
    error InvalidRole();
    error InvalidDataset();
    error AlreadyRegistered();
    error UnknownDataset();
    error InvalidPageList();
    error DuplicatePage(address page);
    error UntrustedPage(address page);
    error InvalidPage(address page);
    error PageChanged(address page);
    error InvalidCoverage();
    error InvalidRead();
    error NoncanonicalWord();

    bytes32 public constant POSITION_ROLE = keccak256("ORVIA.POSITIONS.v1");
    bytes32 public constant BOND_ROLE = keccak256("ORVIA.BONDS.v1");
    bytes32 public constant DATASET_DOMAIN = keccak256("ORVIA.DATASET.v1");
    uint256 public constant MAX_PAGES_PER_STREAM = 16;
    uint32 public constant MAX_ATOMS = 4096;
    uint32 public constant MAX_BONDS = 16384;
    address public immutable owner;

    struct PageRecord {
        address page;
        bytes32 codeHash;
        bytes32 digest;
        uint32 wordCount;
    }

    struct Dataset {
        bytes32 commitment;
        uint32 atomCount;
        uint32 bondCount;
        bool exists;
        PageRecord[] positions;
        PageRecord[] bonds;
    }

    mapping(address => bool) public isCatalogPage;
    mapping(bytes32 => Dataset) private _datasets;

    event PageCreated(address indexed page, bytes32 indexed role, uint32 capacityWords);
    event DatasetRegistered(bytes32 indexed datasetId, bytes32 commitment, uint32 atomCount, uint32 bondCount);

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidOwner();
        owner = owner_;
    }

    /// @notice Create a page that the catalog owner can populate and seal directly.
    function createPage(bytes32 role, uint32 capacityWords) external returns (address page) {
        if (msg.sender != owner) revert Unauthorized();
        if (role != POSITION_ROLE && role != BOND_ROLE) revert InvalidRole();
        page = address(new DataPage(owner, role, capacityWords));
        isCatalogPage[page] = true;
        emit PageCreated(page, role, capacityWords);
    }

    function registerDataset(
        bytes32 id,
        address[] calldata positionPages,
        address[] calldata bondPages,
        uint32 atomCount,
        uint32 bondCount
    ) external returns (bytes32 commitment) {
        if (msg.sender != owner) revert Unauthorized();
        if (id == bytes32(0) || atomCount < 2 || atomCount > MAX_ATOMS || bondCount == 0 || bondCount > MAX_BONDS) {
            revert InvalidDataset();
        }
        if (_datasets[id].exists) revert AlreadyRegistered();
        _checkPageLists(positionPages, bondPages);

        Dataset storage dataset = _datasets[id];
        (bytes32 positionCommitment, uint256 positionWords) = _freezePages(positionPages, POSITION_ROLE, dataset.positions);
        (bytes32 bondCommitment, uint256 bondWords) = _freezePages(bondPages, BOND_ROLE, dataset.bonds);
        if (positionWords != uint256(atomCount) * 3 || bondWords != uint256(bondCount) * 4) revert InvalidCoverage();

        commitment = keccak256(abi.encode(
            DATASET_DOMAIN, block.chainid, address(this), id, atomCount, bondCount, positionCommitment, bondCommitment
        ));
        dataset.commitment = commitment;
        dataset.atomCount = atomCount;
        dataset.bondCount = bondCount;
        dataset.exists = true;
        emit DatasetRegistered(id, commitment, atomCount, bondCount);
    }

    function datasetInfo(bytes32 id) external view returns (bytes32 commitment, uint32 atomCount, uint32 bondCount) {
        Dataset storage dataset = _get(id);
        return (dataset.commitment, dataset.atomCount, dataset.bondCount);
    }

    /// @notice Check all frozen pages before accepting or advancing a dataset run.
    function assertDataset(bytes32 id) external view returns (bytes32 commitment) {
        Dataset storage dataset = _get(id);
        for (uint256 i; i < dataset.positions.length; ++i) _assertPage(dataset.positions[i]);
        for (uint256 i; i < dataset.bonds.length; ++i) _assertPage(dataset.bonds[i]);
        return dataset.commitment;
    }

    /// @notice Position index is flat x0,y0,z0,x1,y1,z1,...; payload is low 128 bits.
    function readPositionWord(bytes32 id, uint256 index) external view returns (bytes32 word) {
        Dataset storage dataset = _get(id);
        if (index >= uint256(dataset.atomCount) * 3) revert InvalidRead();
        word = _read(dataset.positions, index);
        if (uint256(word) >> 128 != 0) revert NoncanonicalWord();
    }

    /// @notice Bond index is flat a0,b0,k0,r0_0,a1,b1,k1,r0_1,... across pages.
    function readBondWord(bytes32 id, uint256 index) external view returns (bytes32 word) {
        Dataset storage dataset = _get(id);
        if (index >= uint256(dataset.bondCount) * 4) revert InvalidRead();
        word = _read(dataset.bonds, index);
        uint256 payloadBits = index % 4 < 2 ? 32 : 128;
        if (uint256(word) >> payloadBits != 0) revert NoncanonicalWord();
    }

    function pageCount(bytes32 id, bool bondStream) external view returns (uint256) {
        Dataset storage dataset = _get(id);
        return bondStream ? dataset.bonds.length : dataset.positions.length;
    }

    /// @notice Read frozen metadata; bondStream=false selects the position stream.
    function pageInfo(bytes32 id, bool bondStream, uint256 index)
        external view returns (address page, bytes32 codeHash, bytes32 digest, uint32 wordCount)
    {
        Dataset storage dataset = _get(id);
        PageRecord[] storage pages = bondStream ? dataset.bonds : dataset.positions;
        if (index >= pages.length) revert InvalidRead();
        PageRecord storage record = pages[index];
        return (record.page, record.codeHash, record.digest, record.wordCount);
    }

    function _checkPageLists(address[] calldata positions, address[] calldata bonds) private pure {
        if (positions.length == 0 || positions.length > MAX_PAGES_PER_STREAM || bonds.length == 0 || bonds.length > MAX_PAGES_PER_STREAM) {
            revert InvalidPageList();
        }
        for (uint256 i; i < positions.length; ++i) {
            for (uint256 j; j < i; ++j) {
                if (positions[i] == positions[j]) revert DuplicatePage(positions[i]);
            }
        }
        for (uint256 i; i < bonds.length; ++i) {
            for (uint256 j; j < i; ++j) {
                if (bonds[i] == bonds[j]) revert DuplicatePage(bonds[i]);
            }
            for (uint256 j; j < positions.length; ++j) {
                if (bonds[i] == positions[j]) revert DuplicatePage(bonds[i]);
            }
        }
    }

    function _freezePages(address[] calldata pages, bytes32 role, PageRecord[] storage records)
        private returns (bytes32 streamCommitment, uint256 totalWords)
    {
        streamCommitment = keccak256(abi.encode(role, pages.length));
        for (uint256 i; i < pages.length; ++i) {
            address page = pages[i];
            if (!isCatalogPage[page]) revert UntrustedPage(page);
            DataPage inputPage = DataPage(page);
            if (page.code.length == 0 || inputPage.role() != role || !inputPage.isSealed()) revert InvalidPage(page);
            uint256 words = inputPage.wordCount();
            if (words == 0 || words > inputPage.capacityWords()) revert InvalidPage(page);
            PageRecord memory record = PageRecord(page, page.codehash, inputPage.rollingDigest(), uint32(words));
            records.push(record);
            totalWords += words;
            streamCommitment = keccak256(abi.encode(
                streamCommitment, i, record.page, record.codeHash, record.wordCount, record.digest
            ));
        }
    }

    function _assertPage(PageRecord storage record) private view {
        address page = record.page;
        if (page.code.length == 0 || page.codehash != record.codeHash) revert PageChanged(page);
        DataPage inputPage = DataPage(page);
        if (!inputPage.isSealed() || inputPage.rollingDigest() != record.digest || inputPage.wordCount() != record.wordCount) {
            revert PageChanged(page);
        }
    }

    function _read(PageRecord[] storage pages, uint256 index) private view returns (bytes32) {
        for (uint256 i; i < pages.length; ++i) {
            PageRecord storage record = pages[i];
            if (index < record.wordCount) {
                _assertPage(record);
                return DataPage(record.page).readWord(index);
            }
            index -= record.wordCount;
        }
        revert InvalidRead();
    }

    function _get(bytes32 id) private view returns (Dataset storage dataset) {
        dataset = _datasets[id];
        if (!dataset.exists) revert UnknownDataset();
    }
}
