// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC1363} from "@openzeppelin/contracts/token/ERC20/extensions/ERC1363.sol";
import {ERC20Authorization} from "./extensions/ERC20Authorization.sol";
import {ERC20PermitWithContractSignatures} from "./extensions/ERC20PermitWithContractSignatures.sol";

/// @title Longtail
/// @notice Fixed-supply ERC-20 with signed approvals, signed payments, and transfer/approval callbacks.
/// @dev Mints only during construction. Uses 18 decimals and has no privileged or upgrade entry points.
/// Both permit overloads share a nonce counter; ERC-3009 nonces are independent.
/// Token movements to this contract's own address are rejected, including zero-value movements.
contract Token is ERC20PermitWithContractSignatures, ERC20Authorization, ERC1363 {
    /// @notice Creates Longtail and mints the entire fixed supply to the receiver.
    /// @dev The amount is not scaled. The complete uint256 range, including zero, is accepted.
    /// @param totalSupply_ Base units (1 token = 10**18 units), at most type(uint256).max.
    /// @param receiver Address receiving the entire supply; cannot be zero or this token's own address.
    constructor(uint256 totalSupply_, address receiver) ERC20("Longtail", "TAIL") ERC20Permit("Longtail") {
        _mint(receiver, totalSupply_);
    }

    /// @dev Rejects this token's own address as a destination before accounting, including for the constructor mint.
    /// @param from Account debited, or zero for the constructor mint.
    /// @param to Account credited, or zero for the inherited internal burn path, which is not exposed.
    /// @param value Amount moved in base units.
    function _update(address from, address to, uint256 value) internal override {
        if (to == address(this)) revert ERC20InvalidReceiver(to);
        super._update(from, to, value);
    }
}
