// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AlchemicalTopologyCatalog} from "./AlchemicalTopologyCatalog.sol";
import {ExperimentRegistry} from "./ExperimentRegistry.sol";
import {FloatMath} from "../math/FloatMath.sol";
import {HarmonicBondKernel} from "../kernels/HarmonicBondKernel.sol";
import {HarmonicAngleKernel} from "../kernels/HarmonicAngleKernel.sol";
import {PeriodicTorsionKernel} from "../kernels/PeriodicTorsionKernel.sol";
import {LennardJonesKernel} from "../kernels/LennardJonesKernel.sol";
import {SoftcoreLennardJonesKernel} from "../kernels/SoftcoreLennardJonesKernel.sol";
import {OrthorhombicGeometry} from "../kernels/OrthorhombicGeometry.sol";
import {EwaldRealSpaceKernel} from "../kernels/EwaldRealSpaceKernel.sol";
import {EwaldReciprocalKernel} from "../kernels/EwaldReciprocalKernel.sol";
import {EwaldCorrections} from "../kernels/EwaldCorrections.sol";

interface IProductionWordState {
    function writer() external view returns (address);
    function createNamespace(bytes32 id, uint32 capacity) external;
    function writeWord(bytes32 id, uint256 index, bytes32 value) external;
    function writeWords(bytes32 id, uint256 start, bytes32[] calldata values) external;
    function readWord(bytes32 id, uint256 index) external view returns (bytes32);
    function namespaceInfo(bytes32 id) external view returns (uint32 capacity, bool isSealed);
    function sealNamespace(bytes32 id) external;
    function snapshotNamespace(bytes32 source, bytes32 snapshot) external returns (bytes32);
    function snapshotInfo(bytes32 id) external view returns (bytes32 source, uint64 epoch, uint32 capacity, bytes32 writeDigest, bytes32 commitment);
}
interface IProductionMathIdentity { function numericalMath() external view returns (address); }

/// @notice One complete on-chain hybrid Hamiltonian on an immutable molecular snapshot.
/// @dev NVT fixed orthorhombic box; bonded endpoint interpolation, switched dual
///      soft-core LJ and interpolated-charge finite tin-foil Ewald. No CMAP,
///      Urey-Bradley, harmonic improper, constraints, PME or tail correction is
///      silently supplied. The catalog accepts only its explicit supported schema.
contract AlchemicalHamiltonianEvaluator {
    error Unauthorized(); error InvalidInput(); error WrongStage(); error DependencyChanged(); error NotConfigured();
    enum Stage { Missing, Atoms, Bonds, Angles, Torsions, Exceptions, Pairs, ModeSetup, StructureFactor, ModeForces, Background, Complete }
    struct Modules {
        address registry; address topology; address math; address geometry;
        address bond; address angle; address torsion; address lj; address softcore;
        address realSpace; address reciprocal; address corrections;
    }
    struct Input { bytes32 protocol; bytes32 topology; uint8 state; address sourcePage; bytes32 sourceNamespace; uint32 offset; uint32 stride; }
    struct Run {
        Input input; Stage stage; uint64 cursor; uint64 pairs; uint32 modeIndex; uint32 modes;
        bytes32 topologyCommitment; bytes32 snapshotCommitment; bytes32 sourceHash; bytes32 sourceWriterHash;
        address sourceWriter; bytes32 outputNamespace; bytes32 commitment;
        bytes16 lambda; bytes16 totalCharge; bool anyCharge;
        int32[3] mode; bytes16[3] wave; bytes16 coefficient; bytes16 cosine; bytes16 sine;
    }
    struct Pair { uint32 a; uint32 b; uint32 kind; bytes16 sigmaA; bytes16 epsilonA; bytes16 desiredA; bytes16 sigmaB; bytes16 epsilonB; bytes16 desiredB; }
    struct Evaluation { bytes16 energy; bytes16[3][4] forces; }
    address public immutable owner;
    Modules public modules;
    bytes32[12] public moduleHashes;
    bytes32 public immutable coreConfigurationHash;
    IProductionWordState public outputPage;
    bytes32 public outputPageHash;
    uint256 public nextEvaluation = 1;
    uint256 public constant MAX_WORK = 8;
    bytes16 private constant ONE = 0x3fff0000000000000000000000000000;
    bytes16 private constant TWO = 0x40000000000000000000000000000000;
    mapping(uint256 => Run) private runs;
    mapping(uint256 => mapping(uint64 => uint64)) private exceptionIndex;
    event EvaluationRegistered(uint256 indexed id, bytes32 commitment, bytes32 snapshotCommitment);
    event EvaluationAdvanced(uint256 indexed id, Stage stage, uint64 cursor, uint32 mode);

    constructor(address owner_, Modules memory m) {
        if (owner_ == address(0)) revert InvalidInput(); owner = owner_; modules = m;
        address[12] memory addresses = _addresses(m);
        for (uint256 i; i < 12; ++i) {
            if (addresses[i].code.length == 0) revert InvalidInput(); moduleHashes[i] = addresses[i].codehash;
            if (i >= 3 && IProductionMathIdentity(addresses[i]).numericalMath() != m.math) revert InvalidInput();
        }
        if (address(AlchemicalTopologyCatalog(m.topology).numericalMath()) != m.math
            || address(AlchemicalTopologyCatalog(m.topology).geometry()) != m.geometry) revert InvalidInput();
        // All Ewald kernels must share their actual scalar implementation.
        if (address(EwaldRealSpaceKernel(m.realSpace).scalarMath()) != address(EwaldCorrections(m.corrections).scalarMath())
            || address(EwaldRealSpaceKernel(m.realSpace).scalarMath()) != address(EwaldReciprocalKernel(m.reciprocal).scalarMath())) revert InvalidInput();
        coreConfigurationHash = keccak256(abi.encode(m, moduleHashes));
    }
    function bindOutputPage(address page) external {
        if (msg.sender != owner) revert Unauthorized(); if (address(outputPage) != address(0)) revert WrongStage();
        if (page.code.length == 0 || IProductionWordState(page).writer() != address(this)) revert InvalidInput();
        outputPage = IProductionWordState(page); outputPageHash = page.codehash;
    }
    function registerEvaluation(bytes32 protocolId, bytes32 topologyId, uint8 state, address sourcePage,
        bytes32 sourceNamespace, uint32 offset, uint32 stride) external returns (uint256 id)
    {
        if (msg.sender != owner) revert Unauthorized();
        return _register(Input(protocolId,topologyId,state,sourcePage,sourceNamespace,offset,stride));
    }
    function _register(Input memory input) private returns(uint256 id) {
        bytes32 manifest = _dependencies(input.protocol);
        AlchemicalTopologyCatalog catalog = AlchemicalTopologyCatalog(modules.topology);
        bytes32 topologyCommitment = catalog.assertTopology(input.topology);
        AlchemicalTopologyCatalog.Definition memory d = catalog.definition(input.topology);
        if (input.state >= catalog.stateCount(input.topology) || input.sourcePage.code.length == 0 || input.stride < 3) revert InvalidInput();
        bytes32 snapshot = _checkSource(input,d.atoms);
        id = nextEvaluation++; Run storage r = runs[id];
        r.input = input;
        r.stage = Stage.Atoms; r.pairs = uint64(uint256(d.atoms) * (d.atoms - 1) / 2);
        r.topologyCommitment = topologyCommitment; r.snapshotCommitment = snapshot;
        r.sourceHash = input.sourcePage.codehash;
        r.sourceWriter = IProductionWordState(input.sourcePage).writer(); r.sourceWriterHash = r.sourceWriter.codehash;
        r.lambda = catalog.lambdaAt(input.topology, input.state); r.modes = _modeCount(d.ewaldExtent);
        r.outputNamespace = keccak256(abi.encode(bytes32("ORVIA-HAMILTONIAN-OUTPUT-v1"), block.chainid, address(this), id));
        r.commitment = _commitment(r,id,manifest);
        outputPage.createNamespace(r.outputNamespace, d.atoms * 3 + 10);
        emit EvaluationRegistered(id, r.commitment, snapshot);
    }
    function _checkSource(Input memory input,uint32 atoms) private view returns(bytes32 snapshot) {
        (uint32 capacity, bool frozen) = IProductionWordState(input.sourcePage).namespaceInfo(input.sourceNamespace);
        (,,,,snapshot) = IProductionWordState(input.sourcePage).snapshotInfo(input.sourceNamespace);
        if (!frozen || snapshot == bytes32(0) || uint256(input.offset) + uint256(atoms - 1) * input.stride + 3 > capacity) revert InvalidInput();
        address writer = IProductionWordState(input.sourcePage).writer();
        ExperimentRegistry(modules.registry).assertModule(input.protocol, input.sourcePage, input.sourcePage.codehash);
        ExperimentRegistry(modules.registry).assertModule(input.protocol, writer, writer.codehash);
    }
    function _commitment(Run storage r,uint256 id,bytes32 manifest) private view returns(bytes32) {
        bytes32 source = keccak256(abi.encode(r.input,r.snapshotCommitment,r.sourceHash,r.sourceWriter,r.sourceWriterHash));
        bytes32 configuration = keccak256(abi.encode(coreConfigurationHash,address(outputPage),outputPageHash));
        return keccak256(abi.encode(bytes32("ORVIA-HAMILTONIAN-v1"), block.chainid, address(this), id,
            manifest, configuration, r.topologyCommitment, source));
    }
    function advance(uint256 id, uint256 work) external returns (uint256 processed, bool complete) {
        if (work == 0 || work > MAX_WORK) revert InvalidInput(); Run storage r = _get(id);
        if (r.stage == Stage.Complete) revert WrongStage(); _assertRun(r);
        AlchemicalTopologyCatalog.Definition memory d = AlchemicalTopologyCatalog(modules.topology).definition(r.input.topology);
        while (processed < work && r.stage != Stage.Complete) { _one(id, r, d); ++processed; }
        complete = r.stage == Stage.Complete; emit EvaluationAdvanced(id, r.stage, r.cursor, r.modeIndex);
    }
    function result(uint256 id) external view returns (bytes32 outputNamespace, bytes32 commitment, bytes16 energy) {
        Run storage r = _get(id); if (r.stage != Stage.Complete) revert WrongStage(); _assertRun(r);
        AlchemicalTopologyCatalog.Definition memory d = AlchemicalTopologyCatalog(modules.topology).definition(r.input.topology);
        return (r.outputNamespace, r.commitment, _decode(outputPage.readWord(r.outputNamespace, uint256(d.atoms) * 3)));
    }
    function forceAt(uint256 id, uint32 atom) external view returns (bytes16[3] memory force) {
        Run storage r = _get(id); if (r.stage != Stage.Complete) revert WrongStage(); _assertRun(r);
        if (atom >= AlchemicalTopologyCatalog(modules.topology).definition(r.input.topology).atoms) revert InvalidInput();
        for (uint256 axis; axis < 3; ++axis) force[axis] = _decode(outputPage.readWord(r.outputNamespace, uint256(atom) * 3 + axis));
    }
    function components(uint256 id) external view returns (bytes16[10] memory values) {
        Run storage r = _get(id); if (r.stage != Stage.Complete) revert WrongStage(); _assertRun(r);
        uint256 start = uint256(AlchemicalTopologyCatalog(modules.topology).definition(r.input.topology).atoms) * 3;
        for (uint256 k; k < 10; ++k) values[k] = _decode(outputPage.readWord(r.outputNamespace, start + k));
    }
    function moduleConfiguration()external view returns(Modules memory){return modules;}
    function runInfo(uint256 id) external view returns (Stage stage, uint64 cursor, uint32 mode, Input memory input, bytes32 snapshotCommitment) {
        Run storage r = _get(id); return (r.stage, r.cursor, r.modeIndex, r.input, r.snapshotCommitment);
    }
    function _one(uint256 id, Run storage r, AlchemicalTopologyCatalog.Definition memory d) private {
        FloatMath m = FloatMath(modules.math);
        if (r.stage == Stage.Atoms) {
            _position(r, uint32(r.cursor)); bytes16 q = _charge(r, d, uint32(r.cursor));
            r.anyCharge = r.anyCharge || !m.isZero(q); r.totalCharge = m.add(r.totalCharge, q);
            _energy(r, d, 6, EwaldCorrections(modules.corrections).selfEnergy(q, d.ewaldAlpha, d.prefactor));
            if (++r.cursor == d.atoms) { r.cursor = 0; r.stage = Stage.Bonds; }
        } else if (r.stage == Stage.Bonds || r.stage == Stage.Angles || r.stage == Stage.Torsions) {
            uint64 count = r.stage == Stage.Bonds ? d.bonds : r.stage == Stage.Angles ? d.angles : d.torsions;
            if (count != 0) { _bonded(r, d); ++r.cursor; }
            if (r.cursor == count) { r.cursor = 0; r.stage = Stage(uint8(r.stage) + 1); }
        } else if (r.stage == Stage.Exceptions) {
            if (d.exceptions != 0) {
                Pair memory p = _exception(r, d, r.cursor);
                exceptionIndex[id][uint64(uint256(p.a) * d.atoms + p.b)] = r.cursor + 1;
                _exceptionPair(r, d, p); ++r.cursor;
            }
            if (r.cursor == d.exceptions) { r.cursor = 0; r.stage = Stage.Pairs; }
        } else if (r.stage == Stage.Pairs) {
            (uint32 a, uint32 b) = _pairIndices(r.cursor, d.atoms);
            if (exceptionIndex[id][uint64(uint256(a) * d.atoms + b)] == 0) _normalPair(r, d, a, b);
            if (++r.cursor == r.pairs) { r.cursor = 0; r.stage = r.anyCharge ? Stage.ModeSetup : Stage.Background; }
        } else if (r.stage == Stage.ModeSetup) {
            r.mode = _modeAt(r.modeIndex, d.ewaldExtent);
            (r.wave, r.coefficient) = EwaldReciprocalKernel(modules.reciprocal).waveVector(r.mode, d.box, d.ewaldAlpha, d.prefactor);
            r.cosine = bytes16(0); r.sine = bytes16(0); r.cursor = 0; r.stage = Stage.StructureFactor;
        } else if (r.stage == Stage.StructureFactor) {
            (bytes16 c, bytes16 s) = _term(r, d, uint32(r.cursor)); r.cosine = m.add(r.cosine, c); r.sine = m.add(r.sine, s);
            if (++r.cursor == d.atoms) {
                _energy(r, d, 5, EwaldReciprocalKernel(modules.reciprocal).modeEnergy(r.coefficient, r.cosine, r.sine));
                r.cursor = 0; r.stage = Stage.ModeForces;
            }
        } else if (r.stage == Stage.ModeForces) {
            (bytes16 c, bytes16 s) = _term(r, d, uint32(r.cursor));
            _force(r, uint32(r.cursor), EwaldReciprocalKernel(modules.reciprocal).forceContribution(r.wave, r.coefficient, c, s, r.cosine, r.sine), false);
            if (++r.cursor == d.atoms) { r.cursor = 0; r.stage = ++r.modeIndex == r.modes ? Stage.Background : Stage.ModeSetup; }
        } else if (r.stage == Stage.Background) {
            _energy(r, d, 7, EwaldCorrections(modules.corrections).backgroundEnergy(r.totalCharge, d.box, d.ewaldAlpha, d.prefactor));
            outputPage.sealNamespace(r.outputNamespace); r.stage = Stage.Complete;
        } else revert WrongStage();
    }
    function _bonded(Run storage r, AlchemicalTopologyCatalog.Definition memory d) private {
        uint32[4] memory atoms; uint64 width = r.stage == Stage.Bonds ? 4 : r.stage == Stage.Angles ? 5 : 7;
        uint64 n = r.stage == Stage.Bonds ? 2 : r.stage == Stage.Angles ? 3 : 4;
        bytes32 sa = r.stage == Stage.Bonds ? d.a.bonds : r.stage == Stage.Angles ? d.a.angles : d.a.torsions;
        bytes32 sb = r.stage == Stage.Bonds ? d.b.bonds : r.stage == Stage.Angles ? d.b.angles : d.b.torsions;
        for (uint64 k; k < n; ++k) atoms[k] = uint32(uint256(_word(sa, r.cursor * width + k)));
        Evaluation memory a;
        Evaluation memory b;
        if(r.lambda==ONE){b=_bondedEndpoint(r,d,sb,width,atoms);a=b;}
        else{a=_bondedEndpoint(r,d,sa,width,atoms);b=r.lambda==bytes16(0)||sa==sb?a:_bondedEndpoint(r,d,sb,width,atoms);}
        _energy(r, d, uint8(r.stage) - uint8(Stage.Bonds), _mix(a.energy, b.energy, r.lambda));
        for (uint256 k; k < n; ++k) _force(r, atoms[k], _mixVector(a.forces[k], b.forces[k], r.lambda), false);
    }
    function _bondedEndpoint(Run storage r, AlchemicalTopologyCatalog.Definition memory d, bytes32 stream, uint64 width, uint32[4] memory atoms)
        private view returns (Evaluation memory e)
    {
        if(width==4)return _bondEvaluation(r,d,stream,atoms);
        if(width==5)return _angleEvaluation(r,d,stream,atoms);
        return _torsionEvaluation(r,d,stream,atoms);
    }
    function _bondEvaluation(Run storage r,AlchemicalTopologyCatalog.Definition memory d,bytes32 stream,uint32[4] memory atoms)private view returns(Evaluation memory e){
        bytes16 k=_value(stream,r.cursor*4+2);if(k==bytes16(0))return e;
        bytes16 r0=_value(stream,r.cursor*4+3);
        bytes16[3] memory zero;
        bytes16[3] memory displacement=_bondedDisplacement(r,d,atoms[0],atoms[1]);
        (e.energy,e.forces[0])=HarmonicBondKernel(modules.bond).evaluate(zero,displacement,k,r0);
        e.forces[1]=_negative(e.forces[0]);
    }
    function _angleEvaluation(Run storage r,AlchemicalTopologyCatalog.Definition memory d,bytes32 stream,uint32[4] memory atoms)private view returns(Evaluation memory e){
        bytes16 k=_value(stream,r.cursor*5+3);if(k==bytes16(0))return e;bytes16 theta=_value(stream,r.cursor*5+4);
        bytes16[3] memory zero;bytes16[3] memory a=_bondedDisplacement(r,d,atoms[1],atoms[0]);bytes16[3] memory c=_bondedDisplacement(r,d,atoms[1],atoms[2]);
        (e.energy,e.forces[0],e.forces[1],e.forces[2])=HarmonicAngleKernel(modules.angle).evaluate(a,zero,c,k,theta);
    }
    function _torsionEvaluation(Run storage r,AlchemicalTopologyCatalog.Definition memory d,bytes32 stream,uint32[4] memory atoms)private view returns(Evaluation memory e){
        bytes16 k=_value(stream,r.cursor*7+5);if(k==bytes16(0))return e;
        bytes16[3][4] memory p;p[0]=_bondedDisplacement(r,d,atoms[1],atoms[0]);p[2]=_bondedDisplacement(r,d,atoms[1],atoms[2]);
        bytes16[3] memory last=_bondedDisplacement(r,d,atoms[2],atoms[3]);
        for(uint256 axis;axis<3;++axis)p[3][axis]=FloatMath(modules.math).add(p[2][axis],last[axis]);
        uint32 n=uint32(uint256(_word(stream,r.cursor*7+4)));bytes16 phase=_value(stream,r.cursor*7+6);
        return _torsionCall(p,n,k,phase);
    }
    function _torsionCall(bytes16[3][4] memory p,uint32 n,bytes16 k,bytes16 phase)private view returns(Evaluation memory e){
        (e.energy,e.forces[0],e.forces[1],e.forces[2],e.forces[3])=PeriodicTorsionKernel(modules.torsion).evaluate(p[0],p[1],p[2],p[3],n,k,phase);
    }
    function _normalPair(Run storage r, AlchemicalTopologyCatalog.Definition memory d, uint32 a, uint32 b) private {
        bytes16[3] memory displacement = _displacement(r, d, a, b);
        Pair memory p; p.a = a; p.b = b;
        (p.sigmaA, p.epsilonA) = _mixParticle(d.a.nonbonded, a, b);
        (p.sigmaB, p.epsilonB) = _mixParticle(d.b.nonbonded, a, b);
        (bytes16 energy, bytes16[3] memory force) = _lj(r, d, p, displacement, false);
        _energy(r, d, 3, energy); _force(r, a, force, false); _force(r, b, force, true);
        bytes16 chargeProduct = FloatMath(modules.math).mul(_charge(r, d, a), _charge(r, d, b));
        if (chargeProduct != bytes16(0)) {
            (energy, force) = EwaldRealSpaceKernel(modules.realSpace).evaluate(displacement,
                chargeProduct, d.prefactor, d.ewaldAlpha, d.cutoff);
            _energy(r, d, 4, energy); _force(r, a, force, false); _force(r, b, force, true);
        }
    }
    function _exceptionPair(Run storage r, AlchemicalTopologyCatalog.Definition memory d, Pair memory p) private {
        bytes16[3] memory displacement = _bondedDisplacement(r, d, p.a, p.b);
        if (p.kind == 2) {
            (bytes16 e, bytes16[3] memory f) = _lj(r, d, p, displacement, true);
            _energy(r, d, 3, e); _force(r, p.a, f, false); _force(r, p.b, f, true);
        }
        if (r.anyCharge || p.desiredA != bytes16(0) || p.desiredB != bytes16(0)) {
            (bytes16 e, bytes16[3] memory f) = EwaldCorrections(modules.corrections).exception(displacement,
                FloatMath(modules.math).mul(_charge(r, d, p.a), _charge(r, d, p.b)), _mix(p.desiredA, p.desiredB, r.lambda), d.prefactor, d.ewaldAlpha);
            _energy(r, d, 8, e); _force(r, p.a, f, false); _force(r, p.b, f, true);
        }
    }
    function _lj(Run storage r, AlchemicalTopologyCatalog.Definition memory d, Pair memory p, bytes16[3] memory displacement, bool direct)
        private view returns (bytes16 energy, bytes16[3] memory force)
    {
        FloatMath m = FloatMath(modules.math);
        if (p.epsilonA == bytes16(0) && p.epsilonB == bytes16(0)) return (energy, force);
        bytes16 squared;
        for (uint256 k; k < 3; ++k) squared = m.add(squared, m.mul(displacement[k], displacement[k]));
        bytes16 distance = m.sqrt(squared);
        if (!direct && m.compare(distance, d.cutoff) >= 0) return (energy, force);
        if (p.sigmaA == p.sigmaB && p.epsilonA == p.epsilonB) {
            bytes16[3] memory zero; (energy, force) = LennardJonesKernel(modules.lj).evaluate(zero, displacement, p.sigmaA, p.epsilonA);
        } else {
            SoftcoreLennardJonesKernel.Configuration memory c = SoftcoreLennardJonesKernel.Configuration(
                SoftcoreLennardJonesKernel.Endpoint(p.sigmaA,p.epsilonA),SoftcoreLennardJonesKernel.Endpoint(p.sigmaB,p.epsilonB),r.lambda,d.softcoreAlpha);
            (energy, force,) = SoftcoreLennardJonesKernel(modules.softcore).evaluate(displacement, c);
        }
        if (!direct && m.compare(distance, d.switchDistance) > 0) {
            return _applySwitch(displacement,distance,d,energy,force);
        }
    }
    function _applySwitch(bytes16[3] memory displacement,bytes16 distance,AlchemicalTopologyCatalog.Definition memory d,bytes16 energy,bytes16[3] memory force)
        private view returns(bytes16,bytes16[3] memory)
    {
        FloatMath m=FloatMath(modules.math);
        (bytes16 switching,bytes16 derivative)=_switch(distance,d.switchDistance,d.cutoff);
        bytes16 correction=m.div(m.mul(energy,derivative),distance);
        force=_combineForce(force,displacement,switching,correction);
        return(m.mul(switching,energy),force);
    }
    function _combineForce(bytes16[3] memory force,bytes16[3] memory displacement,bytes16 scale,bytes16 correction)private view returns(bytes16[3] memory){
        FloatMath m=FloatMath(modules.math);for(uint256 k;k<3;++k)force[k]=m.add(m.mul(scale,force[k]),m.mul(correction,displacement[k]));return force;
    }
    function _switch(bytes16 distance, bytes16 rs, bytes16 rc) private view returns (bytes16 value, bytes16 derivative) {
        FloatMath m = FloatMath(modules.math); bytes16 width = m.sub(rc, rs);
        bytes16 x = m.div(m.sub(distance, rs), width); bytes16 t = m.div(m.sub(rc, distance), width); bytes16 t2 = m.mul(t, t);
        value = m.mul(m.mul(t2,t), m.add(m.sub(m.fromUInt(10),m.mul(m.fromUInt(15),t)),m.mul(m.fromUInt(6),t2)));
        derivative = m.neg(m.div(m.mul(m.fromUInt(30),m.mul(m.mul(x,x),t2)),width));
    }
    function _mixParticle(bytes32 stream, uint32 a, uint32 b) private view returns (bytes16 sigma, bytes16 epsilon) {
        FloatMath m = FloatMath(modules.math);
        sigma = m.div(m.add(_value(stream,uint64(a)*3),_value(stream,uint64(b)*3)),TWO);
        epsilon = m.sqrt(m.mul(_value(stream,uint64(a)*3+1),_value(stream,uint64(b)*3+1)));
    }
    function _exception(Run storage, AlchemicalTopologyCatalog.Definition memory d, uint64 index) private view returns (Pair memory p) {
        uint64 offset = index * 6; p.a = uint32(uint256(_word(d.a.exceptions,offset))); p.b = uint32(uint256(_word(d.a.exceptions,offset+1)));
        p.kind = uint32(uint256(_word(d.a.exceptions,offset+2))); p.sigmaA = _value(d.a.exceptions,offset+3); p.epsilonA = _value(d.a.exceptions,offset+4); p.desiredA = _value(d.a.exceptions,offset+5);
        p.sigmaB = _value(d.b.exceptions,offset+3); p.epsilonB = _value(d.b.exceptions,offset+4); p.desiredB = _value(d.b.exceptions,offset+5);
    }
    function _position(Run storage r, uint32 atom) private view returns (bytes16[3] memory p) {
        for (uint256 k; k < 3; ++k) p[k] = _decode(IProductionWordState(r.input.sourcePage).readWord(r.input.sourceNamespace,uint256(r.input.offset)+uint256(atom)*r.input.stride+k));
    }
    function _displacement(Run storage r, AlchemicalTopologyCatalog.Definition memory d, uint32 a, uint32 b) private view returns (bytes16[3] memory) {
        return OrthorhombicGeometry(modules.geometry).displacement(_position(r,a),_position(r,b),d.box);
    }
    function _bondedDisplacement(Run storage r, AlchemicalTopologyCatalog.Definition memory d, uint32 a, uint32 b) private view returns (bytes16[3] memory value) {
        value = _displacement(r,d,a,b); FloatMath m = FloatMath(modules.math);
        for (uint256 k; k < 3; ++k) if (m.compare(m.abs(value[k]),m.div(d.box[k],TWO)) == 0) revert InvalidInput();
    }
    function _charge(Run storage r, AlchemicalTopologyCatalog.Definition memory d, uint32 atom) private view returns (bytes16) {
        return _mix(_value(d.a.nonbonded,uint64(atom)*3+2),_value(d.b.nonbonded,uint64(atom)*3+2),r.lambda);
    }
    function _term(Run storage r, AlchemicalTopologyCatalog.Definition memory d, uint32 atom) private view returns (bytes16,bytes16) {
        return EwaldReciprocalKernel(modules.reciprocal).structureFactorTerm(_position(r,atom),_charge(r,d,atom),r.mode,d.box);
    }
    function _force(Run storage r, uint32 atom, bytes16[3] memory force, bool negative) private {
        if(((uint128(force[0])|uint128(force[1])|uint128(force[2]))&0x7fffffffffffffffffffffffffffffff)==0)return;
        FloatMath m = FloatMath(modules.math); bytes32[] memory words = new bytes32[](3);
        for (uint256 k; k < 3; ++k) { bytes16 old = _decode(outputPage.readWord(r.outputNamespace,uint256(atom)*3+k)); words[k] = _encode(negative ? m.sub(old,force[k]) : m.add(old,force[k])); }
        outputPage.writeWords(r.outputNamespace,uint256(atom)*3,words);
    }
    function _energy(Run storage r, AlchemicalTopologyCatalog.Definition memory d, uint256 component, bytes16 energy) private {
        if((uint128(energy)&0x7fffffffffffffffffffffffffffffff)==0)return;
        uint256 start = uint256(d.atoms)*3; FloatMath m = FloatMath(modules.math);
        outputPage.writeWord(r.outputNamespace,start,_encode(m.add(_decode(outputPage.readWord(r.outputNamespace,start)),energy)));
        outputPage.writeWord(r.outputNamespace,start+component+1,_encode(m.add(_decode(outputPage.readWord(r.outputNamespace,start+component+1)),energy)));
    }
    function _mix(bytes16 a, bytes16 b, bytes16 lambda) private view returns (bytes16) {
        if (a == b || lambda == bytes16(0)) return a; if (lambda == ONE) return b;
        FloatMath m = FloatMath(modules.math); return m.add(m.mul(m.sub(ONE,lambda),a),m.mul(lambda,b));
    }
    function _mixVector(bytes16[3] memory a, bytes16[3] memory b, bytes16 lambda) private view returns (bytes16[3] memory out) { for (uint256 k; k < 3; ++k) out[k] = _mix(a[k],b[k],lambda); }
    function _negative(bytes16[3] memory x) private view returns (bytes16[3] memory out) { for (uint256 k; k < 3; ++k) out[k] = FloatMath(modules.math).neg(x[k]); }
    function _word(bytes32 stream, uint64 index) private view returns (bytes32) { return AlchemicalTopologyCatalog(modules.topology).word(stream,index); }
    function _value(bytes32 stream, uint64 index) private view returns (bytes16) { return _decode(_word(stream,index)); }
    function _modeCount(uint32 extent) private pure returns (uint32) { uint32 width = extent*2+1; return extent*(1+width+width*width); }
    function _modeAt(uint32 index,uint32 extent) private pure returns (int32[3] memory mode) {
        uint32 width = extent*2+1;
        if(index<extent){mode[2]=int32(index+1);return mode;}index-=extent;
        if(index<extent*width){mode[1]=int32(index/width+1);mode[2]=int32(index%width)-int32(extent);return mode;}index-=extent*width;
        mode[0]=int32(index/(width*width)+1);mode[1]=int32((index/width)%width)-int32(extent);mode[2]=int32(index%width)-int32(extent);
    }
    function _pairIndices(uint64 index,uint32 count) private pure returns(uint32 a,uint32 b){
        uint256 low;uint256 high=count-1;while(low+1<high){uint256 mid=(low+high)/2;if(mid*(2*uint256(count)-mid-1)/2<=index)low=mid;else high=mid;}
        a=uint32(low);b=uint32(low+1+index-low*(2*uint256(count)-low-1)/2);
    }
    function _assertRun(Run storage r) private view {
        _dependencies(r.input.protocol);
        if (AlchemicalTopologyCatalog(modules.topology).assertTopology(r.input.topology) != r.topologyCommitment
            || r.input.sourcePage.codehash != r.sourceHash || r.sourceWriter.codehash != r.sourceWriterHash) revert DependencyChanged();
        (,bool frozen)=IProductionWordState(r.input.sourcePage).namespaceInfo(r.input.sourceNamespace);
        (,,,,bytes32 snapshot)=IProductionWordState(r.input.sourcePage).snapshotInfo(r.input.sourceNamespace);
        if(!frozen||snapshot!=r.snapshotCommitment)revert DependencyChanged();
    }
    function _dependencies(bytes32 protocol) private view returns (bytes32 manifest) {
        if(address(outputPage)==address(0))revert NotConfigured();address[12] memory addresses=_addresses(modules);
        ExperimentRegistry registry=ExperimentRegistry(modules.registry);manifest=registry.assertProtocol(protocol);
        for(uint256 i;i<12;++i){if(addresses[i].codehash!=moduleHashes[i])revert DependencyChanged();if(i!=0)registry.assertModule(protocol,addresses[i],moduleHashes[i]);}
        if(address(outputPage).codehash!=outputPageHash)revert DependencyChanged();registry.assertModule(protocol,address(outputPage),outputPageHash);registry.assertModule(protocol,address(this),address(this).codehash);
    }
    function _addresses(Modules memory m) private pure returns(address[12] memory){return[m.registry,m.topology,m.math,m.geometry,m.bond,m.angle,m.torsion,m.lj,m.softcore,m.realSpace,m.reciprocal,m.corrections];}
    function _get(uint256 id) private view returns(Run storage r){r=runs[id];if(r.stage==Stage.Missing)revert InvalidInput();}
    function _decode(bytes32 word) private pure returns(bytes16 value){if(uint256(word)>>128!=0)revert InvalidInput();value=bytes16(uint128(uint256(word)));if(((uint128(value)>>112)&0x7fff)==0x7fff)revert InvalidInput();}
    function _encode(bytes16 value) private pure returns(bytes32){if(((uint128(value)>>112)&0x7fff)==0x7fff)revert InvalidInput();return bytes32(uint256(uint128(value)));}
}
