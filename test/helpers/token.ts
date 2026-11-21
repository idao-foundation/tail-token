import type { Signer, TypedDataDomain } from "ethers";
import { network } from "hardhat";

export const MAX_SUPPLY = (1n << 256n) - 1n;
export const PERMIT_BYTES = "permit(address,address,uint256,uint256,bytes)";
export const PERMIT_VRS = "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)";
export const TRANSFER_BYTES = "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)";
export const TRANSFER_VRS = "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)";
export const RECEIVE_BYTES = "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)";
export const RECEIVE_VRS = "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)";
export const CANCEL_BYTES = "cancelAuthorization(address,bytes32,bytes)";
export const CANCEL_VRS = "cancelAuthorization(address,bytes32,uint8,bytes32,bytes32)";

export const permitTypes = { Permit: [
  { name: "owner", type: "address" },
  { name: "spender", type: "address" },
  { name: "value", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] };
export const cancelTypes = { CancelAuthorization: [
  { name: "authorizer", type: "address" },
  { name: "nonce", type: "bytes32" },
] };
const authorizationFields = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];
export type Authorization = {
  from: string; to: string; value: bigint;
  validAfter: bigint; validBefore: bigint; nonce: string;
};

export function authorizationArgs(a: Authorization) {
  return [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce] as const;
}

export function signAuthorization(
  signer: Signer, domain: TypedDataDomain, authorization: Authorization,
  kind: "TransferWithAuthorization" | "ReceiveWithAuthorization" = "TransferWithAuthorization",
) {
  return signer.signTypedData(domain, { [kind]: authorizationFields }, authorization);
}

export async function createContext() {
  const connection = await network.create("local");
  const { ethers, networkHelpers } = connection;

  async function deployTokenFixture() {
    const [deployer, receiver, spender, recipient, walletSigner] = await ethers.getSigners();
    const supply = ethers.parseUnits("1000000", 18);
    const token = await ethers.deployContract("Token", [supply, receiver.address]);
    await token.waitForDeployment();
    const wallet = await ethers.deployContract("SignatureWalletMock", [walletSigner.address]);
    const hooks = await ethers.deployContract("TokenHooksMock", [await token.getAddress()]);
    const domain = {
      name: "Longtail", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await token.getAddress(),
    };
    const deadline = BigInt(await networkHelpers.time.latest()) + 3600n;
    function authorization(overrides: Partial<Authorization> = {}): Authorization {
      return {
        from: receiver.address, to: recipient.address, value: 10n,
        validAfter: 0n, validBefore: deadline,
        nonce: ethers.hexlify(ethers.randomBytes(32)), ...overrides,
      };
    }
    return {
      token, supply, deployer, receiver, spender, recipient, walletSigner,
      wallet, hooks, domain, deadline, authorization,
    };
  }

  function wrapWalletSignature(signature: string) {
    return ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], [signature]);
  }

  return { connection, ethers, networkHelpers, deployTokenFixture, wrapWalletSignature };
}
