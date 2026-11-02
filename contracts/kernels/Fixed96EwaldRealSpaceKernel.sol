// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixed96EwaldMath} from "../math/Fixed96EwaldMath.sol";

/// @notice Candidate Q96 real-space Ewald pair; this component is not an Ewald sum.
/// @dev Separate arithmetic policy and runtime admission from the binary128 kernel.
contract Fixed96EwaldRealSpaceKernel is Fixed96EwaldMath {
    bytes32 public constant IMPLEMENTATION_ID = keccak256("ORVIA.Fixed96EwaldReal.v1");
    struct Values { int256 strength; int256 alpha; int256 cutoff; }

    function evaluate(bytes16[3] calldata displacement, bytes16 chargeProduct,
        bytes16 prefactor, bytes16 alpha, bytes16 cutoff)
        external pure returns (bytes16 energy, bytes16[3] memory forceOnA)
    {
        int256 charge = _fixed(chargeProduct);
        int256 pref = _fixed(prefactor);
        Values memory p = Values(_mul(charge,pref),_fixed(alpha),_fixed(cutoff));
        if (pref < 0 || p.alpha <= 0 || p.cutoff <= 0) revert InvalidParameter();
        if (_mul(p.alpha,p.cutoff) > 16 * ONE) revert ArithmeticDomain();
        int256 r2;
        int256[3] memory d;
        for (uint256 axis; axis < 3; ++axis) {
            d[axis] = _fixed(displacement[axis]);
            r2 = _add(r2,_mul(d[axis],d[axis]));
        }
        if (r2 == 0) revert ZeroSeparation();
        int256 r = _sqrt(r2);
        if (r >= p.cutoff) return (energy,forceOnA);
        (int256 e,int256 scale) = _radial(r,r2,p);
        energy = _quad(e);
        for (uint256 axis; axis < 3; ++axis) forceOnA[axis] = _quad(_mul(scale,d[axis]));
    }

    function _radial(int256 r,int256 r2,Values memory p) private pure returns(int256 energy,int256 scale) {
        int256 x = _mul(p.alpha,r);
        int256 complement = _erfcPositive(x);
        energy = _div(_mul(p.strength,complement),r);
        int256 derivative = _mul(_mul(2 * INV_SQRT_PI96,p.alpha),_expNegative(_mul(x,x)));
        scale = -_div(_mul(p.strength,_add(_div(complement,r),derivative)),r2);
    }
}
