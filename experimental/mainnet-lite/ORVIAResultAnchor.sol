// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Small mainnet publication endpoint for GPU-produced ORVIA results.
/// @dev This authenticates an operator's signed report; it does not prove or
///      execute the molecular calculation. Full inputs and outputs stay off-chain.
///      The immutable operator must use an EOA signature. Identical reports may
///      be relayed repeatedly; consumers must deduplicate by the EIP-712 digest.
contract ORVIAResultAnchor {
    error InvalidOperator();
    error InvalidSignature();
    error InvalidReport();

    address public immutable operator;

    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant REPORT_TYPEHASH = keccak256(
        "Report(bytes32 inputHash,bytes32 methodHash,bytes32 settingsHash,bytes32 outputHash,uint32 atomCount,uint64 sampleCount)"
    );
    bytes32 private constant NAME_HASH = keccak256("ORVIAResultAnchor");
    bytes32 private constant VERSION_HASH = keccak256("1");

    event ResultAnchored(
        bytes32 indexed inputHash,
        bytes32 indexed outputHash,
        bytes32 indexed methodHash,
        bytes32 settingsHash,
        uint32 atomCount,
        uint64 sampleCount,
        address operator
    );

    constructor(address operator_) {
        if (operator_ == address(0)) revert InvalidOperator();
        operator = operator_;
    }

    function anchor(
        bytes32 inputHash,
        bytes32 methodHash,
        bytes32 settingsHash,
        bytes32 outputHash,
        uint32 atomCount,
        uint64 sampleCount,
        bytes calldata signature
    ) external {
        if (inputHash == 0 || methodHash == 0 || settingsHash == 0 || outputHash == 0 || atomCount == 0 || sampleCount == 0) {
            revert InvalidReport();
        }
        bytes32 domain = keccak256(abi.encode(
            DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)
        ));
        bytes32 report = keccak256(abi.encode(
            REPORT_TYPEHASH, inputHash, methodHash, settingsHash, outputHash, atomCount, sampleCount
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, report));
        if (_recover(digest, signature) != operator) revert InvalidSignature();
        emit ResultAnchored(inputHash, outputHash, methodHash, settingsHash, atomCount, sampleCount, operator);
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v != 27 && v != 28) revert InvalidSignature();
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
