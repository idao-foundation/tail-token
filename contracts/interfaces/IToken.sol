// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Longtail (TAIL) complete token interface
/// @notice Standalone interface for an already-deployed Longtail token. Copy this file without any dependencies.
/// @dev Matches Token's functions, events, and custom errors, including inherited OpenZeppelin declarations.
/// All token amounts use 18-decimal base units. Signature validity timestamps use Unix seconds.
/// Both permit overloads share sequential nonces; ERC-3009 uses separate unordered bytes32 nonces.
/// Movements to the token's own address revert, even for zero amounts. All writes are nonpayable.
/// The constructor is documented separately because Solidity interfaces describe deployed-contract calls.
interface IToken {
    // Read functions: metadata, balances, and allowances

    /// @notice Returns the token's display name.
    /// @return "Longtail".
    function name() external view returns (string memory);

    /// @notice Returns the token's ticker.
    /// @return "TAIL".
    function symbol() external view returns (string memory);

    /// @notice Returns the number of decimal places used to display token amounts.
    /// @return 18.
    function decimals() external view returns (uint8);

    /// @notice Returns the fixed supply minted during construction.
    /// @return Total supply in base units.
    function totalSupply() external view returns (uint256);

    /// @notice Returns an account's token balance.
    /// @param account Account whose balance is requested.
    /// @return Balance in base units.
    function balanceOf(address account) external view returns (uint256);

    /// @notice Returns a spender's remaining allowance from an owner.
    /// @param owner Account whose tokens may be spent.
    /// @param spender Account authorized to spend those tokens.
    /// @return Allowance in base units; type(uint256).max means unlimited.
    function allowance(address owner, address spender) external view returns (uint256);

    // Read functions: signatures and replay protection

    /// @notice Returns the next sequential permit nonce.
    /// @dev Ordinary approve calls do not consume this nonce. ERC-3009 nonces are independent.
    /// @param owner Account whose sequential nonce is requested.
    /// @return Next unused nonce, initially zero.
    function nonces(address owner) external view returns (uint256);

    /// @notice Returns the EIP-712 domain separator used for signed operations.
    /// @return Domain separator for this deployment and the current chain ID.
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    /// @notice Returns the EIP-712 domain fields for wallet and application integrations.
    /// @return fields 0x0f: name, version, chain ID, and verifying contract are present.
    /// @return name "Longtail".
    /// @return version "1".
    /// @return chainId Current chain ID; 56 on BSC mainnet.
    /// @return verifyingContract Address of the deployed token.
    /// @return salt Zero; salt is not included in the signed domain.
    /// @return extensions Empty array; no domain extensions are declared.
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );

    /// @notice Reports whether an ERC-3009 authorization nonce has been executed or canceled.
    /// @param authorizer Account whose nonce is queried.
    /// @param nonce Unordered authorization identifier scoped to the authorizer.
    /// @return True if consumed; false does not imply a valid, funded, or currently executable signature exists.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    /// @notice Returns the EIP-712 type hash for TransferWithAuthorization.
    /// @dev Hashes "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)".
    /// @return Canonical transfer-authorization type hash.
    function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);

    /// @notice Returns the EIP-712 type hash for ReceiveWithAuthorization.
    /// @dev Hashes "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)".
    /// @return Canonical receive-authorization type hash.
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);

    /// @notice Returns the EIP-712 type hash for CancelAuthorization.
    /// @dev Hashes "CancelAuthorization(address authorizer,bytes32 nonce)".
    /// @return Canonical cancellation type hash.
    function CANCEL_AUTHORIZATION_TYPEHASH() external view returns (bytes32);

    // Read functions: interface discovery

    /// @notice Reports whether an ERC-165 interface ID is advertised by the token.
    /// @param interfaceId Interface identifier to check.
    /// @return True for ERC-165 (0x01ffc9a7) and ERC-1363 (0xb0202a11); false for other IDs.
    function supportsInterface(bytes4 interfaceId) external view returns (bool);

    // Write functions: ordinary ERC-20 operations

    /// @notice Transfers the caller's tokens without invoking a recipient callback.
    /// @param to Nonzero recipient, which must differ from the token contract's own address.
    /// @param value Amount in base units. Holder-to-same-holder transfers are allowed.
    /// @return True on success; reverts on failure.
    function transfer(address to, uint256 value) external returns (bool);

    /// @notice Replaces the caller's allowance for a spender without moving tokens.
    /// @dev Does not consume a nonce or invalidate outstanding signed permits.
    /// @param spender Nonzero account authorized to spend the caller's tokens.
    /// @param value New allowance in base units; zero revokes and type(uint256).max means unlimited.
    /// @return True on success; reverts on failure.
    function approve(address spender, uint256 value) external returns (bool);

    /// @notice Transfers tokens using the caller's allowance, without invoking a recipient callback.
    /// @dev Finite allowance is spent before moving tokens. Unlimited allowance is not decremented.
    /// @param from Nonzero token holder granting the caller sufficient allowance.
    /// @param to Nonzero recipient, which must differ from the token contract's own address.
    /// @param value Amount in base units.
    /// @return True on success; reverts on failure.
    function transferFrom(address from, address to, uint256 value) external returns (bool);

    // Write functions: signed approvals

    /// @notice Sets an allowance using a canonical ERC-2612 ECDSA signature; anyone may relay it.
    /// @dev Signs Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline).
    /// Consumes nonces(owner), shared with the bytes permit. Does not validate ERC-1271 signatures.
    /// @param owner Nonzero account signing the allowance.
    /// @param spender Nonzero account authorized to spend the owner's tokens.
    /// @param value Replacement allowance in base units; type(uint256).max means unlimited.
    /// @param deadline Last valid submission timestamp, inclusive; the resulting allowance does not expire.
    /// @param v ECDSA recovery identifier, 27 or 28.
    /// @param r First 32-byte ECDSA signature component.
    /// @param s Canonical low-s ECDSA signature component.
    function permit(
        address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s
    ) external;

    /// @notice Sets an allowance using an EOA or ERC-1271 wallet signature; anyone may relay it.
    /// @dev Uses the same Permit typed message and sequential nonce as canonical ERC-2612.
    /// Contract signatures are validated through STATICCALL. A failed operation rolls back nonce consumption.
    /// @param owner Nonzero account authorizing the allowance.
    /// @param spender Nonzero account authorized to spend the owner's tokens.
    /// @param value Replacement allowance in base units; type(uint256).max means unlimited.
    /// @param deadline Last valid submission timestamp, inclusive; the resulting allowance does not expire.
    /// @param signature EOA r || s || v bytes, or the contract wallet's ERC-1271 signature encoding.
    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata signature) external;

    // Write functions: ERC-3009 signed payments and cancellation

    /// @notice Executes a signed transfer without allowance; anyone may relay it.
    /// @dev Packs r || s || v and uses the bytes implementation. Requires validAfter < now < validBefore.
    /// @param from Nonzero authorizer and token holder.
    /// @param to Nonzero signed recipient, which must differ from the token contract's own address.
    /// @param value Amount in base units.
    /// @param validAfter Exclusive lower timestamp bound in Unix seconds.
    /// @param validBefore Exclusive upper timestamp bound in Unix seconds.
    /// @param nonce Unused unordered bytes32 identifier scoped to from.
    /// @param v ECDSA recovery identifier, normally 27 or 28.
    /// @param r First 32-byte signature component.
    /// @param s Second 32-byte signature component; EOA signatures must be low-s.
    function transferWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, uint8 v, bytes32 r, bytes32 s
    ) external;

    /// @notice Executes an EOA- or wallet-authorized transfer without allowance; anyone may relay it.
    /// @dev Uses TransferWithAuthorization and requires validAfter < now < validBefore.
    /// Consumes the authorization nonce and updates balances atomically. No recipient callback is invoked.
    /// @param from Nonzero authorizer and token holder.
    /// @param to Nonzero signed recipient, which must differ from the token contract's own address.
    /// @param value Amount in base units.
    /// @param validAfter Exclusive lower timestamp bound in Unix seconds.
    /// @param validBefore Exclusive upper timestamp bound in Unix seconds.
    /// @param nonce Unused unordered bytes32 identifier scoped to from.
    /// @param signature EOA r || s || v bytes, or the contract wallet's ERC-1271 signature encoding.
    function transferWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, bytes calldata signature
    ) external;

    /// @notice Receives a signed payment submitted by its signed payee.
    /// @dev Packs r || s || v and uses the bytes implementation. Requires validAfter < now < validBefore.
    /// @param from Nonzero authorizer and token holder.
    /// @param to Nonzero signed payee; must equal the immediate caller and differ from the token contract.
    /// @param value Amount in base units.
    /// @param validAfter Exclusive lower timestamp bound in Unix seconds.
    /// @param validBefore Exclusive upper timestamp bound in Unix seconds.
    /// @param nonce Unused unordered bytes32 identifier scoped to from.
    /// @param v ECDSA recovery identifier, normally 27 or 28.
    /// @param r First 32-byte signature component.
    /// @param s Second 32-byte signature component; EOA signatures must be low-s.
    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, uint8 v, bytes32 r, bytes32 s
    ) external;

    /// @notice Receives an EOA- or wallet-authorized payment submitted by its signed payee.
    /// @dev Uses ReceiveWithAuthorization and requires validAfter < now < validBefore.
    /// Consumes the authorization nonce and transfers without allowance or a recipient callback.
    /// @param from Nonzero authorizer and token holder.
    /// @param to Nonzero signed payee; must equal the immediate caller and differ from the token contract.
    /// @param value Amount in base units.
    /// @param validAfter Exclusive lower timestamp bound in Unix seconds.
    /// @param validBefore Exclusive upper timestamp bound in Unix seconds.
    /// @param nonce Unused unordered bytes32 identifier scoped to from.
    /// @param signature EOA r || s || v bytes, or the contract wallet's ERC-1271 signature encoding.
    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, bytes calldata signature
    ) external;

    /// @notice Cancels an unused authorization nonce using a signed message; anyone may relay it.
    /// @dev Packs r || s || v and uses the bytes implementation.
    /// @param authorizer Nonzero account authorizing cancellation.
    /// @param nonce Unused bytes32 nonce to invalidate for this authorizer.
    /// @param v ECDSA recovery identifier, normally 27 or 28.
    /// @param r First 32-byte signature component.
    /// @param s Second 32-byte signature component; EOA signatures must be low-s.
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;

    /// @notice Cancels an unused authorization with an EOA or wallet signature; anyone may relay it.
    /// @dev Signs CancelAuthorization(address authorizer,bytes32 nonce). No deadline applies.
    /// Invalidates the nonce for both payment methods; cannot undo an already executed authorization.
    /// @param authorizer Nonzero account authorizing cancellation.
    /// @param nonce Unused bytes32 nonce to invalidate for this authorizer.
    /// @param signature EOA r || s || v bytes, or the contract wallet's ERC-1271 signature encoding.
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes calldata signature) external;

    // Write functions: ERC-1363 callbacks

    /// @notice Transfers tokens, then calls the recipient's onTransferReceived with empty data.
    /// @dev The recipient must return the ERC-1363 acceptance selector; rejection reverts all changes.
    /// @param to Receiver contract, which must differ from the token contract's own address.
    /// @param value Amount in token base units; no native BNB is forwarded.
    /// @return True on acceptance; reverts on failure.
    function transferAndCall(address to, uint256 value) external returns (bool);

    /// @notice Transfers tokens, then calls the recipient's onTransferReceived with supplied data.
    /// @dev Balances are updated before the callback. Rejection reverts all changes.
    /// @param to Receiver contract, which must differ from the token contract's own address.
    /// @param value Amount in token base units; no native BNB is forwarded.
    /// @param data Additional callback data, forwarded unchanged.
    /// @return True on acceptance; reverts on failure.
    function transferAndCall(address to, uint256 value, bytes calldata data) external returns (bool);

    /// @notice Spends allowance to transfer tokens, then invokes the receiver callback with empty data.
    /// @dev The receiver must return the ERC-1363 acceptance selector; rejection reverts all changes.
    /// @param from Nonzero holder granting the caller sufficient allowance.
    /// @param to Receiver contract, which must differ from the token contract's own address.
    /// @param value Amount in token base units; no native BNB is forwarded.
    /// @return True on acceptance; reverts on failure.
    function transferFromAndCall(address from, address to, uint256 value) external returns (bool);

    /// @notice Spends allowance to transfer tokens, then invokes the receiver callback with supplied data.
    /// @dev Allowance spending and balances are updated before the callback. Rejection reverts all changes.
    /// @param from Nonzero holder granting the caller sufficient allowance.
    /// @param to Receiver contract, which must differ from the token contract's own address.
    /// @param value Amount in token base units; no native BNB is forwarded.
    /// @param data Additional callback data, forwarded unchanged.
    /// @return True on acceptance; reverts on failure.
    function transferFromAndCall(address from, address to, uint256 value, bytes calldata data) external returns (bool);

    /// @notice Sets an allowance, then invokes the spender's onApprovalReceived with empty data.
    /// @dev The spender may consume the allowance during the callback. Rejection reverts all changes.
    /// @param spender Contract implementing the ERC-1363 spender callback.
    /// @param value Replacement allowance in base units; type(uint256).max means unlimited.
    /// @return True on acceptance; reverts on failure.
    function approveAndCall(address spender, uint256 value) external returns (bool);

    /// @notice Sets an allowance, then invokes the spender's onApprovalReceived with supplied data.
    /// @dev The spender may consume the allowance during the callback. Rejection reverts all changes.
    /// @param spender Contract implementing the ERC-1363 spender callback.
    /// @param value Replacement allowance in base units; type(uint256).max means unlimited.
    /// @param data Additional callback data, forwarded unchanged.
    /// @return True on acceptance; reverts on failure.
    function approveAndCall(address spender, uint256 value, bytes calldata data) external returns (bool);

    // Events

    /// @notice Tokens were moved, including the initial mint from the zero address.
    /// @param from Account debited, or zero for minting.
    /// @param to Account credited.
    /// @param value Amount in base units.
    event Transfer(address indexed from, address indexed to, uint256 value);

    /// @notice An allowance was explicitly set by approval or permit.
    /// @dev Finite allowance consumption by transferFrom does not emit this event in this implementation.
    /// @param owner Account granting the allowance.
    /// @param spender Account authorized to spend.
    /// @param value Replacement allowance in base units.
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice A signed payment consumed an ERC-3009 authorization nonce.
    /// @param authorizer Account that authorized the payment.
    /// @param nonce Consumed unordered nonce.
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    /// @notice A signed cancellation invalidated an ERC-3009 authorization nonce.
    /// @param authorizer Account that authorized cancellation.
    /// @param nonce Canceled unordered nonce.
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    /// @notice Standard ERC-5267 event indicating a changed EIP-712 domain.
    /// @dev Included in the inherited ABI; the token exposes no domain-update function.
    event EIP712DomainChanged();

    // Custom errors: ERC-20 and supply

    /// @notice A transfer would exceed the sender's balance.
    /// @param sender Account whose tokens would be spent.
    /// @param balance Available balance in base units.
    /// @param needed Requested amount in base units.
    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);

    /// @notice A transfer would exceed the caller's allowance.
    /// @param spender Account attempting to spend an allowance.
    /// @param allowance Remaining allowance in base units.
    /// @param needed Requested amount in base units.
    error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed);

    /// @notice The sender address is invalid.
    /// @param sender Rejected sender address.
    error ERC20InvalidSender(address sender);

    /// @notice The recipient address is zero or the token contract's own address.
    /// @param receiver Rejected recipient address.
    error ERC20InvalidReceiver(address receiver);

    /// @notice The allowance owner address is invalid.
    /// @param approver Rejected allowance owner.
    error ERC20InvalidApprover(address approver);

    /// @notice The allowance spender address is invalid.
    /// @param spender Rejected spender address.
    error ERC20InvalidSpender(address spender);

    // Custom errors: signatures and authorizations

    /// @notice ECDSA signature recovery failed.
    error ECDSAInvalidSignature();

    /// @notice ECDSA signature bytes have an unsupported length.
    /// @param length Supplied signature length in bytes.
    error ECDSAInvalidSignatureLength(uint256 length);

    /// @notice The ECDSA s component is not in canonical low-s form.
    /// @param s Rejected signature component.
    error ECDSAInvalidSignatureS(bytes32 s);

    /// @notice The permit submission deadline has passed.
    /// @param deadline Expired deadline in Unix seconds.
    error ERC2612ExpiredSignature(uint256 deadline);

    /// @notice The recovered permit signer differs from the claimed owner.
    /// @param signer Recovered ECDSA signer.
    /// @param owner Required allowance owner.
    error ERC2612InvalidSigner(address signer, address owner);

    /// @notice The bytes permit signature failed EOA or ERC-1271 validation.
    /// @param owner Account whose authorization was required.
    error ERC7597InvalidSignature(address owner);

    /// @notice The supplied sequential nonce is not the account's current nonce.
    /// @param account Account whose nonce was checked.
    /// @param currentNonce Expected nonce at the time of the check.
    error InvalidAccountNonce(address account, uint256 currentNonce);

    /// @notice An ERC-3009 nonce was already executed or canceled.
    /// @param authorizer Account to which the nonce belongs.
    /// @param nonce Unavailable authorization nonce.
    error ERC3009AuthorizationAlreadyUsed(address authorizer, bytes32 nonce);

    /// @notice The current timestamp is at or before the authorization's lower bound.
    /// @param validAfter Exclusive lower time bound in Unix seconds.
    error ERC3009AuthorizationNotYetValid(uint256 validAfter);

    /// @notice The current timestamp is at or after the authorization's upper bound.
    /// @param validBefore Exclusive upper time bound in Unix seconds.
    error ERC3009AuthorizationExpired(uint256 validBefore);

    /// @notice The authorization signature did not validate for its authorizer.
    /// @param authorizer Account whose signature was required.
    error ERC3009InvalidSignature(address authorizer);

    /// @notice A receive authorization was submitted by an account other than its signed payee.
    /// @param caller Immediate caller.
    /// @param payee Signed recipient that must submit the call.
    error ERC3009CallerMustBePayee(address caller, address payee);

    // Custom errors: ERC-1363 callbacks

    /// @notice A callback-enabled transfer returned false.
    /// @param receiver Intended recipient.
    /// @param value Attempted token amount.
    error ERC1363TransferFailed(address receiver, uint256 value);

    /// @notice A callback-enabled allowance-funded transfer returned false.
    /// @param sender Token holder to debit.
    /// @param receiver Intended recipient.
    /// @param value Attempted token amount.
    error ERC1363TransferFromFailed(address sender, address receiver, uint256 value);

    /// @notice A callback-enabled approval returned false.
    /// @param spender Intended allowance spender.
    /// @param value Attempted allowance amount.
    error ERC1363ApproveFailed(address spender, uint256 value);

    /// @notice A transfer callback target has no code, rejected the callback, or reverted without a reason.
    /// @param receiver Rejected receiver contract or address.
    error ERC1363InvalidReceiver(address receiver);

    /// @notice An approval callback target has no code, rejected the callback, or reverted without a reason.
    /// @param spender Rejected spender contract or address.
    error ERC1363InvalidSpender(address spender);

    // Custom errors: inherited utilities

    /// @notice An inherited short-string utility encountered an invalid encoding.
    error InvalidShortString();

    /// @notice An inherited short-string utility received a string that was too long to encode.
    /// @param str Rejected string.
    error StringTooLong(string str);
}
