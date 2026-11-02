// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Bounded, append-only 32-byte input words with irreversible sealing.
/// @dev This is an immutable-input page. Mutable simulation pages require a separate design.
contract DataPage {
    error Unauthorized();
    error InvalidConfiguration();
    error PageSealed();
    error InvalidBatch();
    error CapacityExceeded();
    error DigestMismatch();
    error EmptyPage();
    error InvalidRead();

    uint256 public constant MAX_APPEND_WORDS = 128;
    uint256 public constant MAX_CAPACITY_WORDS = 4096;
    address public immutable owner;
    bytes32 public immutable role;
    uint32 public immutable capacityWords;
    bool public isSealed;
    bytes32 public rollingDigest;
    bytes32[] private _words;

    event WordsAppended(uint256 start, uint256 count, bytes32 rollingDigest);
    event PageFrozen(uint256 wordCount, bytes32 digest);

    constructor(address owner_, bytes32 role_, uint32 capacityWords_) {
        if (owner_ == address(0) || role_ == bytes32(0) || capacityWords_ == 0 || capacityWords_ > MAX_CAPACITY_WORDS) {
            revert InvalidConfiguration();
        }
        owner = owner_;
        role = role_;
        capacityWords = capacityWords_;
        rollingDigest = keccak256(abi.encode(bytes32("ORVIA-DATA-PAGE-v1"), role_, capacityWords_));
    }

    function append(bytes32[] calldata values) external {
        if (msg.sender != owner) revert Unauthorized();
        if (isSealed) revert PageSealed();
        if (values.length == 0 || values.length > MAX_APPEND_WORDS) revert InvalidBatch();
        uint256 start = _words.length;
        if (start + values.length > capacityWords) revert CapacityExceeded();
        bytes32 digest = rollingDigest;
        for (uint256 i; i < values.length; ++i) {
            _words.push(values[i]);
            digest = keccak256(abi.encode(digest, values[i]));
        }
        rollingDigest = digest;
        emit WordsAppended(start, values.length, digest);
    }

    function seal(bytes32 expectedDigest) external {
        if (msg.sender != owner) revert Unauthorized();
        if (isSealed) revert PageSealed();
        if (_words.length == 0) revert EmptyPage();
        if (expectedDigest != rollingDigest) revert DigestMismatch();
        isSealed = true;
        emit PageFrozen(_words.length, expectedDigest);
    }

    function wordCount() external view returns (uint256) { return _words.length; }

    function readWord(uint256 index) external view returns (bytes32) {
        if (index >= _words.length) revert InvalidRead();
        return _words[index];
    }

    function readWords(uint256 start, uint256 count) external view returns (bytes32[] memory words) {
        if (count > MAX_APPEND_WORDS || start > _words.length || count > _words.length - start) revert InvalidRead();
        words = new bytes32[](count);
        for (uint256 i; i < count; ++i) words[i] = _words[start + i];
    }
}
