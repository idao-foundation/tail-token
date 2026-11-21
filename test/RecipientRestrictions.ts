import { expect } from "chai";
import {
  createContext, authorizationArgs, signAuthorization,
  TRANSFER_BYTES, TRANSFER_VRS, RECEIVE_BYTES, RECEIVE_VRS,
} from "./helpers/token.js";

const { connection, ethers, networkHelpers, deployTokenFixture, wrapWalletSignature } = await createContext();
after(async () => connection.close());

async function recipientFixture() {
  const f = await deployTokenFixture();
  await f.token.connect(f.receiver).approve(f.spender, 10n);
  return { ...f, tokenAddress: await f.token.getAddress() };
}

type Fixture = Awaited<ReturnType<typeof recipientFixture>>;

async function tokenState(f: Fixture) {
  const accounts = [f.receiver.address, f.spender.address, f.recipient.address, await f.wallet.getAddress(), f.tokenAddress];
  return {
    supply: await f.token.totalSupply(),
    allowance: await f.token.allowance(f.receiver, f.spender),
    accounts: await Promise.all(accounts.map(async account => ({
      balance: await f.token.balanceOf(account),
      nonce: await f.token.nonces(account),
    }))),
  };
}

describe("Token: reject movements to the token contract", function () {
  for (const amount of [0n, 10n]) {
    for (const useAllowance of [false, true]) {
      it(`rejects ${amount}-unit ${useAllowance ? "transferFrom" : "transfer"} without changing token state`, async function () {
        const f = await networkHelpers.loadFixture(recipientFixture);
        const before = await tokenState(f);
        const tx = useAllowance
          ? f.token.connect(f.spender).transferFrom(f.receiver, f.tokenAddress, amount)
          : f.token.connect(f.receiver).transfer(f.tokenAddress, amount);
        await expect(tx).to.be.revertedWithCustomError(f.token, "ERC20InvalidReceiver").withArgs(f.tokenAddress);
        expect(await tokenState(f)).to.deep.equal(before);
      });
    }

    for (const format of ["vrs", "bytes", "wallet"] as const) {
      it(`rejects a ${amount}-unit ${format} transfer authorization without consuming its nonce`, async function () {
        const f = await networkHelpers.loadFixture(recipientFixture);
        const { token, receiver, wallet, walletSigner, domain, tokenAddress } = f;
        const from = format === "wallet" ? await wallet.getAddress() : receiver.address;
        if (format === "wallet") {
          await token.connect(receiver).transfer(from, 10n);
        }
        const a = f.authorization({ from, to: tokenAddress, value: amount });
        const signature = await signAuthorization(format === "wallet" ? walletSigner : receiver, domain, a);
        const { v, r, s } = ethers.Signature.from(signature);
        const before = await tokenState(f);
        const tx = format === "vrs"
          ? token[TRANSFER_VRS](...authorizationArgs(a), v, r, s)
          : token[TRANSFER_BYTES](...authorizationArgs(a), format === "wallet" ? wrapWalletSignature(signature) : signature);
        await expect(tx).to.be.revertedWithCustomError(token, "ERC20InvalidReceiver").withArgs(tokenAddress);
        expect(await token.authorizationState(from, a.nonce)).to.equal(false);
        expect(await tokenState(f)).to.deep.equal(before);
      });
    }

    it(`rejects a ${amount}-unit constructor mint to its own predicted deployment address`, async function () {
      const { deployer } = await networkHelpers.loadFixture(recipientFixture);
      const factory = await ethers.getContractFactory("Token");
      const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: await deployer.getNonce() });
      await expect(factory.deploy(amount, predicted))
        .to.be.revertedWithCustomError(factory, "ERC20InvalidReceiver").withArgs(predicted);
      expect(await ethers.provider.getCode(predicted)).to.equal("0x");
    });
  }

  for (const withData of [false, true]) {
    for (const useAllowance of [false, true]) {
      it(`rejects ${useAllowance ? "transferFromAndCall" : "transferAndCall"} ${withData ? "with" : "without"} data before calling the token`, async function () {
        const f = await networkHelpers.loadFixture(recipientFixture);
        const before = await tokenState(f);
        const tx = useAllowance
          ? withData
            ? f.token.connect(f.spender)["transferFromAndCall(address,address,uint256,bytes)"](f.receiver, f.tokenAddress, 10n, "0x1234")
            : f.token.connect(f.spender)["transferFromAndCall(address,address,uint256)"](f.receiver, f.tokenAddress, 10n)
          : withData
            ? f.token.connect(f.receiver)["transferAndCall(address,uint256,bytes)"](f.tokenAddress, 10n, "0x1234")
            : f.token.connect(f.receiver)["transferAndCall(address,uint256)"](f.tokenAddress, 10n);
        await expect(tx).to.be.revertedWithCustomError(f.token, "ERC20InvalidReceiver").withArgs(f.tokenAddress);
        expect(await tokenState(f)).to.deep.equal(before);
      });
    }
  }

  for (const format of ["vrs", "bytes"] as const) {
    it(`enforces the recipient guard after the ${format} receive authorization's caller check`, async function () {
      const f = await networkHelpers.loadFixture(recipientFixture);
      const a = f.authorization({ to: f.tokenAddress });
      const signature = await signAuthorization(f.receiver, f.domain, a, "ReceiveWithAuthorization");
      await expect(f.token.connect(f.recipient)[RECEIVE_BYTES](...authorizationArgs(a), signature))
        .to.be.revertedWithCustomError(f.token, "ERC3009CallerMustBePayee")
        .withArgs(f.recipient.address, f.tokenAddress);

      // The deployed token cannot originate such a call. Local impersonation
      // reaches the movement guard independently of ERC-3009's payee restriction.
      const caller = await ethers.getImpersonatedSigner(f.tokenAddress);
      await networkHelpers.setBalance(f.tokenAddress, ethers.parseEther("1"));
      const before = await tokenState(f);
      try {
        const { v, r, s } = ethers.Signature.from(signature);
        const tx = format === "vrs"
          ? f.token.connect(caller)[RECEIVE_VRS](...authorizationArgs(a), v, r, s)
          : f.token.connect(caller)[RECEIVE_BYTES](...authorizationArgs(a), signature);
        await expect(tx).to.be.revertedWithCustomError(f.token, "ERC20InvalidReceiver").withArgs(f.tokenAddress);
        expect(await f.token.authorizationState(f.receiver, a.nonce)).to.equal(false);
        expect(await tokenState(f)).to.deep.equal(before);
      } finally {
        await networkHelpers.stopImpersonatingAccount(f.tokenAddress);
      }
    });
  }

  it("blocks a callback's transfer into the token without spending its allowance", async function () {
    const f = await networkHelpers.loadFixture(recipientFixture);
    const callback = await ethers.deployContract("ReentrantCallbacksMock", [f.tokenAddress]);
    const spender = await callback.getAddress();
    const before = await tokenState(f);
    await callback.configure([{
      data: f.token.interface.encodeFunctionData("transferFrom", [f.receiver.address, f.tokenAddress, 10n]),
      expectedSuccess: false,
      checkResult: true,
      expectedResult: f.token.interface.encodeErrorResult("ERC20InvalidReceiver", [f.tokenAddress]),
    }]);
    // The callback catches the rejected nested movement and accepts the approval.
    await f.token.connect(f.receiver)["approveAndCall(address,uint256)"](spender, 10n);
    expect(await callback.callbackCount()).to.equal(1n);
    expect(await f.token.allowance(f.receiver, spender)).to.equal(10n);
    expect(await f.token.balanceOf(spender)).to.equal(0n);
    expect(await tokenState(f)).to.deep.equal(before);
  });

  it("still permits zero and positive transfers back to the same holder", async function () {
    const { token, receiver, spender, supply } = await networkHelpers.loadFixture(recipientFixture);
    for (const amount of [0n, 10n]) {
      await expect(token.connect(receiver).transfer(receiver, amount))
        .to.emit(token, "Transfer").withArgs(receiver.address, receiver.address, amount);
      await expect(token.connect(spender).transferFrom(receiver, receiver, amount))
        .to.emit(token, "Transfer").withArgs(receiver.address, receiver.address, amount);
    }
    expect(await token.balanceOf(receiver)).to.equal(supply);
    expect(await token.allowance(receiver, spender)).to.equal(0n);
    expect(await token.totalSupply()).to.equal(supply);
  });
});
