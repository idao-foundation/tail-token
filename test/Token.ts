import { expect } from "chai";
import { createContext, MAX_SUPPLY } from "./helpers/token.js";

const { connection, ethers, networkHelpers, deployTokenFixture } = await createContext();
after(async () => connection.close());

describe("Token: fixed supply and metadata", function () {
  it("mints the exact supply to the receiver and preserves Longtail metadata", async function () {
    const { token, supply, receiver, deployer } = await networkHelpers.loadFixture(deployTokenFixture);
    expect(await token.name()).to.equal("Longtail");
    expect(await token.symbol()).to.equal("TAIL");
    expect(await token.decimals()).to.equal(18n);
    expect(await token.totalSupply()).to.equal(supply);
    expect(await token.balanceOf(receiver)).to.equal(supply);
    expect(await token.balanceOf(deployer)).to.equal(0n);
    await expect(token.deploymentTransaction()).to.emit(token, "Transfer")
      .withArgs(ethers.ZeroAddress, receiver.address, supply);
  });

  for (const [label, supply] of [["zero", 0n], ["one base unit", 1n], ["uint256 maximum", MAX_SUPPLY]] as const) {
    it(`accepts ${label} without rescaling`, async function () {
      const [receiver] = await ethers.getSigners();
      const token = await ethers.deployContract("Token", [supply, receiver.address]);
      expect(await token.totalSupply()).to.equal(supply);
      expect(await token.balanceOf(receiver)).to.equal(supply);
    });
  }

  it("supports full-supply transfers and unlimited allowances at the uint256 maximum", async function () {
    const [receiver, recipient, spender] = await ethers.getSigners();
    const token = await ethers.deployContract("Token", [MAX_SUPPLY, receiver.address]);
    await token.connect(receiver).transfer(recipient, MAX_SUPPLY);
    expect(await token.balanceOf(receiver)).to.equal(0n);
    expect(await token.balanceOf(recipient)).to.equal(MAX_SUPPLY);
    await token.connect(recipient).approve(spender, MAX_SUPPLY);
    await token.connect(spender).transferFrom(recipient, receiver, MAX_SUPPLY);
    expect(await token.balanceOf(receiver)).to.equal(MAX_SUPPLY);
    expect(await token.balanceOf(recipient)).to.equal(0n);
    expect(await token.allowance(recipient, spender)).to.equal(MAX_SUPPLY);
    expect(await token.totalSupply()).to.equal(MAX_SUPPLY);
  });

  it("rejects a zero-address receiver", async function () {
    const factory = await ethers.getContractFactory("Token");
    await expect(factory.deploy(1n, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(factory, "ERC20InvalidReceiver").withArgs(ethers.ZeroAddress);
  });

  it("supports standard transfers and allowances without changing supply", async function () {
    const { token, supply, receiver, spender, recipient } = await networkHelpers.loadFixture(deployTokenFixture);
    await token.connect(receiver).transfer(recipient, 10n);
    await token.connect(receiver).approve(spender, 20n);
    await token.connect(spender).transferFrom(receiver, recipient, 20n);
    expect(await token.balanceOf(receiver)).to.equal(supply - 30n);
    expect(await token.balanceOf(recipient)).to.equal(30n);
    expect(await token.allowance(receiver, spender)).to.equal(0n);
    expect(await token.totalSupply()).to.equal(supply);
    await expect(token.connect(receiver).transfer(ethers.ZeroAddress, 1n))
      .to.be.revertedWithCustomError(token, "ERC20InvalidReceiver");
  });

  it("exposes no admin, supply-changing, upgrade, or temporary-approval entry points", async function () {
    const { token } = await networkHelpers.loadFixture(deployTokenFixture);
    for (const name of ["owner", "transferOwnership", "renounceOwnership", "grantRole", "revokeRole", "mint", "burn", "burnFrom", "pause", "unpause", "upgradeToAndCall", "initialize", "flashLoan", "crosschainMint", "temporaryApprove"]) {
      expect(token.interface.hasFunction(name), name).to.equal(false);
    }
    expect(token.interface.deploy.inputs.map((input) => input.type)).to.deep.equal(["uint256", "address"]);
  });

  it("exposes one ERC-5267 domain matching DOMAIN_SEPARATOR", async function () {
    const { token, domain } = await networkHelpers.loadFixture(deployTokenFixture);
    const result = await token.eip712Domain();
    expect(result.fields).to.equal("0x0f");
    expect(result.name).to.equal(domain.name);
    expect(result.version).to.equal(domain.version);
    expect(result.chainId).to.equal(domain.chainId);
    expect(result.verifyingContract).to.equal(domain.verifyingContract);
    expect(result.salt).to.equal(ethers.ZeroHash);
    expect(result.extensions).to.deep.equal([]);
    expect(await token.DOMAIN_SEPARATOR()).to.equal(ethers.TypedDataEncoder.hashDomain(domain));
  });
});

describe("Token: ERC-1363 callbacks", function () {
  it("advertises ERC-165 and ERC-1363, but not an invalid interface", async function () {
    const { token } = await networkHelpers.loadFixture(deployTokenFixture);
    expect(await token.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await token.supportsInterface("0xb0202a11")).to.equal(true);
    expect(await token.supportsInterface("0xffffffff")).to.equal(false);
  });

  for (const withData of [false, true]) {
    it(`transfers and calls the receiver ${withData ? "with" : "without"} data`, async function () {
      const { token, supply, receiver, hooks } = await networkHelpers.loadFixture(deployTokenFixture);
      const to = await hooks.getAddress();
      const data = withData ? "0x1234" : "0x";
      const tx = withData
        ? token.connect(receiver)["transferAndCall(address,uint256,bytes)"](to, 10n, data)
        : token.connect(receiver)["transferAndCall(address,uint256)"](to, 10n);
      await expect(tx).to.emit(hooks, "Received").withArgs(receiver.address, receiver.address, 10n, data);
      expect(await hooks.balanceDuringCallback()).to.equal(10n);
      expect(await token.totalSupply()).to.equal(supply);
    });

    it(`transfers from an approved holder and calls ${withData ? "with" : "without"} data`, async function () {
      const { token, receiver, spender, hooks } = await networkHelpers.loadFixture(deployTokenFixture);
      await token.connect(receiver).approve(spender, 10n);
      const to = await hooks.getAddress();
      const data = withData ? "0xabcd" : "0x";
      const tx = withData
        ? token.connect(spender)["transferFromAndCall(address,address,uint256,bytes)"](receiver, to, 10n, data)
        : token.connect(spender)["transferFromAndCall(address,address,uint256)"](receiver, to, 10n);
      await expect(tx).to.emit(hooks, "Received").withArgs(spender.address, receiver.address, 10n, data);
      expect(await token.allowance(receiver, spender)).to.equal(0n);
    });

    it(`allows the approval callback to spend tokens ${withData ? "with" : "without"} data`, async function () {
      const { token, supply, receiver, hooks } = await networkHelpers.loadFixture(deployTokenFixture);
      const to = await hooks.getAddress();
      const data = withData ? "0x9876" : "0x";
      const tx = withData
        ? token.connect(receiver)["approveAndCall(address,uint256,bytes)"](to, 10n, data)
        : token.connect(receiver)["approveAndCall(address,uint256)"](to, 10n);
      await expect(tx).to.emit(hooks, "Approved").withArgs(receiver.address, 10n, data);
      expect(await token.balanceOf(to)).to.equal(10n);
      expect(await token.allowance(receiver, to)).to.equal(0n);
      expect(await token.totalSupply()).to.equal(supply);
    });
  }

  for (const mode of [1, 2]) {
    it(`rolls back balances and allowances when a callback ${mode === 1 ? "rejects" : "reverts"}`, async function () {
      const { token, supply, receiver, spender, hooks } = await networkHelpers.loadFixture(deployTokenFixture);
      await token.connect(receiver).approve(spender, 10n);
      await hooks.setResponseMode(mode);
      const to = await hooks.getAddress();
      const transfer = () => token.connect(spender)["transferFromAndCall(address,address,uint256)"](receiver, to, 10n);
      const approve = () => token.connect(receiver)["approveAndCall(address,uint256)"](to, 10n);
      if (mode === 1) {
        await expect(transfer()).to.be.revertedWithCustomError(token, "ERC1363InvalidReceiver");
        await expect(approve()).to.be.revertedWithCustomError(token, "ERC1363InvalidSpender");
      } else {
        await expect(transfer()).to.be.revertedWith("hook rejected");
        await expect(approve()).to.be.revertedWith("hook rejected");
      }
      expect(await token.balanceOf(receiver)).to.equal(supply);
      expect(await token.balanceOf(to)).to.equal(0n);
      expect(await token.allowance(receiver, spender)).to.equal(10n);
      expect(await token.allowance(receiver, to)).to.equal(0n);
    });
  }

  it("keeps ordinary transfers free of callbacks, and rejects callback transfers to EOAs", async function () {
    const { token, receiver, recipient, hooks } = await networkHelpers.loadFixture(deployTokenFixture);
    await token.connect(receiver).transfer(await hooks.getAddress(), 10n);
    expect(await hooks.receivedCount()).to.equal(0n);
    await expect(token.connect(receiver)["transferAndCall(address,uint256)"](recipient, 10n))
      .to.be.revertedWithCustomError(token, "ERC1363InvalidReceiver").withArgs(recipient.address);
    expect(await token.balanceOf(recipient)).to.equal(0n);
  });
});
