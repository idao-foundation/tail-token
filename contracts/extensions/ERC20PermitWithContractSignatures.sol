// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title ERC-20 permits with contract-wallet signatures
/// @notice ERC-7597 permit overload supporting EOA and ERC-1271 wallet signatures.
/// @dev Shares the ERC-2612 domain, typed message, and nonce counter. The inherited
/// v/r/s entry point retains OpenZeppelin's canonical ERC-2612 implementation.
abstract contract ERC20PermitWithContractSignatures is ERC20Permit {
    /// @dev EIP-712 type hash shared with the inherited ERC-2612 permit message.
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /// @notice The supplied signature did not validate for the allowance owner.
    /// @param owner Account whose signature was required.
    error ERC7597InvalidSignature(address owner);

    /// @notice Approve a spender using an EOA signature or an ERC-1271 wallet signature.
    /// @dev The deadline limits signature submission, not the lifetime of the allowance.
    /// Anyone may relay this call. Consumes the nonce shared by both permit overloads on success.
    /// Contract-wallet validation uses STATICCALL; a revert rolls back nonce consumption.
    /// @param owner Nonzero account granting the allowance and authorizing the signature.
    /// @param spender Nonzero account allowed to spend the owner's tokens.
    /// @param value Replacement allowance in base units; type(uint256).max means unlimited.
    /// @param deadline Last valid submission time, inclusive, as Unix seconds.
    /// @param signature ECDSA signature encoded as r || s || v, or the wallet's ERC-1271 signature bytes.
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        bytes calldata signature
    ) public virtual {
        if (block.timestamp > deadline) revert ERC2612ExpiredSignature(deadline);
        if (owner == address(0)) revert ERC20InvalidApprover(owner);

        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, _useNonce(owner), deadline));
        if (!SignatureChecker.isValidSignatureNowCalldata(owner, _hashTypedDataV4(structHash), signature)) {
            revert ERC7597InvalidSignature(owner);
        }

        _approve(owner, spender, value);
    }
}
