// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title ERC-20 signed transfer authorizations
/// @notice ERC-3009 transfers and cancellation, with additional ERC-1271 bytes overloads.
/// @dev Authorization nonces are unordered and independent of permit nonces.
/// The concrete token must initialize the shared EIP-712 domain.
abstract contract ERC20Authorization is ERC20, EIP712 {
    /// @notice Returns the EIP-712 type hash for TransferWithAuthorization messages.
    /// @return The keccak256 hash of the canonical TransferWithAuthorization type string.
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    /// @notice Returns the EIP-712 type hash for ReceiveWithAuthorization messages.
    /// @return The keccak256 hash of the canonical ReceiveWithAuthorization type string.
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    /// @notice Returns the EIP-712 type hash for CancelAuthorization messages.
    /// @return The keccak256 hash of the canonical CancelAuthorization type string.
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    /// @dev True for both executed and canceled nonces; shared by all ERC-3009 entry points.
    mapping(address authorizer => mapping(bytes32 nonce => bool)) private _authorizationStates;

    /// @notice A signed transfer or receipt consumed an authorization nonce.
    /// @param authorizer Account that authorized the token movement.
    /// @param nonce Authorization identifier that can no longer be used.
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    /// @notice A signed cancellation permanently invalidated an authorization nonce.
    /// @param authorizer Account that authorized cancellation.
    /// @param nonce Authorization identifier that can no longer be used.
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    /// @notice Execution was attempted before the authorization's open validity interval.
    /// @param validAfter Unix timestamp that the current time must strictly exceed.
    error ERC3009AuthorizationNotYetValid(uint256 validAfter);
    /// @notice Execution was attempted at or after the authorization's expiration.
    /// @param validBefore Unix timestamp that the current time must be strictly below.
    error ERC3009AuthorizationExpired(uint256 validBefore);
    /// @notice The authorization nonce has already been executed or canceled.
    /// @param authorizer Account whose authorization nonce is unavailable.
    /// @param nonce Previously consumed authorization identifier.
    error ERC3009AuthorizationAlreadyUsed(address authorizer, bytes32 nonce);
    /// @notice The signature did not validate for the claimed authorizer.
    /// @param authorizer Account whose signature was required.
    error ERC3009InvalidSignature(address authorizer);
    /// @notice A receive authorization was submitted by an account other than its signed payee.
    /// @param caller Immediate caller of receiveWithAuthorization.
    /// @param payee Signed recipient that must submit the call.
    error ERC3009CallerMustBePayee(address caller, address payee);

    /// @notice Reports whether an authorizer's ERC-3009 nonce has been consumed.
    /// @param authorizer Account whose authorization state is requested.
    /// @param nonce Unordered authorization identifier scoped to the authorizer.
    /// @return True if the authorization was executed or canceled.
    function authorizationState(address authorizer, bytes32 nonce) public view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice Execute a signed payment. Any account may relay it.
    /// @dev Packs r || s || v and uses the bytes overload. Does not spend allowance or invoke a recipient callback.
    /// @param from Nonzero token holder authorizing the payment.
    /// @param to Nonzero recipient signed into the payment.
    /// @param value Amount to transfer in base units.
    /// @param validAfter Exclusive lower bound on execution time, in Unix seconds.
    /// @param validBefore Exclusive upper bound on execution time, in Unix seconds.
    /// @param nonce Unused bytes32 identifier scoped to from; independent of permit nonces.
    /// @param v ECDSA recovery identifier, normally 27 or 28.
    /// @param r First 32-byte ECDSA signature component.
    /// @param s Second 32-byte ECDSA signature component; EOA signatures must use low-s form.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public virtual {
        transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    /// @notice Execute a payment using an EOA or ERC-1271 wallet signature.
    /// @dev Anyone may relay it. Requires validAfter < block.timestamp < validBefore.
    /// Consumes the authorization before transferring; a revert rolls back all changes. No allowance or callback is used.
    /// @param from Nonzero token holder whose signature is validated.
    /// @param to Nonzero recipient signed into the payment.
    /// @param value Amount to transfer in base units.
    /// @param validAfter Exclusive lower bound on execution time, in Unix seconds.
    /// @param validBefore Exclusive upper bound on execution time, in Unix seconds.
    /// @param nonce Unused bytes32 identifier scoped to from.
    /// @param signature ECDSA signature encoded as r || s || v, or the wallet's ERC-1271 signature bytes.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) public virtual {
        _transferWithAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature
        );
    }

    /// @notice Receive a signed payment. Only the signed payee may submit it.
    /// @dev Use this method in deposit contracts to keep payment and deposit accounting atomic.
    /// Packs r || s || v and uses the bytes overload; it does not invoke a recipient callback.
    /// @param from Nonzero token holder authorizing the payment.
    /// @param to Nonzero signed recipient; must equal the immediate caller.
    /// @param value Amount to transfer in base units.
    /// @param validAfter Exclusive lower bound on execution time, in Unix seconds.
    /// @param validBefore Exclusive upper bound on execution time, in Unix seconds.
    /// @param nonce Unused bytes32 identifier scoped to from.
    /// @param v ECDSA recovery identifier, normally 27 or 28.
    /// @param r First 32-byte ECDSA signature component.
    /// @param s Second 32-byte ECDSA signature component; EOA signatures must use low-s form.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public virtual {
        receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    /// @notice Receive a payment using an EOA or ERC-1271 wallet signature.
    /// @dev Requires the signed payee as caller and validAfter < block.timestamp < validBefore.
    /// No allowance or recipient callback is used. A revert rolls back nonce consumption and the transfer.
    /// @param from Nonzero token holder whose signature is validated.
    /// @param to Nonzero signed recipient; must equal the immediate caller.
    /// @param value Amount to transfer in base units.
    /// @param validAfter Exclusive lower bound on execution time, in Unix seconds.
    /// @param validBefore Exclusive upper bound on execution time, in Unix seconds.
    /// @param nonce Unused bytes32 identifier scoped to from.
    /// @param signature ECDSA signature encoded as r || s || v, or the wallet's ERC-1271 signature bytes.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) public virtual {
        if (_msgSender() != to) revert ERC3009CallerMustBePayee(_msgSender(), to);
        _transferWithAuthorization(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature
        );
    }

    /// @notice Cancel an unused authorization using the authorizer's signature.
    /// @dev Anyone may relay it. Packs r || s || v and uses the bytes overload.
    /// @param authorizer Nonzero account authorizing cancellation.
    /// @param nonce Unused bytes32 identifier to invalidate permanently for this authorizer.
    /// @param v ECDSA recovery identifier, normally 27 or 28.
    /// @param r First 32-byte ECDSA signature component.
    /// @param s Second 32-byte ECDSA signature component; EOA signatures must use low-s form.
    function cancelAuthorization(
        address authorizer,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public virtual {
        cancelAuthorization(authorizer, nonce, abi.encodePacked(r, s, v));
    }

    /// @notice Cancel using an EOA or ERC-1271 wallet signature. Anyone may relay it.
    /// @dev Validates a CancelAuthorization message; cannot reverse an executed transfer.
    /// Cancellation has no deadline and makes the nonce unavailable to both transfer methods.
    /// @param authorizer Nonzero account whose cancellation signature is validated.
    /// @param nonce Unused bytes32 identifier to invalidate permanently for this authorizer.
    /// @param signature ECDSA signature encoded as r || s || v, or the wallet's ERC-1271 signature bytes.
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) public virtual {
        _requireUnusedAuthorization(authorizer, nonce);
        _requireValidSignature(authorizer, keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)), signature);
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    /// @dev Validates the signed message and time window, consumes its nonce, and transfers tokens atomically.
    /// @param typeHash TransferWithAuthorization or ReceiveWithAuthorization EIP-712 type hash.
    /// @param from Nonzero token holder whose signature is required.
    /// @param to Nonzero recipient of the payment.
    /// @param value Amount to transfer in base units.
    /// @param validAfter Exclusive lower time bound in Unix seconds.
    /// @param validBefore Exclusive upper time bound in Unix seconds.
    /// @param nonce Unused authorization identifier scoped to from.
    /// @param signature EOA or ERC-1271 signature over the authorization's typed-data digest.
    function _transferWithAuthorization(
        bytes32 typeHash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) private {
        // ERC-3009 defines an open validity interval: validAfter < now < validBefore.
        if (block.timestamp <= validAfter) revert ERC3009AuthorizationNotYetValid(validAfter);
        if (block.timestamp >= validBefore) revert ERC3009AuthorizationExpired(validBefore);
        _requireUnusedAuthorization(from, nonce);
        _requireValidSignature(
            from, keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce)), signature
        );

        // Consume before moving tokens; a failed transfer rolls this state back.
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @dev Reverts if the authorizer's nonce has been executed or canceled.
    /// @param authorizer Account whose nonce is checked.
    /// @param nonce Authorization identifier to check.
    function _requireUnusedAuthorization(address authorizer, bytes32 nonce) private view {
        if (_authorizationStates[authorizer][nonce]) revert ERC3009AuthorizationAlreadyUsed(authorizer, nonce);
    }

    /// @dev Rejects zero authorizers and invalid signatures; ERC-1271 checks execute through STATICCALL.
    /// @param authorizer Nonzero account expected to authorize the message.
    /// @param structHash Hash of the typed message before applying the shared EIP-712 domain.
    /// @param signature EOA or ERC-1271 signature over the resulting typed-data digest.
    function _requireValidSignature(address authorizer, bytes32 structHash, bytes memory signature) private view {
        if (authorizer == address(0)) revert ERC20InvalidSender(authorizer);
        if (!SignatureChecker.isValidSignatureNow(authorizer, _hashTypedDataV4(structHash), signature)) {
            revert ERC3009InvalidSignature(authorizer);
        }
    }
}
