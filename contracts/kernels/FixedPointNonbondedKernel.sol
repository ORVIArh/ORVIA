// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Fixed96Math} from "../math/Fixed96Math.sol";

/// @notice Experimental Q96.96 switched LJ/reaction-field pair evaluator.
/// @dev NEW numerical policy, not bitwise-equivalent to the binary128 path.
/// Inputs/outputs retain binary128 encoding; all computation uses bounded
/// signed integers. Every intermediate must remain within +/-2^30 real units.
/// No saturation, clipping, arbitrary small-distance floor or host floats.
contract FixedPointNonbondedKernel is Fixed96Math {
    bytes32 public constant IMPLEMENTATION_ID = keccak256("ORVIA.Fixed96Nonbonded.v1.NearestInput.TruncatedArithmetic.FloorSqrt");

    struct Parameters { int256 sigma; int256 epsilon; int256 charge; int256 prefactor; int256 rs; int256 rc; bool exception; }

    function evaluate(bytes16[3] calldata displacement, bytes16 sigma, bytes16 epsilon,
        bytes16 chargeProduct, bytes16 prefactor, bytes16 switchDistance, bytes16 cutoff, bool exception)
        external pure returns (bytes16 energy, bytes16[3] memory forceOnA)
    {
        Parameters memory p = Parameters(_fixed(sigma), _fixed(epsilon), _fixed(chargeProduct),
            _fixed(prefactor), _fixed(switchDistance), _fixed(cutoff), exception);
        if (p.sigma <= 0 || p.epsilon < 0 || p.prefactor < 0 || p.rs <= 0 || p.rc <= p.rs) revert InvalidParameter();
        int256[3] memory d;
        int256 r2;
        for (uint256 i; i < 3; ++i) { d[i] = _fixed(displacement[i]); r2 = _add(r2, _mul(d[i], d[i])); }
        if (r2 == 0) revert ZeroSeparation();
        int256 r = _sqrt(r2);
        if (!exception && r >= p.rc) return (energy, forceOnA);
        (int256 e, int256[3] memory f) = _lj(d,r2,p.sigma,p.epsilon);
        int256 strength = _mul(p.charge,p.prefactor);
        if (exception) {
            int256 ec = _div(strength,r);
            e = _add(e,ec);
            int256 scale = -_div(ec,r2);
            for (uint256 i; i < 3; ++i) f[i] = _add(f[i],_mul(scale,d[i]));
        } else {
            if (r > p.rs) (e,f) = _switched(d,r,p,e,f);
            if (strength != 0) {
                (int256 er,int256 scale) = _reaction(r,p.rc,strength);
                e = _add(e,er);
                for (uint256 i; i < 3; ++i) f[i] = _add(f[i],_mul(scale,d[i]));
            }
        }
        energy = _quad(e);
        for (uint256 i; i < 3; ++i) forceOnA[i] = _quad(f[i]);
    }

    function _lj(int256[3] memory d,int256 r2,int256 sigma,int256 epsilon)
        private pure returns (int256 e,int256[3] memory f)
    {
        if (epsilon == 0) return (e,f);
        int256 s2 = _div(_mul(sigma,sigma),r2);
        int256 s6 = _mul(_mul(s2,s2),s2);
        int256 s12 = _mul(s6,s6);
        e = _mul(_mul(4*ONE,epsilon),_sub(s12,s6));
        int256 scale = _div(_mul(_mul(24*ONE,epsilon),_sub(s6,_mul(2*ONE,s12))),r2);
        for (uint256 i; i < 3; ++i) f[i] = _mul(scale,d[i]);
    }
    function _switched(int256[3] memory d,int256 r,Parameters memory p,int256 e,int256[3] memory f)
        private pure returns (int256,int256[3] memory)
    {
        (int256 s,int256 derivative) = _switch(r,p.rs,p.rc);
        int256 correction = _div(_mul(e,derivative),r);
        for (uint256 i; i < 3; ++i) f[i] = _add(_mul(s,f[i]),_mul(correction,d[i]));
        return (_mul(s,e),f);
    }
    function _switch(int256 r,int256 rs,int256 rc) private pure returns(int256 s,int256 derivative) {
        int256 width = _sub(rc,rs);
        int256 x = _div(_sub(r,rs),width);
        int256 t = _div(_sub(rc,r),width);
        int256 t2 = _mul(t,t);
        s = _mul(_mul(t2,t),_add(_sub(10*ONE,_mul(15*ONE,t)),_mul(6*ONE,t2)));
        derivative = -_div(_mul(30*ONE,_mul(_mul(x,x),t2)),width);
    }
    function _reaction(int256 r,int256 rc,int256 strength) private pure returns(int256 e,int256 scale) {
        int256 t = _div(r,rc);
        int256 gap = _div(_sub(rc,r),rc);
        e = _mul(strength,_div(_div(_mul(_mul(gap,gap),_add(t,2*ONE)),r),2*ONE));
        scale = -_mul(strength,_div(_div(_div(_mul(gap,_add(ONE,_add(t,_mul(t,t)))),r),r),r));
    }
}
