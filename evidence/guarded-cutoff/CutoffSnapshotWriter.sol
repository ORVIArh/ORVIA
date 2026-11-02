// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ShardedWorkingState} from "contracts/core/ShardedWorkingState.sol";
contract CutoffSnapshotWriter {
 address public immutable owner; ShardedWorkingState public state;
 constructor(){owner=msg.sender;}
 function bind(address page) external {require(msg.sender==owner&&address(state)==address(0));state=ShardedWorkingState(page);require(state.writer()==address(this));}
 function load(bytes32 ns,bytes32 snap,bytes32[] calldata values) external {require(msg.sender==owner);state.createNamespace(ns,uint32(values.length));
  for(uint256 start;start<values.length;start+=128){uint256 count=values.length-start;if(count>128)count=128;bytes32[] memory chunk=new bytes32[](count);for(uint256 k;k<count;++k)chunk[k]=values[start+k];state.writeWords(ns,start,chunk);}
  state.snapshotNamespace(ns,snap);
 }
}