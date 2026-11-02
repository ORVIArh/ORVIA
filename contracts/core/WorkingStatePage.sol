// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Bounded, isolated word namespaces controlled by one immutable writer.
/// @dev Values are raw bits. The writer must enforce numerical and run-state rules.
contract WorkingStatePage {
    error Unauthorized();
    error InvalidWriter();
    error InvalidNamespace();
    error NamespaceExists();
    error UnknownNamespace();
    error InvalidCapacity();
    error NamespaceSealed();
    error InvalidBatch();
    error OutOfBounds();

    uint256 public constant MAX_CAPACITY_WORDS = 65536;
    uint256 public constant MAX_BATCH_WORDS = 128;
    address public immutable writer;

    struct Namespace {
        uint32 capacityWords;
        bool isSealed;
        mapping(uint256 => bytes32) words;
    }

    mapping(bytes32 => Namespace) private _namespaces;

    event NamespaceCreated(bytes32 indexed namespace, uint32 capacityWords);
    event WordWritten(bytes32 indexed namespace, uint256 index, bytes32 value);
    event WordsWritten(bytes32 indexed namespace, uint256 start, uint256 count);
    event NamespaceFrozen(bytes32 indexed namespace);

    modifier onlyWriter() {
        if (msg.sender != writer) revert Unauthorized();
        _;
    }

    constructor(address writer_) {
        if (writer_ == address(0) || writer_.code.length == 0) revert InvalidWriter();
        writer = writer_;
    }

    function createNamespace(bytes32 namespace, uint32 capacityWords) external onlyWriter {
        if (namespace == bytes32(0)) revert InvalidNamespace();
        if (_namespaces[namespace].capacityWords != 0) revert NamespaceExists();
        if (capacityWords == 0 || capacityWords > MAX_CAPACITY_WORDS) revert InvalidCapacity();
        _namespaces[namespace].capacityWords = capacityWords;
        emit NamespaceCreated(namespace, capacityWords);
    }

    function writeWord(bytes32 namespace, uint256 index, bytes32 value) external onlyWriter {
        Namespace storage state = _getNamespace(namespace);
        if (state.isSealed) revert NamespaceSealed();
        if (index >= state.capacityWords) revert OutOfBounds();
        state.words[index] = value;
        emit WordWritten(namespace, index, value);
    }

    function writeWords(bytes32 namespace, uint256 start, bytes32[] calldata values) external onlyWriter {
        Namespace storage state = _getNamespace(namespace);
        if (state.isSealed) revert NamespaceSealed();
        if (values.length == 0 || values.length > MAX_BATCH_WORDS) revert InvalidBatch();
        _checkRange(state.capacityWords, start, values.length);
        for (uint256 i; i < values.length; ++i) state.words[start + i] = values[i];
        emit WordsWritten(namespace, start, values.length);
    }

    function readWord(bytes32 namespace, uint256 index) external view returns (bytes32) {
        Namespace storage state = _getNamespace(namespace);
        if (index >= state.capacityWords) revert OutOfBounds();
        return state.words[index];
    }

    function readWords(bytes32 namespace, uint256 start, uint256 count)
        external
        view
        returns (bytes32[] memory values)
    {
        Namespace storage state = _getNamespace(namespace);
        if (count > MAX_BATCH_WORDS) revert InvalidBatch();
        _checkRange(state.capacityWords, start, count);
        values = new bytes32[](count);
        for (uint256 i; i < count; ++i) values[i] = state.words[start + i];
    }

    function namespaceInfo(bytes32 namespace) external view returns (uint32 capacityWords, bool isSealed) {
        Namespace storage state = _getNamespace(namespace);
        return (state.capacityWords, state.isSealed);
    }

    function sealNamespace(bytes32 namespace) external onlyWriter {
        Namespace storage state = _getNamespace(namespace);
        if (state.isSealed) revert NamespaceSealed();
        state.isSealed = true;
        emit NamespaceFrozen(namespace);
    }

    function _getNamespace(bytes32 namespace) private view returns (Namespace storage state) {
        state = _namespaces[namespace];
        if (state.capacityWords == 0) revert UnknownNamespace();
    }

    function _checkRange(uint32 capacityWords, uint256 start, uint256 count) private pure {
        // Subtraction after the start check avoids overflow for adversarial indices.
        if (start > capacityWords || count > uint256(capacityWords) - start) revert OutOfBounds();
    }
}
