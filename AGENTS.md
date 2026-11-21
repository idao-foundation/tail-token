# Repository instructions

These instructions apply to the entire repository. Keep changes within the user's requested scope and preserve the invariants below unless the task explicitly changes them. Document implemented behavior; keep speculative features, roadmaps, and historical design discussions out of repository files.

## Project and navigation

Longtail (`TAIL`) is a fixed-supply, non-upgradeable ERC-20 for BNB Smart Chain mainnet, chain ID `56`. The project uses Hardhat 3, ethers.js 6, TypeScript with ESM, and the non-upgradeable OpenZeppelin Contracts package.

- `contracts/Token.sol`: concrete token and shared recipient restriction.
- `contracts/VanityCreate2Factory.sol`: immutable-owner CREATE2 factory, using salts and initialization code verbatim.
- `contracts/extensions/`: ERC-3009 authorizations and the ERC-7597 permit overload with ERC-1271 support.
- `contracts/interfaces/IToken.sol`: complete, standalone Solidity interface for integrations.
- `docs/Token-ABI.md`: reference for every callable token function.
- `docs/CREATE2.md`: factory ABI, deployment assumptions, and verified token initialization-code hash.
- `test/`: behavioral tests; `test/Interface.ts` checks interface ABI parity; `test/helpers/token.ts` contains shared fixtures and signing helpers.
- `test/Create2Factory.ts` and `test/fixtures/token-create2.json`: factory behavior and exact token deployment-input regression checks.
- `contracts/mocks/`: test-only callback receivers, signature wallets, and factory constructor probes.
- `scripts/deploy.ts` and `scripts/lib/create2-deployment.ts`: CREATE2 deployment entry point, fixed public inputs, validation, and local dry run.
- `test/Deployment.ts`: deployment-script input, network, signer, and account-state guards, plus a complete local deployment.
- `security/reentrancy-review.md`: scoped token and factory review, test evidence, and source fingerprints.
- `security/dependency-review.md`: dated npm advisory findings and dependency compatibility constraints.
- `README.md`: setup, integration, signing, and deployment instructions.

Use Node.js from `.nvmrc` and npm with `package-lock.json`. Read dependency versions from `package.json` and compiler/EVM settings from `hardhat.config.ts`. Compilation and local simulation currently target Cancun. Keep those settings compatible and aligned when changing dependencies or build configuration.

## Contract invariants

- Preserve `Longtail` / `TAIL`, 18 decimals, and constructor arguments `(uint256 totalSupply_, address receiver)`.
- Mint the entire supply once in the constructor. The contract accepts base units without scaling, including zero through `type(uint256).max`. The deployment script fixes 100 million TAIL, scales that amount to 18 decimals, and uses the receiver pinned by the CREATE2 reference fixture.
- The receiver must be nonzero and differ from the token's own address. Enforce the same token-address restriction centrally in `_update` for every movement, including zero amounts, signed transfers, callbacks, and constructor minting. Transfers back to the same holder remain allowed.
- Preserve standard ERC-20 balances, allowances, unlimited-allowance semantics, and fixed supply. No transfer fees, post-construction minting, exposed burning, owner/roles, pause/blocklist, upgrades, privileged relayers, or temporary approvals.
- Preserve the implemented ERC-2612, ERC-7597/ERC-1271, ERC-3009, ERC-5267, ERC-1363/ERC-165, and ERC-6093 behavior. Prefer the existing OpenZeppelin implementation where it supplies the behavior.
- All callable write functions are nonpayable. ERC-1363 callback `value` is a token amount; these methods do not forward native BNB.

## Signatures and callbacks

- All typed signatures share the EIP-712 domain: name `Longtail`, version `1`, the actual chain ID, and the deployed token address. Use typed-data signing, not `signMessage` or `personal_sign`.
- Both permit overloads share the sequential `nonces(owner)` counter. Ordinary approval does not consume it or invalidate outstanding signed permits. Permit deadlines are inclusive and limit submission, not allowance lifetime.
- ERC-3009 uses independent unordered `bytes32` nonces scoped to the authorizer. Transfer, receive, and cancellation share consumption state. Preserve the strict interval `validAfter < block.timestamp < validBefore`, the signed-payee caller requirement for receive, and signed cancellation. Failed operations must roll back nonce consumption.
- Keep canonical ERC-2612 `v/r/s` validation in OpenZeppelin. The bytes permit and ERC-3009 wallet checks use `SignatureChecker` and ERC-1271 `STATICCALL`; ERC-3009 `v/r/s` wrappers forward to the bytes implementation. Do not weaken signature validation or replace static wallet checks with mutable calls.
- Ordinary ERC-20 transfers and ERC-3009 payments do not invoke recipient callbacks. Only explicit ERC-1363 `*AndCall` methods do; retain all six overloads and their callback data behavior.
- Complete balance and allowance accounting before ERC-1363 callbacks. Valid nested token calls are supported; never restore stale state after a callback. Rejected or reverting callbacks must roll back the entire operation, including nested token changes.
- Review external interactions from the token's perspective: protect its accounting, permissions, nonces, and recipient rule. Called applications are responsible for their own internal accounting and reentrancy protection.

## CREATE2 factory invariants

- Keep the factory separate from the token API. Its immutable constructor caller is its only authorized deployer, with no ownership transfer or renunciation and no privileges over Token.
- Preserve `deploy(bytes32,bytes)` as payable, with the raw salt and complete initialization code passed unchanged to CREATE2. Forward only `msg.value`; require nonempty runtime code and atomic rollback on failure. Token's nonpayable constructor requires zero native value.
- The search assumes the factory is created directly by its session wallet at transaction nonce zero. Preserve compatibility with saved salt/calldata records; do not mix the caller into the salt.
- Keep the reference fixture's constructor inputs, creation-bytecode hash, and initialization-code hash aligned with the compiled Token build. An intentional deployment-input change must update the fixture, deployment reference, and validation evidence together; do not replace a pinned hash merely to make a failing check pass. Review compatibility with saved searches before reusing their results.
- Keep factory NatSpec, its ABI reference, and tests synchronized. Factory ABI entries do not belong in `IToken.sol` or `Token-ABI.md`.
- The deployment script takes only `CREATE2_SALT` as a variable deployment input. Keep its fixed supply, receiver, public deployer address, and expected hash aligned with the validated search inputs. Assert the exact initialization-code hash before any deployment, require a raw bytes32 salt, and create the factory at nonce zero.
- Both deployment modes load `BSC_PRIVATE_KEY` from the environment or ignored `.env`, derive its wallet address, and assert the fixed search deployer before connecting to the network. Use an ethers Wallet to sign both transactions; never impersonate or depend on unlocked node accounts. Reject missing, malformed, invalid, or mismatched keys without exposing their contents in errors or logs.
- The local dry run uses a fresh, non-forked `local` EDR network (chain ID `31337`) and funds the validated signing wallet with simulated native currency. It needs the private key but no BSC RPC configuration. Never read a search-session file to obtain the key. The live path requires `bsc` HTTP chain ID `56`. Both paths reject a previously used deployer or occupied target addresses without resetting their state, then use transaction nonces zero and one.
- Automated tests must use synthetic signing keys and remain independent of deployment secrets. Test the production identity guard separately from the shared signed-transaction flow, and verify that deployment sends signed raw transactions without impersonation.
- Session files contain private keys. Do not copy session files, private keys, or bulk search results into repository files or print their secret fields during verification. An explicitly selected public salt/address pair may be pinned in a regression test.

## Mandatory contract, interface, and documentation synchronization

Treat the implementation, `contracts/interfaces/IToken.sol`, and `docs/Token-ABI.md` as one maintained API. Update them in the same change whenever a callable signature or behavior changes, including changes inherited from OpenZeppelin or introduced by a dependency update.

1. Compile the current sources and inspect the complete `Token` ABI, including inherited functions, overloads, public-variable getters, events, and custom errors. Use `artifacts/contracts/Token.sol/Token.json` from that build, never stale artifacts or only the declarations directly in `Token.sol`.
2. Keep `IToken.sol` self-contained and copyable: no imports or external dependencies. Include every callable function, event, and custom error from the compiled ABI. Match names, parameter order and types, output names and types, mutability, and event indexing; include tuple components if applicable. Solidity-only `internalType` annotations may differ, as normalized by `test/Interface.ts`. Interfaces do not declare constructors or internal/private functions.
3. Keep `Token-ABI.md` exhaustive: list every callable signature exactly once, counting each overload separately. Group `view`/`pure` functions under read functions and state-changing functions under write functions. Update the displayed counts from the compiled ABI. Describe purpose, parameter order, units, return values, caller requirements, signature rules, callbacks, and failure behavior where relevant. Document the constructor separately.
4. Keep NatSpec accurate in project-owned Solidity and the standalone interface: `@notice` for purpose, `@dev` for constraints and implementation details, `@param` for each input, and `@return` for each output. Document events and errors too. Use `@inheritdoc` where appropriate; inherited OpenZeppelin documentation stays upstream.
5. Update related README examples, signing helpers, deployment validation, and behavioral tests when their assumptions change. A behavior-only change still requires reviewing the interface's NatSpec and ABI reference, even when the ABI shape is unchanged.
6. Run the interface parity tests and relevant behavior checks. Do not weaken `test/Interface.ts` or omit ABI entries to make a mismatch pass. Its parity test does not check Markdown or prose: compare the ABI reference separately and inspect its rendered tables.

The aggregate `type(IToken).interfaceId` is not advertised by the token. Preserve the actual `supportsInterface` behavior and document the supported standard IDs accurately.

In Markdown tables, escape literal pipes even inside inline code: write `r \|\| s \|\| v` in the source. Unescaped pipes split table cells and break the VS Code preview. Keep blank lines around fenced blocks and lists, and check table column counts after editing long ABI rows.

Use relative links for repository files in committed documentation. Do not include machine-specific paths or personal account details. Describe ignored build artifacts as generated paths, rather than linking to files that are absent from a fresh checkout. Preserve the LF line endings set by `.gitattributes` so source fingerprints remain reproducible.

## Validation and generated files

Install locked dependencies with `npm ci` when needed. Use the existing scripts:

```sh
npm run compile
npm test
npm run typecheck
```

For changes to production behavior, ABI, dependencies, or build configuration, compile and run the full test suite and TypeScript checks. Add or adjust meaningful tests for changed behavior, including relevant signature replay, time boundaries, callback rollback, and recipient restrictions. Keep the adversarial reentry payload set aligned with all write functions in the current ABI.

For documentation-only edits, verify accuracy, referenced paths, and Markdown rendering; a full contract test run is unnecessary. For interface edits, also compile and run ABI parity checks. Check that the interface still compiles without OpenZeppelin or other repository sources when changing its declarations or dependencies.

Regenerate `artifacts/`, `cache/`, and `types/ethers-contracts/` through Hardhat rather than editing them. Remove stale generated outputs when deleting or renaming contracts or APIs. Keep generated outputs, coverage, `node_modules/`, and secrets out of version control. Never modify installed third-party sources to change token behavior.

When changing reviewed production code, relevant dependency/build settings, or adversarial tests, recheck the affected external-call reasoning and refresh `security/reentrancy-review.md` with actual results and matching source fingerprints. Do not present old evidence as validation of changed code. Report only checks actually run and distinguish local testing from live-chain evidence.

When updating dependencies, rerun the full and production-only npm audits and refresh `security/dependency-review.md`. Preserve supported dependency ranges; do not suppress findings or force incompatible versions to obtain a clean audit result.

## Network and deployment boundaries

- BSC mainnet is the only live deployment target. Keep the deployment script's `bsc` HTTP-network and chain-ID `56` checks. Local EDR networks exist for isolated tests and non-forked dry runs only; do not add testnet deployment paths.
- Routine development and checks must not send live transactions. Deploy only when deployment is explicitly part of the user's request; `npm run deploy:bsc` submits a real transaction.
- Production deployment contracts are `Token` and `VanityCreate2Factory`; deploy either on mainnet only when explicitly requested, never test mocks. The deployment script creates the nonce-zero factory and then Token through CREATE2. Keep private keys and endpoint credentials in ignored environment files, use `.env.example` for placeholders, and do not expose secrets in logs or documentation.
