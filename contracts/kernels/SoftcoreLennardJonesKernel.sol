// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FloatMath} from "../math/FloatMath.sol";

/// @notice Two-endpoint softcore LJ energy, force and lambda derivative.
/// @dev Unswitched pair primitive. It is not a complete hybrid force field.
contract SoftcoreLennardJonesKernel {
    error InvalidInput();
    error SingularEndpoint();
    FloatMath public immutable numericalMath;
    bytes32 public constant KERNEL_ID = keccak256("ORVIA.SoftcoreLennardJonesKernel.v1");
    bytes16 private constant ONE = 0x3fff0000000000000000000000000000;
    struct Endpoint { bytes16 sigma; bytes16 epsilon; }
    struct Configuration { Endpoint a; Endpoint b; bytes16 lambda; bytes16 alpha; }
    struct Terms { bytes16 energy; bytes16 derivative; bytes16 lambdaDerivative; }
    struct Combined { bytes16 energy; bytes16 derivative; bytes16 lambdaDerivative; }

    constructor(address math_) {
        if (math_.code.length == 0) revert InvalidInput();
        numericalMath = FloatMath(math_);
    }

    /// @dev d=B-A; rho_A=r^6+alpha*sigma_A^6*lambda^2,
    ///      rho_B=r^6+alpha*sigma_B^6*(1-lambda)^2.
    function evaluate(bytes16[3] calldata d, Configuration calldata c)
        external view returns (bytes16 energy, bytes16[3] memory forceA, bytes16 derivativeLambda)
    {
        FloatMath m = numericalMath;
        _nonnegative(c.lambda); _positive(c.alpha);
        if (m.compare(c.lambda, ONE) > 0) revert InvalidInput();
        _positive(c.a.sigma); _nonnegative(c.a.epsilon); _positive(c.b.sigma); _nonnegative(c.b.epsilon);
        bytes16 r2;
        for (uint256 axis; axis < 3; ++axis) {
            _finite(d[axis]); r2 = m.add(r2, m.mul(d[axis], d[axis]));
        }
        bytes16 r4 = m.mul(r2,r2);
        Combined memory result = _combine(c,m.mul(r4,r2));
        energy = result.energy;
        derivativeLambda = result.lambdaDerivative;
        bytes16 coefficient = m.mul(m.mul(m.fromUInt(6),r4),result.derivative);
        for (uint256 axis; axis < 3; ++axis) forceA[axis] = m.mul(coefficient,d[axis]);
    }

    function _combine(Configuration memory c, bytes16 r6) private view returns(Combined memory result) {
        FloatMath m = numericalMath;
        bytes16 complement = m.sub(ONE,c.lambda);
        Terms memory ta = _endpoint(c.a,r6,c.lambda,c.alpha);
        Terms memory tb = _endpoint(c.b,r6,complement,c.alpha);
        result.energy = m.add(m.mul(complement,ta.energy),m.mul(c.lambda,tb.energy));
        result.derivative = m.add(m.mul(complement,ta.derivative),m.mul(c.lambda,tb.derivative));
        result.lambdaDerivative = m.sub(tb.energy,ta.energy);
        result.lambdaDerivative = m.add(result.lambdaDerivative,m.mul(complement,ta.lambdaDerivative));
        result.lambdaDerivative = m.sub(result.lambdaDerivative,m.mul(c.lambda,tb.lambdaDerivative));
    }

    function _endpoint(Endpoint memory p, bytes16 r6, bytes16 softening, bytes16 alpha)
        private view returns (Terms memory t)
    {
        FloatMath m = numericalMath;
        if (m.isZero(p.epsilon)) return t;
        bytes16 s6;
        {
            bytes16 s2 = m.mul(p.sigma,p.sigma);
            s6 = m.mul(s2,s2);
            s6 = m.mul(s6,s2);
        }
        _positive(s6);
        bytes16 alphaS6 = m.mul(alpha,s6);
        bytes16 rho = m.mul(softening,softening);
        rho = m.mul(alphaS6,rho);
        rho = m.add(r6,rho);
        if (m.isZero(rho)) revert SingularEndpoint();
        bytes16 ratio = m.div(s6,rho);
        bytes16 fourEpsilon = m.mul(m.fromUInt(4),p.epsilon);
        t.energy = m.mul(ratio,ratio);
        t.derivative = m.mul(m.fromUInt(2),t.energy);
        t.derivative = m.sub(ratio,t.derivative);
        t.derivative = m.mul(fourEpsilon,t.derivative);
        t.derivative = m.div(t.derivative,rho);
        t.energy = m.sub(t.energy,ratio);
        t.energy = m.mul(fourEpsilon,t.energy);
        t.lambdaDerivative = m.mul(alphaS6,softening);
        t.lambdaDerivative = m.mul(m.fromUInt(2),t.lambdaDerivative);
        t.lambdaDerivative = m.mul(t.derivative,t.lambdaDerivative);
    }

    function _finite(bytes16 x) private view { if (!numericalMath.isFinite(x)) revert InvalidInput(); }
    function _nonnegative(bytes16 x) private view { _finite(x); if(numericalMath.compare(x,bytes16(0))<0) revert InvalidInput(); }
    function _positive(bytes16 x) private view { _finite(x); if(numericalMath.compare(x,bytes16(0))<=0) revert InvalidInput(); }
}
