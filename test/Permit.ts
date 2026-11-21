import { expect } from "chai";
import { createContext, permitTypes, PERMIT_BYTES, PERMIT_VRS } from "./helpers/token.js";

const { connection, ethers, networkHelpers, deployTokenFixture, wrapWalletSignature } = await createContext();
after(async () => connection.close());

describe("Token: ERC-2612 and ERC-7597 permits", function () {
  for (const format of ["vrs", "bytes", "wallet"] as const) {
    it(`accepts a relayed ${format} permit and permits allowance spending`, async function () {
      const { token, supply, receiver, spender, recipient, wallet, walletSigner, domain, deadline } =
        await networkHelpers.loadFixture(deployTokenFixture);
      const owner = format === "wallet" ? await wallet.getAddress() : receiver.address;
      const signer = format === "wallet" ? walletSigner : receiver;
      if (format === "wallet") await token.connect(receiver).transfer(owner, 10n);
      const signature = await signer.signTypedData(domain, permitTypes, {
        owner, spender: spender.address, value: 10n, nonce: 0n, deadline,
      });
      const { v, r, s } = ethers.Signature.from(signature);
      const tx = format === "vrs"
        ? token[PERMIT_VRS](owner, spender, 10n, deadline, v, r, s)
        : token[PERMIT_BYTES](owner, spender, 10n, deadline, format === "wallet" ? wrapWalletSignature(signature) : signature);
      await expect(tx).to.emit(token, "Approval").withArgs(owner, spender.address, 10n);
      expect(await token.nonces(owner)).to.equal(1n);
      await token.connect(spender).transferFrom(owner, recipient, 10n);
      expect(await token.balanceOf(recipient)).to.equal(10n);
      expect(await token.allowance(owner, spender)).to.equal(0n);
      expect(await token.totalSupply()).to.equal(supply);
    });
  }

  for (const first of ["vrs", "bytes"] as const) {
    it(`prevents replay between permit overloads after ${first} submission`, async function () {
      const { token, receiver, spender, domain, deadline } = await networkHelpers.loadFixture(deployTokenFixture);
      const signature = await receiver.signTypedData(domain, permitTypes, {
        owner: receiver.address, spender: spender.address, value: 10n, nonce: 0n, deadline,
      });
      const { v, r, s } = ethers.Signature.from(signature);
      const vrs = () => token[PERMIT_VRS](receiver, spender, 10n, deadline, v, r, s);
      const bytes = () => token[PERMIT_BYTES](receiver, spender, 10n, deadline, signature);
      await (first === "vrs" ? vrs() : bytes());
      await expect(first === "vrs" ? bytes() : vrs()).to.be.revertedWithCustomError(
        token, first === "vrs" ? "ERC7597InvalidSignature" : "ERC2612InvalidSigner",
      );
      expect(await token.nonces(receiver)).to.equal(1n);
      expect(await token.allowance(receiver, spender)).to.equal(10n);
    });
  }

  for (const field of ["owner", "spender", "value", "nonce", "deadline", "chainId", "verifyingContract"] as const) {
    it(`rejects a permit signed for a different ${field}`, async function () {
      const { token, receiver, spender, recipient, domain, deadline } = await networkHelpers.loadFixture(deployTokenFixture);
      const message = { owner: receiver.address, spender: spender.address, value: 10n, nonce: 0n, deadline };
      const signedDomain = { ...domain };
      if (field === "owner" || field === "spender") message[field] = recipient.address;
      else if (field === "chainId") signedDomain.chainId += 1n;
      else if (field === "verifyingContract") signedDomain.verifyingContract = recipient.address;
      else message[field] += 1n;
      const signature = await receiver.signTypedData(signedDomain, permitTypes, message);
      await expect(token[PERMIT_BYTES](receiver, spender, 10n, deadline, signature))
        .to.be.revertedWithCustomError(token, "ERC7597InvalidSignature");
      expect(await token.nonces(receiver)).to.equal(0n);
      expect(await token.allowance(receiver, spender)).to.equal(0n);
    });
  }

  it("accepts a permit at its deadline, while its allowance survives that deadline", async function () {
    const { token, receiver, spender, domain, deadline } = await networkHelpers.loadFixture(deployTokenFixture);
    const signature = await receiver.signTypedData(domain, permitTypes, {
      owner: receiver.address, spender: spender.address, value: 10n, nonce: 0n, deadline,
    });
    await networkHelpers.time.setNextBlockTimestamp(deadline);
    await token[PERMIT_BYTES](receiver, spender, 10n, deadline, signature);
    await networkHelpers.time.increase(1);
    expect(await token.allowance(receiver, spender)).to.equal(10n);
  });

  it("rejects expired permits and zero addresses without consuming a nonce", async function () {
    const { token, receiver, spender, domain, deadline } = await networkHelpers.loadFixture(deployTokenFixture);
    await expect(token[PERMIT_BYTES](ethers.ZeroAddress, spender, 10n, deadline, "0x"))
      .to.be.revertedWithCustomError(token, "ERC20InvalidApprover");
    const badSpenderSignature = await receiver.signTypedData(domain, permitTypes, {
      owner: receiver.address, spender: ethers.ZeroAddress, value: 10n, nonce: 0n, deadline,
    });
    await expect(token[PERMIT_BYTES](receiver, ethers.ZeroAddress, 10n, deadline, badSpenderSignature))
      .to.be.revertedWithCustomError(token, "ERC20InvalidSpender");
    await networkHelpers.time.setNextBlockTimestamp(deadline + 1n);
    await expect(token[PERMIT_BYTES](receiver, spender, 10n, deadline, "0x"))
      .to.be.revertedWithCustomError(token, "ERC2612ExpiredSignature").withArgs(deadline);
    expect(await token.nonces(receiver)).to.equal(0n);
  });

  for (const mode of [1, 2]) {
    it(`rejects an ERC-1271 wallet that ${mode === 1 ? "revokes its signature" : "reverts"}`, async function () {
      const { token, wallet, walletSigner, spender, domain, deadline } = await networkHelpers.loadFixture(deployTokenFixture);
      const owner = await wallet.getAddress();
      const signature = wrapWalletSignature(await walletSigner.signTypedData(domain, permitTypes, {
        owner, spender: spender.address, value: 10n, nonce: 0n, deadline,
      }));
      await wallet.connect(walletSigner).setSignatureMode(mode);
      await expect(token[PERMIT_BYTES](owner, spender, 10n, deadline, signature))
        .to.be.revertedWithCustomError(token, "ERC7597InvalidSignature");
      expect(await token.nonces(owner)).to.equal(0n);
      expect(await token.allowance(owner, spender)).to.equal(0n);
    });
  }

  it("rejects malformed and noncanonical ECDSA signatures", async function () {
    const { token, receiver, spender, domain, deadline } = await networkHelpers.loadFixture(deployTokenFixture);
    const signature = ethers.Signature.from(await receiver.signTypedData(domain, permitTypes, {
      owner: receiver.address, spender: spender.address, value: 10n, nonce: 0n, deadline,
    }));
    const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const malleable = ethers.concat([signature.r, ethers.toBeHex(order - BigInt(signature.s), 32), ethers.toBeHex(signature.v === 27 ? 28 : 27, 1)]);
    for (const invalid of ["0x", "0x1234", malleable]) {
      await expect(token[PERMIT_BYTES](receiver, spender, 10n, deadline, invalid))
        .to.be.revertedWithCustomError(token, "ERC7597InvalidSignature");
    }
    expect(await token.nonces(receiver)).to.equal(0n);
  });
});
