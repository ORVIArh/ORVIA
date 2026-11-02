// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev One member of a fixed, router-created pool. Namespace and GLOBAL word
///      index remain in the key when different logical pages reuse this bank.
contract BankedStateStorageBank {
    error Unauthorized();
    error InvalidRange();
    error InvalidEpoch();

    address public immutable router;
    bytes32 public immutable routerCodeHash;
    struct Version { uint64 epoch; bytes32 value; }
    mapping(bytes32 => mapping(uint256 => Version[])) private _history;

    constructor(address router_) {
        if (router_ != msg.sender || router_.code.length == 0) revert Unauthorized();
        router = router_; routerCodeHash = router_.codehash;
    }

    modifier onlyRouter() {
        if (msg.sender != router || router.codehash != routerCodeHash) revert Unauthorized();
        _;
    }

    function writeWords(bytes32 namespace, uint256 start, bytes32[] calldata values, uint64 epoch)
        external onlyRouter
    {
        if (epoch == 0) revert InvalidEpoch();
        _range(start, values.length);
        if (values.length == 0) revert InvalidRange();
        for (uint256 i; i < values.length; ++i) {
            Version[] storage versions = _history[namespace][start + i];
            uint256 length = versions.length;
            if (length != 0 && versions[length - 1].epoch > epoch) revert InvalidEpoch();
            if (length != 0 && versions[length - 1].epoch == epoch) versions[length - 1].value = values[i];
            else versions.push(Version(epoch, values[i]));
        }
    }

    function readWords(bytes32 namespace, uint256 start, uint256 count, uint64 epoch)
        external view onlyRouter returns (bytes32[] memory values)
    {
        if (epoch == 0) revert InvalidEpoch();
        _range(start, count);
        values = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            Version[] storage versions = _history[namespace][start + i];
            uint256 low; uint256 high = versions.length;
            if (high == 0) continue;
            if (versions[high - 1].epoch <= epoch) { values[i] = versions[high - 1].value; continue; }
            // At most one version per strictly increasing uint64 epoch: <=64
            // predecessor-search rounds, independent of namespaces/page count.
            while (low < high) {
                uint256 middle = low + (high - low) / 2;
                if (versions[middle].epoch <= epoch) low = middle + 1;
                else high = middle;
            }
            if (low != 0) values[i] = versions[low - 1].value;
        }
    }

    function _range(uint256 start, uint256 count) private pure {
        if (start >= type(uint32).max || count > 128 || count > 4096 - (start % 4096)
            || count > uint256(type(uint32).max) - start) revert InvalidRange();
    }
}

/// @notice Mutable word namespaces and retained snapshots in a fixed bank pool.
/// @dev Matches the ShardedWorkingState consumer ABI. Provisioning is explicit:
///      reads of unprovisioned, unwritten banks are zero; writes fail closed.
///      No namespace, write, snapshot or seal operation deploys a child contract.
contract BankedWorkingState {
    error Unauthorized();
    error InvalidWriter();
    error InvalidBankCount();
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
    error BankUnavailable();
    error BankChanged();

    uint256 public constant MAX_CAPACITY_WORDS = type(uint32).max;
    uint256 public constant MAX_BATCH_WORDS = 128;
    uint256 public constant SHARD_WORDS = 4096;
    uint256 public constant MAX_BANKS = 128;
    uint256 public constant MAX_BANKS_PER_DEPLOY = 4;
    address public immutable writer;
    bytes32 public immutable writerCodeHash;
    uint16 public immutable bankCount;
    uint16 public deployedBankCount;
    bytes32 public bankRuntimeCodeHash;

    struct Bank { address page; bytes32 codeHash; }
    struct Namespace {
        uint32 capacityWords;
        bool isSealed;
        bool isSnapshot;
        uint64 epoch;
        bytes32 source;
        bytes32 writeDigest;
        bytes32 commitment;
    }
    mapping(uint256 => Bank) private _banks;
    mapping(bytes32 => Namespace) private _namespaces;

    event BankDeployed(uint256 indexed index, address indexed page, bytes32 codeHash);
    event NamespaceCreated(bytes32 indexed namespace, uint32 capacityWords);
    event WordsWritten(bytes32 indexed namespace, uint256 start, uint256 count, bytes32 writeDigest);
    event NamespaceFrozen(bytes32 indexed namespace);
    event SnapshotCreated(bytes32 indexed source, bytes32 indexed snapshot, uint64 epoch, bytes32 commitment);

    modifier onlyWriter() {
        if (msg.sender != writer || writer.codehash != writerCodeHash) revert Unauthorized();
        _;
    }

    constructor(address writer_, uint16 bankCount_) {
        if (writer_ == address(0) || writer_.code.length == 0) revert InvalidWriter();
        if (bankCount_ == 0 || bankCount_ > MAX_BANKS) revert InvalidBankCount();
        writer = writer_; writerCodeHash = writer_.codehash; bankCount = bankCount_;
    }

    /// @notice Anyone may pay to provision the next <=4 predetermined banks.
    /// @dev Cannot register arbitrary code, replace a bank or grow the fixed pool.
    function deployBanks(uint256 work) external returns (uint256 processed, bool complete) {
        if (work == 0 || work > MAX_BANKS_PER_DEPLOY) revert InvalidBatch();
        uint256 next = deployedBankCount;
        while (processed < work && next < bankCount) {
            address page = address(new BankedStateStorageBank{salt: bytes32(next)}(address(this)));
            bytes32 codeHash = page.codehash;
            if (next == 0) bankRuntimeCodeHash = codeHash;
            else if (codeHash != bankRuntimeCodeHash) revert BankChanged();
            _banks[next] = Bank(page, codeHash);
            emit BankDeployed(next, page, codeHash);
            ++next; ++processed;
        }
        deployedBankCount = uint16(next);
        complete = next == bankCount;
    }

    function createNamespace(bytes32 namespace, uint32 capacityWords) external onlyWriter {
        if (namespace == bytes32(0)) revert InvalidNamespace();
        if (_namespaces[namespace].capacityWords != 0) revert NamespaceExists();
        if (capacityWords == 0) revert InvalidCapacity();
        Namespace storage n = _namespaces[namespace];
        n.capacityWords = capacityWords; n.epoch = 1;
        n.writeDigest = keccak256(abi.encode(bytes32("ORVIA-BANKED-STATE-v1"), block.chainid,
            address(this), writer, writerCodeHash, bankCount, namespace, capacityWords));
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
            uint256 count = values.length - done;
            if (count > SHARD_WORDS - (index % SHARD_WORDS)) count = SHARD_WORDS - (index % SHARD_WORDS);
            Bank storage bank = _banks[(index / SHARD_WORDS) % bankCount];
            if (bank.page == address(0)) revert BankUnavailable();
            _assertBank(bank);
            bytes32[] memory chunk = new bytes32[](count);
            for (uint256 i; i < count; ++i) {
                chunk[i] = values[done + i];
                n.writeDigest = keccak256(abi.encode(n.writeDigest, index + i, chunk[i]));
            }
            BankedStateStorageBank(bank.page).writeWords(namespace, index, chunk, n.epoch);
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
        uint64 epoch = viewNamespace.isSnapshot ? viewNamespace.epoch : _namespaces[source].epoch;
        values = new bytes32[](count);
        uint256 done;
        while (done < count) {
            uint256 index = start + done;
            uint256 length = count - done;
            if (length > SHARD_WORDS - (index % SHARD_WORDS)) length = SHARD_WORDS - (index % SHARD_WORDS);
            Bank storage bank = _banks[(index / SHARD_WORDS) % bankCount];
            if (bank.page != address(0)) {
                _assertBank(bank);
                bytes32[] memory chunk = BankedStateStorageBank(bank.page).readWords(source, index, length, epoch);
                for (uint256 i; i < length; ++i) values[done + i] = chunk[i];
            }
            done += length;
        }
    }

    /// @dev Only the pinned writer establishes scientific completion and derives
    ///      snapshot names from complete run/step identity. Storage does not infer it.
    function snapshotNamespace(bytes32 source, bytes32 snapshot) external onlyWriter returns (bytes32 commitment) {
        Namespace storage n = _get(source);
        if (n.isSnapshot) revert InvalidSnapshotSource();
        if (snapshot == bytes32(0)) revert InvalidNamespace();
        if (_namespaces[snapshot].capacityWords != 0) revert NamespaceExists();
        if (n.epoch == type(uint64).max) revert EpochExhausted();
        Namespace storage s = _namespaces[snapshot];
        s.capacityWords = n.capacityWords; s.isSealed = true; s.isSnapshot = true;
        s.epoch = n.epoch; s.source = source; s.writeDigest = n.writeDigest;
        commitment = keccak256(abi.encode(bytes32("ORVIA-BANKED-SNAPSHOT-v1"), block.chainid,
            address(this), writer, writerCodeHash, bankCount, source, snapshot, s.epoch, s.capacityWords, s.writeDigest));
        s.commitment = commitment; ++n.epoch;
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
    function bankInfo(uint256 index) external view returns (address page, bytes32 codeHash) {
        if (index >= bankCount) revert OutOfBounds();
        Bank storage bank = _banks[index]; return (bank.page, bank.codeHash);
    }
    /// @notice Compatibility metadata: logical pages share physical bank addresses.
    function shardInfo(bytes32 namespace, uint256 shardIndex) external view returns (address page, bytes32 codeHash) {
        Namespace storage n = _get(namespace);
        if (shardIndex >= (uint256(n.capacityWords) + SHARD_WORDS - 1) / SHARD_WORDS) revert OutOfBounds();
        Bank storage bank = _banks[shardIndex % bankCount]; return (bank.page, bank.codeHash);
    }
    function sealNamespace(bytes32 namespace) external onlyWriter {
        Namespace storage n = _get(namespace);
        if (n.isSealed) revert NamespaceSealed();
        n.isSealed = true; emit NamespaceFrozen(namespace);
    }
    function _assertBank(Bank storage bank) private view {
        if (bank.page.code.length == 0 || bank.page.codehash != bank.codeHash
            || bank.codeHash != bankRuntimeCodeHash) revert BankChanged();
    }
    function _get(bytes32 namespace) private view returns (Namespace storage n) {
        n = _namespaces[namespace]; if (n.capacityWords == 0) revert UnknownNamespace();
    }
    function _range(uint32 capacity, uint256 start, uint256 count) private pure {
        if (start > capacity || count > uint256(capacity) - start) revert OutOfBounds();
    }
}
