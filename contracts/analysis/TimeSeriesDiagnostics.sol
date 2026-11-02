// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {FloatMath} from "../math/FloatMath.sol";

/// @notice Bounded single-series initial-positive/monotone autocorrelation analysis.
/// @dev The stationary reversible-chain interpretation is a model assumption;
///      these diagnostics cannot establish stationarity or validate all observables.
contract TimeSeriesDiagnostics {
    error Unauthorized();error InvalidInput();error UnknownSeries();error InvalidStage();error DependencyChanged();
    enum Status { Missing, Collecting, Mean, Covariance, Sequence, Completed }
    struct Configuration {
        bytes32 protocolHash;bytes32 runHash;bytes32 replicaHash;bytes32 observableHash;
        uint32 state;uint32 expectedSamples;uint64 firstStep;uint64 stride;uint16 maxLag;uint32 minimumSamples;
    }
    struct Series {
        Configuration config;bytes32 digest;bytes32 resultDigest;Status status;
        uint32 count;uint32 cursor;uint16 lag;uint16 pair;uint16 usedLag;
        bytes16 mean;bytes16 m2;bytes16 covarianceSum;bytes16 pairSum;bytes16 previousPair;bytes16 g;bytes16 effectiveSamples;
        bool constantSeries;bool shortSeries;bool truncated;bool hasVariation;
        bytes16[] values;mapping(uint256=>bytes16) covariance;
    }
    struct Summary {
        bytes32 inputDigest;bytes32 resultDigest;Status status;uint32 samples;uint32 cursor;uint16 lag;uint16 usedLag;
        bytes16 mean;bytes16 populationVariance;bytes16 sampleVariance;bytes16 g;bytes16 effectiveSamples;
        bool constantSeries;bool shortSeries;bool truncated;bool validEstimate;
    }
    address public immutable writer;FloatMath public immutable numericalMath;
    bytes32 public immutable writerCodeHash;bytes32 public immutable mathCodeHash;
    uint256 public constant MAX_SAMPLES=4096;uint256 public constant MAX_LAG=255;
    uint256 public constant MAX_APPEND=64;uint256 public constant MAX_WORK=32;
    bytes16 private constant ONE=0x3fff0000000000000000000000000000;
    bytes16 private constant TWO=0x40000000000000000000000000000000;
    mapping(bytes32=>Series)private _series;
    event SeriesRegistered(bytes32 indexed id,bytes32 digest);
    event SeriesSealed(bytes32 indexed id,bytes32 digest);
    event DiagnosticsCompleted(bytes32 indexed id,bytes32 resultDigest,bool validEstimate);
    constructor(address writer_,address math_){
        if(writer_.code.length==0||math_.code.length==0)revert InvalidInput();
        writer=writer_;numericalMath=FloatMath(math_);writerCodeHash=writer_.codehash;mathCodeHash=math_.codehash;
    }
    function createSeries(bytes32 id,Configuration calldata c)external{
        _writer();
        if(id==bytes32(0)||_series[id].status!=Status.Missing||c.protocolHash==bytes32(0)||c.runHash==bytes32(0)
            ||c.replicaHash==bytes32(0)||c.observableHash==bytes32(0)||c.expectedSamples==0||c.expectedSamples>MAX_SAMPLES
            ||c.stride==0||c.minimumSamples<4||c.minimumSamples>MAX_SAMPLES||c.maxLag>MAX_LAG
            ||(c.expectedSamples==1?c.maxLag!=0:(c.maxLag==0||c.maxLag%2!=1||c.maxLag>=c.expectedSamples))
            ||uint256(c.firstStep)+uint256(c.expectedSamples-1)*c.stride>type(uint64).max)revert InvalidInput();
        Series storage s=_series[id];s.config=c;s.status=Status.Collecting;
        s.shortSeries=c.expectedSamples<c.minimumSamples;
        s.digest=keccak256(abi.encode(bytes32("ORVIA-TIMESERIES-v1"),block.chainid,address(this),id,
            writer,writerCodeHash,address(numericalMath),mathCodeHash,c));
        emit SeriesRegistered(id,s.digest);
    }
    function append(bytes32 id,uint64 firstStep,bytes16[] calldata values)external{
        _writer();Series storage s=_get(id);if(s.status!=Status.Collecting)revert InvalidStage();
        if(values.length==0||values.length>MAX_APPEND||uint256(s.count)+values.length>s.config.expectedSamples
            ||uint256(firstStep)!=uint256(s.config.firstStep)+uint256(s.count)*s.config.stride)revert InvalidInput();
        for(uint256 i;i<values.length;++i){
            if(!numericalMath.isFinite(values[i]))revert InvalidInput();
            bytes16 value=numericalMath.add(values[i],bytes16(0));
            if(s.count!=0&&numericalMath.compare(value,s.values[0])!=0)s.hasVariation=true;
            s.values.push(value);
            s.digest=keccak256(abi.encode(s.digest,s.count,uint256(firstStep)+i*s.config.stride,value));++s.count;
        }
    }
    function seal(bytes32 id)external{
        _writer();Series storage s=_get(id);if(s.status!=Status.Collecting)revert InvalidStage();
        if(s.count!=s.config.expectedSamples)revert InvalidInput();s.status=Status.Mean;emit SeriesSealed(id,s.digest);
    }
    function advance(bytes32 id,uint256 workLimit)external returns(uint256 processed,bool completed){
        _dependencies();if(workLimit==0||workLimit>MAX_WORK)revert InvalidInput();Series storage s=_get(id);
        if(s.status<Status.Mean||s.status==Status.Completed)revert InvalidStage();
        while(processed<workLimit&&s.status!=Status.Completed){
            if(s.status==Status.Mean)_mean(s,id);else if(s.status==Status.Covariance)_covariance(s);else _sequence(s,id);++processed;
        }completed=s.status==Status.Completed;
    }
    function _mean(Series storage s,bytes32 id)private{
        FloatMath m=numericalMath;bytes16 x=s.values[s.cursor];bytes16 delta=m.sub(x,s.mean);++s.cursor;
        bytes16 increment=m.div(delta,m.fromUInt(s.cursor));s.mean=m.add(s.mean,increment);
        s.m2=m.add(s.m2,m.mul(delta,m.sub(x,s.mean)));
        if(s.cursor==s.count){
            if(m.compare(s.m2,bytes16(0))<0)revert InvalidInput();
            s.covariance[0]=m.div(s.m2,m.fromUInt(s.count));s.cursor=0;
            if(m.isZero(s.covariance[0])){if(s.hasVariation)revert InvalidInput();s.constantSeries=true;_complete(s,id);}
            else{s.lag=1;s.status=Status.Covariance;}
        }
    }
    function _covariance(Series storage s)private{
        FloatMath m=numericalMath;
        bytes16 a=m.sub(s.values[s.cursor],s.mean);bytes16 b=m.sub(s.values[s.cursor+s.lag],s.mean);
        s.covarianceSum=m.add(s.covarianceSum,m.mul(a,b));++s.cursor;
        if(s.cursor==s.count-s.lag){
            s.covariance[s.lag]=m.div(s.covarianceSum,m.fromUInt(s.count));s.cursor=0;s.covarianceSum=bytes16(0);
            if(s.lag==s.config.maxLag)s.status=Status.Sequence;else ++s.lag;
        }
    }
    function _sequence(Series storage s,bytes32 id)private{
        FloatMath m=numericalMath;uint256 lag=uint256(s.pair)*2;
        bytes16 pair=m.add(s.covariance[lag],s.covariance[lag+1]);
        if(m.compare(pair,bytes16(0))<=0){_complete(s,id);return;}
        if(s.pair!=0&&m.compare(pair,s.previousPair)>0)pair=s.previousPair;
        s.previousPair=pair;s.pairSum=m.add(s.pairSum,pair);s.usedLag=uint16(lag+1);++s.pair;
        if(s.usedLag==s.config.maxLag){s.truncated=true;_complete(s,id);}
    }
    function _complete(Series storage s,bytes32 id)private{
        if(!s.constantSeries){
            FloatMath m=numericalMath;bytes16 ratio=m.div(s.pairSum,s.covariance[0]);
            s.g=m.sub(m.mul(TWO,ratio),ONE);if(m.compare(s.g,ONE)<0)s.g=ONE;
            s.effectiveSamples=m.div(m.fromUInt(s.count),s.g);
        }
        s.status=Status.Completed;
        s.resultDigest=keccak256(abi.encode(s.digest,s.mean,s.covariance[0],s.g,s.effectiveSamples,s.usedLag,s.constantSeries,s.shortSeries,s.truncated));
        emit DiagnosticsCompleted(id,s.resultDigest,!s.constantSeries&&!s.shortSeries&&!s.truncated);
    }
    function configuration(bytes32 id)external view returns(Configuration memory){return _get(id).config;}
    function valueAt(bytes32 id,uint256 index)external view returns(bytes16){Series storage s=_get(id);if(index>=s.count)revert InvalidInput();return s.values[index];}
    function covarianceAt(bytes32 id,uint256 lag)external view returns(bytes16){Series storage s=_get(id);if(s.status!=Status.Completed||lag>s.config.maxLag)revert InvalidInput();if(s.constantSeries)return bytes16(0);return s.covariance[lag];}
    function summary(bytes32 id)external view returns(Summary memory out){
        Series storage s=_get(id);out.inputDigest=s.digest;out.resultDigest=s.resultDigest;out.status=s.status;out.samples=s.count;out.cursor=s.cursor;
        out.lag=s.lag;out.usedLag=s.usedLag;out.mean=s.mean;out.populationVariance=s.covariance[0];
        if(s.count>1&&s.status==Status.Completed)out.sampleVariance=numericalMath.div(s.m2,numericalMath.fromUInt(s.count-1));
        out.g=s.g;out.effectiveSamples=s.effectiveSamples;out.constantSeries=s.constantSeries;out.shortSeries=s.shortSeries;out.truncated=s.truncated;
        out.validEstimate=s.status==Status.Completed&&!s.constantSeries&&!s.shortSeries&&!s.truncated;
    }
    function assertCompleted(bytes32 id)external view returns(bytes32 digest,bool validEstimate){
        _dependencies();Series storage s=_get(id);if(s.status!=Status.Completed)revert InvalidStage();return(s.resultDigest,!s.constantSeries&&!s.shortSeries&&!s.truncated);
    }
    function _writer()private view{if(msg.sender!=writer)revert Unauthorized();_dependencies();}
    function _dependencies()private view{if(writer.codehash!=writerCodeHash||address(numericalMath).codehash!=mathCodeHash)revert DependencyChanged();}
    function _get(bytes32 id)private view returns(Series storage s){s=_series[id];if(s.status==Status.Missing)revert UnknownSeries();}
}
