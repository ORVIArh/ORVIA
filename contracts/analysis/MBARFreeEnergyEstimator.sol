// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {FloatMath} from "../math/FloatMath.sol";
import {ReducedPotentialCollector} from "./ReducedPotentialCollector.sol";

interface IMBARScalarMath {
    function numericalMath() external view returns (address);
    function ln(bytes16) external view returns (bytes16);
    function exp(bytes16) external view returns (bytes16);
}

/// @notice General sampled-state MBAR fixed-point equations, resumable by cell.
/// @dev Convergence alone is not an overlap, equilibration or uncertainty claim.
contract MBARFreeEnergyEstimator {
    error InvalidInput(); error UnknownAnalysis(); error Terminal(); error DependencyChanged();
    enum Status { Missing, Denominators, Update, Normalize, FinalDenominators, Converged, MaxIterations }
    ReducedPotentialCollector public immutable collector;
    FloatMath public immutable numericalMath;
    IMBARScalarMath public immutable scalarMath;
    bytes32[3] public dependencyHashes;
    bytes32 public immutable configurationHash;
    uint256 public constant MAX_WORK = 32;
    bytes16 private constant ONE = 0x3fff0000000000000000000000000000;
    bytes16 private constant MAX_FREE_ENERGY = 0x40050000000000000000000000000000; // 64
    struct Analysis {
        bytes32 seriesId; bytes32 sampleDigest; bytes32 commitment;
        uint32 samples; uint8 states; uint32 iterations; uint32 maxIterations;
        uint32 n; uint8 k; Status status; bytes16 tolerance; bytes16 accumulator; bytes16 residual;
        bytes16[16] f; bytes16[16] next; bytes16[16] logCounts;
        mapping(uint256 => bytes16) logDenominator;
    }
    mapping(uint256=>Analysis) private _analyses;
    uint256 public nextAnalysisId=1;
    event AnalysisCreated(uint256 indexed id,bytes32 indexed seriesId,bytes32 commitment);
    event IterationCompleted(uint256 indexed id,uint32 iteration,bytes16 residual,Status status);
    constructor(address collector_,address math_,address scalar_) {
        if (collector_.code.length==0 || math_.code.length==0 || scalar_.code.length==0
            || address(ReducedPotentialCollector(collector_).numericalMath())!=math_
            || IMBARScalarMath(scalar_).numericalMath()!=math_) revert InvalidInput();
        collector=ReducedPotentialCollector(collector_); numericalMath=FloatMath(math_); scalarMath=IMBARScalarMath(scalar_);
        dependencyHashes=[collector_.codehash,math_.codehash,scalar_.codehash];
        configurationHash=keccak256(abi.encode(collector_,math_,scalar_,dependencyHashes));
    }
    function createAnalysis(bytes32 seriesId,bytes16 tolerance,uint32 maxIterations) external returns(uint256 id) {
        _dependencies();
        if (!numericalMath.isFinite(tolerance) || numericalMath.compare(tolerance,bytes16(0))<=0
            || numericalMath.compare(tolerance,ONE)>=0 || maxIterations==0 || maxIterations>10000) revert InvalidInput();
        bytes32 digest=collector.assertSealed(seriesId);
        (ReducedPotentialCollector.Configuration memory config,,uint32 count,)=collector.seriesInfo(seriesId);
        if(tolerance!=config.mbarTolerance)revert InvalidInput();
        id=nextAnalysisId++; Analysis storage a=_analyses[id];
        a.seriesId=seriesId;a.sampleDigest=digest;a.samples=count;a.states=config.stateCount;
        a.maxIterations=maxIterations;a.tolerance=tolerance;a.status=Status.Denominators;
        a.commitment=keccak256(abi.encode(bytes32("ORVIA-MBAR-v1"),block.chainid,address(this),id,
            seriesId,digest,configurationHash,tolerance,maxIterations));
        for(uint256 k;k<a.states;++k) a.logCounts[k]=scalarMath.ln(numericalMath.fromUInt(collector.stateCount(seriesId,k)));
        emit AnalysisCreated(id,seriesId,a.commitment);
    }
    function advanceAnalysis(uint256 id,uint256 workLimit) external returns(uint256 processed,bool terminal) {
        if(workLimit==0 || workLimit>MAX_WORK) revert InvalidInput();
        _dependencies(); Analysis storage a=_get(id);
        if(a.status>=Status.Converged) revert Terminal();
        if(collector.assertSealed(a.seriesId)!=a.sampleDigest) revert DependencyChanged();
        while(processed<workLimit && a.status<Status.Converged) {
            if(a.status==Status.Denominators || a.status==Status.FinalDenominators) _denominator(a);
            else if(a.status==Status.Update) _update(a);
            else _normalize(a,id);
            ++processed;
        }
        terminal=a.status>=Status.Converged;
    }
    function _denominator(Analysis storage a) private {
        FloatMath m=numericalMath;
        bytes16 term=m.sub(m.add(a.logCounts[a.k],a.f[a.k]),collector.potential(a.seriesId,a.n,a.k));
        a.accumulator=a.k==0?term:_logAdd(a.accumulator,term);
        ++a.k;
        if(a.k==a.states) {
            a.logDenominator[a.n]=a.accumulator;a.k=0;++a.n;
            if(a.n==a.samples) {a.n=0;a.status=a.status==Status.FinalDenominators?Status.Converged:Status.Update;}
        }
    }
    function _update(Analysis storage a) private {
        bytes16 term=numericalMath.neg(numericalMath.add(collector.potential(a.seriesId,a.n,a.k),a.logDenominator[a.n]));
        a.accumulator=a.n==0?term:_logAdd(a.accumulator,term);
        ++a.n;
        if(a.n==a.samples) {
            a.next[a.k]=numericalMath.neg(a.accumulator);a.n=0;++a.k;
            if(a.k==a.states){a.k=0;a.residual=bytes16(0);a.status=Status.Normalize;}
        }
    }
    function _normalize(Analysis storage a,uint256 id) private {
        FloatMath m=numericalMath;
        bytes16 next=m.sub(a.next[a.k],a.next[0]);
        if(m.compare(m.abs(next),MAX_FREE_ENERGY)>0) revert InvalidInput();
        bytes16 change=m.abs(m.sub(next,a.f[a.k]));
        if(m.compare(change,a.residual)>0)a.residual=change;
        a.f[a.k]=next;++a.k;
        if(a.k==a.states){
            a.k=0;++a.iterations;
            if(m.compare(a.residual,a.tolerance)<=0)a.status=Status.FinalDenominators;
            else if(a.iterations==a.maxIterations)a.status=Status.MaxIterations;
            else a.status=Status.Denominators;
            emit IterationCompleted(id,a.iterations,a.residual,a.status);
        }
    }
    function _logAdd(bytes16 a,bytes16 b) private view returns(bytes16) {
        FloatMath m=numericalMath;
        if(m.compare(a,b)<0)(a,b)=(b,a);
        bytes16 delta=m.sub(b,a);
        bytes16 correction=scalarMath.exp(delta);
        correction=m.add(ONE,correction);
        correction=scalarMath.ln(correction);
        return m.add(a,correction);
    }
    function runInfo(uint256 id) external view returns(bytes32 seriesId,bytes32 commitment,uint32 samples,uint8 states,
        uint32 iterations,uint32 maxIterations,uint32 sampleCursor,uint8 stateCursor,Status status,bytes16 residual,bytes16 tolerance) {
        Analysis storage a=_get(id);return(a.seriesId,a.commitment,a.samples,a.states,a.iterations,a.maxIterations,a.n,a.k,a.status,a.residual,a.tolerance);
    }
    function fAt(uint256 id,uint256 k) external view returns(bytes16){Analysis storage a=_get(id);if(k>=a.states)revert InvalidInput();return a.f[k];}
    function logDenominatorAt(uint256 id,uint256 n) external view returns(bytes16){Analysis storage a=_get(id);if(n>=a.samples || a.status!=Status.Converged)revert InvalidInput();return a.logDenominator[n];}
    function assertConverged(uint256 id) external view returns(bytes32 seriesId,bytes32 commitment,uint32 samples,uint8 states){
        _dependencies();Analysis storage a=_get(id);if(a.status!=Status.Converged)revert InvalidInput();
        if(collector.assertSealed(a.seriesId)!=a.sampleDigest)revert DependencyChanged();return(a.seriesId,a.commitment,a.samples,a.states);
    }
    function _dependencies() private view {if(address(collector).codehash!=dependencyHashes[0] || address(numericalMath).codehash!=dependencyHashes[1] || address(scalarMath).codehash!=dependencyHashes[2])revert DependencyChanged();}
    function _get(uint256 id) private view returns(Analysis storage a){a=_analyses[id];if(a.status==Status.Missing)revert UnknownAnalysis();}
}
