// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixed96EwaldMath} from "../math/Fixed96EwaldMath.sol";

/// @notice Candidate bounded Q96 half-space finite Ewald reciprocal operations.
/// @dev Modes, correction terms, truncation error and snapshot identity remain
/// coordinator responsibilities. This is a new explicit numerical policy.
contract Fixed96EwaldReciprocalKernel is Fixed96EwaldMath {
    bytes32 public constant IMPLEMENTATION_ID = keccak256("ORVIA.Fixed96EwaldReciprocal.v1.HalfSpace");
    int32 public constant MAX_MODE = 32;
    struct Wave { int256[3] k; int256 k2; int256 volume; int256 alpha; int256 prefactor; }

    function waveVector(int32[3] calldata mode,bytes16[3] calldata box,bytes16 alpha,bytes16 prefactor)
        external pure returns(bytes16[3] memory k,bytes16 coefficient)
    {
        _mode(mode);
        Wave memory p;
        p.alpha = _fixed(alpha); p.prefactor = _fixed(prefactor); p.volume = ONE;
        if(p.alpha<=0||p.prefactor<0)revert InvalidParameter();
        for(uint256 axis;axis<3;++axis){
            int256 length=_fixed(box[axis]);if(length<=0)revert InvalidParameter();
            p.volume=_mul(p.volume,length);
            p.k[axis]=_div(int256(mode[axis]) * (2 * PI96),length);
            p.k2=_add(p.k2,_mul(p.k[axis],p.k[axis]));
            k[axis]=_quad(p.k[axis]);
        }
        int256 exponent=_div(p.k2,_mul(4 * ONE,_mul(p.alpha,p.alpha)));
        int256 value=_div(_mul(_div(_mul(4 * PI96,p.prefactor),p.volume),_expNegative(exponent)),p.k2);
        coefficient=_quad(value);
    }

    function structureFactorTerm(bytes16[3] calldata position,bytes16 charge,int32[3] calldata mode,bytes16[3] calldata box)
        external pure returns(bytes16 cosineTerm,bytes16 sineTerm)
    {
        _mode(mode);
        int256 q=_fixed(charge);
        int256 cycles;
        for(uint256 axis;axis<3;++axis){
            int256 x=_fixed(position[axis]);int256 length=_fixed(box[axis]);
            if(length<=0)revert InvalidParameter();
            // Coordinate-space remainder avoids cancellation after a rounded ratio.
            int256 remainder=x%length;
            if(remainder>length/2)remainder-=length;
            else if(remainder< -length/2)remainder+=length;
            cycles=_add(cycles,int256(mode[axis])*_div(remainder,length));
        }
        cycles%=ONE;
        if(cycles>ONE/2)cycles-=ONE;
        else if(cycles< -ONE/2)cycles+=ONE;
        (int256 sine,int256 cosine)=_sinCosReduced(_mul(2 * PI96,cycles));
        return(_quad(_mul(q,cosine)),_quad(_mul(q,sine)));
    }

    function modeEnergy(bytes16 coefficient,bytes16 totalCosine,bytes16 totalSine) external pure returns(bytes16){
        int256 a=_fixed(coefficient);if(a<0)revert InvalidParameter();
        int256 c=_fixed(totalCosine);int256 s=_fixed(totalSine);
        return _quad(_mul(a,_add(_mul(c,c),_mul(s,s))));
    }

    function forceContribution(bytes16[3] calldata k,bytes16 coefficient,bytes16 cosineTerm,bytes16 sineTerm,bytes16 totalCosine,bytes16 totalSine)
        external pure returns(bytes16[3] memory force)
    {
        int256 a=_fixed(coefficient);if(a<0)revert InvalidParameter();
        int256 amplitude=_sub(_mul(_fixed(totalCosine),_fixed(sineTerm)),_mul(_fixed(totalSine),_fixed(cosineTerm)));
        amplitude=_mul(2 * ONE,_mul(a,amplitude));
        for(uint256 axis;axis<3;++axis)force[axis]=_quad(_mul(_fixed(k[axis]),amplitude));
    }

    function _mode(int32[3] memory mode) private pure {
        bool nonzero;
        for(uint256 axis;axis<3;++axis){
            int32 value=mode[axis];if(value< -MAX_MODE||value>MAX_MODE)revert ArithmeticDomain();
            if(!nonzero&&value!=0){if(value<0)revert InvalidParameter();nonzero=true;}
        }
        if(!nonzero)revert InvalidParameter();
    }
}
