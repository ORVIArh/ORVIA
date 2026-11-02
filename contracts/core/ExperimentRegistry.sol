// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Append-only protocol/version commitments for ORVIA component validation.
/// @dev A registered protocol cannot be edited, deleted, or reassigned.
contract ExperimentRegistry {
    error Unauthorized();
    error InvalidOwner();
    error InvalidProtocol();
    error AlreadyRegistered();
    error UnknownProtocol();
    error InvalidModule();
    error DuplicateModule();
    error ModuleCodeChanged(address module);
    error ModuleNotRegistered(address module);

    uint256 public constant MAX_MODULES = 64;
    address public immutable owner;

    struct Protocol {
        bytes32 specificationHash;
        bytes32 manifestHash;
        address[] modules;
        bytes32[] codeHashes;
        bool exists;
    }

    mapping(bytes32 => Protocol) private _protocols;

    event ProtocolRegistered(bytes32 indexed protocolId, bytes32 specificationHash, bytes32 manifestHash);

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidOwner();
        owner = owner_;
    }

    function registerProtocol(
        bytes32 protocolId,
        bytes32 specificationHash,
        address[] calldata modules
    ) external returns (bytes32 manifestHash) {
        if (msg.sender != owner) revert Unauthorized();
        if (protocolId == bytes32(0) || specificationHash == bytes32(0)) revert InvalidProtocol();
        if (_protocols[protocolId].exists) revert AlreadyRegistered();
        if (modules.length == 0 || modules.length > MAX_MODULES) revert InvalidModule();

        bytes32[] memory hashes = new bytes32[](modules.length);
        for (uint256 i; i < modules.length; ++i) {
            if (modules[i].code.length == 0) revert InvalidModule();
            for (uint256 j; j < i; ++j) {
                if (modules[j] == modules[i]) revert DuplicateModule();
            }
            hashes[i] = modules[i].codehash;
        }
        manifestHash = keccak256(abi.encode(protocolId, specificationHash, modules, hashes));
        Protocol storage p = _protocols[protocolId];
        p.specificationHash = specificationHash;
        p.manifestHash = manifestHash;
        p.modules = modules;
        p.codeHashes = hashes;
        p.exists = true;
        emit ProtocolRegistered(protocolId, specificationHash, manifestHash);
    }

    function getProtocol(bytes32 protocolId)
        external view returns (bytes32 specificationHash, bytes32 manifestHash, uint256 moduleCount)
    {
        Protocol storage p = _get(protocolId);
        return (p.specificationHash, p.manifestHash, p.modules.length);
    }

    function moduleAt(bytes32 protocolId, uint256 index) external view returns (address module, bytes32 codeHash) {
        Protocol storage p = _get(protocolId);
        return (p.modules[index], p.codeHashes[index]);
    }

    function assertProtocol(bytes32 protocolId) external view returns (bytes32 manifestHash) {
        Protocol storage p = _get(protocolId);
        for (uint256 i; i < p.modules.length; ++i) {
            if (p.modules[i].code.length == 0 || p.modules[i].codehash != p.codeHashes[i]) {
                revert ModuleCodeChanged(p.modules[i]);
            }
        }
        return p.manifestHash;
    }

    function assertModule(bytes32 protocolId, address module, bytes32 expectedHash) external view {
        Protocol storage p = _get(protocolId);
        for (uint256 i; i < p.modules.length; ++i) {
            if (p.modules[i] == module) {
                if (p.codeHashes[i] != expectedHash || module.codehash != expectedHash || module.code.length == 0) {
                    revert ModuleCodeChanged(module);
                }
                return;
            }
        }
        revert ModuleNotRegistered(module);
    }

    function _get(bytes32 protocolId) private view returns (Protocol storage p) {
        p = _protocols[protocolId];
        if (!p.exists) revert UnknownProtocol();
    }
}
