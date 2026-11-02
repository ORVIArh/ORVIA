// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Fixed96Math} from "../math/Fixed96Math.sol";

/// @notice NEW bounded fixed-point numerical policy for the full softcore term.
/// @dev Same declared scalar potential as the binary128 reference; different
/// rounding/domain. No claim of full-experiment validation or bitwise identity.
contract Fixed96SoftcoreLennardJonesKernel is Fixed96Math {
    error SingularEndpoint();
    bytes32 public constant IMPLEMENTATION_ID = keccak256("ORVIA.Fixed96SoftcoreLJ.v2.FactoredDerivatives");
    struct Endpoint { bytes16 sigma; bytes16 epsilon; }
    struct Configuration { Endpoint a; Endpoint b; bytes16 lambda; bytes16 alpha; }
    struct Term { int256 energy; int256 forceCoefficient; int256 lambdaDerivative; }
    struct EndpointValues { int256 sigma; int256 epsilon; int256 r4; int256 r6; int256 softening; int256 alpha; }
    struct Values { int256 sigmaA; int256 epsA; int256 sigmaB; int256 epsB; int256 lambda; int256 alpha; }

    function evaluate(bytes16[3] calldata displacement,Configuration calldata c)
        external pure returns(bytes16 energy,bytes16[3] memory forceA,bytes16 derivativeLambda)
    {
        Values memory p=Values(_fixed(c.a.sigma),_fixed(c.a.epsilon),_fixed(c.b.sigma),_fixed(c.b.epsilon),_fixed(c.lambda),_fixed(c.alpha));
        if(p.sigmaA<=0||p.sigmaB<=0||p.epsA<0||p.epsB<0||p.lambda<0||p.lambda>ONE||p.alpha<=0)revert InvalidParameter();
        int256[3] memory d;int256 r2;
        for(uint256 i;i<3;++i){d[i]=_fixed(displacement[i]);r2=_add(r2,_mul(d[i],d[i]));}
        int256 r4=_mul(r2,r2);int256 r6=_mul(r4,r2);
        (int256 e,int256 coefficient,int256 dl)=_combined(p,r4,r6);
        energy=_quad(e);derivativeLambda=_quad(dl);
        for(uint256 i;i<3;++i)forceA[i]=_quad(_mul(coefficient,d[i]));
    }
    function _combined(Values memory p,int256 r4,int256 r6) private pure returns(int256 e,int256 coefficient,int256 dl){
        int256 complement=ONE-p.lambda;
        Term memory a=_endpoint(EndpointValues(p.sigmaA,p.epsA,r4,r6,p.lambda,p.alpha));
        Term memory b=_endpoint(EndpointValues(p.sigmaB,p.epsB,r4,r6,complement,p.alpha));
        e=_add(_mul(complement,a.energy),_mul(p.lambda,b.energy));
        coefficient=_add(_mul(complement,a.forceCoefficient),_mul(p.lambda,b.forceCoefficient));
        dl=_sub(_add(_sub(b.energy,a.energy),_mul(complement,a.lambdaDerivative)),_mul(p.lambda,b.lambdaDerivative));
    }
    function _endpoint(EndpointValues memory p)private pure returns(Term memory t){
        if(p.epsilon==0)return t;
        int256 s2=_mul(p.sigma,p.sigma);int256 s6=_mul(_mul(s2,s2),s2);
        if(s6==0)revert ArithmeticDomain();
        int256 alphaS6=_mul(p.alpha,s6);
        int256 rho=_add(p.r6,_mul(alphaS6,_mul(p.softening,p.softening)));
        if(rho<=0)revert SingularEndpoint();
        int256 ratio=_div(s6,rho);int256 squared=_mul(ratio,ratio);
        int256 fourEps=_mul(4*ONE,p.epsilon);
        t.energy=_mul(fourEps,_sub(squared,ratio));
        // Factor each physical derivative before division. Materializing dU/drho
        // needlessly overflows its unit-dependent intermediate at finite r=0
        // even when the requested force and dU/dlambda are well within domain.
        int256 strength=_mul(fourEps,_sub(ratio,_mul(2*ONE,squared)));
        t.forceCoefficient=_mul(strength,_div(_mul(6*ONE,p.r4),rho));
        t.lambdaDerivative=_mul(strength,_div(_mul(_mul(2*ONE,alphaS6),p.softening),rho));
    }
}
