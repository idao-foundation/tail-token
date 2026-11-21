// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VanityCreate2Factory} from "../VanityCreate2Factory.sol";

/// @notice Test-only constructor that records its caller and native value.
contract Create2PayableMock {
    /// @notice Returns the account that created this contract.
    /// @return The immediate constructor caller.
    address public immutable creator;

    /// @notice Returns the native value supplied to the constructor, in wei.
    /// @return The constructor's msg.value.
    uint256 public immutable receivedValue;

    /// @notice Records the caller and accepts native value for factory forwarding tests.
    constructor() payable {
        creator = msg.sender;
        receivedValue = msg.value;
    }
}

/// @notice Test-only constructor that attempts to reenter its deploying factory.
contract Create2ReentrantMock {
    /// @notice Returns whether the nested deployment was accepted.
    /// @return True if the nested factory call succeeded.
    bool public immutable reentrySucceeded;

    /// @notice Returns the nested call's revert selector, or zero if no selector was returned.
    /// @return The first four bytes of the nested revert data.
    bytes4 public immutable reentryError;

    /// @notice Attempts a nested deployment as the new contract, rather than as the factory owner.
    /// @param salt Salt for the nested deployment attempt.
    /// @param initCode Valid initialization code for the nested deployment attempt.
    constructor(bytes32 salt, bytes memory initCode) {
        (bool success, bytes memory result) = msg.sender.call(
            abi.encodeCall(VanityCreate2Factory.deploy, (salt, initCode))
        );
        reentrySucceeded = success;
        reentryError = result.length >= 4 ? bytes4(result) : bytes4(0);
    }
}
