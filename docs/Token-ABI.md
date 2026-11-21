# Longtail (TAIL): Token ABI reference

This document describes every function in the compiled `Token` ABI: **14 read functions and 17 write functions**, with each overload listed separately. The deployment constructor is documented separately below. Events and custom errors also appear in the ABI but are not callable functions.

Source of truth: [Token.sol](../contracts/Token.sol) and its compiled ABI at `artifacts/contracts/Token.sol/Token.json`, generated locally by `npm run compile` using OpenZeppelin Contracts 5.6.1. Build artifacts are not included in the repository. The project targets BNB Smart Chain mainnet, chain ID `56`.

For Solidity integrations, copy the standalone [IToken.sol](../contracts/interfaces/IToken.sol). It has no imports and includes all functions, events, and custom errors. Its callable ABI is checked against Token by the test suite.

## Conventions

- **Amounts:** balances, allowances, transfers, and supply use integer base units. `1 TAIL = 10^18` base units. Use `ethers.parseUnits("1", 18)` to encode one token.
- **Recipients:** token movements to the token contract's own address revert with `ERC20InvalidReceiver(tokenAddress)`, even for zero amounts. This shared rule covers ordinary transfers, signed payments, callback-triggered movements, and constructor minting. Transfers back to the same holder remain supported.
- **Time:** `validAfter`, `validBefore`, and `deadline` are Unix timestamps in **seconds**, not block numbers or milliseconds.
- **Read functions:** `view`; normally accessed with `eth_call` without submitting a transaction. On-chain calls still consume gas in the calling transaction.
- **Write functions:** all are `nonpayable`. Submit a transaction with no BNB value; its sender pays gas. All are permissionless subject to their balance, allowance, caller, or signature requirements.
- **Returns:** ERC-20/ERC-1363 methods returning `bool` return `true` on success and revert on failure. Signed authorization and permit methods return no value. With ethers, a submitted write returns a transaction response; inspect its receipt/events rather than expecting the Solidity return value from the transaction submission.
- **No administrative API:** the deployed ABI has no owner/role management, mint/burn entry point, pause, blacklist, upgrade, or temporary approval function.

## Deployment constructor

```solidity
constructor(uint256 totalSupply_, address receiver)
```

Creates the `Longtail` / `TAIL` token and mints its entire fixed supply once.

| Parameter | Meaning |
| --- | --- |
| `totalSupply_` | Initial supply in base units. The contract does not scale it. Must be at most `2^256 - 1`, the uint256 limit; zero is accepted. |
| `receiver` | Nonzero address receiving the complete initial supply; must differ from the token's own deployment address. This does not grant administrative privileges. |

The constructor is nonpayable and is not callable after deployment. It emits the standard mint `Transfer` from the zero address.

## Read functions

### Metadata, balances, and allowances

| Function | Returns | Purpose and inputs |
| --- | --- | --- |
| `name()` | `string` | Returns `"Longtail"`, the token's display name. |
| `symbol()` | `string` | Returns `"TAIL"`, the token's ticker. |
| `decimals()` | `uint8` | Returns `18`, the number of decimal places used for display. It does not perform amount scaling. |
| `totalSupply()` | `uint256` | Returns the fixed total minted supply in base units. |
| `balanceOf(address)` | `uint256` | Returns the base-unit balance of `account`. |
| `allowance(address,address)` | `uint256` | Returns how many base units `spender` may transfer from `owner`, in that parameter order. `type(uint256).max` denotes an unlimited allowance that is not decremented when spent. |

### Signature domain and replay state

| Function | Returns | Purpose and inputs |
| --- | --- | --- |
| `nonces(address)` | `uint256` | Returns the next sequential nonce for `owner`, initially zero. Shared by both permit overloads; unrelated to ERC-3009 authorization nonces. |
| `DOMAIN_SEPARATOR()` | `bytes32` | Returns the EIP-712 domain separator for this deployment and the current chain ID. Used in every supported typed-data signature. |
| `eip712Domain()` | `(bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)` | Returns the domain's fields for wallets/integrators: `fields = 0x0f`, `name = "Longtail"`, `version = "1"`, the current chain ID, this token's address, zero salt, and an empty extensions array. The bitmap indicates that name, version, chain ID, and verifying contract are present; salt is absent from the signed domain. |
| `authorizationState(address,bytes32)` | `bool` | For `authorizer` and `nonce`, returns `true` once that ERC-3009 nonce has been executed **or canceled**. `false` means unused; it does not prove a signature exists, is valid, is in its time window, or is sufficiently funded. |
| `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` | `bytes32` | Returns the hash of the exact `TransferWithAuthorization(...)` type string in the signing section below. |
| `RECEIVE_WITH_AUTHORIZATION_TYPEHASH()` | `bytes32` | Returns the hash of the distinct `ReceiveWithAuthorization(...)` type string. A transfer authorization signature cannot be substituted for a receive authorization signature. |
| `CANCEL_AUTHORIZATION_TYPEHASH()` | `bytes32` | Returns the hash of the `CancelAuthorization(...)` type string used to invalidate an unused authorization nonce. |

### Interface discovery

| Function | Returns | Purpose and inputs |
| --- | --- | --- |
| `supportsInterface(bytes4)` | `bool` | Checks `interfaceId`. Returns `true` for ERC-165 (`0x01ffc9a7`) and ERC-1363 (`0xb0202a11`), and `false` for other IDs, including `0xffffffff`. The token does not advertise every implemented ERC standard through ERC-165. |

## Write functions

Every token movement below enforces the recipient restriction described above. Failed movements roll back their balance, allowance, and authorization-nonce changes.

### Ordinary ERC-20 operations

| Function | Returns | Purpose and inputs |
| --- | --- | --- |
| `transfer(address,uint256)` | `bool` | Moves `value` base units from the caller to nonzero `to`. Requires enough balance. Emits `Transfer`. Does not invoke a receiver callback. |
| `approve(address,uint256)` | `bool` | Replaces the caller's allowance for nonzero `spender` with `value` base units and emits `Approval`. Zero revokes the current allowance; `type(uint256).max` grants unlimited allowance. Does not move tokens, invoke a callback, or consume a signature nonce. |
| `transferFrom(address,address,uint256)` | `bool` | Moves `value` base units from nonzero `from` to nonzero `to`, spending the caller's allowance from `from`. Requires enough allowance and balance, including when the caller is `from`. Finite allowance is decremented; unlimited allowance is unchanged. Emits `Transfer`. Does not invoke a receiver callback. |

An allowance set to zero does not invalidate an outstanding signed permit. Allowance replacement follows ordinary ERC-20 semantics, including ordering against already-authorized spending.

### Signed approvals: ERC-2612 and ERC-7597

Both overloads use the `Permit` typed message, set a replacement allowance, emit `Approval`, and increment the same sequential `nonces(owner)` counter. The nonce is signed but is not a function argument. Execution is accepted when `block.timestamp <= deadline`; the resulting allowance does not expire at that deadline. Anyone may submit the signature.

| Function | Returns | Purpose and inputs |
| --- | --- | --- |
| `permit(address,address,uint256,uint256,uint8,bytes32,bytes32)` | None | Canonical ERC-2612 approval. Parameters: nonzero `owner`, nonzero `spender`, replacement `value`, inclusive `deadline`, then ECDSA `v`, `r`, `s`. Recovers the owner's EOA signature using OpenZeppelin; it does not perform ERC-1271 validation. |
| `permit(address,address,uint256,uint256,bytes)` | None | ERC-7597 approval. Parameters: nonzero `owner`, nonzero `spender`, replacement `value`, inclusive `deadline`, then `signature`. Validates an EOA signature or calls the owner's ERC-1271 validator if the owner has code. Supports wallet-specific signature bytes. |

Failure reverts the allowance update and nonce consumption. A successful permit invalidates other outstanding permit signatures using that same sequential nonce.

### Signed payments and cancellation: ERC-3009

Transfer and receive parameters appear in this order:

| Parameter | Meaning |
| --- | --- |
| `from` | Nonzero token holder whose signature authorizes the payment. |
| `to` | Nonzero signed recipient. For receive authorizations it must also be the immediate caller. |
| `value` | Amount to transfer in base units. |
| `validAfter` | Exclusive lower timestamp bound. Execution requires `block.timestamp > validAfter`. |
| `validBefore` | Exclusive upper timestamp bound. Execution requires `block.timestamp < validBefore`. |
| `nonce` | Unused unordered `bytes32` identifier scoped to `from`. Shared across transfer, receive, and cancellation, but separate from `nonces(address)`. |
| `v`, `r`, `s` or `signature` | Signature over the matching EIP-712 message, in the chosen overload's format. |

| Function | Returns | Purpose and caller requirements |
| --- | --- | --- |
| `transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)` | None | Executes `TransferWithAuthorization` using `from, to, value, validAfter, validBefore, nonce, v, r, s`. Anyone may relay it. Packs `r \|\| s \|\| v` and calls the bytes implementation. |
| `transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)` | None | Executes the same payment using `from, to, value, validAfter, validBefore, nonce, signature`. Anyone may relay it. Supports EOA and ERC-1271 wallet signatures. |
| `receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)` | None | Executes a distinct `ReceiveWithAuthorization` message using `from, to, value, validAfter, validBefore, nonce, v, r, s`. The caller must be `to`. Packs `r \|\| s \|\| v` and calls the bytes implementation. |
| `receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)` | None | Executes the recipient-submitted payment using `from, to, value, validAfter, validBefore, nonce, signature`. The caller must be `to`. Supports EOA and ERC-1271 wallet signatures. A deposit contract can call this as the payee and complete its deposit accounting in the same transaction. |
| `cancelAuthorization(address,bytes32,uint8,bytes32,bytes32)` | None | Permanently invalidates an unused nonce using `authorizer, nonce, v, r, s` signed over `CancelAuthorization`. Anyone may relay it. Packs `r \|\| s \|\| v` and calls the bytes implementation. |
| `cancelAuthorization(address,bytes32,bytes)` | None | Invalidates an unused nonce using nonzero `authorizer, nonce, signature`. Anyone may relay it. Supports EOA and ERC-1271 wallet signatures and has no deadline parameter. |

Payments consume the nonce, move tokens without allowance and emit `AuthorizationUsed` plus `Transfer`. They do not invoke an ERC-1363 receiver callback. Cancellation emits `AuthorizationCanceled` and makes the nonce unavailable to both payment functions; it cannot undo an already executed transfer. Execution and cancellation compete by transaction ordering. Any failed operation rolls back nonce consumption and token changes.

In this implementation, ERC-3009's `v/r/s` overloads also use the shared signature checker after packing exactly 65 bytes. A contract wallet can accept that encoding if its validator supports it; use the `bytes` overload for arbitrary wallet formats.

### Transfer and approval callbacks: ERC-1363

These are the only token entry points that invoke recipient/spender callbacks. The target must be a contract implementing the matching callback and returning the required acceptance selector. Rejection, an incompatible target, or a reverting callback reverts the operation and all nested token changes.

| Function | Returns | Purpose and inputs |
| --- | --- | --- |
| `transferAndCall(address,uint256)` | `bool` | Transfers `value` from the caller to `to`, then calls `to.onTransferReceived(operator, from, value, data)` with caller as both `operator` and `from`, and empty `data`. |
| `transferAndCall(address,uint256,bytes)` | `bool` | The same caller-funded transfer and receiver callback, with the supplied `data` forwarded unchanged. Inputs: `to, value, data`. |
| `transferFromAndCall(address,address,uint256)` | `bool` | Spends the caller's allowance to transfer `value` from `from` to `to`, then invokes the receiver callback with caller as `operator` and empty `data`. |
| `transferFromAndCall(address,address,uint256,bytes)` | `bool` | The same allowance-funded transfer and receiver callback, forwarding `data` unchanged. Inputs: `from, to, value, data`. |
| `approveAndCall(address,uint256)` | `bool` | Sets the caller's allowance for `spender` to `value`, then calls `spender.onApprovalReceived(owner, value, data)` with caller as `owner` and empty `data`. |
| `approveAndCall(address,uint256,bytes)` | `bool` | The same allowance update and spender callback, forwarding the supplied `data` unchanged. Inputs: `spender, value, data`. |

Transfer callbacks observe completed balances and allowance spending. Approval callbacks observe the new allowance and may spend it immediately. Valid nested token operations are allowed, so the final balance or allowance can reflect actions taken during the callback.

## Signing details shared by the ABI

All signed operations use the domain `name = "Longtail"`, `version = "1"`, current `chainId`, and the deployed token address as `verifyingContract`. On BSC mainnet the chain ID is `56`; local test deployments use their actual local chain ID. Discover the domain through `eip712Domain()`.

The exact typed-data messages are:

```text
Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)
TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)
ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)
CancelAuthorization(address authorizer,bytes32 nonce)
```

Use EIP-712 typed-data signing, such as ethers `signTypedData`. `signMessage`/`personal_sign` produces a different digest. EOA signatures use `v` of 27 or 28 and canonical low-`s` form; byte signatures are 65-byte `r || s || v`. Contract-wallet signatures use whatever byte format that wallet validates through ERC-1271. The token performs those wallet validations with `STATICCALL`.

Read `nonces(owner)` before signing permits and coordinate outstanding signatures because the counter is shared. Ordinary `approve` calls do not advance it. ERC-3009 instead uses independent unordered identifiers, commonly generated with `ethers.hexlify(ethers.randomBytes(32))`.

For overloaded functions, ethers can select an exact ABI signature:

```ts
await token["permit(address,address,uint256,uint256,bytes)"](
  ownerAddress, spenderAddress, amount, deadline, signature,
);
await token["transferAndCall(address,uint256,bytes)"](
  receiverContractAddress, amount, "0x",
);
```

## Solidity documentation

Project Solidity uses `@notice` for purpose, `@dev` for implementation details, `@param` for inputs, and `@return` for returned values. Overrides use `@inheritdoc` where appropriate; inherited OpenZeppelin functions retain their upstream NatSpec. These tags follow the [Solidity NatSpec format](https://docs.soliditylang.org/en/latest/natspec-format.html).

Test mocks under `contracts/mocks` have their own documented interfaces and are not part of the deployed `Token` ABI. Recompile with `npm run compile` after changing Solidity; update this reference whenever a Token function signature or behavior changes.
