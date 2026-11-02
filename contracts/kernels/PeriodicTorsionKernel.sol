// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FloatMath} from "../math/FloatMath.sol";
import {ElementaryMath} from "../math/ElementaryMath.sol";

/// @notice U = k*(1+cos(n*phi-phase)); phi uses the documented oriented normals.
/// @dev Unwrapped coordinates; n=1..6, phase in [-2*pi,2*pi]. Collinear bonds reject.
contract PeriodicTorsionKernel {
    error InvalidDependencies();
    error InvalidParameter();
    error NonFiniteInput();
    error SingularGeometry();
    FloatMath public immutable numericalMath;
    ElementaryMath public immutable elementaryMath;
    bytes32 public constant KERNEL_ID = keccak256("ORVIA.PeriodicTorsionKernel.v0.3");
    struct Input { bytes16[3] a; bytes16[3] b; bytes16[3] c; bytes16[3] d; uint32 n; bytes16 k; bytes16 phase; }
    struct Work {
        bytes16[3] b1; bytes16[3] b2; bytes16[3] b3; bytes16[3] n1; bytes16[3] n2;
        bytes16[3] hat; bytes16[3] cross; bytes16[3] gn1; bytes16[3] gn2; bytes16[3] gh;
        bytes16[3] gb1; bytes16[3] gb2; bytes16[3] gb3;
        bytes16 length; bytes16 x; bytes16 y; bytes16 denom; bytes16 gx; bytes16 gy; bytes16 derivative;
    }
    struct Result { bytes16 energy; bytes16[3] a; bytes16[3] b; bytes16[3] c; bytes16[3] d; }
    bytes16 private constant ONE = 0x3fff0000000000000000000000000000;

    constructor(address math_, address elementary_) {
        if (math_.code.length == 0 || elementary_.code.length == 0 ||
            address(ElementaryMath(elementary_).numericalMath()) != math_) revert InvalidDependencies();
        numericalMath = FloatMath(math_); elementaryMath = ElementaryMath(elementary_);
    }

    function evaluate(bytes16[3] calldata a, bytes16[3] calldata b, bytes16[3] calldata c, bytes16[3] calldata d,
        uint32 periodicity, bytes16 k, bytes16 phase) external view
        returns (bytes16 energy, bytes16[3] memory forceA, bytes16[3] memory forceB, bytes16[3] memory forceC, bytes16[3] memory forceD)
    {
        Input memory input;
        input.a=a; input.b=b; input.c=c; input.d=d; input.n=periodicity; input.k=k; input.phase=phase;
        Result memory r = _evaluate(input);
        return (r.energy,r.a,r.b,r.c,r.d);
    }

    function _evaluate(Input memory p) private view returns (Result memory r) {
        FloatMath m = numericalMath;
        if (!m.isFinite(p.k) || !m.isFinite(p.phase)) revert NonFiniteInput();
        if (p.n == 0 || p.n > 6 || m.isNegative(p.k) || m.compare(m.abs(p.phase), elementaryMath.TWO_PI()) > 0) revert InvalidParameter();
        for (uint256 i; i < 3; ++i) {
            if (!m.isFinite(p.a[i]) || !m.isFinite(p.b[i]) || !m.isFinite(p.c[i]) || !m.isFinite(p.d[i])) revert NonFiniteInput();
        }
        Work memory w;
        w.b1=_sub(p.b,p.a); w.b2=_sub(p.c,p.b); w.b3=_sub(p.d,p.c);
        w.n1=_cross(w.b1,w.b2); w.n2=_cross(w.b2,w.b3);
        w.length=_dot(w.b2,w.b2);
        if (m.isZero(w.length) || m.isZero(_dot(w.n1,w.n1)) || m.isZero(_dot(w.n2,w.n2))) revert SingularGeometry();
        w.length=m.sqrt(w.length); w.hat=_scale(w.b2,m.div(ONE,w.length));
        if (m.isZero(p.k)) return r;
        w.cross=_cross(w.n1,w.n2); w.x=_dot(w.n1,w.n2); w.y=_dot(w.hat,w.cross);
        bytes16 phi=elementaryMath.atan2(w.y,w.x);
        (bytes16 sine,bytes16 cosine)=elementaryMath.sinCos(m.sub(m.mul(m.fromUInt(p.n),phi),p.phase));
        r.energy=m.mul(p.k,m.add(ONE,cosine));
        w.derivative=m.neg(m.mul(m.mul(p.k,m.fromUInt(p.n)),sine));
        w.denom=m.add(m.mul(w.x,w.x),m.mul(w.y,w.y));
        if (m.isZero(w.denom)) revert SingularGeometry();
        w.gx=m.div(m.neg(w.y),w.denom); w.gy=m.div(w.x,w.denom);
        w.gn1=_add(_scale(w.n2,w.gx),_scale(_cross(w.n2,w.hat),w.gy));
        w.gn2=_add(_scale(w.n1,w.gx),_scale(_cross(w.hat,w.n1),w.gy));
        w.gh=_scale(w.cross,w.gy);
        w.gb1=_cross(w.b2,w.gn1);
        w.gb2=_add(_add(_cross(w.gn1,w.b1),_cross(w.b3,w.gn2)),
            _scale(_sub(w.gh,_scale(w.hat,_dot(w.hat,w.gh))),m.div(ONE,w.length)));
        w.gb3=_cross(w.gn2,w.b2);
        // Reverse chain rule through b1=b-a, b2=c-b and b3=d-c; force=-gradient(U).
        r.a=_scale(w.gb1,w.derivative);
        r.b=_scale(_sub(w.gb2,w.gb1),w.derivative);
        r.c=_scale(_sub(w.gb3,w.gb2),w.derivative);
        r.d=_scale(w.gb3,m.neg(w.derivative));
    }
    function _dot(bytes16[3] memory a, bytes16[3] memory b) private view returns(bytes16 s) {
        for(uint256 i;i<3;++i) s=numericalMath.add(s,numericalMath.mul(a[i],b[i]));
    }
    function _cross(bytes16[3] memory a, bytes16[3] memory b) private view returns(bytes16[3] memory c) {
        for(uint256 i;i<3;++i) c[i]=numericalMath.sub(numericalMath.mul(a[(i+1)%3],b[(i+2)%3]),numericalMath.mul(a[(i+2)%3],b[(i+1)%3]));
    }
    function _add(bytes16[3] memory a, bytes16[3] memory b) private view returns(bytes16[3] memory c) {
        for(uint256 i;i<3;++i)c[i]=numericalMath.add(a[i],b[i]);
    }
    function _sub(bytes16[3] memory a, bytes16[3] memory b) private view returns(bytes16[3] memory c) {
        for(uint256 i;i<3;++i)c[i]=numericalMath.sub(a[i],b[i]);
    }
    function _scale(bytes16[3] memory a, bytes16 k) private view returns(bytes16[3] memory c) {
        for(uint256 i;i<3;++i)c[i]=numericalMath.mul(a[i],k);
    }
}
