// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1363Receiver} from "@openzeppelin/contracts/interfaces/IERC1363Receiver.sol";
import {IERC1363Spender} from "@openzeppelin/contracts/interfaces/IERC1363Spender.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title Token reentry test harness
/// @notice Configures and executes token calls with expected success and return data.
/// @dev Test-only adversarial harness. Configuration and execution are intentionally unrestricted.
abstract contract TokenReentryProbe {
    /// @notice Describes one attempted token call and its expected outcome.
    struct Probe {
        /// @dev ABI-encoded calldata to send to the token.
        bytes data;
        /// @dev Whether the low-level token call must succeed.
        bool expectedSuccess;
        /// @dev Whether the returned bytes must match expectedResult.
        bool checkResult;
        /// @dev Expected return or revert data when checkResult is true.
        bytes expectedResult;
    }

    /// @notice Returns the token targeted by this probe.
    /// @return The immutable token address.
    address public immutable token;
    /// @dev Ordered token calls executed during each configured attack.
    Probe[] private _probes;

    /// @notice A probe produced an unexpected success flag or return value.
    /// @param index Zero-based position of the failing probe.
    /// @param success Actual success flag of the low-level call.
    /// @param result Actual return or revert data.
    error UnexpectedProbeResult(uint256 index, bool success, bytes result);

    /// @notice Creates a probe targeting a token.
    /// @param token_ Token whose entry points will be exercised.
    constructor(address token_) {
        token = token_;
    }

    /// @notice Replaces the ordered list of calls attempted by this mock.
    /// @param probes Token calldata and expected results for each attempted call.
    function configure(Probe[] calldata probes) external {
        delete _probes;
        for (uint256 i; i < probes.length; ++i) {
            _probes.push(probes[i]);
        }
    }

    /// @notice Executes a token call from the mock's address.
    /// @dev Bubbles token revert data. This test helper has no access restrictions.
    /// @param data ABI-encoded calldata for the token.
    /// @return result Raw return data from the successful token call.
    function execute(bytes calldata data) external returns (bytes memory result) {
        bool success;
        (success, result) = token.call(data);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
    }

    /// @dev Runs each probe with bounded gas and reverts if its success flag or checked result differs.
    function _runProbes() internal {
        for (uint256 i; i < _probes.length; ++i) {
            Probe storage probe = _probes[i];
            // Bound each attempted write so an exceptional halt under STATICCALL
            // cannot exhaust the gas needed to test the remaining entry points.
            (bool success, bytes memory result) = token.call{gas: 300_000}(probe.data);
            if (success != probe.expectedSuccess ||
                (probe.checkResult && keccak256(result) != keccak256(probe.expectedResult))) {
                revert UnexpectedProbeResult(i, success, result);
            }
        }
    }
}

/// @title Reentrant ERC-1363 callback mock
/// @notice Executes configured token reentries from transfer and approval callbacks.
/// @dev Test-only harness; response selection is unrestricted.
contract ReentrantCallbacksMock is TokenReentryProbe, IERC1363Receiver, IERC1363Spender {
    /// @notice Returns the count of callbacks, including callbacks nested inside an active attack.
    /// @return Number of callback entries whose enclosing transaction did not revert.
    uint256 public callbackCount;
    /// @notice Returns the configured callback response.
    /// @return Mode 1 returns zero magic, mode 2 reverts, and every other value accepts.
    uint8 public response;
    /// @dev Prevents recursively rerunning the attack list while allowing nested callback entries.
    bool private _running;

    /// @notice The mock was configured to revert its callback.
    error CallbackRejected();

    /// @notice Creates a callback attack mock for a token.
    /// @param token_ Token allowed to invoke the callbacks.
    constructor(address token_) TokenReentryProbe(token_) {}

    /// @notice Selects the return behavior after the configured probes execute.
    /// @param response_ Use 1 for zero magic, 2 for a revert, or another value to accept.
    function setResponse(uint8 response_) external {
        response = response_;
    }

    /// @inheritdoc IERC1363Receiver
    /// @notice Runs the configured reentry probes when this mock receives a token callback.
    /// @dev Ignores callback arguments and runs the configured attack. Only the configured token may call.
    /// @return ERC-1363 receiver acceptance magic, or zero in rejection mode.
    function onTransferReceived(address, address, uint256, bytes calldata) external returns (bytes4) {
        _callback();
        return response == 1 ? bytes4(0) : IERC1363Receiver.onTransferReceived.selector;
    }

    /// @inheritdoc IERC1363Spender
    /// @notice Runs the configured reentry probes when this mock receives an approval callback.
    /// @dev Ignores callback arguments and runs the configured attack. Only the configured token may call.
    /// @return ERC-1363 spender acceptance magic, or zero in rejection mode.
    function onApprovalReceived(address, uint256, bytes calldata) external returns (bytes4) {
        _callback();
        return response == 1 ? bytes4(0) : IERC1363Spender.onApprovalReceived.selector;
    }

    /// @dev Counts each callback, executes the attack once per active callback stack, and applies rejection mode.
    function _callback() private {
        require(msg.sender == token, "only token");
        ++callbackCount;
        // Execute the configured attack once; nested callbacks still run and are counted.
        if (!_running) {
            _running = true;
            _runProbes();
            _running = false;
        }
        if (response == 2) revert CallbackRejected();
    }
}

/// @title Reentrant ERC-1271 signature-validation mock
/// @notice Attempts configured token calls while responding to a signature check.
/// @dev Test-only adversarial wallet; configuration and direct execution are unrestricted.
contract ReentrantSignatureWalletMock is TokenReentryProbe {
    /// @dev Digest accepted by the next signature-validation attempts.
    bytes32 private _expectedHash;
    /// @dev Hash of the exact signature bytes accepted by validation attempts.
    bytes32 private _expectedSignatureHash;
    /// @notice Returns whether validation rejects after executing the configured probes.
    /// @return True to return zero magic after the probes, or false to return ERC-1271 acceptance magic.
    bool public reject;

    /// @notice Creates an adversarial signature wallet targeting a token.
    /// @param token_ Token allowed to invoke the signature-validation function.
    constructor(address token_) TokenReentryProbe(token_) {}

    /// @notice Configures the signature check accepted by this mock and its final response.
    /// @param hash Expected EIP-712 digest.
    /// @param signature Exact signature bytes the token must forward.
    /// @param reject_ Whether to reject after the configured probes have completed.
    function configureSignature(bytes32 hash, bytes calldata signature, bool reject_) external {
        _expectedHash = hash;
        _expectedSignatureHash = keccak256(signature);
        reject = reject_;
    }

    /// @notice Attempts token reentries before returning the configured signature-validation result.
    /// @dev Deliberately non-view and not declared as implementing IERC1271: malicious bytecode may attempt writes.
    /// The token must enforce STATICCALL regardless of this mock's ABI annotations.
    /// @param hash Digest that must match the configured expected digest.
    /// @param signature Signature bytes that must match the configured expected bytes.
    /// @return ERC-1271 acceptance magic when reject is false, or zero otherwise.
    function isValidSignature(bytes32 hash, bytes calldata signature) external returns (bytes4) {
        require(msg.sender == token, "only token");
        require(hash == _expectedHash && keccak256(signature) == _expectedSignatureHash, "unexpected signature");
        _runProbes();
        return reject ? bytes4(0) : IERC1271.isValidSignature.selector;
    }
}
