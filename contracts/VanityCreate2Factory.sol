// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

/// @title Vanity CREATE2 factory
/// @notice Deploys contracts at deterministic addresses for the account that created this factory.
/// @dev The vanity search assumes this factory is created directly by its session wallet at transaction nonce zero.
/// Salts are used verbatim. Initialization code must include the creation bytecode and encoded constructor arguments.
/// The immutable owner controls factory deployments only; it gains no privileges in Longtail.
contract VanityCreate2Factory {
    /// @notice Returns the only account permitted to deploy through this factory.
    /// @dev Set to the immediate constructor caller; cannot be transferred or renounced.
    /// @return The account that created the factory.
    address public immutable owner;

    /// @notice The caller is not the factory's immutable owner.
    /// @param caller Account attempting the deployment.
    error UnauthorizedDeployer(address caller);

    /// @notice Initialization completed without leaving runtime code at the deployed address.
    /// @param deployed Address whose empty deployment is rolled back.
    error EmptyDeployedCode(address deployed);

    /// @notice A contract was deployed successfully with nonempty runtime code.
    /// @param deployed Address of the deployed contract.
    /// @param salt Unmodified CREATE2 salt supplied by the owner.
    /// @param initCodeHash Keccak-256 hash of the complete initialization code, including constructor arguments.
    event Deployed(address indexed deployed, bytes32 indexed salt, bytes32 initCodeHash);

    /// @notice Creates a factory controlled permanently by its immediate deployer.
    constructor() {
        owner = msg.sender;
    }

    /// @notice Deploys the supplied initialization code using an unmodified CREATE2 salt.
    /// @dev Only the owner may call this function. Exactly msg.value is forwarded to the new constructor.
    /// Longtail's constructor is nonpayable, so its deployment must supply zero native BNB.
    /// OpenZeppelin rejects empty initialization code and failed creation, bubbling constructor revert data.
    /// An empty runtime also reverts. Failure rolls back the deployment, constructor effects, and forwarded value.
    /// @param salt Raw 32-byte salt; neither the caller nor any other value is mixed into it.
    /// @param initCode Creation bytecode followed by ABI-encoded constructor arguments.
    /// @return deployed Address of the newly created contract with nonempty runtime code.
    function deploy(bytes32 salt, bytes memory initCode) external payable returns (address deployed) {
        if (msg.sender != owner) revert UnauthorizedDeployer(msg.sender);

        deployed = Create2.deploy(msg.value, salt, initCode);
        if (deployed.code.length == 0) revert EmptyDeployedCode(deployed);

        emit Deployed(deployed, salt, keccak256(initCode));
    }
}
