// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Test-only writer. Deliberately forwards arbitrary calls without authorization.
///      Never use this contract as a production coordinator or page writer.
contract WorkingStateWriterHarness {
    function forward(address page, bytes calldata data) external returns (bytes memory) {
        (bool success, bytes memory result) = page.call(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }
}
