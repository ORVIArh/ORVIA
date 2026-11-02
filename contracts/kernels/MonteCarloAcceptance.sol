// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FloatMath} from "../math/FloatMath.sol";

interface IMCScalarMath {
    function numericalMath() external view returns (address);
    function ln(bytes16 x) external view returns (bytes16);
}

/// @notice Log-space Metropolis decisions for registered, completed energies.
/// @dev This primitive neither draws randomness nor commits a trial state.
contract MonteCarloAcceptance {
    error InvalidInput();
    FloatMath public immutable numericalMath;
    IMCScalarMath public immutable scalarMath;
    bytes32 public constant KERNEL_ID = keccak256("ORVIA.MonteCarloAcceptance.v1");
    bytes16 private constant ONE = 0x3fff0000000000000000000000000000;
    struct VolumeTrial {
        bytes16 oldEnergy;
        bytes16 trialEnergy;
        bytes16 oldVolume;
        bytes16 trialVolume;
        bytes16 pressure;
        bytes16 kT;
        uint32 scaledEntities;
        bytes16 uniform;
    }

    constructor(address math_, address scalar_) {
        if (math_.code.length==0 || scalar_.code.length==0 || IMCScalarMath(scalar_).numericalMath()!=math_) revert InvalidInput();
        numericalMath=FloatMath(math_); scalarMath=IMCScalarMath(scalar_);
    }

    /// @notice Inputs are u_i(x_i),u_i(x_j),u_j(x_i),u_j(x_j), already reduced.
    function replicaExchange(bytes16[4] calldata u, bytes16 uniform)
        external view returns (bytes16 logAcceptance, bool accepted)
    {
        for(uint256 i;i<4;++i) _finite(u[i]);
        FloatMath m=numericalMath;
        logAcceptance=m.sub(m.add(u[0],u[3]),m.add(u[1],u[2]));
        accepted=_accept(logAcceptance,uniform);
    }

    /// @notice A proposal symmetric in V (not log V); count is scaled entities.
    /// @dev Atomic coordinate scaling uses atom count. Rigid-molecule COM scaling
    ///      needs molecule count and a separate correct proposal implementation.
    function volumeTrial(VolumeTrial calldata p) external view
        returns(bytes16 logAcceptance,bool accepted)
    {
        _finite(p.oldEnergy); _finite(p.trialEnergy); _finite(p.pressure);
        _positive(p.oldVolume); _positive(p.trialVolume); _positive(p.kT);
        if(numericalMath.compare(p.pressure,bytes16(0))<0 || p.scaledEntities==0 || p.scaledEntities>1_000_000) revert InvalidInput();
        FloatMath m=numericalMath;
        bytes16 work=m.add(m.sub(p.trialEnergy,p.oldEnergy),m.mul(p.pressure,m.sub(p.trialVolume,p.oldVolume)));
        // Difference of logarithms avoids overflow in trialVolume/oldVolume.
        bytes16 logRatio=m.sub(scalarMath.ln(p.trialVolume),scalarMath.ln(p.oldVolume));
        logAcceptance=m.sub(m.mul(m.fromUInt(p.scaledEntities),logRatio),m.div(work,p.kT));
        accepted=_accept(logAcceptance,p.uniform);
    }

    function _accept(bytes16 logAcceptance,bytes16 uniform) private view returns(bool) {
        _positive(uniform);
        if(numericalMath.compare(uniform,ONE)>=0) revert InvalidInput();
        return numericalMath.compare(scalarMath.ln(uniform),logAcceptance)<0;
    }
    function _finite(bytes16 x) private view {if(!numericalMath.isFinite(x)) revert InvalidInput();}
    function _positive(bytes16 x) private view {_finite(x);if(numericalMath.compare(x,bytes16(0))<=0) revert InvalidInput();}
}
