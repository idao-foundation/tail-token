import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { expect } from "chai";
import { artifacts } from "hardhat";
import {
  deployCreate2Token, deployWithWallet, deployerAddress, deploymentMode, expectedFactoryAddress,
  expectedInitCodeHash, factoryGasLimit, tokenGasLimit, loadDeploymentWallet, parseSalt, prepareTokenDeployment, receiverInput, supplyInput,
} from "../scripts/lib/create2-deployment.js";
import { createContext } from "./helpers/token.js";

const { connection, ethers, networkHelpers } = await createContext();
after(async () => connection.close());
const salt = ethers.zeroPadValue("0x1234", 32);
// A synthetic test-only key keeps real transaction signing independent of deployment credentials.
const testWallet = new ethers.Wallet(ethers.toBeHex(1n, 32));
const testDeployer = testWallet.address;
const testFactoryAddress = ethers.getCreateAddress({ from: testDeployer, nonce: 0 });
const tokenAddress = ethers.getCreate2Address(testFactoryAddress, salt, expectedInitCodeHash);

async function pristineNetwork() {
  return { testDeployer };
}

describe("Deployment script: fixed CREATE2 inputs and execution guards", function () {
  let previousPrivateKey: string | undefined;
  beforeEach(async () => {
    previousPrivateKey = process.env.BSC_PRIVATE_KEY;
    delete process.env.BSC_PRIVATE_KEY;
    await networkHelpers.loadFixture(pristineNetwork);
  });
  afterEach(() => {
    if (previousPrivateKey === undefined) delete process.env.BSC_PRIVATE_KEY;
    else process.env.BSC_PRIVATE_KEY = previousPrivateKey;
  });

  it("requires the environment private key for both deployment modes", function () {
    expect(() => loadDeploymentWallet()).to.throw("Set BSC_PRIVATE_KEY");
    process.env.BSC_PRIVATE_KEY = "";
    expect(() => loadDeploymentWallet()).to.throw("Set BSC_PRIVATE_KEY");
  });

  it("rejects malformed and invalid private keys without including them in errors", function () {
    for (const value of ["do-not-log-this-input", "0x1234", ethers.ZeroHash, ethers.toBeHex(ethers.MaxUint256, 32)]) {
      process.env.BSC_PRIVATE_KEY = value;
      assert.throws(() => loadDeploymentWallet(), error => {
        assert.ok(error instanceof Error);
        expect(error.message).to.include("BSC_PRIVATE_KEY must be a valid");
        expect(String(error)).not.to.include(value);
        expect(error.cause).to.equal(undefined);
        return true;
      });
    }
  });

  it("derives and asserts the environment key's wallet address", function () {
    process.env.BSC_PRIVATE_KEY = testWallet.privateKey;
    assert.throws(() => loadDeploymentWallet(), error => {
      assert.ok(error instanceof Error);
      expect(error.message).to.include(`vanity-search deployer ${deployerAddress}`);
      expect(String(error)).not.to.include(testWallet.privateKey);
      return true;
    });
  });

  it("uses the exact JSON supply, receiver, hash, and session factory address", async function () {
    const reference = JSON.parse(await readFile(new URL("./fixtures/token-create2.json", import.meta.url), "utf8"));
    const prepared = await prepareTokenDeployment(await artifacts.readArtifact("Token"));
    expect(supplyInput).to.equal("100000000");
    expect(receiverInput).to.equal(reference.receiver);
    expect(prepared.totalSupply.toString()).to.equal(reference.totalSupply);
    expect(prepared.initCodeHash).to.equal(reference.initCodeHash);
    expect(expectedFactoryAddress).to.equal(ethers.getAddress("0x66a8fbbdfcac14499fc30060c50fc7416d92063d"));
  });

  it("rejects changed initialization bytecode before deployment", async function () {
    const artifact = await artifacts.readArtifact("Token");
    await assert.rejects(prepareTokenDeployment({ ...artifact, bytecode: artifact.bytecode + "00" }), /initCodeHash mismatch/);
    expect(await ethers.provider.getTransactionCount(testDeployer)).to.equal(0);
  });

  it("requires an exact bytes32 salt and preserves all its bits", async function () {
    for (const invalid of [undefined, "", "1234", "0x1234", "0x" + "00".repeat(33), "0x" + "gg".repeat(32)]) {
      await assert.rejects(deployWithWallet(connection, invalid, testWallet, () => {}), /Set CREATE2_SALT/);
    }
    expect(parseSalt(ethers.ZeroHash)).to.equal(ethers.ZeroHash);
    expect(parseSalt("0x" + "AB".repeat(32))).to.equal("0x" + "AB".repeat(32));
    expect(await ethers.provider.getTransactionCount(testDeployer)).to.equal(0);
  });

  it("accepts only local non-forked EDR or BSC mainnet", function () {
    expect(deploymentMode("local", "edr-simulated", 31337n, false)).to.equal("local");
    expect(deploymentMode("bsc", "http", 56n, false)).to.equal("bsc");
    const rejected: [string, string, bigint, boolean][] = [
      ["local", "edr-simulated", 31337n, true], ["local", "edr-simulated", 56n, false],
      ["local", "http", 31337n, false], ["bsc", "http", 97n, false],
      ["bsc", "edr-simulated", 56n, false], ["other", "http", 56n, false],
    ];
    for (const target of rejected) expect(() => deploymentMode(...target)).to.throw("Deployment requires non-forked local EDR");
  });

  it("enforces the pinned signer before entering the deployment flow", async function () {
    await assert.rejects(deployCreate2Token(connection, salt, testWallet, () => {}), /BSC_PRIVATE_KEY must belong to the vanity-search deployer/);
    expect(await ethers.provider.getTransactionCount(testDeployer)).to.equal(0);
    expect(await ethers.provider.getBalance(testDeployer)).to.equal(0n);
  });

  for (const [label, deploymentSalt] of [
    ["zero salt", ethers.ZeroHash],
    ["selected vanity salt", "0x542c34d29cde4147af89e56f8063dd45450644a4d76bdce78729472ba8925af1"],
    ["all-nonzero salt", "0x" + "ff".repeat(32)],
  ] as const) {
    it(`deploys with fixed gas limits and no estimation for ${label}`, async function () {
      const tokenAddress = ethers.getCreate2Address(testFactoryAddress, deploymentSalt, expectedInitCodeHash);
      const logs: string[] = [];
      const methods: string[] = [];
      const provider = connection.provider;
      const originalRequest = provider.request;
      provider.request = async request => {
        methods.push(request.method);
        if (request.method === "eth_estimateGas") throw new Error("Deployment must not estimate gas");
        return originalRequest.call(provider, request);
      };
      let result: Awaited<ReturnType<typeof deployWithWallet>>;
      try {
        result = await deployWithWallet(connection, deploymentSalt, testWallet, message => logs.push(message));
      } finally {
        provider.request = originalRequest;
      }
      expect(methods.filter(method => method === "eth_sendRawTransaction")).to.have.length(2);
      expect(methods).not.to.include("eth_sendTransaction");
      expect(methods).not.to.include("eth_estimateGas");
      expect(methods).not.to.include("hardhat_impersonateAccount");
      expect(methods).not.to.include("hardhat_stopImpersonatingAccount");
      expect(result.dryRun).to.equal(true);
      expect(result.chainId).to.equal(31337);
      expect(result.deployer).to.equal(testDeployer);
      expect(result.factory).to.equal(testFactoryAddress);
      expect(result.address).to.equal(tokenAddress);
      expect(result.initCodeHash).to.equal(expectedInitCodeHash);
      const factory = await ethers.getContractAt("VanityCreate2Factory", result.factory);
      const token = await ethers.getContractAt("Token", result.address);
      expect(await factory.owner()).to.equal(testDeployer);
      expect(await token.balanceOf(receiverInput)).to.equal(ethers.parseUnits("100000000", 18));
      expect(await token.totalSupply()).to.equal(ethers.parseUnits("100000000", 18));
      expect((await ethers.provider.getTransaction(result.factoryTransaction))!.nonce).to.equal(0);
      expect((await ethers.provider.getTransaction(result.tokenTransaction))!.nonce).to.equal(1);
      expect(logs).to.include(`Initialization-code hash verified: ${expectedInitCodeHash}`);
      expect(logs).to.include(`Factory deployed: ${testFactoryAddress}`);
      expect(logs).to.include(`Token deployed: ${tokenAddress}`);
      expect(logs.join("\n")).not.to.include(testWallet.privateKey);
      expect(factoryGasLimit).to.equal(350_000n);
      expect(tokenGasLimit).to.equal(3_000_000n);
      const factoryTx = (await ethers.provider.getTransaction(result.factoryTransaction))!;
      const tokenTx = (await ethers.provider.getTransaction(result.tokenTransaction))!;
      const factoryReceipt = (await ethers.provider.getTransactionReceipt(result.factoryTransaction))!;
      const tokenReceipt = (await ethers.provider.getTransactionReceipt(result.tokenTransaction))!;
      expect(factoryTx.gasLimit).to.equal(factoryGasLimit);
      expect(tokenTx.gasLimit).to.equal(tokenGasLimit);
      expect(factoryReceipt.status).to.equal(1);
      expect(tokenReceipt.status).to.equal(1);
      // Preserve at least 50% headroom, including the most expensive salt calldata.
      expect(factoryGasLimit * 2n).to.be.at.least(factoryReceipt.gasUsed * 3n);
      expect(tokenGasLimit * 2n).to.be.at.least(tokenReceipt.gasUsed * 3n);
      expect(result.gasLimits).to.deep.equal({ factory: "350000", token: "3000000", total: "3350000" });
      expect(result.gasUsed).to.deep.equal({
        factory: factoryReceipt.gasUsed.toString(), token: tokenReceipt.gasUsed.toString(),
        total: (factoryReceipt.gasUsed + tokenReceipt.gasUsed).toString(),
      });
    });
  }

  it("refuses a previously used wallet without resetting its nonce or funding it", async function () {
    await networkHelpers.setNonce(testDeployer, 1);
    await assert.rejects(deployWithWallet(connection, salt, testWallet, () => {}), /unused account/);
    expect(await ethers.provider.getTransactionCount(testDeployer)).to.equal(1);
    expect(await ethers.provider.getBalance(testDeployer)).to.equal(0n);
    expect(await ethers.provider.getCode(testFactoryAddress)).to.equal("0x");
  });

  it("refuses a deployment wallet that has code", async function () {
    await networkHelpers.setCode(testDeployer, "0x00");
    await assert.rejects(deployWithWallet(connection, salt, testWallet, () => {}), /unused account/);
    expect(await ethers.provider.getCode(testFactoryAddress)).to.equal("0x");
  });

  for (const [kind, address] of [["factory", testFactoryAddress], ["token", tokenAddress]] as const) {
    for (const state of ["code", "nonce"] as const) {
      it(`rejects an occupied ${kind} address with ${state} before sending the factory transaction`, async function () {
        if (state === "code") await networkHelpers.setCode(address, "0x00");
        else await networkHelpers.setNonce(address, 1);
        await assert.rejects(deployWithWallet(connection, salt, testWallet, () => {}), new RegExp(`predicted ${kind} address is already occupied`));
        expect(await ethers.provider.getTransactionCount(testDeployer)).to.equal(0);
        expect(await ethers.provider.getBalance(testDeployer)).to.equal(0n);
      });
    }
  }
});
