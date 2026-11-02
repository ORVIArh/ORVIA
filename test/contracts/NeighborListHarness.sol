// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NeighborList} from "../../contracts/core/NeighborList.sol";
import {WorkingStatePage} from "../../contracts/core/WorkingStatePage.sol";

/// @dev Test-only writer. Never include in a production protocol.
contract NeighborListHarness {
    WorkingStatePage public page;
    NeighborList public list;
    function configure(address math, address geometry) external {
        require(address(page) == address(0));
        page = new WorkingStatePage(address(this));
        list = new NeighborList(address(this), math, geometry, address(page));
    }
    function register(bytes32 ns, uint32 n, bytes16[3] calldata box, bytes16 cutoff, bytes16 skin) external {
        page.createNamespace(ns, n * 18 + 2);
        list.registerList(ns, n, box, cutoff, skin);
    }
    function position(bytes32 ns, uint32 n, uint8 buffer, uint32 atom, bytes16[3] calldata p) external {
        bytes32[] memory words = new bytes32[](3);
        for (uint256 d; d < 3; ++d) words[d] = bytes32(uint256(uint128(p[d])));
        page.writeWords(ns, uint256(buffer) * 9 * n + atom * 9, words);
    }
    function exception(bytes32 ns, uint32 a, uint32 b, uint8 kind) external { list.setException(ns, a, b, kind); }
    function begin(bytes32 ns, uint8 buffer) external { list.beginEvaluation(ns, buffer); }
    function advance(bytes32 ns, uint256 work) external { list.advance(ns, work); }
    function positionThenAdvance(bytes32 ns, uint32 n, uint32 atom, bytes16[3] calldata p, uint256 work) external {
        bytes32[] memory words = new bytes32[](3);
        for (uint256 d; d < 3; ++d) words[d] = bytes32(uint256(uint128(p[d])));
        page.writeWords(ns, atom * 9, words);
        list.advance(ns, work);
        n;
    }
}
