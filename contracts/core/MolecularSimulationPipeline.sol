// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AlchemicalTopologyCatalog} from "./AlchemicalTopologyCatalog.sol";
import {AlchemicalHamiltonianEvaluator,IProductionWordState} from "./AlchemicalHamiltonianEvaluator.sol";
import {ExperimentRegistry} from "./ExperimentRegistry.sol";
import {FloatMath} from "../math/FloatMath.sol";
import {LangevinBAOABKernel} from "../kernels/LangevinBAOABKernel.sol";
import {CounterRandom} from "../kernels/CounterRandom.sol";
import {ReducedPotentialCollector} from "../analysis/ReducedPotentialCollector.sol";
import {TimeSeriesDiagnostics} from "../analysis/TimeSeriesDiagnostics.sol";
import {MBARFreeEnergyEstimator} from "../analysis/MBARFreeEnergyEstimator.sol";
import {IMolecularCampaignSource} from "../interfaces/IMolecularCampaignSource.sol";

/// @notice Authenticated NVT dynamics -> frozen cross-state energies -> analysis.
/// @dev One supported unconstrained, fixed-box hybrid Hamiltonian is used for
///      both sampled forces and every cross-state energy. No EOA supplies a
///      force/energy/sample, and partial positions never become committed state.
///      Full molecular preparation, ensemble validation and campaign feasibility
///      remain scientific requirements; this contract cannot certify them.
contract MolecularSimulationPipeline {
    error Unauthorized(); error InvalidInput(); error WrongStage(); error DependencyChanged(); error NotConfigured();
    enum Stage { Missing, Loading, InitialEvaluation, InitialForces, Ready, Drift, StepEvaluation, StepForces, CrossStart, CrossEvaluation, Record, Complete, HandedOff, Copying }
    enum AnalysisStage { Collecting, FlushRaw, Chronology, Selecting, Selected, Analyzing }
    struct Modules { address registry; address topology; address math; address integrator; address random; }
    struct Policy {
        bytes32 protocol; bytes32 topology; bytes32 leg; bytes32 seed; bytes32 stream;
        uint32 replica; bytes16 dt; bytes16 friction; bytes16 kT;
        uint64 equilibrationSteps; uint64 stride; uint32 samplesPerState;
        uint16 maxLag; uint32 minimumChronologySamples;
        bytes16 mbarTolerance; bytes16 overlapThreshold; bytes16 minimumESS; bytes16 normalizationTolerance;
        uint32 maxMbarIterations;
    }
    struct Campaign {
        Policy policy; bytes32 commitment; bytes32 topologyCommitment; uint8 states; uint8 completedWindows;
        AnalysisStage analysisStage; uint32 flushCursor; uint8 selectionState; uint32 selectionOrdinal;
        uint32 selectedExpected; uint32 selectedCount; uint256 analysisId;
        uint32[16] thinning; uint256[16] activeRuns; uint32[16] windowSamples;
    }
    struct Run {
        bytes32 campaign; uint8 state; Stage stage; uint32 cursor; uint64 step; uint256 parent;
        bytes32 commitment; bytes32 workingNamespace; bytes32 committedSnapshot; bytes32 sourceSnapshot;
        uint64 snapshotSerial; uint256 evaluation; uint256 sampledEvaluation; bytes32 sampledEvaluationCommitment; uint8 crossState; bytes16 energy;
        bytes16[16] sampleEnergies; bytes32 evaluationDigest; uint256[] evaluationHistory;
    }
    struct Sample {
        bytes32 snapshot; bytes32 snapshotCommitment; bytes32 runCommitment; bytes32 evaluationDigest;
        uint64 step; uint256 run; bytes16[16] energies;
    }
    address public immutable owner;
    Modules public modules; bytes32[5] public moduleHashes; bytes32 public immutable coreConfigurationHash;
    IProductionWordState public statePage; AlchemicalHamiltonianEvaluator public hamiltonian;
    ReducedPotentialCollector public collector; TimeSeriesDiagnostics public chronology; MBARFreeEnergyEstimator public estimator;
    bytes32[5] public boundHashes;
    uint256 public nextRun = 1; uint256 public constant MAX_WORK = 8;
    mapping(bytes32 => Campaign) private campaigns;
    mapping(uint256 => Run) private runs;
    mapping(bytes32 => mapping(uint32 => Sample)) private samples;
    event CampaignCreated(bytes32 indexed id, bytes32 commitment);
    event WindowStarted(bytes32 indexed campaign,uint8 state,uint256 run,bytes32 commitment);
    event CheckpointCommitted(uint256 indexed run,uint64 step,bytes32 snapshot,bytes32 snapshotCommitment);
    event WindowContinued(uint256 indexed parent,uint256 indexed child,bytes32 checkpoint);
    event MolecularSampleRecorded(bytes32 indexed campaign,uint32 sample,uint8 state,uint64 step,bytes32 snapshot,bytes32 evaluationDigest);

    constructor(address owner_,Modules memory m) {
        if(owner_==address(0))revert InvalidInput();owner=owner_;modules=m;address[5] memory addresses=_addresses(m);
        for(uint256 i;i<5;++i){if(addresses[i].code.length==0)revert InvalidInput();moduleHashes[i]=addresses[i].codehash;}
        if(address(AlchemicalTopologyCatalog(m.topology).numericalMath())!=m.math
            ||address(LangevinBAOABKernel(m.integrator).numericalMath())!=m.math
            ||address(CounterRandom(m.random).numericalMath())!=m.math
            ||address(LangevinBAOABKernel(m.integrator).scalarMath())!=address(CounterRandom(m.random).scalarMath()))revert InvalidInput();
        coreConfigurationHash=keccak256(abi.encode(m,moduleHashes));
    }
    function bind(address page,address evaluator,address evaluatorOutput,address collector_,address chronology_,address estimator_)external{
        if(msg.sender!=owner)revert Unauthorized();if(address(statePage)!=address(0))revert WrongStage();
        address[5] memory addresses=[page,evaluator,collector_,chronology_,estimator_];for(uint256 i;i<5;++i)if(addresses[i].code.length==0)revert InvalidInput();
        if(IProductionWordState(page).writer()!=address(this)||AlchemicalHamiltonianEvaluator(evaluator).owner()!=address(this)
            ||ReducedPotentialCollector(collector_).writer()!=address(this)||TimeSeriesDiagnostics(chronology_).writer()!=address(this)
            ||address(ReducedPotentialCollector(collector_).numericalMath())!=modules.math
            ||address(TimeSeriesDiagnostics(chronology_).numericalMath())!=modules.math
            ||address(MBARFreeEnergyEstimator(estimator_).collector())!=collector_)revert InvalidInput();
        AlchemicalHamiltonianEvaluator.Modules memory hm=AlchemicalHamiltonianEvaluator(evaluator).moduleConfiguration();
        if(hm.topology!=modules.topology||hm.math!=modules.math)revert InvalidInput();
        AlchemicalHamiltonianEvaluator(evaluator).bindOutputPage(evaluatorOutput);
        statePage=IProductionWordState(page);hamiltonian=AlchemicalHamiltonianEvaluator(evaluator);
        collector=ReducedPotentialCollector(collector_);chronology=TimeSeriesDiagnostics(chronology_);estimator=MBARFreeEnergyEstimator(estimator_);
        for(uint256 i;i<5;++i)boundHashes[i]=addresses[i].codehash;
    }
    function createCampaign(bytes32 id,Policy calldata policy)external{
        if(msg.sender!=owner)revert Unauthorized();bytes32 manifest=_dependencies(policy.protocol);
        if(id==bytes32(0)||campaigns[id].commitment!=bytes32(0)||policy.leg==bytes32(0)||policy.seed==bytes32(0)||policy.stream==bytes32(0)
            ||policy.replica>0x00ffffff||policy.samplesPerState<4||policy.minimumChronologySamples<4||policy.minimumChronologySamples>policy.samplesPerState
            ||policy.maxLag==0||policy.maxLag%2!=1||policy.maxLag>255||policy.maxLag>=policy.samplesPerState||policy.stride==0||policy.maxMbarIterations==0||policy.maxMbarIterations>10000)revert InvalidInput();
        _positive(policy.dt);_positive(policy.kT);_nonnegative(policy.friction);
        LangevinBAOABKernel(modules.integrator).coefficients(FloatMath(modules.math).fromUInt(1),policy.dt,policy.friction,policy.kT);
        uint8 states=AlchemicalTopologyCatalog(modules.topology).stateCount(policy.topology);
        if(uint256(states)*policy.samplesPerState>collector.MAX_SAMPLES()
            ||uint256(policy.equilibrationSteps)+uint256(policy.stride)*policy.samplesPerState>type(uint64).max)revert InvalidInput();
        Campaign storage c=campaigns[id];c.policy=policy;c.states=states;c.topologyCommitment=AlchemicalTopologyCatalog(modules.topology).assertTopology(policy.topology);
        c.commitment=keccak256(abi.encode(bytes32("ORVIA-MOLECULAR-CAMPAIGN-v1"),block.chainid,address(this),id,manifest,coreConfigurationHash,boundHashes,policy,c.topologyCommitment));
        collector.createSeries(_rawSeries(id),_collectionPolicy(c,uint32(states)*policy.samplesPerState));
        emit CampaignCreated(id,c.commitment);
    }
    function startWindow(bytes32 campaign,uint8 state)external returns(uint256 id){
        // Only the owner chooses when sampling starts, so third parties cannot
        // invalidate repeat preregistration by front-running campaign setup.
        // Once started, every computational advance remains permissionless.
        if(msg.sender!=owner)revert Unauthorized();
        Campaign storage c=_campaign(campaign);_dependencies(c.policy.protocol);
        if(c.analysisStage!=AnalysisStage.Collecting||state>=c.states||c.activeRuns[state]!=0)revert InvalidInput();
        id=_newRun(campaign,state,0);c.activeRuns[state]=id;
        TimeSeriesDiagnostics.Configuration memory tc;
        tc.protocolHash=c.policy.protocol;tc.runHash=c.commitment;tc.replicaHash=keccak256(abi.encode(c.policy.seed,c.policy.stream,c.policy.replica,state));
        tc.observableHash=keccak256("ORVIA.Molecular.SampledPotentialEnergy.v1");tc.state=state;tc.expectedSamples=c.policy.samplesPerState;
        tc.firstStep=c.policy.equilibrationSteps+c.policy.stride;tc.stride=c.policy.stride;tc.maxLag=c.policy.maxLag;tc.minimumSamples=c.policy.minimumChronologySamples;
        chronology.createSeries(_chronologySeries(campaign,state),tc);
    }
    function continueWindow(uint256 parent)external returns(uint256 child){
        if(msg.sender!=owner)revert Unauthorized();Run storage previous=_run(parent);Campaign storage c=_campaign(previous.campaign);_dependencies(c.policy.protocol);
        if(previous.stage!=Stage.Ready||c.activeRuns[previous.state]!=parent)revert WrongStage();
        child=_newRun(previous.campaign,previous.state,parent);Run storage r=runs[child];
        r.step=previous.step;r.sourceSnapshot=previous.committedSnapshot;r.committedSnapshot=previous.committedSnapshot;r.energy=previous.energy;
        r.stage=Stage.Copying;previous.stage=Stage.HandedOff;c.activeRuns[previous.state]=child;
        emit WindowContinued(parent,child,previous.committedSnapshot);
    }
    function advance(uint256 id,uint256 work)external returns(uint256 processed,bool complete){
        if(work==0||work>MAX_WORK)revert InvalidInput();Run storage r=_run(id);Campaign storage c=_campaign(r.campaign);_dependencies(c.policy.protocol);
        if(r.stage==Stage.Complete||r.stage==Stage.HandedOff||c.activeRuns[r.state]!=id)revert WrongStage();
        AlchemicalTopologyCatalog.Definition memory d=AlchemicalTopologyCatalog(modules.topology).definition(c.policy.topology);
        while(processed<work&&r.stage!=Stage.Complete){
            if(r.stage==Stage.InitialEvaluation||r.stage==Stage.StepEvaluation||r.stage==Stage.CrossEvaluation){
                (uint256 used,bool finished)=hamiltonian.advance(r.evaluation,work-processed);processed+=used;
                if(finished)_evaluationFinished(r);
            }else{_one(id,r,c,d);++processed;}
        }
        complete=r.stage==Stage.Complete;
    }
    function _one(uint256 id,Run storage r,Campaign storage c,AlchemicalTopologyCatalog.Definition memory d)private{
        if(r.stage==Stage.Loading){
            bytes32[] memory words=new bytes32[](9);uint64 atom=r.cursor;
            for(uint64 k;k<3;++k){words[k]=AlchemicalTopologyCatalog(modules.topology).word(d.positions,atom*3+k);words[k+3]=AlchemicalTopologyCatalog(modules.topology).word(d.a.particles,atom*4+k+1);}
            statePage.writeWords(r.workingNamespace,uint256(atom)*9,words);
            if(++r.cursor==d.atoms){r.cursor=0;bytes32 snapshot=_snapshot(r,id,1);_beginEvaluation(r,snapshot,r.state);r.stage=Stage.InitialEvaluation;}
        }else if(r.stage==Stage.Copying){
            bytes32[] memory words=new bytes32[](9);for(uint256 k;k<9;++k)words[k]=statePage.readWord(r.sourceSnapshot,uint256(r.cursor)*9+k);
            statePage.writeWords(r.workingNamespace,uint256(r.cursor)*9,words);
            if(++r.cursor==d.atoms){statePage.writeWord(r.workingNamespace,uint256(d.atoms)*9,_encode(r.energy));r.cursor=0;r.committedSnapshot=_snapshot(r,id,4);r.stage=Stage.Ready;}
        }else if(r.stage==Stage.InitialForces||r.stage==Stage.StepForces){
            _importForce(r,c,d);
            if(++r.cursor==d.atoms){
                r.cursor=0;statePage.writeWord(r.workingNamespace,uint256(d.atoms)*9,_encode(r.energy));
                if(r.stage==Stage.StepForces)++r.step;
                r.committedSnapshot=_snapshot(r,id,2);(,,,,bytes32 sc)=statePage.snapshotInfo(r.committedSnapshot);emit CheckpointCommitted(id,r.step,r.committedSnapshot,sc);
                if(r.step>c.policy.equilibrationSteps&&(r.step-c.policy.equilibrationSteps)%c.policy.stride==0){r.crossState=0;r.evaluationDigest=bytes32(0);r.stage=Stage.CrossStart;}
                else r.stage=Stage.Ready;
            }
        }else if(r.stage==Stage.Ready){r.cursor=0;r.stage=Stage.Drift;
        }else if(r.stage==Stage.Drift){
            _drift(r,c,d);
            if(++r.cursor==d.atoms){r.cursor=0;bytes32 snapshot=_snapshot(r,id,3);_beginEvaluation(r,snapshot,r.state);r.stage=Stage.StepEvaluation;}
        }else if(r.stage==Stage.CrossStart){
            if(r.crossState==c.states)r.stage=Stage.Record;
            else if(r.crossState==r.state){r.sampleEnergies[r.crossState]=r.energy;r.evaluationDigest=keccak256(abi.encode(r.evaluationDigest,r.state,r.sampledEvaluation,r.sampledEvaluationCommitment));++r.crossState;}
            else{_beginEvaluation(r,r.committedSnapshot,r.crossState);r.stage=Stage.CrossEvaluation;}
        }else if(r.stage==Stage.Record){_record(id,r,c);
        }else revert WrongStage();
    }
    function _newRun(bytes32 campaign,uint8 state,uint256 parent)private returns(uint256 id){
        Campaign storage c=campaigns[campaign];AlchemicalTopologyCatalog.Definition memory d=AlchemicalTopologyCatalog(modules.topology).definition(c.policy.topology);
        id=nextRun++;Run storage r=runs[id];r.campaign=campaign;r.state=state;r.parent=parent;r.stage=Stage.Loading;
        r.workingNamespace=keccak256(abi.encode(bytes32("ORVIA-MOLECULAR-WORK-v1"),block.chainid,address(this),id));
        bytes32 lineage=parent==0?bytes32(0):keccak256(abi.encode(runs[parent].commitment,runs[parent].committedSnapshot,runs[parent].step));
        r.commitment=keccak256(abi.encode(bytes32("ORVIA-MOLECULAR-RUN-v1"),block.chainid,address(this),id,c.commitment,state,parent,lineage,r.workingNamespace));
        statePage.createNamespace(r.workingNamespace,d.atoms*9+1);emit WindowStarted(campaign,state,id,r.commitment);
    }
    function _drift(Run storage r,Campaign storage c,AlchemicalTopologyCatalog.Definition memory d)private{
        bytes16[3] memory normal;
        if(c.policy.friction!=bytes16(0)){
            uint64 draw=uint64(r.cursor)*2;uint32 replica=(c.policy.replica<<8)|r.state;
            (normal[0],normal[1])=CounterRandom(modules.random).normalPair(c.policy.seed,c.policy.stream,replica,r.step,draw);
            (normal[2],)=CounterRandom(modules.random).normalPair(c.policy.seed,c.policy.stream,replica,r.step,draw+1);
        }
        bytes16 mass=_decode(AlchemicalTopologyCatalog(modules.topology).word(d.a.particles,uint64(r.cursor)*4));
        (bytes16[3] memory position,bytes16[3] memory velocity)=LangevinBAOABKernel(modules.integrator).begin(
            _vector(r.committedSnapshot,r.cursor,0),_vector(r.committedSnapshot,r.cursor,3),_vector(r.committedSnapshot,r.cursor,6),mass,c.policy.dt,c.policy.friction,c.policy.kT,normal);
        bytes32[] memory words=new bytes32[](9);for(uint256 k;k<3;++k){words[k]=_encode(position[k]);words[k+3]=_encode(velocity[k]);}
        statePage.writeWords(r.workingNamespace,uint256(r.cursor)*9,words);
    }
    function _importForce(Run storage r,Campaign storage c,AlchemicalTopologyCatalog.Definition memory d)private{
        bytes16[3] memory force=hamiltonian.forceAt(r.evaluation,r.cursor);bytes32[] memory words=new bytes32[](6);
        bytes16[3] memory velocity=_vector(r.workingNamespace,r.cursor,3);
        if(r.stage==Stage.StepForces)velocity=LangevinBAOABKernel(modules.integrator).finish(velocity,force,
            _decode(AlchemicalTopologyCatalog(modules.topology).word(d.a.particles,uint64(r.cursor)*4)),c.policy.dt);
        for(uint256 k;k<3;++k){words[k]=_encode(velocity[k]);words[k+3]=_encode(force[k]);}
        statePage.writeWords(r.workingNamespace,uint256(r.cursor)*9+3,words);
    }
    function _beginEvaluation(Run storage r,bytes32 snapshot,uint8 state)private{
        Policy storage p=campaigns[r.campaign].policy;
        r.evaluation=hamiltonian.registerEvaluation(p.protocol,p.topology,state,address(statePage),snapshot,0,9);
        r.evaluationHistory.push(r.evaluation);
    }
    function _evaluationFinished(Run storage r)private{
        (,bytes32 commitment,bytes16 energy)=hamiltonian.result(r.evaluation);
        if(r.stage==Stage.CrossEvaluation){r.sampleEnergies[r.crossState]=energy;r.evaluationDigest=keccak256(abi.encode(r.evaluationDigest,r.crossState,r.evaluation,commitment));++r.crossState;r.stage=Stage.CrossStart;}
        else{r.energy=energy;r.sampledEvaluation=r.evaluation;r.sampledEvaluationCommitment=commitment;r.cursor=0;r.stage=r.stage==Stage.InitialEvaluation?Stage.InitialForces:Stage.StepForces;}
    }
    function _record(uint256 id,Run storage r,Campaign storage c)private{
        uint32 ordinal=c.windowSamples[r.state];if(ordinal>=c.policy.samplesPerState||r.step!=c.policy.equilibrationSteps+uint64(ordinal+1)*c.policy.stride)revert InvalidInput();
        uint32 index=uint32(r.state)*c.policy.samplesPerState+ordinal;Sample storage sample=samples[r.campaign][index];
        if(sample.snapshot!=bytes32(0))revert WrongStage();(,,,,bytes32 sc)=statePage.snapshotInfo(r.committedSnapshot);
        sample.snapshot=r.committedSnapshot;sample.snapshotCommitment=sc;sample.runCommitment=r.commitment;sample.run=id;sample.step=r.step;sample.energies=r.sampleEnergies;
        sample.evaluationDigest=keccak256(abi.encode(r.evaluationDigest,r.state,r.energy,sc));
        bytes16[] memory observable=new bytes16[](1);observable[0]=r.energy;chronology.append(_chronologySeries(r.campaign,r.state),r.step,observable);
        ++c.windowSamples[r.state];emit MolecularSampleRecorded(r.campaign,index,r.state,r.step,r.committedSnapshot,sample.evaluationDigest);
        if(c.windowSamples[r.state]==c.policy.samplesPerState){
            chronology.seal(_chronologySeries(r.campaign,r.state));r.stage=Stage.Complete;++c.completedWindows;
            if(c.completedWindows==c.states)c.analysisStage=AnalysisStage.FlushRaw;
        }else r.stage=Stage.Ready;
    }
    /// @notice Materialize a canonical state-major matrix, independent of window interleaving.
    function flushRaw(bytes32 id,uint256 work)external returns(uint256 processed,bool complete){
        Campaign storage c=_campaign(id);_dependencies(c.policy.protocol);if(c.analysisStage!=AnalysisStage.FlushRaw||work==0||work>MAX_WORK)revert WrongStage();
        uint32 count=uint32(c.states)*c.policy.samplesPerState;
        while(processed<work&&c.flushCursor<count){uint32 index=c.flushCursor;uint8 state=uint8(index/c.policy.samplesPerState);_append(id,_rawSeries(id),index,state);++c.flushCursor;++processed;}
        complete=c.flushCursor==count;if(complete){collector.seal(_rawSeries(id));c.analysisStage=AnalysisStage.Chronology;}
    }
    /// @notice Frozen rule: choose every ceil(g)th chronological sample per state.
    /// @dev Correlation estimates are finite-sample model diagnostics, not a proof
    ///      that every slow molecular observable has equilibrated or decorrelated.
    function beginSelection(bytes32 id)external{
        Campaign storage c=_campaign(id);_dependencies(c.policy.protocol);if(c.analysisStage!=AnalysisStage.Chronology)revert WrongStage();
        uint32 total;FloatMath m=FloatMath(modules.math);
        for(uint8 k;k<c.states;++k){
            ( ,bool valid)=chronology.assertCompleted(_chronologySeries(id,k));if(!valid)revert WrongStage();
            TimeSeriesDiagnostics.Summary memory s=chronology.summary(_chronologySeries(id,k));
            if(m.compare(s.effectiveSamples,c.policy.minimumESS)<0)revert WrongStage();
            uint32 thin=_ceil(s.g,c.policy.samplesPerState);uint32 retained=(c.policy.samplesPerState-1)/thin+1;
            if(m.compare(m.fromUInt(retained),c.policy.minimumESS)<0)revert WrongStage();c.thinning[k]=thin;total+=retained;
        }
        c.selectedExpected=total;collector.createSeries(_selectedSeries(id),_collectionPolicy(c,total));c.analysisStage=AnalysisStage.Selecting;
    }
    function advanceSelection(bytes32 id,uint256 work)external returns(uint256 processed,bool complete){
        Campaign storage c=_campaign(id);_dependencies(c.policy.protocol);if(c.analysisStage!=AnalysisStage.Selecting||work==0||work>MAX_WORK)revert WrongStage();
        while(processed<work&&c.selectionState<c.states){
            uint32 ordinal=c.selectionOrdinal*c.thinning[c.selectionState];
            _append(id,_selectedSeries(id),uint32(c.selectionState)*c.policy.samplesPerState+ordinal,c.selectionState);++c.selectedCount;++c.selectionOrdinal;++processed;
            if(uint256(c.selectionOrdinal)*c.thinning[c.selectionState]>=c.policy.samplesPerState){++c.selectionState;c.selectionOrdinal=0;}
        }
        complete=c.selectionState==c.states;if(complete){if(c.selectedCount!=c.selectedExpected)revert InvalidInput();collector.seal(_selectedSeries(id));c.analysisStage=AnalysisStage.Selected;}
    }
    function startAnalysis(bytes32 id)external returns(uint256 analysisId){
        Campaign storage c=_campaign(id);_dependencies(c.policy.protocol);if(c.analysisStage!=AnalysisStage.Selected)revert WrongStage();
        analysisId=estimator.createAnalysis(_selectedSeries(id),c.policy.mbarTolerance,c.policy.maxMbarIterations);c.analysisId=analysisId;c.analysisStage=AnalysisStage.Analyzing;
    }
    function _append(bytes32 id,bytes32 series,uint32 index,uint8 state)private{
        Campaign storage c=campaigns[id];Sample storage sample=samples[id][index];if(sample.snapshot==bytes32(0))revert WrongStage();
        (,,,,bytes32 sc)=statePage.snapshotInfo(sample.snapshot);if(sc!=sample.snapshotCommitment)revert DependencyChanged();
        bytes16[] memory energies=new bytes16[](c.states);for(uint256 k;k<c.states;++k)energies[k]=sample.energies[k];
        collector.appendSample(series,state,sample.step,energies);
    }
    function _collectionPolicy(Campaign storage c,uint32 expected)private view returns(ReducedPotentialCollector.Configuration memory p){
        p.protocolHash=c.policy.protocol;p.runHash=c.commitment;p.leg=c.policy.leg;p.repeatSeed=c.policy.seed;p.stateCount=c.states;p.expectedSamples=expected;p.kT=c.policy.kT;
        p.stride=c.policy.stride;p.equilibrationEnd=c.policy.equilibrationSteps;p.mbarTolerance=c.policy.mbarTolerance;p.overlapThreshold=c.policy.overlapThreshold;p.minimumESS=c.policy.minimumESS;p.normalizationTolerance=c.policy.normalizationTolerance;
    }
    function _snapshot(Run storage r,uint256 id,uint8 kind)private returns(bytes32 snapshot){
        snapshot=keccak256(abi.encode(bytes32("ORVIA-MOLECULAR-SNAPSHOT-v1"),block.chainid,address(this),id,++r.snapshotSerial,kind,r.step));statePage.snapshotNamespace(r.workingNamespace,snapshot);
    }
    function _vector(bytes32 ns,uint32 atom,uint32 offset)private view returns(bytes16[3] memory vector){for(uint256 k;k<3;++k)vector[k]=_decode(statePage.readWord(ns,uint256(atom)*9+offset+k));}
    function _ceil(bytes16 g,uint32 maximum)private view returns(uint32){FloatMath m=FloatMath(modules.math);if(m.compare(g,m.fromUInt(maximum))>0)revert InvalidInput();uint32 low=1;uint32 high=maximum;while(low<high){uint32 mid=low+(high-low)/2;if(m.compare(m.fromUInt(mid),g)<0)low=mid+1;else high=mid;}return low;}
    function campaignInfo(bytes32 id)external view returns(bytes32 commitment,AnalysisStage stage,uint8 states,uint8 completed,uint256 analysisId,uint32 selectedExpected){Campaign storage c=_campaign(id);return(c.commitment,c.analysisStage,c.states,c.completedWindows,c.analysisId,c.selectedExpected);}
    /// @notice Freeze repeat membership before any trajectory can be observed.
    /// @dev The future selected-series identifier is deterministic even though its
    ///      sample count is only known after the registered chronology rule runs.
    function campaignRegistration(bytes32 id)external view returns(IMolecularCampaignSource.Registration memory out){
        Campaign storage c=_campaign(id);_dependencies(c.policy.protocol);
        if(c.analysisStage!=AnalysisStage.Collecting)revert WrongStage();
        for(uint256 k;k<c.states;++k)if(c.activeRuns[k]!=0)revert WrongStage();
        out.commitment=c.commitment;out.selectedSeries=_selectedSeries(id);
        out.config=_collectionPolicy(c,uint32(c.states)*c.policy.samplesPerState);
        Policy storage p=c.policy;
        out.samplingPolicyHash=keccak256(abi.encode(p.dt,p.friction,p.kT,p.equilibrationSteps,p.stride,
            p.samplesPerState,p.maxLag,p.minimumChronologySamples,p.maxMbarIterations));
        out.modelHash=c.topologyCommitment;
    }
    /// @notice Bind a selected analysis back to its original dynamics campaign.
    function campaignAnalysis(bytes32 id)external view returns(bytes32 commitment,bytes32 series,uint256 analysis){
        Campaign storage c=_campaign(id);_dependencies(c.policy.protocol);
        if(c.analysisStage!=AnalysisStage.Analyzing||c.analysisId==0)revert WrongStage();
        (bytes32 actual,,,)=estimator.assertConverged(c.analysisId);
        series=_selectedSeries(id);if(actual!=series)revert DependencyChanged();
        return(c.commitment,series,c.analysisId);
    }
    function runInfo(uint256 id)external view returns(bytes32 campaign,uint8 state,Stage stage,uint64 step,uint32 cursor,uint256 parent,bytes32 commitment,bytes32 checkpoint){Run storage r=_run(id);return(r.campaign,r.state,r.stage,r.step,r.cursor,r.parent,r.commitment,r.committedSnapshot);}
    function stateAt(uint256 id,uint32 atom)external view returns(bytes16[3] memory position,bytes16[3] memory velocity,bytes16[3] memory force){Run storage r=_run(id);if(r.committedSnapshot==bytes32(0)||atom>=AlchemicalTopologyCatalog(modules.topology).definition(campaigns[r.campaign].policy.topology).atoms)revert WrongStage();return(_vector(r.committedSnapshot,atom,0),_vector(r.committedSnapshot,atom,3),_vector(r.committedSnapshot,atom,6));}
    function sampleInfo(bytes32 id,uint32 index)external view returns(bytes32 snapshot,bytes32 snapshotCommitment,bytes32 runCommitment,bytes32 evaluationDigest,uint64 step,uint256 run){Sample storage s=samples[id][index];if(s.snapshot==bytes32(0))revert InvalidInput();return(s.snapshot,s.snapshotCommitment,s.runCommitment,s.evaluationDigest,s.step,s.run);}
    function sampleEnergy(bytes32 id,uint32 sample,uint8 state)external view returns(bytes16){if(state>=_campaign(id).states||samples[id][sample].snapshot==bytes32(0))revert InvalidInput();return samples[id][sample].energies[state];}
    function evaluationHistory(uint256 id,uint256 index)external view returns(uint256){return _run(id).evaluationHistory[index];}
    function chronologySeries(bytes32 id,uint8 state)external pure returns(bytes32){return _chronologySeries(id,state);}
    function rawSeries(bytes32 id)external pure returns(bytes32){return _rawSeries(id);}
    function selectedSeries(bytes32 id)external pure returns(bytes32){return _selectedSeries(id);}
    function _rawSeries(bytes32 id)private pure returns(bytes32){return keccak256(abi.encode(bytes32("ORVIA-MOLECULAR-RAW-v1"),id));}
    function _selectedSeries(bytes32 id)private pure returns(bytes32){return keccak256(abi.encode(bytes32("ORVIA-MOLECULAR-SELECTED-v1"),id));}
    function _chronologySeries(bytes32 id,uint8 state)private pure returns(bytes32){return keccak256(abi.encode(bytes32("ORVIA-MOLECULAR-TIME-v1"),id,state));}
    function _dependencies(bytes32 protocol)private view returns(bytes32 manifest){
        if(address(statePage)==address(0))revert NotConfigured();ExperimentRegistry registry=ExperimentRegistry(modules.registry);manifest=registry.assertProtocol(protocol);address[5] memory a=_addresses(modules);
        for(uint256 i;i<5;++i){if(a[i].codehash!=moduleHashes[i])revert DependencyChanged();if(i!=0)registry.assertModule(protocol,a[i],moduleHashes[i]);}
        address[5] memory b=[address(statePage),address(hamiltonian),address(collector),address(chronology),address(estimator)];
        for(uint256 i;i<5;++i){if(b[i].codehash!=boundHashes[i])revert DependencyChanged();registry.assertModule(protocol,b[i],boundHashes[i]);}
        registry.assertModule(protocol,address(this),address(this).codehash);
    }
    function _addresses(Modules memory m)private pure returns(address[5] memory){return[m.registry,m.topology,m.math,m.integrator,m.random];}
    function _campaign(bytes32 id)private view returns(Campaign storage c){c=campaigns[id];if(c.commitment==bytes32(0))revert InvalidInput();}
    function _run(uint256 id)private view returns(Run storage r){r=runs[id];if(r.stage==Stage.Missing)revert InvalidInput();}
    function _positive(bytes16 x)private view{if(!FloatMath(modules.math).isFinite(x)||FloatMath(modules.math).compare(x,bytes16(0))<=0)revert InvalidInput();}
    function _nonnegative(bytes16 x)private view{if(!FloatMath(modules.math).isFinite(x)||FloatMath(modules.math).compare(x,bytes16(0))<0)revert InvalidInput();}
    function _decode(bytes32 word)private pure returns(bytes16 value){if(uint256(word)>>128!=0)revert InvalidInput();value=bytes16(uint128(uint256(word)));if(((uint128(value)>>112)&0x7fff)==0x7fff)revert InvalidInput();}
    function _encode(bytes16 value)private pure returns(bytes32){if(((uint128(value)>>112)&0x7fff)==0x7fff)revert InvalidInput();return bytes32(uint256(uint128(value)));}
}
