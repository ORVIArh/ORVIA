// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Factory-created state shard. Only its immutable router can write history.
///      Every retained epoch reads a predecessor in at most 64 binary-search rounds.
contract VersionedStateShard {
    error Unauthorized();
    error InvalidRange();
    error InvalidEpoch();
    uint256 public constant WORDS = 4096;
    address public immutable router;
    struct Version { uint64 epoch; bytes32 value; }
    mapping(uint256 => Version[]) private _history;

    constructor(address router_) { router = router_; }

    function writeWords(uint256 start, bytes32[] calldata values, uint64 epoch) external {
        if (msg.sender != router) revert Unauthorized();
        if (epoch == 0) revert InvalidEpoch();
        if (values.length == 0 || values.length > 128 || start >= WORDS || values.length > WORDS - start)
            revert InvalidRange();
        for (uint256 i; i < values.length; ++i) {
            Version[] storage versions = _history[start + i];
            uint256 length = versions.length;
            if (length != 0 && versions[length - 1].epoch > epoch) revert InvalidEpoch();
            if (length != 0 && versions[length - 1].epoch == epoch) versions[length - 1].value = values[i];
            else versions.push(Version(epoch, values[i]));
        }
    }

    function readWords(uint256 start, uint256 count, uint64 epoch) external view returns (bytes32[] memory values) {
        if (count > 128 || start > WORDS || count > WORDS - start) revert InvalidRange();
        values = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            Version[] storage versions = _history[start + i];
            uint256 low; uint256 high = versions.length;
            if (high == 0) continue;
            if (versions[high - 1].epoch <= epoch) { values[i] = versions[high - 1].value; continue; }
            // A word gains at most one entry per uint64 epoch. Upper bound is
            // 2**64-1 entries, so this loop has a hard maximum of 64 iterations.
            while (low < high) {
                uint256 middle = low + (high - low) / 2;
                if (versions[middle].epoch <= epoch) low = middle + 1;
                else high = middle;
            }
            if (low != 0) values[i] = versions[low - 1].value;
        }
    }
}

/// @notice Global word namespaces with bounded authenticated cross-shard access.
/// @dev WorkingStatePage-compatible mutable ABI; snapshots add immutable namespaces.
///      Semantic step completeness is enforced by the pinned writer before snapshot.
contract ShardedWorkingState {
    error Unauthorized();
    error InvalidWriter();
    error InvalidNamespace();
    error NamespaceExists();
    error UnknownNamespace();
    error InvalidCapacity();
    error NamespaceSealed();
    error InvalidBatch();
    error OutOfBounds();
    error InvalidSnapshotSource();
    error NotSnapshot();
    error EpochExhausted();
    error ShardChanged();

    uint256 public constant MAX_CAPACITY_WORDS = type(uint32).max;
    uint256 public constant MAX_BATCH_WORDS = 128;
    uint256 public constant SHARD_WORDS = 4096;
    address public immutable writer;
    bytes32 public immutable writerCodeHash;

    struct Shard { address page; bytes32 codeHash; }
    struct Namespace {
        uint32 capacityWords;
        bool isSealed;
        bool isSnapshot;
        uint64 epoch;
        bytes32 source;
        bytes32 writeDigest;
        bytes32 commitment;
        mapping(uint256 => Shard) shards;
    }
    mapping(bytes32 => Namespace) private _namespaces;

    event NamespaceCreated(bytes32 indexed namespace, uint32 capacityWords);
    event ShardCreated(bytes32 indexed namespace, uint256 indexed shardIndex, address page, bytes32 codeHash);
    event WordsWritten(bytes32 indexed namespace, uint256 start, uint256 count, bytes32 writeDigest);
    event NamespaceFrozen(bytes32 indexed namespace);
    event SnapshotCreated(bytes32 indexed source, bytes32 indexed snapshot, uint64 epoch, bytes32 commitment);

    modifier onlyWriter() {
        if (msg.sender != writer || writer.codehash != writerCodeHash) revert Unauthorized();
        _;
    }

    constructor(address writer_) {
        if (writer_ == address(0) || writer_.code.length == 0) revert InvalidWriter();
        writer = writer_; writerCodeHash = writer_.codehash;
    }

    function createNamespace(bytes32 namespace, uint32 capacityWords) external onlyWriter {
        if (namespace == bytes32(0)) revert InvalidNamespace();
        if (_namespaces[namespace].capacityWords != 0) revert NamespaceExists();
        if (capacityWords == 0) revert InvalidCapacity();
        Namespace storage n = _namespaces[namespace];
        n.capacityWords = capacityWords; n.epoch = 1;
        n.writeDigest = keccak256(abi.encode(bytes32("ORVIA-SHARDED-STATE-v1"), block.chainid,
            address(this), writer, namespace, capacityWords));
        emit NamespaceCreated(namespace, capacityWords);
    }

    function writeWord(bytes32 namespace, uint256 index, bytes32 value) external onlyWriter {
        bytes32[] memory values = new bytes32[](1); values[0] = value;
        _write(namespace, index, values);
    }
    function writeWords(bytes32 namespace, uint256 start, bytes32[] calldata values) external onlyWriter {
        _write(namespace, start, values);
    }
    function _write(bytes32 namespace, uint256 start, bytes32[] memory values) private {
        Namespace storage n = _get(namespace);
        if (n.isSealed) revert NamespaceSealed();
        if (values.length == 0 || values.length > MAX_BATCH_WORDS) revert InvalidBatch();
        _range(n.capacityWords, start, values.length);
        uint256 done;
        while (done < values.length) {
            uint256 index = start + done;
            uint256 local = index % SHARD_WORDS;
            uint256 count = values.length - done;
            if (count > SHARD_WORDS - local) count = SHARD_WORDS - local;
            Shard storage shard = n.shards[index / SHARD_WORDS];
            if (shard.page == address(0)) {
                shard.page = address(new VersionedStateShard{salt: keccak256(abi.encode(namespace, index / SHARD_WORDS))}(address(this)));
                shard.codeHash = shard.page.codehash;
                emit ShardCreated(namespace, index / SHARD_WORDS, shard.page, shard.codeHash);
            } else _assertShard(shard);
            bytes32[] memory chunk = new bytes32[](count);
            for (uint256 i; i < count; ++i) {
                chunk[i] = values[done + i];
                n.writeDigest = keccak256(abi.encode(n.writeDigest, index + i, chunk[i]));
            }
            VersionedStateShard(shard.page).writeWords(local, chunk, n.epoch);
            done += count;
        }
        emit WordsWritten(namespace, start, values.length, n.writeDigest);
    }

    function readWord(bytes32 namespace, uint256 index) external view returns (bytes32) {
        return _read(namespace, index, 1)[0];
    }
    function readWords(bytes32 namespace, uint256 start, uint256 count) external view returns (bytes32[] memory) {
        return _read(namespace, start, count);
    }
    function _read(bytes32 namespace, uint256 start, uint256 count) private view returns (bytes32[] memory values) {
        Namespace storage viewNamespace = _get(namespace);
        if (count > MAX_BATCH_WORDS) revert InvalidBatch();
        _range(viewNamespace.capacityWords, start, count);
        bytes32 source = viewNamespace.isSnapshot ? viewNamespace.source : namespace;
        Namespace storage n = _namespaces[source];
        uint64 epoch = viewNamespace.isSnapshot ? viewNamespace.epoch : n.epoch;
        values = new bytes32[](count);
        uint256 done;
        while (done < count) {
            uint256 index = start + done;
            uint256 local = index % SHARD_WORDS;
            uint256 length = count - done;
            if (length > SHARD_WORDS - local) length = SHARD_WORDS - local;
            Shard storage shard = n.shards[index / SHARD_WORDS];
            if (shard.page != address(0)) {
                _assertShard(shard);
                bytes32[] memory chunk = VersionedStateShard(shard.page).readWords(local, length, epoch);
                for (uint256 i; i < length; ++i) values[done + i] = chunk[i];
            }
            done += length;
        }
    }

    /// @notice Called by a code-pinned coordinator only after its complete-state barrier.
    /// @dev Names bind the writer's run/step identity; commitment additionally binds
    ///      source, exact retained epoch, capacity and every ordered word write.
    function snapshotNamespace(bytes32 source, bytes32 snapshot) external onlyWriter returns (bytes32 commitment) {
        Namespace storage n = _get(source);
        if (n.isSnapshot) revert InvalidSnapshotSource();
        if (snapshot == bytes32(0)) revert InvalidNamespace();
        if (_namespaces[snapshot].capacityWords != 0) revert NamespaceExists();
        if (n.epoch == type(uint64).max) revert EpochExhausted();
        Namespace storage s = _namespaces[snapshot];
        s.capacityWords = n.capacityWords; s.isSealed = true; s.isSnapshot = true;
        s.epoch = n.epoch; s.source = source; s.writeDigest = n.writeDigest;
        commitment = keccak256(abi.encode(bytes32("ORVIA-STATE-SNAPSHOT-v1"), block.chainid,
            address(this), writer, source, snapshot, s.epoch, s.capacityWords, s.writeDigest));
        s.commitment = commitment;
        ++n.epoch;
        emit SnapshotCreated(source, snapshot, s.epoch, commitment);
    }

    function snapshotInfo(bytes32 snapshot) external view returns (
        bytes32 source, uint64 epoch, uint32 capacityWords, bytes32 writeDigest, bytes32 commitment
    ) {
        Namespace storage s = _get(snapshot);
        if (!s.isSnapshot) revert NotSnapshot();
        return (s.source, s.epoch, s.capacityWords, s.writeDigest, s.commitment);
    }
    function namespaceInfo(bytes32 namespace) external view returns (uint32 capacityWords, bool isSealed) {
        Namespace storage n = _get(namespace); return (n.capacityWords, n.isSealed);
    }
    function namespaceCommitment(bytes32 namespace) external view returns (bytes32 writeDigest, uint64 epoch) {
        Namespace storage n = _get(namespace); return (n.writeDigest, n.epoch);
    }
    function shardInfo(bytes32 namespace, uint256 shardIndex) external view returns (address page, bytes32 codeHash) {
        Namespace storage n = _get(namespace);
        if (shardIndex >= (uint256(n.capacityWords) + SHARD_WORDS - 1) / SHARD_WORDS) revert OutOfBounds();
        if (n.isSnapshot) n = _namespaces[n.source];
        Shard storage s = n.shards[shardIndex]; return (s.page, s.codeHash);
    }
    function sealNamespace(bytes32 namespace) external onlyWriter {
        Namespace storage n = _get(namespace);
        if (n.isSealed) revert NamespaceSealed();
        n.isSealed = true; emit NamespaceFrozen(namespace);
    }
    function _assertShard(Shard storage shard) private view {
        if (shard.page.codehash != shard.codeHash || shard.page.code.length == 0) revert ShardChanged();
    }
    function _get(bytes32 namespace) private view returns (Namespace storage n) {
        n = _namespaces[namespace]; if (n.capacityWords == 0) revert UnknownNamespace();
    }
    function _range(uint32 capacity, uint256 start, uint256 count) private pure {
        if (start > capacity || count > uint256(capacity) - start) revert OutOfBounds();
    }
}
