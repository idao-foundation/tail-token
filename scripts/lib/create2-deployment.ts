import { ContractFactory, Wallet, getAddress, getCreate2Address, getCreateAddress, isHexString, keccak256, parseEther, parseUnits } from "ethers";
import type { InterfaceAbi } from "ethers";
import { artifacts } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

// Fixed public deployment inputs, matching the validated JSON and vanity-search session.
export const supplyInput = "100000000";
export const receiverInput = "0x631a52566152799DB3cffb5432F9d1d60Dc91c8d";
export const deployerAddress = getAddress("0xf7c70402a270e444ef5e1325eb9af8f1aefdd782");
export const expectedInitCodeHash = "0xbcaaceb0c490365b2a3f3bebb7a4b2127bd30e11fb48a3f6132cc0e993abb0cc";
export const expectedFactoryAddress = getCreateAddress({ from: deployerAddress, nonce: 0 });

// Local Cancun receipts: factory 223,118; selected-salt token 1,997,461 gas.
// Rounded budgets retain at least 50% headroom; tests reject eth_estimateGas calls.
export const factoryGasLimit = 350_000n;
export const tokenGasLimit = 3_000_000n;

/** Loads the signing key from the environment and verifies the pinned search wallet without exposing key material. */
export function loadDeploymentWallet(): Wallet {
  const privateKey = process.env.BSC_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("Set BSC_PRIVATE_KEY in the environment or ignored .env file for both local and BSC deployment.");
  }
  if (!isHexString(privateKey, 32)) {
    throw new Error("BSC_PRIVATE_KEY must be a valid 0x-prefixed 32-byte private key.");
  }
  let wallet: Wallet;
  try {
    wallet = new Wallet(privateKey);
  } catch {
    // Do not propagate library errors that could contain the supplied key.
    throw new Error("BSC_PRIVATE_KEY must be a valid secp256k1 private key.");
  }
  if (wallet.address !== deployerAddress) {
    throw new Error(`BSC_PRIVATE_KEY must belong to the vanity-search deployer ${deployerAddress}.`);
  }
  return wallet;
}

/** Validates the raw bytes32 salt without padding it or mixing in other inputs. */
export function parseSalt(input: string | undefined): string {
  if (input === undefined || !isHexString(input, 32)) {
    throw new Error("Set CREATE2_SALT to the computed salt: 0x followed by exactly 64 hexadecimal digits.");
  }
  return input;
}

/** Builds initialization code from the current artifact and rejects any deviation from the pinned hash. */
export async function prepareTokenDeployment(artifact: { abi: InterfaceAbi; bytecode: string }) {
  const totalSupply = parseUnits(supplyInput, 18);
  const receiver = getAddress(receiverInput);
  const { data: initCode } = await new ContractFactory(artifact.abi, artifact.bytecode)
    .getDeployTransaction(totalSupply, receiver);
  const initCodeHash = keccak256(initCode);
  if (initCodeHash !== expectedInitCodeHash) {
    throw new Error(`Token initCodeHash mismatch: expected ${expectedInitCodeHash}, received ${initCodeHash}. No deployment was submitted.`);
  }
  return { totalSupply, receiver, initCode, initCodeHash };
}

/** Restricts execution to a non-forked local simulation or BSC mainnet. */
export function deploymentMode(name: string, type: string, chainId: bigint, forked: boolean): "local" | "bsc" {
  if (name === "local" && type === "edr-simulated" && chainId === 31337n && !forked) return "local";
  if (name === "bsc" && type === "http" && chainId === 56n && !forked) return "bsc";
  throw new Error("Deployment requires non-forked local EDR (chain ID 31337) or bsc HTTP (chain ID 56).");
}

/** Enforces the pinned deployment identity before running the signed deployment flow. */
export async function deployCreate2Token(
  connection: NetworkConnection,
  saltInput: string | undefined,
  wallet: Wallet,
  log: (message: string) => void = console.log,
) {
  if (wallet.address !== deployerAddress) {
    throw new Error(`BSC_PRIVATE_KEY must belong to the vanity-search deployer ${deployerAddress}.`);
  }
  return deployWithWallet(connection, saltInput, wallet, log);
}

/** Executes the fixed-token CREATE2 flow with a signing wallet; the production entry point pins its identity above. */
export async function deployWithWallet(
  connection: NetworkConnection,
  saltInput: string | undefined,
  wallet: Wallet,
  log: (message: string) => void = console.log,
) {
  const salt = parseSalt(saltInput);
  const { totalSupply, receiver, initCode, initCodeHash } = await prepareTokenDeployment(await artifacts.readArtifact("Token"));
  log(`Initialization-code hash verified: ${initCodeHash}`);

  const { ethers, networkConfig, networkName } = connection;
  const chainId = BigInt(await ethers.provider.send("eth_chainId", []));
  const forked = networkConfig.type === "edr-simulated" && networkConfig.forking !== undefined && networkConfig.forking.enabled;
  const mode = deploymentMode(networkName, networkConfig.type, chainId, forked);
  log(`Network: ${networkName} (chain ID ${chainId})${mode === "local" ? "; isolated dry run, no fork" : "; live BSC mainnet"}`);

  const deployer = wallet.address;
  const factoryAddress = getCreateAddress({ from: deployer, nonce: 0 });
  const address = getCreate2Address(factoryAddress, salt, initCodeHash);
  if (address === receiver) throw new Error("The predicted token address cannot be the mint receiver.");
  log(`Signing wallet: ${deployer}`);
  log(`Salt: ${salt}`);
  log(`Predicted factory address (nonce 0): ${factoryAddress}`);
  log(`Predicted token address: ${address}`);
  log(`Mint: ${supplyInput} TAIL (${totalSupply} base units) to ${receiver}`);

  const [latestNonce, pendingNonce, deployerCode, factoryCode, factoryNonce, tokenCode, tokenNonce] = await Promise.all([
    ethers.provider.getTransactionCount(deployer, "latest"),
    ethers.provider.getTransactionCount(deployer, "pending"),
    ethers.provider.getCode(deployer),
    ethers.provider.getCode(factoryAddress),
    ethers.provider.getTransactionCount(factoryAddress),
    ethers.provider.getCode(address),
    ethers.provider.getTransactionCount(address),
  ]);
  if (latestNonce !== 0 || pendingNonce !== 0 || deployerCode !== "0x") {
    throw new Error("The deployment wallet must be an unused account with no code and both latest and pending nonce zero.");
  }
  if (factoryCode !== "0x" || factoryNonce !== 0) {
    throw new Error("The predicted factory address is already occupied; no deployment was submitted.");
  }
  if (tokenCode !== "0x" || tokenNonce !== 0) {
    throw new Error("The predicted token address is already occupied; no deployment was submitted.");
  }
  log("Preflight passed: deployer nonce is zero and both deployment addresses are unused.");

  if (mode === "local") {
    await connection.networkHelpers.setBalance(deployer, parseEther("100"));
    log("Funded the signing wallet with 100 simulated BNB on the local network.");
  }
  const signer = wallet.connect(ethers.provider);
  log(`Fixed gas limits: factory ${factoryGasLimit}, token ${tokenGasLimit}, total ${factoryGasLimit + tokenGasLimit}`);

  log("Deploying VanityCreate2Factory at wallet nonce 0...");
  const factory = await (await ethers.getContractFactory("VanityCreate2Factory", signer)).deploy({ nonce: 0, gasLimit: factoryGasLimit });
  const factoryTransaction = factory.deploymentTransaction()!;
  log(`Factory transaction submitted: ${factoryTransaction.hash}`);
  await factory.waitForDeployment();
  const factoryReceipt = await factoryTransaction.wait();
  if (!factoryReceipt || factoryReceipt.status !== 1) throw new Error("Factory deployment did not succeed.");
  if (await factory.getAddress() !== factoryAddress || await factory.owner() !== deployer) {
    throw new Error("Deployed factory address or owner does not match the signing wallet.");
  }
  log(`Factory deployed: ${factoryAddress}`);

  log("Deploying Token through CREATE2 with zero native value at wallet nonce 1...");
  const tokenTransaction = await factory.deploy(salt, initCode, { value: 0n, nonce: 1, gasLimit: tokenGasLimit });
  log(`Token transaction submitted: ${tokenTransaction.hash}`);
  const tokenReceipt = await tokenTransaction.wait();
  if (!tokenReceipt || tokenReceipt.status !== 1) throw new Error("Token deployment did not succeed.");
  const totalGasUsed = factoryReceipt.gasUsed + tokenReceipt.gasUsed;
  log(`Gas used: factory ${factoryReceipt.gasUsed}, token ${tokenReceipt.gasUsed}, total ${totalGasUsed}`);
  const token = await ethers.getContractAt("Token", address);
  const [code, supply, receiverBalance, decimals, domain] = await Promise.all([
    ethers.provider.getCode(address), token.totalSupply(), token.balanceOf(receiver), token.decimals(), token.eip712Domain(),
  ]);
  if (code === "0x" || supply !== totalSupply || receiverBalance !== totalSupply || decimals !== 18n
    || domain.verifyingContract !== address || domain.chainId !== chainId) {
    throw new Error("Post-deployment token verification failed.");
  }
  log(`Token deployed: ${address}`);
  log("Verified total supply, receiver balance, 18 decimals, and the deployed EIP-712 domain.");

  return {
    network: networkName, chainId: Number(chainId), dryRun: mode === "local",
    deployer, factory: factoryAddress, address,
    salt, initCodeHash, receiver, totalSupply: totalSupply.toString(), decimals: 18,
    factoryTransaction: factoryTransaction.hash, tokenTransaction: tokenTransaction.hash,
    gasLimits: { factory: factoryGasLimit.toString(), token: tokenGasLimit.toString(), total: (factoryGasLimit + tokenGasLimit).toString() },
    gasUsed: { factory: factoryReceipt.gasUsed.toString(), token: tokenReceipt.gasUsed.toString(), total: totalGasUsed.toString() },
  };
}
