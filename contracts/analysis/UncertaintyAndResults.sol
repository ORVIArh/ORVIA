// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {FloatMath} from "../math/FloatMath.sol";
import {ReducedPotentialCollector} from "./ReducedPotentialCollector.sol";
import {MBARFreeEnergyEstimator} from "./MBARFreeEnergyEstimator.sol";
import {SamplingDiagnostics} from "./SamplingDiagnostics.sol";
import {IMolecularCampaignSource} from "../interfaces/IMolecularCampaignSource.sol";

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
        address molecularSource;bytes32 molecularSourceHash;bytes32 samplingPolicyHash;
        bytes32 complexModel;bytes32 solventModel;
        bytes32[] complexCampaigns;bytes32[] solventCampaigns;
        bytes32[] complexCommitments;bytes32[] solventCommitments;
    }
    struct Result {
        bytes32 planId;bytes32 commitment;uint8 cursor;bool completed;bytes16 mean;bytes16 m2;bytes16 sem;
        uint256[] complexDiagnostics;uint256[] solventDiagnostics;
    }
    struct LegResult {ReducedPotentialCollector.Configuration config;bytes32 seriesId;bytes32 commitment;bytes16 g;uint256 analysisId;}
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
    /// @notice Preregister molecular repeats before any window starts. Selected
    ///         series are resolved later using the frozen on-chain thinning rule.
    function registerMolecularPlan(bytes32 planId,bytes32 campaignHash,address source,
        bytes32[] calldata complexCampaigns,bytes32[] calldata solventCampaigns)external{
        if(msg.sender!=owner)revert Unauthorized();_dependencies();
        if(planId==bytes32(0)||campaignHash==bytes32(0)||campaignPlan[campaignHash]!=bytes32(0)||_plans[planId].campaignHash!=bytes32(0)
            ||complexCampaigns.length<3||complexCampaigns.length>MAX_REPEATS||complexCampaigns.length!=solventCampaigns.length
            ||source.code.length==0||collector.writer()!=source||collector.writerCodeHash()!=source.codehash)revert InvalidInput();
        IMolecularCampaignSource pipeline=IMolecularCampaignSource(source);
        if(pipeline.owner()!=owner||pipeline.collector()!=address(collector)||pipeline.estimator()!=address(estimator))revert InvalidInput();
        campaignPlan[campaignHash]=planId;Plan storage p=_plans[planId];p.campaignHash=campaignHash;
        p.molecularSource=source;p.molecularSourceHash=source.codehash;
        p.complexCampaigns=complexCampaigns;p.solventCampaigns=solventCampaigns;
        p.commitment=keccak256(abi.encode(bytes32("ORVIA-MOLECULAR-REPEATS-v1"),block.chainid,address(this),planId,
            configurationHash,campaignHash,source,p.molecularSourceHash,complexCampaigns,solventCampaigns));
        for(uint256 i;i<complexCampaigns.length;++i)_registerMolecularPair(p,i);
        emit PlanRegistered(planId,campaignHash,p.commitment);
    }
    function _registerMolecularPair(Plan storage p,uint256 index)private{
        IMolecularCampaignSource pipeline=IMolecularCampaignSource(p.molecularSource);
        IMolecularCampaignSource.Registration memory c=pipeline.campaignRegistration(p.complexCampaigns[index]);
        IMolecularCampaignSource.Registration memory s=pipeline.campaignRegistration(p.solventCampaigns[index]);
        if(c.commitment==bytes32(0)||s.commitment==bytes32(0)||c.selectedSeries==s.selectedSeries
            ||c.config.leg!=COMPLEX_LEG||s.config.leg!=SOLVENT_LEG||c.config.protocolHash!=s.config.protocolHash
            ||c.config.repeatSeed!=s.config.repeatSeed||c.config.kT!=s.config.kT||c.config.stateCount!=s.config.stateCount
            ||p.seeds[c.config.repeatSeed]||c.samplingPolicyHash!=s.samplingPolicyHash)revert InvalidInput();
        bytes32 policy=_policy(c.config);if(policy!=_policy(s.config))revert InvalidInput();
        if(index==0){
            p.protocolHash=c.config.protocolHash;p.policyHash=policy;p.kT=c.config.kT;p.states=c.config.stateCount;
            p.samplingPolicyHash=c.samplingPolicyHash;p.complexModel=c.modelHash;p.solventModel=s.modelHash;
        }else if(p.protocolHash!=c.config.protocolHash||p.policyHash!=policy||p.kT!=c.config.kT||p.states!=c.config.stateCount
            ||p.samplingPolicyHash!=c.samplingPolicyHash||p.complexModel!=c.modelHash||p.solventModel!=s.modelHash)revert InvalidInput();
        p.seeds[c.config.repeatSeed]=true;p.complexSeries.push(c.selectedSeries);p.solventSeries.push(s.selectedSeries);
        p.complexCommitments.push(c.commitment);p.solventCommitments.push(s.commitment);
        p.commitment=keccak256(abi.encode(p.commitment,index,c,s));
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
        if(p.molecularSource!=address(0)){
            if(p.molecularSource.codehash!=p.molecularSourceHash)revert DependencyChanged();
            _assertMolecularLeg(p,p.complexCampaigns[r.cursor],p.complexCommitments[r.cursor],c);
            _assertMolecularLeg(p,p.solventCampaigns[r.cursor],p.solventCommitments[r.cursor],s);
        }
        r.commitment=keccak256(abi.encode(r.commitment,r.cursor,c.commitment,s.commitment));
        _accumulate(r,numericalMath.sub(c.g,s.g));
    }
    function _assertMolecularLeg(Plan storage p,bytes32 campaign,bytes32 expected,LegResult memory leg)private view{
        (bytes32 commitment,bytes32 series,uint256 analysis)=IMolecularCampaignSource(p.molecularSource).campaignAnalysis(campaign);
        if(commitment!=expected||series!=leg.seriesId||analysis!=leg.analysisId||leg.config.runHash!=expected)revert DependencyChanged();
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
        out.analysisId=analysisId;
        (bytes32 seriesId,bytes32 analysisCommitment,,uint8 states)=estimator.assertConverged(analysisId);
        (out.config,,,)=collector.seriesInfo(seriesId);if(out.config.leg!=expectedLeg)revert InvalidInput();out.seriesId=seriesId;
        bytes16 difference=numericalMath.sub(estimator.fAt(analysisId,states-1),estimator.fAt(analysisId,0));
        out.g=numericalMath.mul(out.config.kT,difference);
        out.commitment=keccak256(abi.encode(diagnosticId,diagnosticCommitment,analysisId,analysisCommitment));
    }
    function planInfo(bytes32 planId)external view returns(bytes32 campaignHash,bytes32 protocolHash,bytes32 commitment,bytes32[] memory complexSeries,bytes32[] memory solventSeries){
        Plan storage p=_plan(planId);return(p.campaignHash,p.protocolHash,p.commitment,p.complexSeries,p.solventSeries);
    }
    function molecularPlanInfo(bytes32 planId)external view returns(address source,bytes32 sourceHash,bytes32[] memory complexCampaigns,bytes32[] memory solventCampaigns){
        Plan storage p=_plan(planId);return(p.molecularSource,p.molecularSourceHash,p.complexCampaigns,p.solventCampaigns);
    }
    function resultInfo(uint256 id)external view returns(bytes32 planId,bytes32 protocolHash,bytes32 commitment,uint8 repeatsCompleted,uint256 repeatsExpected,bool completed,bytes16 deltaDeltaG,bytes16 repeatSEM){
        Result storage r=_get(id);return(r.planId,_plans[r.planId].protocolHash,r.commitment,r.cursor,r.complexDiagnostics.length,r.completed,r.mean,r.sem);
    }
    function _dependencies()private view{if(address(diagnostics).codehash!=dependencyHashes[0]||address(estimator).codehash!=dependencyHashes[1]||address(collector).codehash!=dependencyHashes[2]||address(numericalMath).codehash!=dependencyHashes[3])revert DependencyChanged();}
    function _plan(bytes32 planId)private view returns(Plan storage p){p=_plans[planId];if(p.campaignHash==bytes32(0))revert InvalidInput();}
    function _get(uint256 id)private view returns(Result storage r){r=_results[id];if(r.planId==bytes32(0))revert UnknownResult();}
}
