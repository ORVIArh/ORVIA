// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {FloatMath} from "../math/FloatMath.sol";
import {ReducedPotentialCollector} from "./ReducedPotentialCollector.sol";
import {MBARFreeEnergyEstimator} from "./MBARFreeEnergyEstimator.sol";
import {SamplingDiagnostics} from "./SamplingDiagnostics.sol";

/// @notice Mean and SEM of a complete preregistered set of paired leg estimates.
/// @dev Repeat-level SEM is not MBAR covariance, a confidence interval, proof of
///      equilibration, or a remedy for shared systematic bias among repeats.
contract UncertaintyAndResults {
    error Unauthorized();error InvalidInput();error UnknownResult();error Terminal();error DependencyChanged();
    address public immutable owner;
    SamplingDiagnostics public immutable diagnostics;MBARFreeEnergyEstimator public immutable estimator;
    ReducedPotentialCollector public immutable collector;FloatMath public immutable numericalMath;
    bytes32[4] public dependencyHashes;bytes32 public immutable configurationHash;
    bytes32 public constant COMPLEX_LEG=keccak256("ORVIA.COMPLEX.v1");
    bytes32 public constant SOLVENT_LEG=keccak256("ORVIA.SOLVENT.v1");
    uint256 public constant MAX_REPEATS=32;uint256 public constant MAX_WORK=8;
    struct Plan {
        bytes32 campaignHash;bytes32 protocolHash;bytes32 policyHash;bytes32 commitment;bytes16 kT;uint8 states;
        bytes32[] complexSeries;bytes32[] solventSeries;mapping(bytes32=>bool) seeds;
    }
    struct Result {
        bytes32 planId;bytes32 commitment;uint8 cursor;bool completed;bytes16 mean;bytes16 m2;bytes16 sem;
        uint256[] complexDiagnostics;uint256[] solventDiagnostics;
    }
    struct LegResult {ReducedPotentialCollector.Configuration config;bytes32 seriesId;bytes32 commitment;bytes16 g;}
    mapping(bytes32=>bytes32)public campaignPlan;
    mapping(bytes32=>Plan)private _plans;mapping(uint256=>Result)private _results;uint256 public nextResultId=1;
    event PlanRegistered(bytes32 indexed planId,bytes32 indexed campaignHash,bytes32 commitment);
    event ResultCreated(uint256 indexed id,bytes32 indexed planId,bytes32 commitment);
    event ResultCompleted(uint256 indexed id,bytes16 deltaDeltaG,bytes16 repeatSEM,uint8 repeats);
    constructor(address diagnostics_,address owner_){
        if(diagnostics_.code.length==0||owner_==address(0))revert InvalidInput();owner=owner_;diagnostics=SamplingDiagnostics(diagnostics_);
        estimator=diagnostics.estimator();collector=diagnostics.collector();numericalMath=diagnostics.numericalMath();
        dependencyHashes=[diagnostics_.codehash,address(estimator).codehash,address(collector).codehash,address(numericalMath).codehash];
        configurationHash=keccak256(abi.encode(owner_,diagnostics_,address(estimator),address(collector),address(numericalMath),dependencyHashes));
    }
    function registerPlan(bytes32 planId,bytes32 campaignHash,bytes32[] calldata complexSeries,bytes32[] calldata solventSeries)external{
        if(msg.sender!=owner)revert Unauthorized();_dependencies();
        if(planId==bytes32(0)||campaignHash==bytes32(0)||campaignPlan[campaignHash]!=bytes32(0)||_plans[planId].campaignHash!=bytes32(0)
            ||complexSeries.length<3||complexSeries.length>MAX_REPEATS||complexSeries.length!=solventSeries.length)revert InvalidInput();
        campaignPlan[campaignHash]=planId;
        Plan storage p=_plans[planId];p.campaignHash=campaignHash;p.complexSeries=complexSeries;p.solventSeries=solventSeries;
        p.commitment=keccak256(abi.encode(bytes32("ORVIA-REPEAT-PLAN-v1"),block.chainid,address(this),planId,
            configurationHash,campaignHash,complexSeries,solventSeries));
        for(uint256 i;i<complexSeries.length;++i)_registerPair(p,complexSeries[i],solventSeries[i],i);
        emit PlanRegistered(planId,campaignHash,p.commitment);
    }
    function _registerPair(Plan storage p,bytes32 complexId,bytes32 solventId,uint256 index)private{
        (ReducedPotentialCollector.Configuration memory c,bytes32 cd,uint32 cn,bool cs)=collector.seriesInfo(complexId);
        (ReducedPotentialCollector.Configuration memory s,bytes32 sd,uint32 sn,bool ss)=collector.seriesInfo(solventId);
        if(cn!=0||sn!=0||cs||ss||c.leg!=COMPLEX_LEG||s.leg!=SOLVENT_LEG||c.protocolHash!=s.protocolHash
            ||c.repeatSeed!=s.repeatSeed||c.kT!=s.kT||c.stateCount!=s.stateCount||p.seeds[c.repeatSeed])revert InvalidInput();
        bytes32 policy=_policy(c);if(policy!=_policy(s))revert InvalidInput();
        if(index==0){p.protocolHash=c.protocolHash;p.policyHash=policy;p.kT=c.kT;p.states=c.stateCount;}
        else if(p.protocolHash!=c.protocolHash||p.policyHash!=policy||p.kT!=c.kT||p.states!=c.stateCount)revert InvalidInput();
        p.seeds[c.repeatSeed]=true;p.commitment=keccak256(abi.encode(p.commitment,index,cd,sd,c.repeatSeed));
    }
    function createResult(bytes32 planId,uint256[] calldata complexDiagnostics,uint256[] calldata solventDiagnostics)external returns(uint256 id){
        _dependencies();Plan storage p=_plan(planId);
        if(complexDiagnostics.length!=p.complexSeries.length||solventDiagnostics.length!=p.solventSeries.length)revert InvalidInput();
        id=nextResultId++;Result storage r=_results[id];r.planId=planId;
        r.complexDiagnostics=complexDiagnostics;r.solventDiagnostics=solventDiagnostics;
        r.commitment=keccak256(abi.encode(bytes32("ORVIA-REPEAT-RESULT-v1"),block.chainid,address(this),id,
            configurationHash,planId,p.commitment,complexDiagnostics,solventDiagnostics));
        emit ResultCreated(id,planId,r.commitment);
    }
    function advanceResult(uint256 id,uint256 workLimit)external returns(uint256 processed,bool completed){
        _dependencies();if(workLimit==0||workLimit>MAX_WORK)revert InvalidInput();Result storage r=_get(id);if(r.completed)revert Terminal();
        while(processed<workLimit&&!r.completed){_repeat(r);++processed;}
        completed=r.completed;if(completed)emit ResultCompleted(id,r.mean,r.sem,r.cursor);
    }
    function _repeat(Result storage r)private{
        Plan storage p=_plan(r.planId);
        LegResult memory c=_leg(r.complexDiagnostics[r.cursor],COMPLEX_LEG);
        LegResult memory s=_leg(r.solventDiagnostics[r.cursor],SOLVENT_LEG);
        if(c.seriesId!=p.complexSeries[r.cursor]||s.seriesId!=p.solventSeries[r.cursor])revert InvalidInput();
        r.commitment=keccak256(abi.encode(r.commitment,r.cursor,c.commitment,s.commitment));
        _accumulate(r,numericalMath.sub(c.g,s.g));
    }
    function _policy(ReducedPotentialCollector.Configuration memory c)private pure returns(bytes32){
        return keccak256(abi.encode(c.mbarTolerance,c.overlapThreshold,c.minimumESS,c.normalizationTolerance));
    }
    function _accumulate(Result storage r,bytes16 value)private{
        FloatMath m=numericalMath;++r.cursor;bytes16 delta=m.sub(value,r.mean);
        bytes16 meanIncrement=m.div(delta,m.fromUInt(r.cursor));r.mean=m.add(r.mean,meanIncrement);
        r.m2=m.add(r.m2,m.mul(delta,m.sub(value,r.mean)));
        if(r.cursor==r.complexDiagnostics.length){
            if(m.compare(r.m2,bytes16(0))<0)revert InvalidInput();
            bytes16 denominator=m.fromUInt(uint256(r.cursor)*(r.cursor-1));
            r.sem=m.sqrt(m.div(r.m2,denominator));r.completed=true;
        }
    }
    function _leg(uint256 diagnosticId,bytes32 expectedLeg)private view returns(LegResult memory out){
        (uint256 analysisId,bytes32 diagnosticCommitment)=diagnostics.assertAccepted(diagnosticId);
        (bytes32 seriesId,bytes32 analysisCommitment,,uint8 states)=estimator.assertConverged(analysisId);
        (out.config,,,)=collector.seriesInfo(seriesId);if(out.config.leg!=expectedLeg)revert InvalidInput();out.seriesId=seriesId;
        bytes16 difference=numericalMath.sub(estimator.fAt(analysisId,states-1),estimator.fAt(analysisId,0));
        out.g=numericalMath.mul(out.config.kT,difference);
        out.commitment=keccak256(abi.encode(diagnosticId,diagnosticCommitment,analysisId,analysisCommitment));
    }
    function planInfo(bytes32 planId)external view returns(bytes32 campaignHash,bytes32 protocolHash,bytes32 commitment,bytes32[] memory complexSeries,bytes32[] memory solventSeries){
        Plan storage p=_plan(planId);return(p.campaignHash,p.protocolHash,p.commitment,p.complexSeries,p.solventSeries);
    }
    function resultInfo(uint256 id)external view returns(bytes32 planId,bytes32 protocolHash,bytes32 commitment,uint8 repeatsCompleted,uint256 repeatsExpected,bool completed,bytes16 deltaDeltaG,bytes16 repeatSEM){
        Result storage r=_get(id);return(r.planId,_plans[r.planId].protocolHash,r.commitment,r.cursor,r.complexDiagnostics.length,r.completed,r.mean,r.sem);
    }
    function _dependencies()private view{if(address(diagnostics).codehash!=dependencyHashes[0]||address(estimator).codehash!=dependencyHashes[1]||address(collector).codehash!=dependencyHashes[2]||address(numericalMath).codehash!=dependencyHashes[3])revert DependencyChanged();}
    function _plan(bytes32 planId)private view returns(Plan storage p){p=_plans[planId];if(p.campaignHash==bytes32(0))revert InvalidInput();}
    function _get(uint256 id)private view returns(Result storage r){r=_results[id];if(r.planId==bytes32(0))revert UnknownResult();}
}
