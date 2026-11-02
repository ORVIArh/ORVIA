// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {TimeSeriesDiagnostics} from "../../contracts/analysis/TimeSeriesDiagnostics.sol";
/// @dev Test-only supplied observable inputs. Not a production simulation writer.
contract TimeSeriesWriterHarness {
    address public immutable owner=msg.sender;
    function create(address target,bytes32 id,TimeSeriesDiagnostics.Configuration calldata config)external{require(msg.sender==owner);TimeSeriesDiagnostics(target).createSeries(id,config);}
    function append(address target,bytes32 id,uint64 firstStep,bytes16[] calldata values)external{require(msg.sender==owner);TimeSeriesDiagnostics(target).append(id,firstStep,values);}
    function seal(address target,bytes32 id)external{require(msg.sender==owner);TimeSeriesDiagnostics(target).seal(id);}
}
