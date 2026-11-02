// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {ReducedPotentialCollector} from "../../contracts/analysis/ReducedPotentialCollector.sol";
/// @dev Test only. It deliberately accepts supplied energies, never a production writer.
contract AnalysisWriterHarness {
    address public immutable owner=msg.sender;
    function create(address c,bytes32 id,ReducedPotentialCollector.Configuration calldata config)external{require(msg.sender==owner);ReducedPotentialCollector(c).createSeries(id,config);}
    function append(address c,bytes32 id,uint8 state,uint64 step,bytes16[] calldata energies)external{require(msg.sender==owner);ReducedPotentialCollector(c).appendSample(id,state,step,energies);}
    function seal(address c,bytes32 id)external{require(msg.sender==owner);ReducedPotentialCollector(c).seal(id);}
}
