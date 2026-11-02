// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SwitchedNonbondedKernel} from "../../contracts/kernels/SwitchedNonbondedKernel.sol";

/// @dev Test-only local gas meter. No molecular dataset, production writer or state.
/// Repeating identical charged inputs deliberately measures favorable warm-call locality.
contract PairWorkMeter {
    SwitchedNonbondedKernel public immutable kernel;
    event Measured(uint256 count, bool insideSwitch, uint256[8] callGas, bytes32 digest);

    constructor(address kernel_) {
        require(kernel_.code.length != 0, "missing kernel");
        kernel = SwitchedNonbondedKernel(kernel_);
    }

    function measure(uint256 count, bool insideSwitch) external {
        require(count <= 8, "local meter limit");
        bytes16[3] memory d;
        // (1, 1/4, 1/8) or (5/2, 1/4, 1/8), with rs=2 and rc=3.
        d[0] = insideSwitch ? bytes16(0x40004000000000000000000000000000)
            : bytes16(0x3fff0000000000000000000000000000);
        d[1] = 0x3ffd0000000000000000000000000000;
        d[2] = 0x3ffc0000000000000000000000000000;
        uint256[8] memory callGas;
        bytes32 digest;
        for (uint256 i; i < count; ++i) {
            uint256 beforeCall = gasleft();
            (bytes16 energy, bytes16[3] memory force) = kernel.evaluate(
                d,
                0x3ffe0000000000000000000000000000, // sigma=1/2
                0x3ffc0000000000000000000000000000, // epsilon=1/8
                0xbffd0000000000000000000000000000, // charge product=-1/4
                0x3fff0000000000000000000000000000, // prefactor=1
                0x40000000000000000000000000000000, // rs=2
                0x40008000000000000000000000000000, // rc=3
                false
            );
            callGas[i] = beforeCall - gasleft();
            // Outputs are consumed; their independent readback is checked by the script.
            digest = keccak256(abi.encode(digest, energy, force));
        }
        emit Measured(count, insideSwitch, callGas, digest);
    }
}
