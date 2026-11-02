// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FloatMath} from "../math/FloatMath.sol";

/// @notice Immutable-writer collection of complete cross-state energy samples.
/// @dev A trusted simulation writer must supply computed energies. The collector
///      converts them on-chain; it does not certify equilibrium or independence.
contract ReducedPotentialCollector {
    error Unauthorized(); error InvalidInput(); error UnknownSeries(); error Frozen();
    error DependencyChanged();
    address public immutable writer;
    bytes32 public immutable writerCodeHash;
    FloatMath public immutable numericalMath;
    bytes32 public immutable mathCodeHash;
    uint256 public constant MAX_STATES = 16;
    uint256 public constant MAX_SAMPLES = 4096;
    bytes16 private constant MAX_DIFFERENCE = 0x40040000000000000000000000000000; // 32

    struct Configuration {
        bytes32 protocolHash; bytes32 runHash; bytes32 leg; bytes32 repeatSeed;
        uint8 stateCount; uint32 expectedSamples; bytes16 kT;
        uint64 stride; uint64 equilibrationEnd;
        bytes16 mbarTolerance; bytes16 overlapThreshold; bytes16 minimumESS; bytes16 normalizationTolerance;
    }
    struct Series {
        Configuration config; bytes32 digest; uint32 count; bool isSealed;
        uint32[16] stateCounts; uint64[16] lastStep;
        bytes16[] reduced; bytes16[] referenceEnergy; uint8[] sampledStates; uint64[] steps;
    }
    mapping(bytes32 => Series) private _series;
    event SeriesCreated(bytes32 indexed id, bytes32 digest);
    event SampleRecorded(bytes32 indexed id, uint32 sample, uint8 state, uint64 step, bytes32 digest);
    event SeriesSealed(bytes32 indexed id, bytes32 digest);

    constructor(address writer_, address math_) {
        if (writer_.code.length == 0 || math_.code.length == 0) revert InvalidInput();
        writer = writer_; writerCodeHash = writer_.codehash;
        numericalMath = FloatMath(math_); mathCodeHash = math_.codehash;
    }
    function createSeries(bytes32 id, Configuration calldata config) external {
        _writer();
        if (id == bytes32(0) || _series[id].config.stateCount != 0 || config.protocolHash == bytes32(0)
            || config.runHash == bytes32(0) || config.leg == bytes32(0) || config.repeatSeed == bytes32(0)
            || config.stateCount < 2 || config.stateCount > MAX_STATES || config.expectedSamples < config.stateCount
            || config.expectedSamples > MAX_SAMPLES || config.stride == 0
            || !numericalMath.isFinite(config.kT) || numericalMath.compare(config.kT, bytes16(0)) <= 0) revert InvalidInput();
        _validatePolicy(config);
        Series storage s = _series[id]; s.config = config;
        s.digest = keccak256(abi.encode(bytes32("ORVIA-REDUCED-SERIES-v1"),block.chainid,address(this),id,
            writer,writerCodeHash,address(numericalMath),mathCodeHash,config));
        emit SeriesCreated(id,s.digest);
    }
    function _validatePolicy(Configuration calldata c) private view {
        FloatMath m=numericalMath;bytes16 one=m.fromUInt(1);
        if(!m.isFinite(c.mbarTolerance)||!m.isFinite(c.overlapThreshold)||!m.isFinite(c.minimumESS)||!m.isFinite(c.normalizationTolerance)
            ||m.compare(c.mbarTolerance,bytes16(0))<=0||m.compare(c.mbarTolerance,one)>=0
            ||m.compare(c.overlapThreshold,bytes16(0))<=0||m.compare(c.overlapThreshold,one)>=0
            ||m.compare(c.normalizationTolerance,bytes16(0))<=0||m.compare(c.normalizationTolerance,one)>=0
            ||m.compare(c.minimumESS,one)<0||m.compare(c.minimumESS,m.fromUInt(c.expectedSamples))>0)revert InvalidInput();
    }
    function appendSample(bytes32 id, uint8 sampledState, uint64 step, bytes16[] calldata energies) external {
        _writer(); Series storage s = _get(id);
        if (s.isSealed) revert Frozen();
        if (s.count >= s.config.expectedSamples || sampledState >= s.config.stateCount || energies.length != s.config.stateCount
            || step <= s.config.equilibrationEnd || (s.stateCounts[sampledState] != 0
                && (step <= s.lastStep[sampledState] || step - s.lastStep[sampledState] < s.config.stride))) revert InvalidInput();
        FloatMath m = numericalMath;
        if (!m.isFinite(energies[0])) revert InvalidInput();
        for (uint256 k; k < energies.length; ++k) {
            if (!m.isFinite(energies[k])) revert InvalidInput();
            bytes16 reduced = m.div(m.sub(energies[k],energies[0]),s.config.kT);
            if (m.compare(m.abs(reduced),MAX_DIFFERENCE) > 0) revert InvalidInput();
            s.reduced.push(reduced);
        }
        s.referenceEnergy.push(energies[0]); s.sampledStates.push(sampledState); s.steps.push(step);
        s.lastStep[sampledState] = step; ++s.stateCounts[sampledState];
        s.digest = keccak256(abi.encode(s.digest,s.count,sampledState,step,energies));
        emit SampleRecorded(id,s.count,sampledState,step,s.digest); ++s.count;
    }
    function seal(bytes32 id) external {
        _writer(); Series storage s = _get(id);
        if (s.isSealed) revert Frozen();
        if (s.count != s.config.expectedSamples) revert InvalidInput();
        for (uint256 k; k < s.config.stateCount; ++k) if (s.stateCounts[k] == 0) revert InvalidInput();
        s.isSealed = true; emit SeriesSealed(id,s.digest);
    }
    function seriesInfo(bytes32 id) external view returns (Configuration memory config, bytes32 digest, uint32 count, bool isSealed) {
        Series storage s = _get(id); return (s.config,s.digest,s.count,s.isSealed);
    }
    function stateCount(bytes32 id, uint256 k) external view returns (uint32) {
        Series storage s = _get(id); if (k >= s.config.stateCount) revert InvalidInput(); return s.stateCounts[k];
    }
    function potential(bytes32 id,uint256 n,uint256 k) external view returns (bytes16) {
        Series storage s = _get(id); if (n >= s.count || k >= s.config.stateCount) revert InvalidInput();
        return s.reduced[n*s.config.stateCount+k];
    }
    function sampleInfo(bytes32 id,uint256 n) external view returns (uint8 sampledState,uint64 step,bytes16 referenceEnergy) {
        Series storage s = _get(id); if (n >= s.count) revert InvalidInput();
        return (s.sampledStates[n],s.steps[n],s.referenceEnergy[n]);
    }
    function assertSealed(bytes32 id) external view returns (bytes32) {
        _dependencies(); Series storage s = _get(id); if (!s.isSealed) revert InvalidInput(); return s.digest;
    }
    function _writer() private view { if (msg.sender != writer) revert Unauthorized(); _dependencies(); }
    function _dependencies() private view {
        if (writer.codehash != writerCodeHash || address(numericalMath).codehash != mathCodeHash) revert DependencyChanged();
    }
    function _get(bytes32 id) private view returns (Series storage s) {
        s = _series[id]; if (s.config.stateCount == 0) revert UnknownSeries();
    }
}
