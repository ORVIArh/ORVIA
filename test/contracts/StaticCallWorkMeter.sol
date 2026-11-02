// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Test-only repeated static-call meter. Consumes every returned byte.
contract StaticCallWorkMeter {
    event Measured(uint256[8] callGas,bytes32 digest);
    function measure(address target,bytes calldata input,uint256 count) external {
        require(target.code.length != 0 && count > 0 && count <= 8,"meter domain");
        uint256[8] memory callGas;bytes32 digest;
        for(uint256 i;i<count;++i){
            uint256 beforeCall=gasleft();
            (bool ok,bytes memory result)=target.staticcall(input);
            callGas[i]=beforeCall-gasleft();
            if(!ok)assembly{revert(add(result,32),mload(result))}
            digest=keccak256(abi.encode(digest,result));
        }
        emit Measured(callGas,digest);
    }
}
