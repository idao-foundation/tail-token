# Longtail (TAIL): token and factory reentrancy review

Reviewed on 2026-11-13 against the source hashes below, OpenZeppelin Contracts 5.6.1, and Solidity 0.8.38 with Cancun and optimization at 200 runs.

Validation and deployment-script and test fingerprints were refreshed on 2026-11-21 for the selected vanity-address regression and fixed gas budgets. Contract source fingerprints are unchanged; the factory's authorization-before-CREATE2 reasoning was rechecked for the additional test.

No exploitable token-side or factory-side reentrancy issue was identified in the reviewed implementation. This conclusion is based on source inspection and the local adversarial tests described below; it is not a formal proof.

## Scope

The review covers the token's balances, allowances, fixed supply, signature nonces, authorization state, and recipient restriction across every externally callable write function, plus the factory's deployment authorization and value forwarding. External callback receivers, signature wallets, and factory-supplied initialization code are treated as hostile. Their own application accounting and internal reentrancy protection are outside this review.

Production sources reviewed:

- [Token.sol](../contracts/Token.sol)
- [ERC20Authorization.sol](../contracts/extensions/ERC20Authorization.sol)
- [ERC20PermitWithContractSignatures.sol](../contracts/extensions/ERC20PermitWithContractSignatures.sol)
- [VanityCreate2Factory.sol](../contracts/VanityCreate2Factory.sol)
- Installed OpenZeppelin `ERC20`, `ERC20Permit`, `ERC1363`, `ERC1363Utils`, `Nonces`, `EIP712`, `ECDSA`, and `SignatureChecker` implementations and their relevant dependencies.
- Installed OpenZeppelin `Create2`, `Errors`, and `LowLevelCall` implementations used by the factory.

Operational validation also covers the [deployment entry point](../scripts/deploy.ts) and [CREATE2 deployment implementation](../scripts/lib/create2-deployment.ts), including their network, identity, initialization-code, and account-state guards.

## External calls and state ordering

| Path | External interaction | State at the interaction |
| --- | --- | --- |
| Both `transferAndCall` overloads | Receiver's `onTransferReceived` | Balances have been updated. No token accounting is deferred until after the callback. |
| Both `transferFromAndCall` overloads | Receiver's `onTransferReceived` | Finite allowance has been spent and balances have been updated. An unlimited allowance retains ordinary ERC-20 semantics. |
| Both `approveAndCall` overloads | Spender's `onApprovalReceived` | The replacement allowance has been written. Nested spending consumes that allowance; returning from the callback does not restore it. |
| `permit` with signature bytes and an owner with code | Owner's ERC-1271 validator, using `STATICCALL` | The sequential permit nonce has advanced; the allowance has not yet been written. Failure rolls back nonce consumption. |
| Both overloads of each ERC-3009 operation, with an authorizer with code | Authorizer's ERC-1271 validator, using `STATICCALL` | The authorization nonce is still unused during validation. It is consumed after validation and before a transfer, or before the cancellation event. |
| Factory `deploy(bytes32,bytes)` | CREATE2 executes caller-supplied initialization code | The immutable owner has been checked. Only this call's `msg.value` is forwarded; no mutable factory accounting is deferred until after creation. |

OpenZeppelin's signature checks use `STATICCALL` for both memory and calldata signature paths. This restriction also applies to nested calls made by the wallet: it can read token state but cannot change token storage or emit logs. The observed intermediate permit nonce and allowance do not create a token-side write opportunity.

Ordinary ERC-20 operations and the canonical ERC-2612 permit have no attacker-controlled external calls. The constructor mints the entire supply without calling the receiver. ERC-3009 transfers use the internal transfer path without a recipient callback. ECDSA recovery uses the EVM precompile rather than user-supplied contract code.

## Token invariants

ERC-1363 permits nested token calls. Each nested operation still enforces the caller's balance, allowance, or valid signature. The outer operation has already completed its accounting and performs no later write that could overwrite nested results. A rejected or reverting callback reverts the entire operation, including successful nested token movements, approvals, and nonce changes.

Both permit overloads consume one shared sequential nonce. ERC-3009 uses separate nonces scoped to each authorizer, shared across transfer, receive, and cancellation. Replays and cross-function reuse fail after consumption. Receive authorizations also require the immediate caller to be the signed payee.

The `_update` recipient check rejects the token's own address before balance accounting, including for zero-value movements and the constructor mint. It introduces no external interaction. A failure restores any allowance or authorization state changed earlier in the same operation.

## Factory invariants

The factory checks its immutable owner before executing any initialization code. A newly created contract cannot use its constructor to bypass that check: its nested call arrives from the new contract's address, not the owner. A contract owner may deliberately authorize nested deployments through its own logic; every nested factory entry still checks that owner. The factory stores no mutable salt registry, balance entitlement, or other accounting that could become stale across creation.

Each deployment forwards exactly its own `msg.value`. Existing factory funds are not spent. The EVM prevents a second creation at an occupied address, including during an in-progress constructor. OpenZeppelin handles failed creation and bubbles available constructor revert data. The additional empty-runtime check rejects a creation that returned no code. Reverting either path rolls back constructor effects and forwarded value; the success event is emitted only after nonempty code is present.

The factory's ownership grants no authority over Token. Token initialization only mints the fixed supply internally and invokes no receiver callback. Its constructor is nonpayable, so CREATE2 token deployment must use zero native value.

## Validation

The complete local suite passes **146 tests**, including **24 adversarial token reentrancy tests** in [Reentrancy.ts](../test/Reentrancy.ts), **14 factory tests** in [Create2Factory.ts](../test/Create2Factory.ts), and **17 deployment-script tests** in [Deployment.ts](../test/Deployment.ts). The hostile contracts are in [ReentrancyMocks.sol](../contracts/mocks/ReentrancyMocks.sol) and [Create2Mocks.sol](../contracts/mocks/Create2Mocks.sol).

| Adversarial cases | Count | Verified behavior |
| --- | --- | --- |
| ERC-1363 callback entry points | 6 | Updated balances and allowances are visible during callbacks; overspending fails and authorized nested spending succeeds. |
| Three nested callback levels | 1 | Nested transfers preserve balances and total supply. |
| Callback rejection and reversion | 4 | Nested transfers, permits, and ERC-3009 state changes roll back together. |
| Permit nonce reuse during a callback | 1 | Both overloads share their counter and reject replay after a valid nested permit. |
| ERC-3009 nonce reuse during a callback | 3 | Transfer, receive, and cancellation consume shared authorization state and prevent reuse. |
| Attack payload positive controls | 1 | The payload set exactly matches all 17 write functions in the compiled ABI, and each payload succeeds outside a static context. |
| ERC-1271 validation paths | 7 | Each path attempts all 17 write functions under `STATICCALL`: 119 attempts fail without the attempted state changes. Read calls confirm the expected intermediate state. |
| Rejecting ERC-1271 wallet | 1 | A wallet rejecting validation after attempting reentry leaves the permit nonce and allowance unchanged. |

Factory checks cover the exact reference initialization-code hash, nonce-zero factory address, unchanged salt, correct receiver/supply, unauthorized callers, empty initialization/runtime code, constructor revert propagation, duplicate deployment, value forwarding, and rollback. The adversarial constructor uses valid nested Token initialization code, observes `UnauthorizedDeployer`, and leaves the owner able to deploy with the same intended salt and code afterward.

The selected vanity-address regression executes CREATE2 at the public factory address and asserts the fixed salt's exact Token address, return value, event, deployed code, mint, and EIP-712 verifying contract. Its local setup installs the compiled factory runtime with the fixture's test owner so no deployment credential is required. The owner check still runs before Token initialization, and no production external-call path has changed. A separate signed local deployment validates factory creation at nonce zero and the exact selected token address using the asserted environment key.

The deployment-script tests verify fixed constructor inputs, exact initialization-code hashing, salt format, permitted networks, fork rejection, signer identity, key validation/redaction, unused account checks, and the complete two-transaction local flow. Both modes load an environment key into an ethers Wallet and assert the fixed deployer before network connection. Library key-validation errors are replaced with messages that contain no key material. The script's hash and account-state checks run before any transaction. Local funding is confined to non-forked EDR; both modes sign raw transactions at wallet nonces zero and one. The BSC path also checks chain ID `56`.

The deployment implementation now sets explicit gas limits of 350,000 and 3,000,000, checks successful receipts, and reports measured usage. This changes transaction budgeting and receipt handling only; token/factory bytecode, immutable-owner checks, CREATE2 forwarding, and callback state ordering are unchanged. All 146 local tests, compilation, and TypeScript checks passed. Three signed deployment tests reject `eth_estimateGas` calls and verify successful deployments with at least 50% gas headroom for zero, selected, and all-nonzero salts. The selected-salt local signed run consumed 223,118 and 1,997,461 gas, respectively.

Automated signing tests use a synthetic key and exercise the shared deployment flow without deployment credentials. They observe two `eth_sendRawTransaction` requests, no unlocked-account transaction requests, and no impersonation calls. The production entry point's fixed-deployer guard is tested separately. These operational checks do not add external calls or privileges to the token or factory contracts.

The full suite also verifies signature fields and domains, validity boundaries, callback acceptance, recipient restrictions, full uint256 supply handling, and standalone-interface parity. Compilation, all 146 tests, and TypeScript checks pass on Node.js 24.16.0 and npm 12.0.2. The 2026-11-21 automated checks passed with an empty `BSC_PRIVATE_KEY`. The separate [CREATE2 validation](../docs/CREATE2.md) reproduced the selected search result locally with `npm run deploy:local`, the pinned salt, and the asserted environment signing key while BSC RPC was unavailable; its output contained no signing key material. Missing-key rejection through the command was previously checked on 2026-11-13. All tests run on the local Cancun EVM; this review does not include a mainnet deployment or live BSC transactions.

Reproduce the checks with:

```sh
npm ci
npm run compile
npm test
npm run typecheck
```

## Source fingerprints

SHA-256 values identify the reviewed files and dependency lock:

```text
372c87176e290491f9673b3439ac1fbeb4d2552bbbb043eea0fb2015a83dbe90  contracts/Token.sol
510a82b61648765fe9e75200ad76d69bec9db84914d63b400ca927dd7fde1a47  contracts/extensions/ERC20Authorization.sol
5021fde5205e3d7bf618be4ed16a19dff949ec097516419b4c8429ea876285d3  contracts/extensions/ERC20PermitWithContractSignatures.sol
aa18d44e35e44ede0201d041388a2126a179a2a50fa7017311b395f74d7d9461  contracts/VanityCreate2Factory.sol
aa6ecafdd985512064aa7603fd5c43eb4cabca9930e77eb1a3ca87597f3a6c39  contracts/mocks/Create2Mocks.sol
e199c7911f9d0cb864d264bb82819f9e85bd7dbbf6b16626c69bbd343b63a9e6  test/Create2Factory.ts
1bf10616e4938ee7b59e3b503b65fd5aac300e3246b7f1fc7b56732150d895c3  test/fixtures/token-create2.json
6cf5a7c5eb888a190f3562a0cca1c5700b9c2ccabc62f5745ba20edad3109e08  scripts/deploy.ts
ca155ebc4339da233e8dd76cf436f44e36f125b96eb8e3e7243e7507a250694f  scripts/lib/create2-deployment.ts
cb492962c3440e4b98ef717279e76845778362e4497aba373f4de9cc146f828c  test/Deployment.ts
40bba94ae815c083f4fa3296cf83ac163fb41585b308b46a0614191fd6417bc6  package.json
d9cb29a3bb3a7ee168ca52f2650e8ac7b47024f74bdc8c1206a01e475138efd6  package-lock.json
5d9351182c35e27320797e322904cf80293e51a2fe1060b7d17677029a23e1fd  hardhat.config.ts
3d37cc367b389958d7d969cab3e1f1637f881205c5dad49e209aa1a454f2b66f  test/Reentrancy.ts
1dfa1075f5ed1ddc486e3c6f5635305821c434f6e3731dadfcda0bc05b9f5667  contracts/mocks/ReentrancyMocks.sol
```
