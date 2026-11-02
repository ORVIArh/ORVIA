// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev One of the catalog's 96 permanent banks. Global indices are namespaced
///      by stream ID; neither another stream nor a later routing cycle aliases them.
contract InputWordBank {
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidRange();

    address public immutable router;
    bytes32 public immutable routerCodeHash;
    uint8 public immutable bankIndex;
    mapping(bytes32 => mapping(uint64 => bytes32)) private _words;

    constructor(address router_, uint8 bankIndex_) {
        if (router_ != msg.sender || router_.code.length == 0 || bankIndex_ >= 96)
            revert InvalidConfiguration();
        router = router_;
        routerCodeHash = router_.codehash;
        bankIndex = bankIndex_;
    }

    function writeWords(bytes32 stream, uint64 start, bytes32[] calldata values) external {
        if (msg.sender != router || msg.sender.codehash != routerCodeHash) revert Unauthorized();
        _range(start, values.length);
        if (stream == bytes32(0)) revert InvalidRange();
        for (uint256 i; i < values.length; ++i) _words[stream][uint64(uint256(start) + i)] = values[i];
    }

    /// @dev Raw bank reads do not establish stream sealing or coverage. Consumers
    ///      must use the catalog's authenticated, sealed-stream read interface.
    function readWord(bytes32 stream, uint64 index) external view returns (bytes32) {
        _range(index, 1);
        return _words[stream][index];
    }

    function readWords(bytes32 stream, uint64 start, uint32 count) external view returns (bytes32[] memory values) {
        _range(start, count);
        values = new bytes32[](count);
        for (uint256 i; i < count; ++i) values[i] = _words[stream][uint64(uint256(start) + i)];
    }

    function _range(uint64 start, uint256 count) private view {
        if (count == 0 || count > 128 || uint256(start) + count - 1 > type(uint64).max
            || (uint256(start) / 4096) % 96 != bankIndex
            || count > 4096 - uint256(start) % 4096) revert InvalidRange();
    }
}

/// @notice Append-only input streams sharing exactly 96 permanent storage banks.
/// @dev Bank allocation is independent of model size and stream count. Storage
///      slots and gas still grow with words uploaded; 96 banks is not a size cap.
contract BankedInputCatalog {
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidBankBatch();
    error BanksIncomplete();
    error BankChanged();
    error StreamExists();
    error UnknownStream();
    error StreamSealed();
    error IncompleteStream();
    error InvalidBatch();
    error InvalidRead();

    uint256 public constant BANK_COUNT = 96;
    uint256 public constant MAX_BANKS_PER_CREATION = 4;
    uint256 public constant PAGE_WORDS = 4096;
    uint256 public constant MAX_BATCH_WORDS = 128;
    address public immutable owner;
    uint8 public bankCount;
    bytes32 public banksCommitment;

    struct Bank { address instance; bytes32 codeHash; }
    struct Stream {
        bytes32 role;
        uint64 totalWords;
        uint64 appendedWords;
        bool isSealed;
        bool exists;
        bytes32 rollingDigest;
        bytes32 commitment;
    }
    Bank[96] private _banks;
    mapping(bytes32 => Stream) private _streams;

    event BankCreated(uint8 indexed bankIndex, address indexed instance, bytes32 codeHash);
    event BanksReady(bytes32 commitment);
    event StreamBegun(bytes32 indexed stream, bytes32 indexed role, uint64 totalWords);
    event WordsAppended(bytes32 indexed stream, uint64 start, uint32 count, bytes32 rollingDigest);
    event StreamFrozen(bytes32 indexed stream, bytes32 commitment, uint64 totalWords);

    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidConfiguration();
        owner = owner_;
        banksCommitment = keccak256(abi.encode(bytes32("ORVIA-INPUT-BANKS-v1"),
            block.chainid, address(this), BANK_COUNT, PAGE_WORDS));
    }

    /// @notice Allocate the next 1–4 banks. No other function creates contracts.
    function createBanks(uint8 count) external onlyOwner {
        if (count == 0 || count > MAX_BANKS_PER_CREATION || uint256(bankCount) + count > BANK_COUNT)
            revert InvalidBankBatch();
        for (uint256 i; i < count; ++i) {
            uint8 index = bankCount;
            address instance = address(new InputWordBank{salt: bytes32(uint256(index))}(address(this), index));
            bytes32 codeHash = instance.codehash;
            _banks[index] = Bank(instance, codeHash);
            banksCommitment = keccak256(abi.encode(banksCommitment, index, instance, codeHash));
            ++bankCount;
            emit BankCreated(index, instance, codeHash);
        }
        if (bankCount == BANK_COUNT) emit BanksReady(banksCommitment);
    }

    function bankInfo(uint8 index) external view returns (address instance, bytes32 codeHash) {
        if (index >= BANK_COUNT) revert InvalidRead();
        Bank storage bank = _banks[index];
        return (bank.instance, bank.codeHash);
    }

    function bankForWord(uint64 index) public pure returns (uint8) {
        return uint8((uint256(index) / PAGE_WORDS) % BANK_COUNT);
    }

    function beginStream(bytes32 id, bytes32 role, uint64 totalWords) external onlyOwner {
        if (bankCount != BANK_COUNT) revert BanksIncomplete();
        if (id == bytes32(0) || role == bytes32(0)) revert InvalidConfiguration();
        if (_streams[id].exists) revert StreamExists();
        Stream storage stream = _streams[id];
        stream.role = role;
        stream.totalWords = totalWords;
        stream.exists = true;
        stream.rollingDigest = keccak256(abi.encode(bytes32("ORVIA-BANKED-INPUT-v1"),
            block.chainid, address(this), id, role, totalWords, banksCommitment));
        emit StreamBegun(id, role, totalWords);
    }

    /// @notice Append the next canonical words, without caller-selected offsets.
    function appendWords(bytes32 id, bytes32[] calldata values) external onlyOwner {
        Stream storage stream = _get(id);
        if (stream.isSealed) revert StreamSealed();
        uint256 count = values.length;
        if (count == 0 || count > MAX_BATCH_WORDS || count > stream.totalWords - stream.appendedWords)
            revert InvalidBatch();
        uint64 start = stream.appendedWords;
        bytes32 digest = stream.rollingDigest;
        uint256 done;
        while (done < count) {
            uint64 index = uint64(uint256(start) + done);
            uint256 length = count - done;
            uint256 remainder = PAGE_WORDS - uint256(index) % PAGE_WORDS;
            if (length > remainder) length = remainder;
            Bank storage bank = _bank(bankForWord(index));
            InputWordBank(bank.instance).writeWords(id, index, values[done:done + length]);
            for (uint256 i; i < length; ++i)
                digest = keccak256(abi.encode(digest, uint64(uint256(index) + i), values[done + i]));
            done += length;
        }
        stream.appendedWords += uint64(count);
        stream.rollingDigest = digest;
        emit WordsAppended(id, start, uint32(count), digest);
    }

    function sealStream(bytes32 id) external onlyOwner returns (bytes32 commitment) {
        Stream storage stream = _get(id);
        if (stream.isSealed) revert StreamSealed();
        if (stream.appendedWords != stream.totalWords) revert IncompleteStream();
        commitment = keccak256(abi.encode(bytes32("ORVIA-SEALED-BANKS-v1"), block.chainid,
            address(this), id, stream.role, stream.totalWords, stream.rollingDigest, banksCommitment));
        stream.commitment = commitment;
        stream.isSealed = true;
        emit StreamFrozen(id, commitment, stream.totalWords);
    }

    function assertStream(bytes32 id) external view returns (bytes32 commitment, uint64 wordCount) {
        Stream storage stream = _sealed(id);
        return (stream.commitment, stream.totalWords);
    }

    function readWord(bytes32 id, uint64 index) external view returns (bytes32) {
        Stream storage stream = _sealed(id);
        if (index >= stream.totalWords) revert InvalidRead();
        return InputWordBank(_bank(bankForWord(index)).instance).readWord(id, index);
    }

    function readWords(bytes32 id, uint64 start, uint32 count) external view returns (bytes32[] memory values) {
        Stream storage stream = _sealed(id);
        if (count > MAX_BATCH_WORDS || start > stream.totalWords || count > stream.totalWords - start)
            revert InvalidRead();
        values = new bytes32[](count);
        uint256 done;
        while (done < count) {
            uint64 index = uint64(uint256(start) + done);
            uint256 length = count - done;
            uint256 remainder = PAGE_WORDS - uint256(index) % PAGE_WORDS;
            if (length > remainder) length = remainder;
            bytes32[] memory words = InputWordBank(_bank(bankForWord(index)).instance)
                .readWords(id, index, uint32(length));
            for (uint256 i; i < length; ++i) values[done + i] = words[i];
            done += length;
        }
    }

    /// @dev ABI-compatible with PartitionedInputCatalog. pageCount is the logical
    ///      4096-word block count, never a count of additional deployed contracts.
    function streamInfo(bytes32 id) external view returns (
        bytes32 role, uint64 totalWords, uint64 appendedWords, uint64 pageCount, bool isSealed, bytes32 commitment
    ) {
        Stream storage stream = _get(id);
        return (stream.role, stream.totalWords, stream.appendedWords,
            uint64((uint256(stream.appendedWords) + PAGE_WORDS - 1) / PAGE_WORDS), stream.isSealed, stream.commitment);
    }

    function _bank(uint8 index) private view returns (Bank storage bank) {
        bank = _banks[index];
        if (bank.instance.code.length == 0 || bank.instance.codehash != bank.codeHash) revert BankChanged();
    }
    function _get(bytes32 id) private view returns (Stream storage stream) {
        stream = _streams[id];
        if (!stream.exists) revert UnknownStream();
    }
    function _sealed(bytes32 id) private view returns (Stream storage stream) {
        stream = _get(id);
        if (!stream.isSealed) revert IncompleteStream();
    }
}
