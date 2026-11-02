// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReducedPotentialCollector} from "../analysis/ReducedPotentialCollector.sol";

/// @notice Authenticated bridge from preregistered dynamics to selected analysis.
interface IMolecularCampaignSource {
    struct Registration {
        bytes32 commitment;
        bytes32 selectedSeries;
        ReducedPotentialCollector.Configuration config;
        bytes32 samplingPolicyHash;
        bytes32 modelHash;
    }
    function owner() external view returns (address);
    function collector() external view returns (address);
    function estimator() external view returns (address);
    /// @dev Must reject once any window has started, before observing a trajectory.
    function campaignRegistration(bytes32 id) external view returns (Registration memory);
    /// @dev Must authenticate dependencies and the campaign's converged analysis.
    function campaignAnalysis(bytes32 id) external view returns (bytes32 commitment, bytes32 series, uint256 analysis);
}
