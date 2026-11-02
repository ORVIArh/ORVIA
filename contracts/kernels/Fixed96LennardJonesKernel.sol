// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Fixed96Math} from "../math/Fixed96Math.sol";

/// @notice Ordinary Lennard-Jones under the explicit candidate bounded Q96 policy.
contract Fixed96LennardJonesKernel is Fixed96Math {
    bytes32 public constant IMPLEMENTATION_ID = keccak256("ORVIA.Fixed96LennardJones.v1");
    function evaluate(bytes16[3] calldata a,bytes16[3] calldata b,bytes16 sigma,bytes16 epsilon)
        external pure returns(bytes16 energy,bytes16[3] memory forceOnA)
    {
        int256 s=_fixed(sigma);int256 e=_fixed(epsilon);
        if(s<=0||e<0)revert InvalidParameter();
        int256[3] memory d;int256 r2;
        for(uint256 axis;axis<3;++axis){
            d[axis]=_sub(_fixed(b[axis]),_fixed(a[axis]));
            r2=_add(r2,_mul(d[axis],d[axis]));
        }
        if(r2==0)revert ZeroSeparation();
        if(e==0)return(energy,forceOnA);
        int256 ratio2=_div(_mul(s,s),r2);
        int256 ratio6=_mul(_mul(ratio2,ratio2),ratio2);
        int256 ratio12=_mul(ratio6,ratio6);
        energy=_quad(_mul(_mul(4*ONE,e),_sub(ratio12,ratio6)));
        int256 coefficient=_div(_mul(_mul(24*ONE,e),_sub(ratio6,_mul(2*ONE,ratio12))),r2);
        for(uint256 axis;axis<3;++axis)forceOnA[axis]=_quad(_mul(coefficient,d[axis]));
    }
}
