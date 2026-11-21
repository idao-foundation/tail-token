// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC1363Receiver} from "@openzeppelin/contracts/interfaces/IERC1363Receiver.sol";
import {IERC1363Spender} from "@openzeppelin/contracts/interfaces/IERC1363Spender.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title Contract-signature test wallet
/// @notice Provides controllable ERC-1271 validation and signer-authorized execution for tests.
/// @dev Test-only wallet. Encoded signatures deliberately exceed 65 bytes.
contract SignatureWalletMock is IERC1271 {
    /// @notice Returns the account authorized to sign for and execute through this mock.
    /// @return The immutable wallet signer.
    address public immutable signer;
    /// @notice Returns the configured signature-validation behavior.
    /// @return Mode 1 returns invalid magic, mode 2 reverts, and every other value validates normally.
    uint8 public signatureMode;

    /// @notice Creates a test wallet controlled by a signer.
    /// @param signer_ Account authorized to configure and execute through the wallet.
    constructor(address signer_) { signer = signer_; }

    /// @notice Sets how this mock responds to signature validation.
    /// @param mode Use 1 for invalid magic, 2 for a revert, or another value for normal validation.
    function setSignatureMode(uint8 mode) external {
        require(msg.sender == signer, "not wallet signer");
        signatureMode = mode;
    }

    /// @inheritdoc IERC1271
    /// @notice Validates an ABI-wrapped ECDSA signature according to the configured response mode.
    /// @param hash Digest signed by the wallet's immutable signer.
    /// @param signature abi.encode(bytes) containing an ECDSA r || s || v signature.
    /// @return ERC-1271 acceptance magic on success, or 0xffffffff on an invalid signature or mode 1.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signatureMode == 2) revert("wallet rejected");
        if (signatureMode == 1) return bytes4(0xffffffff);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, abi.decode(signature, (bytes)));
        return err == ECDSA.RecoverError.NoError && recovered == signer
            ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    /// @notice Executes a call from this wallet when requested by its signer.
    /// @dev Bubbles the target's revert data; no native currency is sent.
    /// @param target Contract to call.
    /// @param data ABI-encoded calldata for the target.
    /// @return Raw return data from the successful target call.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == signer, "not wallet signer");
        (bool success, bytes memory result) = target.call(data);
        if (!success) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        return result;
    }
}

/// @title Test interface for recipient-submitted authorizations
/// @notice Exposes the bytes-signature receipt function used by the deposit mock.
interface IReceiveAuthorization {
    /// @notice Transfers tokens using a signed authorization submitted by its recipient.
    /// @param from Token holder authorizing the payment.
    /// @param to Signed payee, which must also be the immediate caller.
    /// @param value Amount in base units.
    /// @param validAfter Exclusive lower time bound in Unix seconds.
    /// @param validBefore Exclusive upper time bound in Unix seconds.
    /// @param nonce Unordered authorization identifier scoped to from.
    /// @param signature EOA or ERC-1271 signature over the ReceiveWithAuthorization message.
    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter,
        uint256 validBefore, bytes32 nonce, bytes calldata signature
    ) external;
}

/// @title ERC-1363 callback and authorized-deposit test mock
/// @notice Exercises token callbacks and recipient-submitted payments.
/// @dev Test-only receiver/spender for successful, rejecting, and reverting callbacks.
contract TokenHooksMock is IERC1363Receiver, IERC1363Spender {
    /// @notice Returns the token accepted by this mock.
    /// @return The immutable token contract.
    IERC20 public immutable token;
    /// @notice Returns the callback response mode.
    /// @return Mode 1 returns invalid magic, mode 2 reverts, and every other value accepts.
    uint8 public responseMode;
    /// @notice Returns the number of accepted transfer callbacks.
    /// @return The successful transfer-callback count.
    uint256 public receivedCount;
    /// @notice Returns the token balance observed during the last accepted transfer callback.
    /// @return The observed balance in base units.
    uint256 public balanceDuringCallback;
    /// @notice Returns the cumulative authorized deposits credited to an account.
    /// @return The account's deposit credit in base units.
    mapping(address => uint256) public deposits;

    /// @notice An incoming transfer callback was accepted.
    /// @param operator Account that initiated the token's callback-enabled transfer.
    /// @param from Account debited by the transfer.
    /// @param value Amount received in base units.
    /// @param data Additional callback data supplied by the initiator.
    event Received(address operator, address from, uint256 value, bytes data);
    /// @notice An approval callback was accepted and its allowance spent into this mock.
    /// @param owner Account granting the allowance.
    /// @param value Amount transferred from the owner in base units.
    /// @param data Additional callback data supplied by the owner.
    event Approved(address owner, uint256 value, bytes data);

    /// @notice Creates a callback mock for a particular token.
    /// @param token_ Token whose callbacks and deposits this mock accepts.
    constructor(IERC20 token_) { token = token_; }

    /// @notice Selects the response for subsequent callbacks.
    /// @param mode Use 1 for invalid magic, 2 for a revert, or another value to accept.
    function setResponseMode(uint8 mode) external { responseMode = mode; }

    /// @inheritdoc IERC1363Receiver
    /// @notice Accepts, rejects, or reverts a transfer callback according to the response mode.
    /// @param operator Account initiating the transfer.
    /// @param from Account debited by the transfer.
    /// @param value Amount received in base units.
    /// @param data Additional callback data.
    /// @return ERC-1363 receiver acceptance magic, or 0xffffffff in rejection mode.
    function onTransferReceived(address operator, address from, uint256 value, bytes calldata data)
        external returns (bytes4)
    {
        require(msg.sender == address(token), "unexpected token");
        if (responseMode == 2) revert("hook rejected");
        if (responseMode == 1) return bytes4(0xffffffff);
        receivedCount++;
        balanceDuringCallback = token.balanceOf(address(this));
        emit Received(operator, from, value, data);
        return IERC1363Receiver.onTransferReceived.selector;
    }

    /// @inheritdoc IERC1363Spender
    /// @notice Accepts an approval callback and spends its value into this mock unless configured to reject.
    /// @param owner Account that granted the allowance.
    /// @param value Amount to transfer from the owner in base units.
    /// @param data Additional callback data.
    /// @return ERC-1363 spender acceptance magic, or 0xffffffff in rejection mode.
    function onApprovalReceived(address owner, uint256 value, bytes calldata data) external returns (bytes4) {
        require(msg.sender == address(token), "unexpected token");
        if (responseMode == 2) revert("hook rejected");
        if (responseMode == 1) return bytes4(0xffffffff);
        require(token.transferFrom(owner, address(this), value), "transfer failed");
        emit Approved(owner, value, data);
        return IERC1363Spender.onApprovalReceived.selector;
    }

    /// @notice Receives an authorized payment and credits its authorizer in the same transaction.
    /// @param from Token holder authorizing and receiving credit for the deposit.
    /// @param value Deposit amount in base units.
    /// @param validAfter Exclusive lower time bound in Unix seconds.
    /// @param validBefore Exclusive upper time bound in Unix seconds.
    /// @param nonce Unused ERC-3009 authorization identifier scoped to from.
    /// @param signature EOA or ERC-1271 signature authorizing payment to this mock.
    function depositWithAuthorization(
        address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature
    ) external {
        IReceiveAuthorization(address(token)).receiveWithAuthorization(
            from, address(this), value, validAfter, validBefore, nonce, signature
        );
        deposits[from] += value;
    }
}
