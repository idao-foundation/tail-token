# CREATE2 deployment

[VanityCreate2Factory.sol](../contracts/VanityCreate2Factory.sol) deploys contracts for its immutable owner using OpenZeppelin's `Create2` utility. The intended production network is BNB Smart Chain mainnet, chain ID `56`.

The factory accepts the existing search tool's `deploy(bytes32,bytes)` calldata. It uses the supplied salt and initialization code unchanged. Its owner is the account that creates the factory; ownership cannot be transferred or renounced. This authority controls factory deployments and grants no privileges over the deployed token.

## Address and constructor inputs

The search assumes the factory is deployed directly by the session wallet using ordinary `CREATE` at transaction nonce **zero**. That wallet and nonce determine the factory address. Factory bytecode is not an input to that address calculation. Creating it from another wallet, another nonce, or through another factory changes the address used by the search.

For the token, initialization code is its complete creation bytecode followed by `abi.encode(uint256 totalSupply_, address receiver)`. Hash it with Keccak-256, not SHA3-256; runtime bytecode alone is insufficient. The CREATE2 address uses the factory address, raw salt, and this initialization-code hash, as specified in [EIP-1014](https://eips.ethereum.org/EIPS/eip-1014).

The verified reference inputs are:

| Input | Value |
| --- | --- |
| Mint amount | `100000000` TAIL (100 million) |
| Decimals | `18` |
| Constructor `totalSupply_` | `100000000000000000000000000` base units |
| Constructor `receiver` | `0x631a52566152799DB3cffb5432F9d1d60Dc91c8d` |
| Factory deployer | `0xF7C70402A270e444eF5e1325EB9AF8f1AEfdD782` |
| Factory address at deployer nonce zero | `0x66A8FBbDFcac14499fc30060c50FC7416d92063D` |
| Compiler | Solidity `0.8.38`, Cancun, optimizer enabled with 200 runs |
| Creation bytecode length | `9952` bytes |
| Encoded constructor arguments | `64` bytes, supply first and receiver second |
| Complete initialization code length | `10016` bytes |

Creation bytecode hash:

```text
0x4a133737e29ab38e8d04e09bb176903866b40218b28b4afd4e1e24bd5abf306b
```

Complete `initCodeHash`:

```text
0xbcaaceb0c490365b2a3f3bebb7a4b2127bd30e11fb48a3f6132cc0e993abb0cc
```

The [reference fixture](../test/fixtures/token-create2.json) pins the token inputs, lengths, and hashes. [Create2Factory.ts](../test/Create2Factory.ts) checks them against the compiled Token artifact and ethers constructor encoding. The [deployment implementation](../scripts/lib/create2-deployment.ts) hardcodes the same supply and receiver, the session's public deployer address, and the expected initialization-code hash. [Deployment.ts](../test/Deployment.ts) checks those constants against the fixture and the expected factory address. These deployment settings do not restrict the Token constructor's accepted supply or receiver.

A source edit, compiler setting, dependency change, or constructor argument change can alter initialization code, including its Solidity metadata. Rebuild and verify the hash before reusing search results. Changing only this factory leaves the token initialization-code hash unchanged; the expected factory address still requires the same session wallet and nonce zero.

## Deployment commands

[scripts/deploy.ts](../scripts/deploy.ts) takes one variable deployment input, `CREATE2_SALT`, as an exact `0x`-prefixed bytes32 value. It does not read search-session files or accept supply/receiver overrides. Both commands compile first, derive complete initialization code from the current Token artifact, and reject a hash mismatch before submitting any transaction.

Both commands also require the signing credential `BSC_PRIVATE_KEY` in the environment or an ignored `.env` file based on [.env.example](../.env.example). An [ethers Wallet](https://docs.ethers.org/v6/api/wallet/#Wallet) derives the key's address, which must match the fixed search deployer before the script creates a network connection. Missing, malformed, invalid, and mismatched keys are rejected. The script does not print key material or propagate key-validation errors from the library.

For a local dry run:

```sh
CREATE2_SALT="<your 0x-prefixed 32-byte salt>" npm run deploy:local
```

The command starts a fresh [Hardhat EDR network](https://hardhat.org/docs/reference/edr-simulated-networks) named `local`, with chain ID `31337` and no fork. It assumes no prior transactions, verifies nonce zero, then assigns the validated wallet 100 simulated BNB. The wallet signs and submits both transactions: factory creation at nonce zero, followed by CREATE2 token deployment at nonce one. It does not impersonate an account or contact a BSC RPC endpoint. Predicted and actual addresses are logged, together with both transaction hashes and the final supply/receiver/domain verification. Each invocation starts from a new local chain. A dry run does not establish the real account's mainnet state or gas balance.

For BSC mainnet, put `CREATE2_SALT`, `BSC_PRIVATE_KEY`, and optionally `BSC_RPC_URL` in an ignored `.env` file, following [.env.example](../.env.example), then run:

```sh
npm run deploy:bsc
```

This sends two real transactions. The script requires the `bsc` HTTP network and actual chain ID `56`. The configured signer must match the fixed search wallet. Before either transaction, the wallet must have no code and both latest and pending transaction counts must be zero; both predicted deployment addresses must have no code and nonce zero. The script never resets a nonce or overwrites existing code. It is for a fresh deployment and does not resume a partially completed one.

The factory creation transaction explicitly uses nonce zero. After checking its address and owner, the script signs the call to `deploy(salt, initCode)` with zero native value and wallet nonce one, then verifies deployed code, 100 million TAIL total supply, the receiver's full balance, 18 decimals, and the EIP-712 verifying contract and chain ID. The local EIP-712 domain uses `31337`; the mainnet domain uses `56`.

## Fixed gas budgets

Both transactions explicitly set `gasLimit`; the script never requests `eth_estimateGas`. Gas prices remain provider-supplied. The following receipt measurements were reproduced on 2026-11-21 using the selected vanity salt, pinned initialization code, and a fresh non-forked local Cancun EVM:

| Transaction | Measured gas used | Fixed gas limit | Surplus |
| --- | ---: | ---: | ---: |
| Factory creation, nonce 0 | 223,118 | 350,000 | 56.9% |
| Token CREATE2 deployment, nonce 1 | 1,997,461 | 3,000,000 | 50.2% |
| Total | 2,220,579 | 3,350,000 | 50.9% |

The limits include transaction overhead, factory execution, constructor execution, and code deposit; the token limit covers the complete factory call. The surplus also covers CREATE2 gas forwarding overhead. These are measured local requirements and conservative transaction budgets, not a live-mainnet gas guarantee. Revalidate after changing code, compiler settings, dependencies, or applicable chain gas rules. The existing initialization-code hash guard remains enforced before either transaction.

[Deployment.ts](../test/Deployment.ts) makes `eth_estimateGas` throw and still completes both signed transactions for zero, selected, and all-nonzero salts. It asserts exact transaction gas limits, successful receipts, correct deployment results, at least 50% headroom over gas used, and accurate reported totals. All-nonzero salts exercise the maximum salt calldata cost. Tests use a synthetic signing key. The script logs fixed limits and actual receipt usage and returns both as decimal strings in `gasLimits` and `gasUsed`.

The wallet must have enough BNB to cover the transaction gas limits at the chosen fee caps. A mined failing transaction still consumes its nonce; fixed gas budgets address the tested out-of-gas risk, while the existing identity, hash, nonce, and occupancy guards remain necessary.

## Factory ABI

The constructor is `constructor()`, nonpayable, and records its immediate caller as `owner`. The compiled factory ABI contains two callable functions, one event, and five custom errors. Token functions remain documented separately in [Token-ABI.md](Token-ABI.md) and [IToken.sol](../contracts/interfaces/IToken.sol).

### Read functions

| Function | Returns | Purpose |
| --- | --- | --- |
| `owner()` | `address` | Returns the immutable account permitted to deploy through this factory. |

### Write functions

| Function | Returns | Purpose and caller requirements |
| --- | --- | --- |
| `deploy(bytes32,bytes)` | `address deployed` | Only `owner` may call. Arguments are `salt`, then `initCode`. Deploys using CREATE2, requires nonempty runtime code, and emits `Deployed`. Payable: forwards exactly `msg.value` to the constructor. Longtail requires zero native BNB because its constructor is nonpayable. Failure rolls back creation, constructor effects, and forwarded value. |

`Deployed(address indexed deployed, bytes32 indexed salt, bytes32 initCodeHash)` reports the created address, unmodified salt, and Keccak-256 hash of the full initialization code after successful deployment.

| Error | Meaning |
| --- | --- |
| `UnauthorizedDeployer(address)` | The supplied `caller` is not the immutable owner. |
| `EmptyDeployedCode(address)` | Initialization returned empty runtime code at `deployed`; the entire operation is reverted. |
| `Create2EmptyBytecode()` | OpenZeppelin rejected empty initialization code. |
| `FailedDeployment()` | OpenZeppelin detected failed creation without revert data, for example an occupied address or native value sent to a nonpayable constructor. |
| `InsufficientBalance(uint256,uint256)` | OpenZeppelin's `balance`, `needed` guard. The current factory forwards only `msg.value`, which is covered by its balance on entry. |

Constructor revert data is propagated, including errors outside the factory ABI, such as Token's `ERC20InvalidReceiver`. Reusing the same salt and initialization code after a successful deployment fails. The same salt with different initialization code, or the same initialization code with a different salt, selects a different address.

The factory has no receive, fallback, withdrawal, or arbitrary-call function. Native value for a payable constructor must accompany `deploy`; existing factory funds are not forwarded. The supported Longtail deployment uses zero native value. Constructor reentry must still satisfy the immutable-owner check; the factory has no mutable deployment accounting to restore after creation.

## Validation

On 2026-11-12, a fresh compilation matched the search input's creation bytecode and constructor arguments byte for byte, the saved session's full initialization code and hash, and all 24 saved results' hashes, addresses, and deployment calldata. An isolated local simulation recreated the session's nonce-zero factory and executed one saved calldata payload successfully, deploying at its saved address and minting the exact supply to the receiver above. No session keys or saved search-result files are included in this repository.

The full local suite passes 146 tests, including 14 factory tests and 17 deployment-script tests. These cover hash compatibility, address prediction, deployment permissions, value forwarding, duplicate deployment, constructor errors, empty code, rollback, constructor reentry, fixed inputs, malformed salts, network/fork restrictions, signer identity, key validation/redaction, unused accounts, and complete local deployment. Automated tests use a synthetic signing key and verify that the shared deployment flow submits exactly two signed raw transactions without unlocked-account transactions or impersonation. The production entry point's fixed-wallet guard is tested separately.

On 2026-11-13, compilation and TypeScript checks also passed. The actual `npm run deploy:local` command loaded the configured environment key, asserted the fixed deployer, and used a saved salt to produce the matching saved token address. BSC RPC was deliberately unavailable during this check. The command also rejected a missing key before submitting transactions, and captured output was checked for key disclosure. See the [reentrancy review](../security/reentrancy-review.md) for the reviewed source fingerprints and external-call analysis. This is local validation, not evidence of a mainnet deployment.

On 2026-11-21, the selected public salt/address pair was pinned in [Create2Factory.ts](../test/Create2Factory.ts):

| Input or result | Value |
| --- | --- |
| Salt | `0x542c34d29cde4147af89e56f8063dd45450644a4d76bdce78729472ba8925af1` |
| Token address | `0xa11A111A3100DDe3224995982643CA592111AA11` |

The regression installs the compiled factory runtime at the public factory address on the local EVM, retaining the fixture's test owner, then executes CREATE2 with the selected salt and pinned Token initialization code. It checks the exact predicted address, return value, deployment event, deployed code, supply, receiver balance, and EIP-712 verifying contract without deployment credentials. A separate `npm run deploy:local` run used the asserted environment signing key to create the nonce-zero factory and deploy Token at the same exact address, with BSC RPC unavailable. Compilation, all 146 tests, and TypeScript checks passed; the automated checks were run with an empty `BSC_PRIVATE_KEY`, and the signed dry-run output was checked for key disclosure.

```sh
npm run compile
npm test
npm run typecheck
```
