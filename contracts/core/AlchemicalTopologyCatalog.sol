// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FloatMath} from "../math/FloatMath.sol";
import {OrthorhombicGeometry} from "../kernels/OrthorhombicGeometry.sol";

interface IAlchemicalInputStreams {
    function assertStream(bytes32 id) external view returns (bytes32 commitment, uint64 words);
    function readWord(bytes32 id, uint64 index) external view returns (bytes32);
}

/// @notice Complete, aligned endpoint parameter streams for a declared hybrid topology.
/// @dev Validation is incremental and does not certify chemical parameter quality.
///      Both endpoints retain every hybrid atom and have identical masses and term
///      indices. Dummy bonded networks/corrections require an explicit model policy.
contract AlchemicalTopologyCatalog {
    error Unauthorized(); error InvalidInput(); error WrongStage(); error DependencyChanged();
    enum Stage { Missing, Atoms, Bonds, Angles, Torsions, Exceptions, Complete }
    struct Endpoint {
        bytes32 particles; // mass, initial vx, vy, vz
        bytes32 nonbonded; // sigma, epsilon, charge
        bytes32 bonds; // atom a,b,k,r0
        bytes32 angles; // a,b,c,k,theta0
        bytes32 torsions; // a,b,c,d,periodicity,k,phase (proper or explicitly ordered periodic improper)
        bytes32 exceptions; // a,b,kind (1 excluded,2 direct),sigma,epsilon,desired charge product
    }
    struct Definition {
        bytes32 modelPolicy; bytes32 dummyPolicy; bytes32 positions;
        Endpoint a; Endpoint b;
        uint32 atoms; uint64 bonds; uint64 angles; uint64 torsions; uint64 exceptions;
        bytes16[3] box; bytes16 switchDistance; bytes16 cutoff; bytes16 prefactor;
        bytes16 ewaldAlpha; uint32 ewaldExtent; bytes16 softcoreAlpha;
    }
    struct Info { Stage stage; uint64 cursor; bytes32 commitment; bytes32 inputDigest; uint64 lastExceptionKey; }
    struct Record { Definition definition; Info info; bytes16[] lambdas; }
    address public immutable owner;
    IAlchemicalInputStreams public immutable inputs;
    FloatMath public immutable numericalMath;
    OrthorhombicGeometry public immutable geometry;
    bytes32[3] public dependencyHashes;
    uint256 public constant MAX_WORK = 8;
    bytes16 private constant ONE = 0x3fff0000000000000000000000000000;
    mapping(bytes32 => Record) private records;
    event TopologyCreated(bytes32 indexed id, bytes32 inputDigest);
    event TopologySealed(bytes32 indexed id, bytes32 commitment);

    constructor(address owner_, address inputs_, address math_, address geometry_) {
        if (owner_ == address(0) || inputs_.code.length == 0 || math_.code.length == 0 || geometry_.code.length == 0
            || address(OrthorhombicGeometry(geometry_).numericalMath()) != math_) revert InvalidInput();
        owner = owner_; inputs = IAlchemicalInputStreams(inputs_); numericalMath = FloatMath(math_);
        geometry = OrthorhombicGeometry(geometry_); dependencyHashes = [inputs_.codehash, math_.codehash, geometry_.codehash];
    }

    function create(bytes32 id, Definition calldata d, bytes16[] calldata lambdas) external {
        _dependencies(); if (msg.sender != owner) revert Unauthorized();
        if (id == bytes32(0) || records[id].info.stage != Stage.Missing || d.atoms < 2
            || uint256(d.atoms) * 9 + 1 > type(uint32).max || d.modelPolicy == bytes32(0) || d.dummyPolicy == bytes32(0)
            || lambdas.length < 2 || lambdas.length > 16 || d.ewaldExtent == 0 || d.ewaldExtent > 32) revert InvalidInput();
        _positive(d.switchDistance); _positive(d.cutoff); _nonnegative(d.prefactor); _positive(d.ewaldAlpha); _positive(d.softcoreAlpha);
        if (numericalMath.compare(d.switchDistance, d.cutoff) >= 0
            || numericalMath.compare(numericalMath.mul(d.ewaldAlpha, d.cutoff), numericalMath.fromUInt(16)) > 0) revert InvalidInput();
        geometry.validateBox(d.box, d.cutoff);
        bytes32 digest = keccak256(abi.encode(bytes32("ORVIA-HYBRID-INPUT-v1"), block.chainid, address(this), id, d, lambdas, dependencyHashes));
        digest = _stream(digest, d.positions, uint64(d.atoms) * 3);
        digest = _endpoint(digest, d.a, d); digest = _endpoint(digest, d.b, d);
        if (lambdas[0] != bytes16(0) || lambdas[lambdas.length - 1] != ONE) revert InvalidInput();
        Record storage r = records[id]; r.definition = d; r.info = Info(Stage.Atoms, 0, bytes32(0), digest, 0);
        for (uint256 k; k < lambdas.length; ++k) {
            _nonnegative(lambdas[k]);
            if (numericalMath.compare(lambdas[k], ONE) > 0 || (k != 0 && numericalMath.compare(lambdas[k], lambdas[k-1]) <= 0)) revert InvalidInput();
            r.lambdas.push(lambdas[k]);
        }
        emit TopologyCreated(id, digest);
    }

    function advance(bytes32 id, uint256 work) external returns (uint256 processed, bool complete) {
        _dependencies(); if (work == 0 || work > MAX_WORK) revert InvalidInput(); Record storage r = _get(id);
        if (r.info.stage == Stage.Complete) revert WrongStage();
        while (processed < work && r.info.stage != Stage.Complete) {
            _skipEmpty(r);
            if (r.info.stage == Stage.Complete) break;
            if (r.info.stage == Stage.Atoms) _atom(r, r.info.cursor);
            else if (r.info.stage == Stage.Exceptions) _exception(r, r.info.cursor);
            else _term(r, r.info.cursor);
            ++r.info.cursor; ++processed;
            if (r.info.cursor == _count(r)) { r.info.cursor = 0; r.info.stage = Stage(uint8(r.info.stage) + 1); }
        }
        _skipEmpty(r); complete = r.info.stage == Stage.Complete;
        if (complete && r.info.commitment == bytes32(0)) {
            r.info.commitment = keccak256(abi.encode(r.info.inputDigest, bytes32("ALIGNED-HYBRID-COMPLETE")));
            emit TopologySealed(id, r.info.commitment);
        }
    }
    function definition(bytes32 id) external view returns (Definition memory) { return _get(id).definition; }
    function info(bytes32 id) external view returns (Info memory) { return _get(id).info; }
    function stateCount(bytes32 id) external view returns (uint8) { return uint8(_get(id).lambdas.length); }
    function lambdaAt(bytes32 id, uint8 state) external view returns (bytes16) {
        Record storage r = _get(id); if (state >= r.lambdas.length) revert InvalidInput(); return r.lambdas[state];
    }
    function assertTopology(bytes32 id) external view returns (bytes32) {
        _dependencies(); Record storage r = _get(id); if (r.info.stage != Stage.Complete) revert WrongStage(); return r.info.commitment;
    }
    function word(bytes32 stream, uint64 index) external view returns (bytes32) { _dependencies(); return inputs.readWord(stream, index); }

    function _stream(bytes32 digest, bytes32 id, uint64 count) private view returns (bytes32) {
        if (count == 0) { if (id != bytes32(0)) revert InvalidInput(); return keccak256(abi.encode(digest, id, count)); }
        (bytes32 commitment, uint64 words) = inputs.assertStream(id);
        if (words != count || commitment == bytes32(0)) revert InvalidInput();
        return keccak256(abi.encode(digest, id, commitment, words));
    }
    function _endpoint(bytes32 digest, Endpoint calldata e, Definition calldata d) private view returns (bytes32) {
        digest = _stream(digest, e.particles, uint64(d.atoms) * 4);
        digest = _stream(digest, e.nonbonded, uint64(d.atoms) * 3);
        digest = _stream(digest, e.bonds, _multiply(d.bonds, 4));
        digest = _stream(digest, e.angles, _multiply(d.angles, 5));
        digest = _stream(digest, e.torsions, _multiply(d.torsions, 7));
        return _stream(digest, e.exceptions, _multiply(d.exceptions, 6));
    }
    function _atom(Record storage r, uint64 atom) private view {
        Definition storage d = r.definition;
        for (uint64 k; k < 3; ++k) _decode(inputs.readWord(d.positions, atom * 3 + k));
        bytes16 ma = _decode(inputs.readWord(d.a.particles, atom * 4)); bytes16 mb = _decode(inputs.readWord(d.b.particles, atom * 4));
        _positive(ma); if (ma != mb) revert InvalidInput();
        for (uint64 k = 1; k < 4; ++k) {
            bytes32 a = inputs.readWord(d.a.particles, atom * 4 + k); bytes32 b = inputs.readWord(d.b.particles, atom * 4 + k);
            _decode(a); _decode(b); if (a != b) revert InvalidInput();
        }
        _particle(d.a.nonbonded, atom); _particle(d.b.nonbonded, atom);
    }
    function _particle(bytes32 stream, uint64 atom) private view {
        _positive(_decode(inputs.readWord(stream, atom * 3)));
        _nonnegative(_decode(inputs.readWord(stream, atom * 3 + 1)));
        _decode(inputs.readWord(stream, atom * 3 + 2));
    }
    function _term(Record storage r, uint64 index) private view {
        uint64 width = r.info.stage == Stage.Bonds ? 4 : r.info.stage == Stage.Angles ? 5 : 7;
        uint64 indices = r.info.stage == Stage.Bonds ? 2 : r.info.stage == Stage.Angles ? 3 : 5;
        bytes32 a = r.info.stage == Stage.Bonds ? r.definition.a.bonds : r.info.stage == Stage.Angles ? r.definition.a.angles : r.definition.a.torsions;
        bytes32 b = r.info.stage == Stage.Bonds ? r.definition.b.bonds : r.info.stage == Stage.Angles ? r.definition.b.angles : r.definition.b.torsions;
        for (uint64 k; k < width; ++k) {
            bytes32 x = inputs.readWord(a, index * width + k); bytes32 y = inputs.readWord(b, index * width + k);
            if (k < indices) {
                if (x != y || uint256(x) > type(uint32).max) revert InvalidInput();
                if (r.info.stage == Stage.Torsions && k == 4) { if (uint256(x) == 0 || uint256(x) > 64) revert InvalidInput(); }
                else if (uint256(x) >= r.definition.atoms) revert InvalidInput();
            } else {
                bytes16 va = _decode(x); bytes16 vb = _decode(y);
                if (k == indices) { _nonnegative(va); _nonnegative(vb); }
                else if (r.info.stage == Stage.Bonds) { _nonnegative(va); _nonnegative(vb); }
                else if (r.info.stage == Stage.Angles) {
                    _nonnegative(va); _nonnegative(vb);
                    if (numericalMath.compare(va, bytes16(0x4000921fb54442d18469898cc51701b8)) > 0
                        || numericalMath.compare(vb, bytes16(0x4000921fb54442d18469898cc51701b8)) > 0) revert InvalidInput();
                }
            }
        }
        uint64 atomFields = r.info.stage == Stage.Torsions ? 4 : indices;
        for (uint64 i; i < atomFields; ++i) for (uint64 j; j < i; ++j)
            if (inputs.readWord(a, index * width + i) == inputs.readWord(a, index * width + j)) revert InvalidInput();
    }
    function _exception(Record storage r, uint64 index) private {
        Definition storage d = r.definition; uint64 start = index * 6;
        uint256 a = uint256(inputs.readWord(d.a.exceptions, start)); uint256 b = uint256(inputs.readWord(d.a.exceptions, start + 1));
        if (a >= b || b >= d.atoms) revert InvalidInput();
        uint64 key = uint64(a * d.atoms + b);
        if (index != 0 && key <= r.info.lastExceptionKey) revert InvalidInput(); r.info.lastExceptionKey = key;
        for (uint64 k; k < 3; ++k) if (inputs.readWord(d.a.exceptions, start + k) != inputs.readWord(d.b.exceptions, start + k)) revert InvalidInput();
        uint256 kind = uint256(inputs.readWord(d.a.exceptions, start + 2)); if (kind != 1 && kind != 2) revert InvalidInput();
        for (uint256 endpoint; endpoint < 2; ++endpoint) {
            bytes32 stream = endpoint == 0 ? d.a.exceptions : d.b.exceptions;
            bytes16 sigma = _decode(inputs.readWord(stream, start + 3)); bytes16 epsilon = _decode(inputs.readWord(stream, start + 4));
            bytes16 charge = _decode(inputs.readWord(stream, start + 5));
            if (kind == 1) { if (sigma != bytes16(0) || epsilon != bytes16(0) || charge != bytes16(0)) revert InvalidInput(); }
            else { _positive(sigma); _nonnegative(epsilon); }
        }
    }
    function _count(Record storage r) private view returns (uint64) {
        if (r.info.stage == Stage.Atoms) return r.definition.atoms;
        if (r.info.stage == Stage.Bonds) return r.definition.bonds;
        if (r.info.stage == Stage.Angles) return r.definition.angles;
        if (r.info.stage == Stage.Torsions) return r.definition.torsions;
        if (r.info.stage == Stage.Exceptions) return r.definition.exceptions;
        return 0;
    }
    function _skipEmpty(Record storage r) private { while (r.info.stage != Stage.Complete && _count(r) == 0) { r.info.cursor = 0; r.info.stage = Stage(uint8(r.info.stage) + 1); } }
    function _multiply(uint64 x, uint64 y) private pure returns (uint64) { return x * y; }
    function _decode(bytes32 word_) private pure returns (bytes16 value) {
        if (uint256(word_) >> 128 != 0) revert InvalidInput(); value = bytes16(uint128(uint256(word_)));
        if (((uint128(value) >> 112) & 0x7fff) == 0x7fff) revert InvalidInput();
        if ((uint128(value) & 0x7fffffffffffffffffffffffffffffff) == 0) value = bytes16(0);
    }
    function _positive(bytes16 x) private view { if (!numericalMath.isFinite(x) || numericalMath.compare(x, bytes16(0)) <= 0) revert InvalidInput(); }
    function _nonnegative(bytes16 x) private view { if (!numericalMath.isFinite(x) || numericalMath.compare(x, bytes16(0)) < 0) revert InvalidInput(); }
    function _dependencies() private view {
        if (address(inputs).codehash != dependencyHashes[0] || address(numericalMath).codehash != dependencyHashes[1]
            || address(geometry).codehash != dependencyHashes[2]) revert DependencyChanged();
    }
    function _get(bytes32 id) private view returns (Record storage r) { r = records[id]; if (r.info.stage == Stage.Missing) revert InvalidInput(); }
}
