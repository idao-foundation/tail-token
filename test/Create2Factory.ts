import { readFile } from "node:fs/promises";
import { expect } from "chai";
import { artifacts } from "hardhat";
import { createContext } from "./helpers/token.js";

const { connection, ethers, networkHelpers } = await createContext();
after(async () => connection.close());

const reference: {
  receiver: string; totalSupply: string; creationBytecodeBytes: number; initCodeBytes: number;
  creationBytecodeHash: string; initCodeHash: string;
} = JSON.parse(await readFile(new URL("./fixtures/token-create2.json", import.meta.url), "utf8"));

async function factoryFixture() {
  const [owner, other] = await ethers.getSigners();
  const factory = await ethers.deployContract("VanityCreate2Factory");
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  const tokenFactory = await ethers.getContractFactory("Token");
  const totalSupply = ethers.parseUnits("100000000", 18);
  const receiver = ethers.getAddress(reference.receiver);
  const { data: initCode } = await tokenFactory.getDeployTransaction(totalSupply, receiver);
  const initCodeHash = ethers.keccak256(initCode);
  const salt = ethers.zeroPadValue("0x1234", 32);
  const predicted = ethers.getCreate2Address(factoryAddress, salt, initCodeHash);
  return { owner, other, factory, factoryAddress, tokenFactory, totalSupply, receiver, initCode, initCodeHash, salt, predicted };
}

describe("VanityCreate2Factory: deployment and search compatibility", function () {
  it("preserves the exact token creation bytecode and 100M-token initialization-code hash", async function () {
    const { tokenFactory, totalSupply, receiver, initCode, initCodeHash } = await networkHelpers.loadFixture(factoryFixture);
    const artifact = await artifacts.readArtifact("Token");
    const argumentsData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address"], [totalSupply, receiver]);
    expect(tokenFactory.interface.deploy.inputs.map(input => input.type)).to.deep.equal(["uint256", "address"]);
    expect(totalSupply.toString()).to.equal(reference.totalSupply);
    expect(ethers.dataLength(artifact.bytecode)).to.equal(reference.creationBytecodeBytes);
    expect(ethers.keccak256(artifact.bytecode)).to.equal(reference.creationBytecodeHash);
    expect(initCode).to.equal(ethers.concat([artifact.bytecode, argumentsData]));
    expect(ethers.dataLength(initCode)).to.equal(reference.initCodeBytes);
    expect(initCodeHash).to.equal(reference.initCodeHash);
  });

  it("keeps the nonce-zero factory address and immutable owner expected by the search", async function () {
    const { owner, factory, factoryAddress } = await networkHelpers.loadFixture(factoryFixture);
    expect(factory.deploymentTransaction()!.nonce).to.equal(0);
    expect(factoryAddress).to.equal(ethers.getCreateAddress({ from: owner.address, nonce: 0 }));
    expect(await factory.owner()).to.equal(owner.address);
    const artifact = await artifacts.readArtifact("VanityCreate2Factory");
    const callable = artifact.abi.filter(item => item.type === "function").map(item => item.name).sort();
    expect(callable).to.deep.equal(["deploy", "owner"]);
  });

  it("deploys 100M tokens at the raw-salt CREATE2 address and reports the exact hash", async function () {
    const f = await networkHelpers.loadFixture(factoryFixture);
    expect(await f.factory.deploy.staticCall(f.salt, f.initCode)).to.equal(f.predicted);
    await expect(f.factory.deploy(f.salt, f.initCode))
      .to.emit(f.factory, "Deployed").withArgs(f.predicted, f.salt, f.initCodeHash);
    const token = await ethers.getContractAt("Token", f.predicted);
    expect(await token.totalSupply()).to.equal(f.totalSupply);
    expect(await token.balanceOf(f.receiver)).to.equal(f.totalSupply);
    expect(await token.balanceOf(f.factoryAddress)).to.equal(0n);
    expect(await token.decimals()).to.equal(18n);
    expect(await token.name()).to.equal("Longtail");
    expect(await token.symbol()).to.equal("TAIL");
    expect(await ethers.provider.getBalance(f.factoryAddress)).to.equal(0n);
    const domain = await token.eip712Domain();
    expect(domain.verifyingContract).to.equal(f.predicted);
    expect(domain.chainId).to.equal((await ethers.provider.getNetwork()).chainId);
  });

  it("rejects other callers before creating code or accepting their value", async function () {
    const f = await networkHelpers.loadFixture(factoryFixture);
    await expect(f.factory.connect(f.other).deploy(f.salt, f.initCode, { value: 1n }))
      .to.be.revertedWithCustomError(f.factory, "UnauthorizedDeployer").withArgs(f.other.address);
    expect(await ethers.provider.getCode(f.predicted)).to.equal("0x");
    expect(await ethers.provider.getBalance(f.factoryAddress)).to.equal(0n);
    await expect(f.factory.deploy(f.salt, f.initCode)).to.emit(f.factory, "Deployed");
  });

  it("rejects empty initialization code", async function () {
    const { factory, salt } = await networkHelpers.loadFixture(factoryFixture);
    await expect(factory.deploy(salt, "0x")).to.be.revertedWithCustomError(factory, "Create2EmptyBytecode");
  });

  it("rejects initialization that returns no runtime code and rolls back value and creation", async function () {
    const { factory, factoryAddress, salt } = await networkHelpers.loadFixture(factoryFixture);
    // PUSH1 0, PUSH1 0, RETURN: successful initialization with empty runtime code.
    const initCode = "0x60006000f3";
    const predicted = ethers.getCreate2Address(factoryAddress, salt, ethers.keccak256(initCode));
    await expect(factory.deploy(salt, initCode, { value: 7n }))
      .to.be.revertedWithCustomError(factory, "EmptyDeployedCode").withArgs(predicted);
    expect(await ethers.provider.getCode(predicted)).to.equal("0x");
    expect(await ethers.provider.getTransactionCount(predicted)).to.equal(0);
    expect(await ethers.provider.getBalance(predicted)).to.equal(0n);
    expect(await ethers.provider.getBalance(factoryAddress)).to.equal(0n);
  });

  it("reports creation failure when the constructor has no revert data", async function () {
    const { factory, salt } = await networkHelpers.loadFixture(factoryFixture);
    // REVERT without data.
    await expect(factory.deploy(salt, "0x60006000fd")).to.be.revertedWithCustomError(factory, "FailedDeployment");
  });

  it("bubbles Token constructor errors and leaves the failed address undeployed", async function () {
    const { factory, factoryAddress, tokenFactory, totalSupply, salt } = await networkHelpers.loadFixture(factoryFixture);
    const { data } = await tokenFactory.getDeployTransaction(totalSupply, ethers.ZeroAddress);
    const predicted = ethers.getCreate2Address(factoryAddress, salt, ethers.keccak256(data));
    await expect(factory.deploy(salt, data))
      .to.be.revertedWithCustomError(tokenFactory, "ERC20InvalidReceiver").withArgs(ethers.ZeroAddress);
    expect(await ethers.provider.getCode(predicted)).to.equal("0x");
    expect(await ethers.provider.getTransactionCount(predicted)).to.equal(0);
  });

  it("rejects native value for Token's nonpayable constructor and allows a zero-value retry", async function () {
    const f = await networkHelpers.loadFixture(factoryFixture);
    await expect(f.factory.deploy(f.salt, f.initCode, { value: 1n }))
      .to.be.revertedWithCustomError(f.factory, "FailedDeployment");
    expect(await ethers.provider.getCode(f.predicted)).to.equal("0x");
    expect(await ethers.provider.getBalance(f.predicted)).to.equal(0n);
    expect(await ethers.provider.getBalance(f.factoryAddress)).to.equal(0n);
    await expect(f.factory.deploy(f.salt, f.initCode)).to.emit(f.factory, "Deployed");
  });

  it("rejects a repeated salt and init-code pair without changing the existing token", async function () {
    const f = await networkHelpers.loadFixture(factoryFixture);
    await f.factory.deploy(f.salt, f.initCode);
    const token = await ethers.getContractAt("Token", f.predicted);
    const code = await ethers.provider.getCode(f.predicted);
    await expect(f.factory.deploy(f.salt, f.initCode)).to.be.revertedWithCustomError(f.factory, "FailedDeployment");
    expect(await ethers.provider.getCode(f.predicted)).to.equal(code);
    expect(await token.balanceOf(f.receiver)).to.equal(f.totalSupply);
    expect(await token.totalSupply()).to.equal(f.totalSupply);
  });

  it("allows another salt or different initialization code to select a different address", async function () {
    const f = await networkHelpers.loadFixture(factoryFixture);
    await f.factory.deploy(f.salt, f.initCode);
    const otherSalt = ethers.zeroPadValue("0x1235", 32);
    const otherAddress = ethers.getCreate2Address(f.factoryAddress, otherSalt, f.initCodeHash);
    await expect(f.factory.deploy(otherSalt, f.initCode))
      .to.emit(f.factory, "Deployed").withArgs(otherAddress, otherSalt, f.initCodeHash);
    const { data } = await f.tokenFactory.getDeployTransaction(0n, f.receiver);
    const otherHash = ethers.keccak256(data);
    const zeroSupplyAddress = ethers.getCreate2Address(f.factoryAddress, f.salt, otherHash);
    await expect(f.factory.deploy(f.salt, data))
      .to.emit(f.factory, "Deployed").withArgs(zeroSupplyAddress, f.salt, otherHash);
    expect(await (await ethers.getContractAt("Token", zeroSupplyAddress)).totalSupply()).to.equal(0n);
    expect(new Set([f.predicted, otherAddress, zeroSupplyAddress]).size).to.equal(3);
  });

  it("forwards exactly msg.value to payable initialization and leaves existing factory funds alone", async function () {
    const { factory, factoryAddress, salt } = await networkHelpers.loadFixture(factoryFixture);
    await networkHelpers.setBalance(factoryAddress, 5n);
    const { data } = await (await ethers.getContractFactory("Create2PayableMock")).getDeployTransaction();
    const predicted = ethers.getCreate2Address(factoryAddress, salt, ethers.keccak256(data));
    await factory.deploy(salt, data, { value: 7n });
    const deployed = await ethers.getContractAt("Create2PayableMock", predicted);
    expect(await deployed.creator()).to.equal(factoryAddress);
    expect(await deployed.receivedValue()).to.equal(7n);
    expect(await ethers.provider.getBalance(predicted)).to.equal(7n);
    expect(await ethers.provider.getBalance(factoryAddress)).to.equal(5n);
  });

  it("rejects constructor reentry as a non-owner and preserves the owner's subsequent deployment", async function () {
    const f = await networkHelpers.loadFixture(factoryFixture);
    const { data } = await (await ethers.getContractFactory("Create2ReentrantMock")).getDeployTransaction(f.salt, f.initCode);
    const outerSalt = ethers.zeroPadValue("0x5678", 32);
    const outerAddress = ethers.getCreate2Address(f.factoryAddress, outerSalt, ethers.keccak256(data));
    await f.factory.deploy(outerSalt, data);
    const deployed = await ethers.getContractAt("Create2ReentrantMock", outerAddress);
    expect(await deployed.reentrySucceeded()).to.equal(false);
    expect(await deployed.reentryError()).to.equal(f.factory.interface.getError("UnauthorizedDeployer")!.selector);
    expect(await ethers.provider.getCode(f.predicted)).to.equal("0x");
    await expect(f.factory.deploy(f.salt, f.initCode)).to.emit(f.factory, "Deployed");
  });
});
