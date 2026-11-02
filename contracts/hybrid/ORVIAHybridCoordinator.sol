// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ORVIAReportShard} from "./ORVIAReportShard.sol";

/// @notice Factory and EIP-712 operator-attestation coordinator for 255 run shards.
/// @dev Exactly 256 deployed addresses after provisioning: this coordinator and
///      255 direct CREATE2 shards. No proxies, libraries or extra factories.
///      GPU calculations remain trusted operator work, not an on-chain or ZK proof.
contract ORVIAHybridCoordinator {
    error Unauthorized();
    error InvalidInput();
    error DeploymentIncomplete();
    error DependencyChanged();
    error ExperimentExists();
    error UnknownExperiment();
    error InvalidSignature();
    error ExpiredReport();

    struct ExperimentConfig {
        bytes32 protocolHash;
        bytes32 modelHash;
        bytes32 inputHash;
        bytes32 softwareHash;
        bytes32 environmentHash;
        uint32 requiredChecks;
        uint32 allowedChecks;
        bool diagnosticOnly;
    }
    struct Experiment { ExperimentConfig config; bytes32 configurationHash; }
    struct Report {
        bytes32 runId;
        bytes32 configurationHash;
        uint64 sequence;
        uint64 completedSteps;
        bytes32 previousCheckpointHash;
        bytes32 checkpointHash;
        bytes32 resultHash;
        uint8 outcome; // 0 checkpoint, 1 completed, 2 failed
        uint32 checks; // Operator-attested flags, interpreted by the frozen protocol.
        uint64 validUntil;
    }

    uint16 public constant SHARD_COUNT = 255;
    uint16 public constant MAX_SHARDS_PER_CALL = 8;
    uint16 public constant MAX_REPORTS_PER_CALL = 8;
    bytes32 public constant TRUST_MODEL = keccak256("ORVIA.OperatorEIP712Attestation.NotComputationProof.v1");
    bytes32 public constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant REPORT_TYPEHASH = keccak256("Report(bytes32 runId,bytes32 configurationHash,uint64 sequence,uint64 completedSteps,bytes32 previousCheckpointHash,bytes32 checkpointHash,bytes32 resultHash,uint8 outcome,uint32 checks,uint64 validUntil)");
    bytes32 private constant NAME_HASH = keccak256("ORVIAHybridCoordinator");
    bytes32 private constant VERSION_HASH = keccak256("1");

    address public immutable owner;
    address public immutable operator;
    uint16 public shardCount;
    bytes32 public deploymentCommitment;
    mapping(uint256 => address) public shards;
    mapping(uint256 => bytes32) public shardCodeHash;
    mapping(bytes32 => Experiment) private experiments;

    event ShardCreated(uint16 indexed index, address indexed shard, bytes32 codeHash);
    event DeploymentReady(bytes32 commitment);
    event ExperimentRegistered(bytes32 indexed experimentId, bytes32 configurationHash, bool diagnosticOnly);
    event RunStarted(bytes32 indexed runId, bytes32 indexed experimentId, uint16 indexed lane,
        bytes32 configurationHash, bytes32 initialCheckpointHash);
    event ReportAccepted(bytes32 indexed runId, uint64 indexed sequence, bytes32 indexed attestationDigest,
        uint64 completedSteps, bytes32 checkpointHash, bytes32 resultHash, uint8 outcome,
        uint32 checks, bool diagnosticOnly);
    event RunCancelled(bytes32 indexed runId, bytes32 reasonHash);

    constructor(address owner_, address operator_) {
        if (owner_ == address(0) || operator_ == address(0)) revert InvalidInput();
        owner = owner_;
        operator = operator_;
        deploymentCommitment = keccak256(abi.encode(TRUST_MODEL, block.chainid, address(this), owner_, operator_, SHARD_COUNT));
    }
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }

    function createShards(uint16 count) external onlyOwner {
        if (count == 0 || count > MAX_SHARDS_PER_CALL || uint256(shardCount) + count > SHARD_COUNT) revert InvalidInput();
        for (uint16 i; i < count; ++i) {
            uint16 index = shardCount;
            address shard = address(new ORVIAReportShard{salt: bytes32(uint256(index))}(address(this), index));
            bytes32 codeHash = shard.codehash;
            shards[index] = shard;
            shardCodeHash[index] = codeHash;
            deploymentCommitment = keccak256(abi.encode(deploymentCommitment, index, shard, codeHash));
            ++shardCount;
            emit ShardCreated(index, shard, codeHash);
        }
        if (deploymentReady()) emit DeploymentReady(deploymentCommitment);
    }
    function deploymentReady() public view returns (bool) { return shardCount == SHARD_COUNT; }
    function laneFor(bytes32 runId) public pure returns (uint16) {
        return uint16(uint256(keccak256(abi.encode(runId))) % SHARD_COUNT);
    }
    function shardFor(bytes32 runId) public view returns (address) { return shards[laneFor(runId)]; }
    function predictShard(uint16 index) external view returns (address) {
        if (index >= SHARD_COUNT) revert InvalidInput();
        bytes32 initHash = keccak256(abi.encodePacked(type(ORVIAReportShard).creationCode, abi.encode(address(this), index)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(uint256(index)), initHash)))));
    }

    function registerExperiment(bytes32 experimentId, ExperimentConfig calldata config) external onlyOwner {
        _ready();
        if (experimentId == 0 || config.protocolHash == 0 || config.modelHash == 0 || config.inputHash == 0
            || config.softwareHash == 0 || config.environmentHash == 0
            || (config.requiredChecks & ~config.allowedChecks) != 0
            || (!config.diagnosticOnly && config.requiredChecks == 0)) revert InvalidInput();
        if (experiments[experimentId].configurationHash != 0) revert ExperimentExists();
        bytes32 hash = keccak256(abi.encode(bytes32("ORVIA-HYBRID-EXPERIMENT-v1"), block.chainid, address(this), experimentId, config));
        experiments[experimentId] = Experiment(config, hash);
        emit ExperimentRegistered(experimentId, hash, config.diagnosticOnly);
    }
    function experimentInfo(bytes32 experimentId) external view returns (Experiment memory) { return experiments[experimentId]; }

    function startRun(bytes32 experimentId, bytes32 runId, bytes32 runConfigHash, bytes32 initialCheckpointHash) external onlyOwner {
        _ready();
        Experiment storage experiment = experiments[experimentId];
        if (experiment.configurationHash == 0) revert UnknownExperiment();
        if (runId == 0 || runConfigHash == 0 || initialCheckpointHash == 0) revert InvalidInput();
        bytes32 hash = keccak256(abi.encode(bytes32("ORVIA-HYBRID-RUN-v1"), block.chainid, address(this),
            experimentId, runId, experiment.configurationHash, runConfigHash, initialCheckpointHash));
        _shard(runId).startRun(runId, experimentId, hash, runConfigHash, initialCheckpointHash,
            experiment.config.requiredChecks, experiment.config.allowedChecks, experiment.config.diagnosticOnly);
        emit RunStarted(runId, experimentId, laneFor(runId), hash, initialCheckpointHash);
    }

    function submitReport(Report calldata report, bytes calldata signature) external { _ready(); _submit(report, signature); }
    function submitReports(Report[] calldata reports, bytes[] calldata signatures) external {
        _ready();
        if (reports.length == 0 || reports.length > MAX_REPORTS_PER_CALL || reports.length != signatures.length) revert InvalidInput();
        for (uint256 i; i < reports.length; ++i) _submit(reports[i], signatures[i]);
    }
    function _submit(Report calldata report, bytes calldata signature) private {
        if (report.runId == 0 || report.configurationHash == 0 || report.sequence == 0
            || report.checkpointHash == 0 || report.resultHash == 0 || report.outcome > 2) revert InvalidInput();
        if (report.validUntil < block.timestamp) revert ExpiredReport();
        bytes32 digest = reportDigest(report);
        if (_recover(digest, signature) != operator) revert InvalidSignature();
        ORVIAReportShard shard = _shard(report.runId);
        shard.appendReport(report.runId, report.configurationHash, report.sequence, report.completedSteps,
            report.previousCheckpointHash, report.checkpointHash, report.resultHash, report.outcome, report.checks, digest);
        ORVIAReportShard.Run memory run = shard.runInfo(report.runId);
        emit ReportAccepted(report.runId, report.sequence, digest, report.completedSteps,
            report.checkpointHash, report.resultHash, report.outcome, report.checks, run.diagnosticOnly);
    }
    function cancelRun(bytes32 runId, bytes32 reasonHash) external onlyOwner {
        _ready(); _shard(runId).cancelRun(runId, reasonHash); emit RunCancelled(runId, reasonHash);
    }
    function runInfo(bytes32 runId) external view returns (ORVIAReportShard.Run memory) { _ready(); return _shard(runId).runInfo(runId); }
    function reportAt(bytes32 runId, uint64 sequence) external view returns (ORVIAReportShard.ReportRecord memory) { _ready(); return _shard(runId).reportAt(runId, sequence); }
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }
    function reportDigest(Report calldata report) public view returns (bytes32) {
        bytes32 hash = keccak256(abi.encode(REPORT_TYPEHASH, report.runId, report.configurationHash, report.sequence,
            report.completedSteps, report.previousCheckpointHash, report.checkpointHash, report.resultHash,
            report.outcome, report.checks, report.validUntil));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), hash));
    }
    function _ready() private view { if (!deploymentReady()) revert DeploymentIncomplete(); }
    function _shard(bytes32 runId) private view returns (ORVIAReportShard) {
        uint16 lane = laneFor(runId);
        address shard = shards[lane];
        if (shard.code.length == 0 || shard.codehash != shardCodeHash[lane]) revert DependencyChanged();
        return ORVIAReportShard(shard);
    }
    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if ((v != 27 && v != 28) || uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0)
            revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
