// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {OrderedNeighborPairs} from "../../contracts/core/OrderedNeighborPairs.sol";

/// @dev Test-only owner forwarding arbitrary calls. A production Hamiltonian
///      must consume the returned pair and update forces in the same transaction.
contract OrderedPairOwnerHarness {
    event Pulled(uint256 indexed id,uint256 processed,bool found,uint32 a,uint32 b,bool complete);
    function register(address pairs,uint256 index) external returns (uint256) {
        return OrderedNeighborPairs(pairs).registerTraversal(index);
    }
    function pull(address pairs,uint256 id,uint256 work) external {
        (uint256 processed,bool found,uint32 a,uint32 b,bool complete)=OrderedNeighborPairs(pairs).advance(id,work);
        emit Pulled(id,processed,found,a,b,complete);
    }
    function pullThenFail(address pairs,uint256 id,uint256 work) external {
        OrderedNeighborPairs(pairs).advance(id,work);
        revert("synthetic consumer-force failure");
    }
}
