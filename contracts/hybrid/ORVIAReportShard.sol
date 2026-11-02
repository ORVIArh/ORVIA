// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Permanent history for one of 255 deterministic hybrid run lanes.
/// @dev Only the pinned coordinator writes. Hashes authenticate an operator's
///      claims; the shard neither executes nor proves the GPU computation.
contract ORVIAReportShard {
    error Unauthorized();
    error InvalidInput();
    error RunExists();
    error UnknownRun();
    error TerminalRun();
    error InvalidSequence();
    error InvalidCheckpoint();
    error MissingChecks();

    enum Status { Missing, Running, Completed, Failed, Cancelled }
    struct Run {
        bytes32 experimentId;
        bytes32 configurationHash;
        bytes32 runConfigHash;
        bytes32 initialCheckpointHash;
        bytes32 latestCheckpointHash;
        bytes32 latestResultHash;
        bytes32 cancellationReason;
        uint64 sequence;
        uint64 completedSteps;
        uint32 requiredChecks;
        uint32 allowedChecks;
        uint32 latestChecks;
        Status status;
        bool diagnosticOnly;
    }
    struct ReportRecord {
        bytes32 previousCheckpointHash;
        bytes32 checkpointHash;
        bytes32 resultHash;
        bytes32 attestationDigest;
        uint64 completedSteps;
        uint64 acceptedAt;
        uint32 checks;
        uint8 outcome;
    }

    address public immutable coordinator;
    bytes32 public immutable coordinatorCodeHash;
    uint16 public immutable index;
    mapping(bytes32 => Run) private runs;
    mapping(bytes32 => mapping(uint64 => ReportRecord)) private reports;

    constructor(address coordinator_, uint16 index_) {
        if (coordinator_ != msg.sender || coordinator_.code.length == 0 || index_ >= 255) revert InvalidInput();
        coordinator = coordinator_;
        coordinatorCodeHash = coordinator_.codehash;
        index = index_;
    }

    modifier onlyCoordinator() {
        if (msg.sender != coordinator || msg.sender.codehash != coordinatorCodeHash) revert Unauthorized();
        _;
    }

    function startRun(bytes32 runId, bytes32 experimentId, bytes32 configurationHash,
        bytes32 runConfigHash, bytes32 initialCheckpointHash, uint32 requiredChecks, uint32 allowedChecks, bool diagnosticOnly)
        external onlyCoordinator
    {
        if (runId == 0 || experimentId == 0 || configurationHash == 0 || runConfigHash == 0 || initialCheckpointHash == 0
            || (requiredChecks & ~allowedChecks) != 0 || (!diagnosticOnly && requiredChecks == 0)) revert InvalidInput();
        if (runs[runId].status != Status.Missing) revert RunExists();
        Run storage run = runs[runId];
        run.experimentId = experimentId;
        run.configurationHash = configurationHash;
        run.runConfigHash = runConfigHash;
        run.initialCheckpointHash = initialCheckpointHash;
        run.latestCheckpointHash = initialCheckpointHash;
        run.requiredChecks = requiredChecks;
        run.allowedChecks = allowedChecks;
        run.status = Status.Running;
        run.diagnosticOnly = diagnosticOnly;
    }

    function appendReport(bytes32 runId, bytes32 configurationHash, uint64 sequence,
        uint64 completedSteps, bytes32 previousCheckpointHash, bytes32 checkpointHash,
        bytes32 resultHash, uint8 outcome, uint32 checks, bytes32 attestationDigest)
        external onlyCoordinator
    {
        Run storage run = runs[runId];
        if (run.status == Status.Missing) revert UnknownRun();
        if (run.status != Status.Running) revert TerminalRun();
        if (configurationHash != run.configurationHash || outcome > 2 || checkpointHash == 0
            || resultHash == 0 || attestationDigest == 0 || (checks & ~run.allowedChecks) != 0) revert InvalidInput();
        if (sequence != run.sequence + 1) revert InvalidSequence();
        if (previousCheckpointHash != run.latestCheckpointHash || completedSteps < run.completedSteps
            || (outcome == 0 && completedSteps == run.completedSteps)) revert InvalidCheckpoint();
        if (outcome == 1 && !run.diagnosticOnly && (checks & run.requiredChecks) != run.requiredChecks) revert MissingChecks();

        reports[runId][sequence] = ReportRecord(previousCheckpointHash, checkpointHash,
            resultHash, attestationDigest, completedSteps, uint64(block.timestamp), checks, outcome);
        run.sequence = sequence;
        run.completedSteps = completedSteps;
        run.latestCheckpointHash = checkpointHash;
        run.latestResultHash = resultHash;
        run.latestChecks = checks;
        if (outcome == 1) run.status = Status.Completed;
        else if (outcome == 2) run.status = Status.Failed;
    }

    function cancelRun(bytes32 runId, bytes32 reasonHash) external onlyCoordinator {
        Run storage run = runs[runId];
        if (run.status == Status.Missing) revert UnknownRun();
        if (run.status != Status.Running) revert TerminalRun();
        if (reasonHash == 0) revert InvalidInput();
        run.status = Status.Cancelled;
        run.cancellationReason = reasonHash;
    }

    function runInfo(bytes32 runId) external view returns (Run memory) { return runs[runId]; }
    function reportAt(bytes32 runId, uint64 sequence) external view returns (ReportRecord memory) {
        if (sequence == 0 || sequence > runs[runId].sequence) revert InvalidSequence();
        return reports[runId][sequence];
    }
}
