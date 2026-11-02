// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {FloatMath} from "../math/FloatMath.sol";
import {ReducedPotentialCollector} from "./ReducedPotentialCollector.sol";
import {MBARFreeEnergyEstimator,IMBARScalarMath} from "./MBARFreeEnergyEstimator.sol";

/// @notice Resumable MBAR weight ESS and overlap diagnostics.
/// @dev Weight ESS does not correct temporal correlation or prove equilibration.
contract SamplingDiagnostics {
    error InvalidInput();error UnknownDiagnostic();error Terminal();error DependencyChanged();
    enum Status { Missing, Weights, Overlap, Summary, Completed }
    MBARFreeEnergyEstimator public immutable estimator;
    ReducedPotentialCollector public immutable collector;
    FloatMath public immutable numericalMath;
    IMBARScalarMath public immutable scalarMath;
    bytes32[4] public dependencyHashes;
    bytes32 public immutable configurationHash;
    bytes16 private constant ONE=0x3fff0000000000000000000000000000;
    uint256 public constant MAX_WORK=32;
    struct Diagnostic {
        uint256 analysisId;bytes32 seriesId;bytes32 analysisCommitment;bytes32 commitment;
        uint32 samples;uint8 states;uint32 n;uint8 i;uint8 j;Status status;
        bytes16 edgeThreshold;bytes16 minimumESS;bytes16 normalizationTolerance;
        bool normalized;bool sufficientESS;bool connected;
        bytes16 accumulator;bytes16[16] weightSum;bytes16[16] weightSquared;bytes16[16] effectiveSamples;
        uint16[16] adjacency;
        mapping(uint256=>bytes16) weights;mapping(uint256=>bytes16) overlaps;
    }
    mapping(uint256=>Diagnostic) private _diagnostics;uint256 public nextDiagnosticId=1;
    event DiagnosticCreated(uint256 indexed id,uint256 indexed analysisId,bytes32 commitment);
    event DiagnosticCompleted(uint256 indexed id,bool normalized,bool sufficientESS,bool connected);
    constructor(address estimator_) {
        if(estimator_.code.length==0)revert InvalidInput();
        estimator=MBARFreeEnergyEstimator(estimator_);collector=estimator.collector();numericalMath=estimator.numericalMath();scalarMath=estimator.scalarMath();
        dependencyHashes=[estimator_.codehash,address(collector).codehash,address(numericalMath).codehash,address(scalarMath).codehash];
        configurationHash=keccak256(abi.encode(estimator_,address(collector),address(numericalMath),address(scalarMath),dependencyHashes));
    }
    function createDiagnostic(uint256 analysisId,bytes16 edgeThreshold,bytes16 minimumESS,bytes16 normalizationTolerance)external returns(uint256 id){
        _dependencies();FloatMath m=numericalMath;
        if(!m.isFinite(edgeThreshold)||!m.isFinite(minimumESS)||!m.isFinite(normalizationTolerance)
            ||m.compare(edgeThreshold,bytes16(0))<=0||m.compare(edgeThreshold,ONE)>=0
            ||m.compare(minimumESS,ONE)<0||m.compare(normalizationTolerance,bytes16(0))<=0||m.compare(normalizationTolerance,ONE)>=0)revert InvalidInput();
        (bytes32 seriesId,bytes32 commitment,uint32 samples,uint8 states)=estimator.assertConverged(analysisId);
        if(m.compare(minimumESS,m.fromUInt(samples))>0)revert InvalidInput();
        _assertPolicy(seriesId,edgeThreshold,minimumESS,normalizationTolerance);
        id=nextDiagnosticId++;Diagnostic storage d=_diagnostics[id];
        d.analysisId=analysisId;d.seriesId=seriesId;d.analysisCommitment=commitment;d.samples=samples;d.states=states;
        d.edgeThreshold=edgeThreshold;d.minimumESS=minimumESS;d.normalizationTolerance=normalizationTolerance;
        d.normalized=true;d.sufficientESS=true;d.status=Status.Weights;
        d.commitment=_commitment(d,id);
        emit DiagnosticCreated(id,analysisId,d.commitment);
    }
    function _assertPolicy(bytes32 seriesId,bytes16 edge,bytes16 ess,bytes16 normalization)private view{
        (ReducedPotentialCollector.Configuration memory c,,,)=collector.seriesInfo(seriesId);
        if(edge!=c.overlapThreshold||ess!=c.minimumESS||normalization!=c.normalizationTolerance)revert InvalidInput();
    }
    function _commitment(Diagnostic storage d,uint256 id)private view returns(bytes32){
        bytes32 thresholds=keccak256(abi.encode(d.edgeThreshold,d.minimumESS,d.normalizationTolerance));
        return keccak256(abi.encode(bytes32("ORVIA-MBAR-DIAG-v1"),block.chainid,address(this),id,
            configurationHash,d.analysisId,d.analysisCommitment,thresholds));
    }
    function advanceDiagnostic(uint256 id,uint256 workLimit)external returns(uint256 processed,bool complete){
        if(workLimit==0||workLimit>MAX_WORK)revert InvalidInput();_dependencies();Diagnostic storage d=_get(id);
        if(d.status==Status.Completed)revert Terminal();
        (,bytes32 commitment,,)=estimator.assertConverged(d.analysisId);if(commitment!=d.analysisCommitment)revert DependencyChanged();
        while(processed<workLimit&&d.status!=Status.Completed){
            if(d.status==Status.Weights)_weight(d);else if(d.status==Status.Overlap)_overlap(d);else _summary(d,id);++processed;
        }complete=d.status==Status.Completed;
    }
    function _weight(Diagnostic storage d)private{
        FloatMath m=numericalMath;
        bytes16 exponent=m.sub(estimator.fAt(d.analysisId,d.i),collector.potential(d.seriesId,d.n,d.i));
        exponent=m.sub(exponent,estimator.logDenominatorAt(d.analysisId,d.n));
        bytes16 weight=scalarMath.exp(exponent);d.weights[uint256(d.n)*d.states+d.i]=weight;
        d.weightSum[d.i]=m.add(d.weightSum[d.i],weight);d.weightSquared[d.i]=m.add(d.weightSquared[d.i],m.mul(weight,weight));
        ++d.i;if(d.i==d.states){d.i=0;++d.n;if(d.n==d.samples){d.n=0;d.status=Status.Overlap;}}
    }
    function _overlap(Diagnostic storage d)private{
        FloatMath m=numericalMath;uint256 offset=uint256(d.n)*d.states;
        bytes16 product=m.mul(d.weights[offset+d.i],d.weights[offset+d.j]);
        d.accumulator=d.n==0?product:m.add(d.accumulator,product);++d.n;
        if(d.n==d.samples){
            bytes16 value=m.mul(m.fromUInt(collector.stateCount(d.seriesId,d.j)),d.accumulator);
            d.overlaps[uint256(d.i)*d.states+d.j]=value;d.n=0;++d.j;
            if(d.j==d.states){d.j=0;++d.i;if(d.i==d.states){d.i=0;d.status=Status.Summary;}}
        }
    }
    function _summary(Diagnostic storage d,uint256 id)private{
        FloatMath m=numericalMath;uint256 i=d.i;
        if(m.compare(m.abs(m.sub(d.weightSum[i],ONE)),d.normalizationTolerance)>0)d.normalized=false;
        bytes16 ess=m.div(m.mul(d.weightSum[i],d.weightSum[i]),d.weightSquared[i]);d.effectiveSamples[i]=ess;
        if(m.compare(ess,d.minimumESS)<0)d.sufficientESS=false;
        uint16 edges=uint16(uint256(1)<<i);
        for(uint256 j;j<d.states;++j){
            if(m.compare(d.overlaps[i*d.states+j],d.edgeThreshold)>=0
                &&m.compare(d.overlaps[j*d.states+i],d.edgeThreshold)>=0)edges|=uint16(uint256(1)<<j);
        }d.adjacency[i]=edges;++d.i;
        if(d.i==d.states){
            uint16 reached=1;
            for(uint256 pass;pass<d.states;++pass){uint16 next=reached;for(uint256 j;j<d.states;++j)if(reached&(uint16(uint256(1)<<j))!=0)next|=d.adjacency[j];if(next==reached)break;reached=next;}
            d.connected=uint256(reached)==(uint256(1)<<d.states)-1;d.status=Status.Completed;
            emit DiagnosticCompleted(id,d.normalized,d.sufficientESS,d.connected);
        }
    }
    function runInfo(uint256 id)external view returns(uint256 analysisId,bytes32 commitment,Status status,uint32 sampleCursor,uint8 rowCursor,uint8 columnCursor,bool normalized,bool sufficientESS,bool connected){
        Diagnostic storage d=_get(id);return(d.analysisId,d.commitment,d.status,d.n,d.i,d.j,d.normalized,d.sufficientESS,d.connected);
    }
    function stateDiagnostics(uint256 id,uint256 k)external view returns(bytes16 weightSum,bytes16 effectiveSamples){Diagnostic storage d=_get(id);if(k>=d.states||d.status!=Status.Completed)revert InvalidInput();return(d.weightSum[k],d.effectiveSamples[k]);}
    function overlap(uint256 id,uint256 i,uint256 j)external view returns(bytes16){Diagnostic storage d=_get(id);if(i>=d.states||j>=d.states||d.status!=Status.Completed)revert InvalidInput();return d.overlaps[i*d.states+j];}
    function assertAccepted(uint256 id)external view returns(uint256 analysisId,bytes32 commitment){
        _dependencies();Diagnostic storage d=_get(id);if(d.status!=Status.Completed||!d.normalized||!d.sufficientESS||!d.connected)revert InvalidInput();
        (,bytes32 actual,,)=estimator.assertConverged(d.analysisId);if(actual!=d.analysisCommitment)revert DependencyChanged();return(d.analysisId,d.commitment);
    }
    function _dependencies()private view{if(address(estimator).codehash!=dependencyHashes[0]||address(collector).codehash!=dependencyHashes[1]||address(numericalMath).codehash!=dependencyHashes[2]||address(scalarMath).codehash!=dependencyHashes[3])revert DependencyChanged();}
    function _get(uint256 id)private view returns(Diagnostic storage d){d=_diagnostics[id];if(d.status==Status.Missing)revert UnknownDiagnostic();}
}
