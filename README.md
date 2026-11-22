# Longtail (TAIL)

A fixed-supply, non-upgradeable ERC-20 for **BNB Smart Chain mainnet only** (chain ID `56`), built with Solidity, Hardhat 3, ethers.js 6, and OpenZeppelin Contracts `5.6.1`.

See the [Token ABI reference](docs/Token-ABI.md) for every read and write function, including overloads, parameters, return values, and signature rules.

## Solidity integration

Copy [IToken.sol](contracts/interfaces/IToken.sol) into your project. It is a standalone interface with no imports, containing every token function, event, and custom error, with NatSpec documentation. Use `IToken(tokenAddress)` to call an existing deployment.

The interface describes deployed-contract calls; constructor parameters are documented below. For ERC-165 discovery, use the standard ERC-165 or ERC-1363 IDs described in the ABI reference. The aggregate `type(IToken).interfaceId` is not advertised by the token.

The interface's functions, return values, events, and errors are checked against the compiled Token ABI by [Interface.ts](test/Interface.ts).

## Supply and permissions

`Token.sol` has the constructor `constructor(uint256 totalSupply_, address receiver)`.

- Name: `Longtail`; symbol: `TAIL`; decimals: `18`.
- The constructor mints the entire supply to the nonzero receiver, which must differ from the token's own address.
- Supply is specified in **base units**, without automatic scaling in the contract. `ethers.parseUnits("1000000", 18)` represents one million tokens.
- The initial supply may be any value from zero through `2^256 - 1` base units.
- No owner, roles, minting after deployment, burning, pausing, blocklisting, upgrade mechanism, or privileged relayer exists.
- Standard `transfer`, `approve`, and `transferFrom` remain available. Transfers have no tax or automatic receiver callbacks.
- All token movements to the token contract's own address revert with `ERC20InvalidReceiver`, including zero-value transfers, signed payments, and callback-triggered transfers. Transfers between holders and transfers back to the same holder remain supported.

## Implemented extensions

| Standard | Functions / implementation |
| --- | --- |
| ERC-2612 | OpenZeppelin `ERC20Permit`: `permit(owner,spender,value,deadline,v,r,s)`, `nonces`, `DOMAIN_SEPARATOR`. |
| ERC-7597 / ERC-1271 | Local `ERC20PermitWithContractSignatures`: `permit(owner,spender,value,deadline,bytes signature)` for EOAs and contract wallets. Validation uses OZ `SignatureChecker`. |
| ERC-3009 | Local `ERC20Authorization`: `transferWithAuthorization`, `receiveWithAuthorization`, `authorizationState`, `cancelAuthorization`, authorization events and type-hash getters. Each signed operation has both canonical `v/r/s` and additional `bytes signature` overloads. The latter support ERC-1271 contract wallets. |
| ERC-5267 | `eip712Domain()`, inherited through OpenZeppelin `EIP712`. |
| ERC-1363 / ERC-165 | OpenZeppelin `ERC1363`: `transferAndCall`, `transferFromAndCall`, `approveAndCall`, each with and without callback data, and `supportsInterface`. |
| ERC-6093 | Standard ERC-20 custom errors, already supplied by OpenZeppelin. |

ERC-7674 temporary approvals are deliberately excluded. The local extensions use the already-installed OpenZeppelin package; they add no third-party runtime dependencies. ERC-3009 and ERC-7597 remain draft standards.

## Signing and replay protection

Every signed operation uses the same EIP-712 domain:

```ts
const domain = {
  name: "Longtail",
  version: "1",
  chainId: (await ethers.provider.getNetwork()).chainId,
  verifyingContract: await token.getAddress(),
};
```

On BSC mainnet `chainId` is `56`. Read the actual domain using `eip712Domain()` when integrating. Do not use `personal_sign` or `signMessage`; use ethers `signTypedData` or the wallet's typed-data signing API.

The exact typed structures are:

```text
Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)
TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)
ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)
CancelAuthorization(address authorizer,bytes32 nonce)
```

Both permit overloads share the **same sequential `nonces(account)` counter**. Read it before signing and coordinate outstanding signatures. A successful operation invalidates other signatures using that counter value. Ordinary `approve` calls do not consume it; in particular, setting an allowance to zero does not invalidate an outstanding permit signature.

ERC-3009 uses a separate, unordered `bytes32` nonce per authorizer. Generate it with `ethers.hexlify(ethers.randomBytes(32))`. Transfer, receive, and cancellation share one authorization-state map: once a nonce is used or canceled, none of those methods can reuse it for that authorizer. Failed operations roll back nonce consumption.

- Permits accept execution **at or before** their deadline.
- ERC-3009 requires **`validAfter < block.timestamp < validBefore`**.
- A permit deadline limits submission; the resulting allowance does not automatically expire.
- `receiveWithAuthorization` requires the immediate caller to be the signed `to` address. Deposit contracts should use this path and complete their own accounting in the same transaction.
- Cancellation needs the authorizer's signature and cannot undo an already executed authorization. A cancellation and transfer compete by transaction ordering.
- Anyone can relay permits, transfer authorizations, and cancellations. The submitting account pays BNB for gas; the token does not provide a relayer or reimbursement service.

The ERC-7597 and ERC-3009 `bytes` interfaces validate contract-wallet signatures through the wallet's `isValidSignature(bytes32,bytes)` at execution time. The exact signature format is wallet-specific. Canonical ERC-2612 retains OpenZeppelin's ECDSA implementation. Contract wallets can call ordinary `approve` and `transfer` through their own execution methods.

For overloaded calls, specify the full signature in ethers when needed, for example:

```ts
await token["permit(address,address,uint256,uint256,bytes)"](
  ownerAddress, spenderAddress, amount, deadline, signature,
);
```

## Callback integration

ERC-1363 callbacks run only through the explicit `*AndCall` methods. Recipients/spenders must implement the appropriate ERC-1363 callback and return its acceptance selector. Calls to EOAs or incompatible contracts revert. A rejected/reverting callback rolls back token balances and allowances. Receiver applications must account for reentrancy when implementing their callbacks.

## Setup and checks

Use Node.js 24 LTS (`nvm use`) and npm:

```sh
npm ci
npm run compile
npm test
npm run typecheck
```

The [Tests workflow](.github/workflows/tests.yml) runs compilation, the full test suite (including interface ABI parity), and TypeScript checks on every push and pull request. It uses the Node.js version in `.nvmrc`, installs locked dependencies with `npm ci`, and requires no deployment credentials.

Solidity is pinned to `0.8.38`, optimization uses 200 runs, and both compilation and local simulation target **Cancun**. This is required by the installed OpenZeppelin EIP-712/signature utilities and supported on BSC. Tests use isolated local networks and test-only contracts under `contracts/mocks`; they do not send mainnet transactions. The deployment script creates `VanityCreate2Factory` and deploys `Token` through it.

Tests cover signature formats and replay protection, wrong domains/fields, expiration boundaries, ERC-1271 validation, authorizer-controlled cancellation, callback acceptance/rollback, recipient restrictions, and the full uint256 supply range.

See the [token and factory reentrancy review](security/reentrancy-review.md) for the external-call analysis and adversarial test coverage. Repository maintenance instructions are in [AGENTS.md](AGENTS.md).

Known development-tool advisories remain open and are recorded in the [dependency advisory review](security/dependency-review.md), including their scope, affected versions, and compatibility constraints.

## CREATE2 deployment

The deployed BSC mainnet token is [`0xa11A111A3100DDe3224995982643CA592111AA11`](https://bscscan.com/address/0xa11A111A3100DDe3224995982643CA592111AA11#code). The [deployment record](deployments/bsc-mainnet/Token.json) preserves the original script output, including both transaction hashes, factory and token addresses, constructor inputs, CREATE2 salt, initialization-code hash, and gas limits/usage.

[VanityCreate2Factory.sol](contracts/VanityCreate2Factory.sol) provides deployment at a searched address using an unmodified CREATE2 salt. Its immutable owner authorizes factory deployments and has no privileges over the token. The [CREATE2 deployment reference](docs/CREATE2.md) documents the factory ABI, wallet/nonce requirements, and verified initialization-code hash for 100 million TAIL with the specified mint receiver. The hash is covered by a regression test.

The deployment script fixes the supply at **100,000,000 TAIL**, the receiver at `0x631a52566152799DB3cffb5432F9d1d60Dc91c8d`, and the deployer at the search session's public wallet address. It checks the exact `initCodeHash` before any deployment. The only variable deployment input is `CREATE2_SALT`: `0x` followed by the 64 hexadecimal digits produced by the search.

Deployment uses fixed gas limits of **350,000** for the factory and **3,000,000** for Token (**3,350,000 total**), with no `eth_estimateGas` calls. The selected-salt local deployment consumed **2,220,579 gas** in total. Both transactions retain at least 50% headroom in regression tests. See the [gas measurements and validation](docs/CREATE2.md#fixed-gas-budgets); the script reports actual receipt usage after deployment.

### Local dry run

Set `BSC_PRIVATE_KEY` in your environment or an ignored `.env` file based on [.env.example](.env.example). Both deployment modes derive its wallet address and require it to match the fixed search deployer before connecting to the network.

```sh
CREATE2_SALT="<your 0x-prefixed 32-byte salt>" npm run deploy:local
```

This starts a fresh Hardhat `local` network with chain ID `31337`, without forking or contacting BSC. It funds the validated signing wallet locally, signs the factory creation transaction at nonce zero, and signs the CREATE2 deployment transaction at nonce one. The script logs the verified hash, predicted addresses, transaction progress, deployed addresses, and final supply/receiver checks. The key is never logged. No BSC RPC configuration or search-session file is needed. The same salt produces the searched address because the factory address and initialization code match the search inputs.

## Deploy to BSC mainnet

Configure the ignored `.env` file using [.env.example](.env.example):

| Variable | Meaning |
| --- | --- |
| `CREATE2_SALT` | Required raw 32-byte computed salt. Supply, receiver, deployer address, and expected initialization-code hash are fixed in the script. |
| `BSC_RPC_URL` | BSC mainnet RPC endpoint; defaults to the official public endpoint. |
| `BSC_PRIVATE_KEY` | Required for both local and mainnet deployment. Its wallet must match the fixed deployer address. On mainnet, it must hold enough BNB for both deployment transactions; local funds are simulated. |

`.env` files are ignored by Git. Compilation and automated tests require no deployment credentials; signing tests use a synthetic test key. Both deployment commands require `BSC_PRIVATE_KEY`.

```sh
npm run deploy:bsc
```

This submits two real BSC mainnet transactions: factory creation, followed by token deployment through CREATE2. Before submitting, the script verifies the `bsc` HTTP network and chain ID `56`, the signer address, the token initialization-code hash, an unused deployer with both latest and pending nonce zero, and unoccupied factory/token addresses. It deploys the factory at nonce zero and sends zero native value to the token constructor. The script starts from a fresh wallet and does not resume a partially completed deployment.

## License

This project is licensed under the [MIT License](LICENSE). OpenZeppelin and other installed dependencies retain their respective licenses. The npm package is marked private to prevent accidental npm publication.

## References

- [OpenZeppelin ERC-20 extensions](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20)
- [ERC-2612](https://eips.ethereum.org/EIPS/eip-2612), [ERC-3009](https://eips.ethereum.org/EIPS/eip-3009), [ERC-7597](https://eips.ethereum.org/EIPS/eip-7597), [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271), [ERC-5267](https://eips.ethereum.org/EIPS/eip-5267)
- [ERC-1363](https://eips.ethereum.org/EIPS/eip-1363)
- [BSC MCOPY support](https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP-342.md)
- [BSC mainnet RPC configuration](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/)
