// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DataPage} from "./DataPage.sol";

/// @notice Append-and-seal input streams with constant-address page lookup.
/// @dev A stream descriptor binds every page in canonical order. assertStream
///      checks descriptor sealing; every actual read authenticates touched pages.
contract PartitionedInputCatalog {
    error Unauthorized();
    error InvalidConfiguration();
    error StreamExists();
    error UnknownStream();
    error StreamSealed();
    error IncompleteStream();
    error InvalidPage();
    error PageAlreadyUsed();
    error PageChanged();
    error InvalidRead();

    uint256 public constant PAGE_WORDS = 4096;
    uint256 public constant MAX_BATCH_WORDS = 128;
    address public immutable owner;
    struct PageRecord { address page; bytes32 codeHash; bytes32 digest; uint32 wordCount; }
    struct Stream {
        bytes32 role;
        uint64 totalWords;
        uint64 appendedWords;
        uint64 pageCount;
        bool isSealed;
        bool exists;
        bytes32 rollingDigest;
        bytes32 commitment;
        mapping(uint256 => PageRecord) pages;
    }
    mapping(bytes32 => Stream) private _streams;
    mapping(address => bool) public isCatalogPage;
    mapping(address => bool) public pageUsed;
    event PageCreated(address indexed page, bytes32 indexed role, uint32 capacityWords);
    event StreamBegun(bytes32 indexed stream, bytes32 indexed role, uint64 totalWords);
    event PageAppended(bytes32 indexed stream, uint64 indexed pageIndex, address page, bytes32 digest);
    event StreamFrozen(bytes32 indexed stream, bytes32 commitment, uint64 totalWords);

    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidConfiguration();
        owner = owner_;
    }
    function createPage(bytes32 role, uint32 capacityWords) external onlyOwner returns (address page) {
        page = address(new DataPage(owner, role, capacityWords));
        isCatalogPage[page] = true;
        emit PageCreated(page, role, capacityWords);
    }
    function beginStream(bytes32 id, bytes32 role, uint64 totalWords) external onlyOwner {
        if (id == bytes32(0) || role == bytes32(0)) revert InvalidConfiguration();
        if (_streams[id].exists) revert StreamExists();
        Stream storage s = _streams[id];
        s.role = role; s.totalWords = totalWords; s.exists = true;
        s.rollingDigest = keccak256(abi.encode(bytes32("ORVIA-PARTITIONED-INPUT-v1"),
            block.chainid, address(this), id, role, totalWords));
        emit StreamBegun(id, role, totalWords);
    }
    function appendPage(bytes32 id, address page) external onlyOwner {
        Stream storage s = _get(id);
        if (s.isSealed) revert StreamSealed();
        if (!isCatalogPage[page] || page.code.length == 0) revert InvalidPage();
        if (pageUsed[page]) revert PageAlreadyUsed();
        uint256 remaining = uint256(s.totalWords) - s.appendedWords;
        uint256 expected = remaining > PAGE_WORDS ? PAGE_WORDS : remaining;
        DataPage p = DataPage(page);
        if (expected == 0 || !p.isSealed() || p.role() != s.role ||
            p.wordCount() != expected || p.capacityWords() != expected) revert InvalidPage();
        PageRecord memory record = PageRecord(page, page.codehash, p.rollingDigest(), uint32(expected));
        s.pages[s.pageCount] = record; pageUsed[page] = true;
        s.rollingDigest = keccak256(abi.encode(s.rollingDigest, s.pageCount,
            record.page, record.codeHash, record.wordCount, record.digest));
        emit PageAppended(id, s.pageCount, page, record.digest);
        ++s.pageCount; s.appendedWords += uint64(expected);
    }
    function sealStream(bytes32 id) external onlyOwner returns (bytes32 commitment) {
        Stream storage s = _get(id);
        if (s.isSealed) revert StreamSealed();
        if (s.appendedWords != s.totalWords) revert IncompleteStream();
        commitment = keccak256(abi.encode(bytes32("ORVIA-SEALED-INPUT-v1"),
            block.chainid, address(this), id, s.role, s.totalWords, s.pageCount, s.rollingDigest));
        s.commitment = commitment; s.isSealed = true;
        emit StreamFrozen(id, commitment, s.totalWords);
    }
    function assertStream(bytes32 id) external view returns (bytes32 commitment, uint64 wordCount) {
        Stream storage s = _sealed(id); return (s.commitment, s.totalWords);
    }
    function readWord(bytes32 id, uint64 index) external view returns (bytes32) {
        Stream storage s = _sealed(id);
        if (index >= s.totalWords) revert InvalidRead();
        PageRecord storage p = s.pages[uint256(index) / PAGE_WORDS]; _assertPage(p);
        return DataPage(p.page).readWord(uint256(index) % PAGE_WORDS);
    }
    function readWords(bytes32 id, uint64 start, uint32 count) external view returns (bytes32[] memory values) {
        Stream storage s = _sealed(id);
        if (count > MAX_BATCH_WORDS || start > s.totalWords || count > s.totalWords - start) revert InvalidRead();
        values = new bytes32[](count);
        uint256 done;
        while (done < count) {
            uint256 index = uint256(start) + done;
            uint256 local = index % PAGE_WORDS;
            uint256 length = uint256(count) - done;
            if (length > PAGE_WORDS - local) length = PAGE_WORDS - local;
            PageRecord storage p = s.pages[index / PAGE_WORDS]; _assertPage(p);
            bytes32[] memory words = DataPage(p.page).readWords(local, length);
            for (uint256 i; i < length; ++i) values[done + i] = words[i];
            done += length;
        }
    }
    function streamInfo(bytes32 id) external view returns (
        bytes32 role, uint64 totalWords, uint64 appendedWords, uint64 pageCount, bool isSealed, bytes32 commitment
    ) {
        Stream storage s = _get(id);
        return (s.role, s.totalWords, s.appendedWords, s.pageCount, s.isSealed, s.commitment);
    }
    function pageInfo(bytes32 id, uint64 pageIndex) external view returns (
        address page, bytes32 codeHash, bytes32 digest, uint32 wordCount
    ) {
        Stream storage s = _get(id); if (pageIndex >= s.pageCount) revert InvalidRead();
        PageRecord storage p = s.pages[pageIndex]; return (p.page, p.codeHash, p.digest, p.wordCount);
    }
    function _assertPage(PageRecord storage p) private view {
        if (p.page.codehash != p.codeHash || p.page.code.length == 0) revert PageChanged();
        DataPage page = DataPage(p.page);
        if (!page.isSealed() || page.rollingDigest() != p.digest || page.wordCount() != p.wordCount)
            revert PageChanged();
    }
    function _get(bytes32 id) private view returns (Stream storage s) {
        s = _streams[id]; if (!s.exists) revert UnknownStream();
    }
    function _sealed(bytes32 id) private view returns (Stream storage s) {
        s = _get(id); if (!s.isSealed) revert IncompleteStream();
    }
}
