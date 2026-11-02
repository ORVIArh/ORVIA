// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FloatMath} from "../math/FloatMath.sol";
import {ElementaryMath} from "../math/ElementaryMath.sol";

/// @notice U = k/2*(theta-theta0)^2 for angle a-b-c, with b the central atom.
/// @dev Nonperiodic, unwrapped coordinates. Collinear/zero-length geometries reject.
contract HarmonicAngleKernel {
    error InvalidDependencies();
    error InvalidParameter();
    error NonFiniteInput();
    error SingularGeometry();
    FloatMath public immutable numericalMath;
    ElementaryMath public immutable elementaryMath;
    bytes32 public constant KERNEL_ID = keccak256("ORVIA.HarmonicAngleKernel.v0.3");
    struct Work {
        bytes16[3] u; bytes16[3] v; bytes16[3] cross;
        bytes16 uu; bytes16 vv; bytes16 uv; bytes16 crossLength; bytes16 extension; bytes16 scale;
    }
    struct Result { bytes16 energy; bytes16[3] a; bytes16[3] b; bytes16[3] c; }

    constructor(address math_, address elementary_) {
        if (math_.code.length == 0 || elementary_.code.length == 0 ||
            address(ElementaryMath(elementary_).numericalMath()) != math_) revert InvalidDependencies();
        numericalMath = FloatMath(math_); elementaryMath = ElementaryMath(elementary_);
    }

    function evaluate(bytes16[3] calldata a, bytes16[3] calldata b, bytes16[3] calldata c,
        bytes16 k, bytes16 theta0) external view
        returns (bytes16 energy, bytes16[3] memory forceA, bytes16[3] memory forceB, bytes16[3] memory forceC)
    {
        Result memory r = _evaluate(a,b,c,k,theta0);
        return (r.energy,r.a,r.b,r.c);
    }

    function _evaluate(bytes16[3] memory a, bytes16[3] memory b, bytes16[3] memory c,
        bytes16 k, bytes16 theta0) private view returns (Result memory r)
    {
        FloatMath m = numericalMath;
        if (!m.isFinite(k) || !m.isFinite(theta0)) revert NonFiniteInput();
        if (m.isNegative(k) || m.isNegative(theta0) || m.compare(theta0, elementaryMath.PI()) > 0) revert InvalidParameter();
        Work memory w;
        for (uint256 d; d < 3; ++d) {
            if (!m.isFinite(a[d]) || !m.isFinite(b[d]) || !m.isFinite(c[d])) revert NonFiniteInput();
            w.u[d] = m.sub(a[d],b[d]); w.v[d] = m.sub(c[d],b[d]);
            w.uu = m.add(w.uu,m.mul(w.u[d],w.u[d]));
            w.vv = m.add(w.vv,m.mul(w.v[d],w.v[d]));
            w.uv = m.add(w.uv,m.mul(w.u[d],w.v[d]));
        }
        for (uint256 d; d < 3; ++d) {
            uint256 j = (d+1)%3; uint256 l = (d+2)%3;
            w.cross[d] = m.sub(m.mul(w.u[j],w.v[l]),m.mul(w.u[l],w.v[j]));
            w.crossLength = m.add(w.crossLength,m.mul(w.cross[d],w.cross[d]));
        }
        if (m.isZero(w.uu) || m.isZero(w.vv) || m.isZero(w.crossLength)) revert SingularGeometry();
        w.crossLength = m.sqrt(w.crossLength);
        if (m.isZero(k)) return r;
        w.extension = m.sub(elementaryMath.atan2(w.crossLength,w.uv),theta0);
        r.energy = m.mul(bytes16(0x3ffe0000000000000000000000000000),m.mul(k,m.mul(w.extension,w.extension)));
        w.scale = m.div(m.mul(k,w.extension),w.crossLength);
        bytes16 projectionU = m.div(w.uv,w.uu);
        bytes16 projectionV = m.div(w.uv,w.vv);
        for (uint256 d; d < 3; ++d) {
            r.a[d] = m.mul(w.scale,m.sub(w.v[d],m.mul(projectionU,w.u[d])));
            r.c[d] = m.mul(w.scale,m.sub(w.u[d],m.mul(projectionV,w.v[d])));
            r.b[d] = m.neg(m.add(r.a[d],r.c[d]));
        }
    }
}
