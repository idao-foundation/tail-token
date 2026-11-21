import { expect } from "chai";
import {
  createContext, authorizationArgs, signAuthorization, cancelTypes,
  TRANSFER_BYTES, TRANSFER_VRS, RECEIVE_BYTES, RECEIVE_VRS, CANCEL_BYTES, CANCEL_VRS,
} from "./helpers/token.js";

const { connection, ethers, networkHelpers, deployTokenFixture, wrapWalletSignature } = await createContext();
after(async () => connection.close());

describe("Token: ERC-3009 authorizations", function () {
  for (const receive of [false, true]) {
    for (const format of ["vrs", "bytes", "wallet"] as const) {
      it(`executes a ${format} ${receive ? "receive" : "transfer"} authorization without allowance`, async function () {
        const { token, supply, receiver, recipient, wallet, walletSigner, domain, authorization } =
          await networkHelpers.loadFixture(deployTokenFixture);
        const from = format === "wallet" ? await wallet.getAddress() : receiver.address;
        const signer = format === "wallet" ? walletSigner : receiver;
        if (format === "wallet") await token.connect(receiver).transfer(from, 10n);
        const a = authorization({ from });
        const signature = await signAuthorization(signer, domain, a, receive ? "ReceiveWithAuthorization" : "TransferWithAuthorization");
        const caller = receive ? token.connect(recipient) : token;
        const { v, r, s } = ethers.Signature.from(signature);
        const tx = format === "vrs"
          ? caller[receive ? RECEIVE_VRS : TRANSFER_VRS](...authorizationArgs(a), v, r, s)
          : caller[receive ? RECEIVE_BYTES : TRANSFER_BYTES](...authorizationArgs(a), format === "wallet" ? wrapWalletSignature(signature) : signature);
        await expect(tx).to.emit(token, "AuthorizationUsed").withArgs(from, a.nonce)
          .and.to.emit(token, "Transfer").withArgs(from, a.to, a.value);
        expect(await token.authorizationState(from, a.nonce)).to.equal(true);
        expect(await token.balanceOf(recipient)).to.equal(10n);
        expect(await token.allowance(from, recipient)).to.equal(0n);
        expect(await token.nonces(from)).to.equal(0n);
        expect(await token.totalSupply()).to.equal(supply);
        await expect(caller[receive ? RECEIVE_BYTES : TRANSFER_BYTES](...authorizationArgs(a), signature))
          .to.be.revertedWithCustomError(token, "ERC3009AuthorizationAlreadyUsed");
      });
    }
  }

  for (const format of ["vrs", "bytes", "wallet"] as const) {
    it(`cancels through the ${format} interface and prevents both transfer methods`, async function () {
      const { token, receiver, recipient, wallet, walletSigner, domain, authorization } =
        await networkHelpers.loadFixture(deployTokenFixture);
      const authorizer = format === "wallet" ? await wallet.getAddress() : receiver.address;
      const signer = format === "wallet" ? walletSigner : receiver;
      const a = authorization({ from: authorizer });
      const signature = await signer.signTypedData(domain, cancelTypes, { authorizer, nonce: a.nonce });
      const { v, r, s } = ethers.Signature.from(signature);
      await expect(format === "vrs"
        ? token[CANCEL_VRS](authorizer, a.nonce, v, r, s)
        : token[CANCEL_BYTES](authorizer, a.nonce, format === "wallet" ? wrapWalletSignature(signature) : signature))
        .to.emit(token, "AuthorizationCanceled").withArgs(authorizer, a.nonce);
      expect(await token.authorizationState(authorizer, a.nonce)).to.equal(true);
      await expect(token[TRANSFER_BYTES](...authorizationArgs(a), "0x"))
        .to.be.revertedWithCustomError(token, "ERC3009AuthorizationAlreadyUsed");
      await expect(token.connect(recipient)[RECEIVE_BYTES](...authorizationArgs(a), "0x"))
        .to.be.revertedWithCustomError(token, "ERC3009AuthorizationAlreadyUsed");
      await expect(token[CANCEL_BYTES](authorizer, a.nonce, signature))
        .to.be.revertedWithCustomError(token, "ERC3009AuthorizationAlreadyUsed");
    });
  }

  it("shares used nonce state between both transfer methods and cancellation", async function () {
    const { token, receiver, recipient, domain, authorization } = await networkHelpers.loadFixture(deployTokenFixture);
    const a = authorization();
    await token[TRANSFER_BYTES](...authorizationArgs(a), await signAuthorization(receiver, domain, a));
    await expect(token.connect(recipient)[RECEIVE_BYTES](...authorizationArgs(a), await signAuthorization(receiver, domain, a, "ReceiveWithAuthorization")))
      .to.be.revertedWithCustomError(token, "ERC3009AuthorizationAlreadyUsed");
    await expect(token[CANCEL_BYTES](a.from, a.nonce, "0x"))
      .to.be.revertedWithCustomError(token, "ERC3009AuthorizationAlreadyUsed");
  });

  it("requires the signed payee as the immediate caller for receive authorization", async function () {
    const { token, receiver, recipient, domain, authorization } = await networkHelpers.loadFixture(deployTokenFixture);
    const a = authorization();
    const signature = await signAuthorization(receiver, domain, a, "ReceiveWithAuthorization");
    await expect(token[RECEIVE_BYTES](...authorizationArgs(a), signature))
      .to.be.revertedWithCustomError(token, "ERC3009CallerMustBePayee");
    expect(await token.authorizationState(a.from, a.nonce)).to.equal(false);
    await token.connect(recipient)[RECEIVE_BYTES](...authorizationArgs(a), signature);
  });

  it("allows a relayer to fund a contract deposit atomically through the payee", async function () {
    const { token, receiver, hooks, domain, authorization } = await networkHelpers.loadFixture(deployTokenFixture);
    const a = authorization({ to: await hooks.getAddress() });
    const signature = await signAuthorization(receiver, domain, a, "ReceiveWithAuthorization");
    await expect(token[RECEIVE_BYTES](...authorizationArgs(a), signature))
      .to.be.revertedWithCustomError(token, "ERC3009CallerMustBePayee");
    await hooks.depositWithAuthorization(a.from, a.value, a.validAfter, a.validBefore, a.nonce, signature);
    expect(await hooks.deposits(a.from)).to.equal(a.value);
    expect(await token.balanceOf(a.to)).to.equal(a.value);
  });

  for (const field of ["from", "to", "value", "validAfter", "validBefore", "nonce", "chainId", "verifyingContract", "type"] as const) {
    it(`rejects authorization signed for another ${field}`, async function () {
      const { token, receiver, spender, domain, authorization } = await networkHelpers.loadFixture(deployTokenFixture);
      const a = authorization();
      const signed = { ...a };
      const signedDomain = { ...domain };
      if (field === "from" || field === "to") signed[field] = spender.address;
      else if (field === "nonce") signed.nonce = ethers.ZeroHash;
      else if (field === "chainId") signedDomain.chainId += 1n;
      else if (field === "verifyingContract") signedDomain.verifyingContract = spender.address;
      else if (field !== "type") signed[field] += 1n;
      const signature = await signAuthorization(receiver, signedDomain, signed,
        field === "type" ? "ReceiveWithAuthorization" : "TransferWithAuthorization");
      await expect(token[TRANSFER_BYTES](...authorizationArgs(a), signature))
        .to.be.revertedWithCustomError(token, "ERC3009InvalidSignature");
      expect(await token.authorizationState(a.from, a.nonce)).to.equal(false);
    });
  }

  for (const boundary of ["before", "start", "inside", "end", "after"] as const) {
    it(`enforces the open validity interval at ${boundary}`, async function () {
      const { token, receiver, domain, authorization } = await networkHelpers.loadFixture(deployTokenFixture);
      const start = BigInt(await networkHelpers.time.latest()) + 10n;
      const a = authorization({ validAfter: start, validBefore: start + 10n });
      const signature = await signAuthorization(receiver, domain, a);
      const time = { before: start - 1n, start, inside: start + 1n, end: start + 10n, after: start + 11n }[boundary];
      await networkHelpers.time.setNextBlockTimestamp(time);
      const tx = token[TRANSFER_BYTES](...authorizationArgs(a), signature);
      if (boundary === "inside") await expect(tx).to.emit(token, "AuthorizationUsed");
      else await expect(tx).to.be.revertedWithCustomError(token,
        boundary === "before" || boundary === "start" ? "ERC3009AuthorizationNotYetValid" : "ERC3009AuthorizationExpired");
      expect(await token.authorizationState(a.from, a.nonce)).to.equal(boundary === "inside");
    });
  }

  it("allows unordered authorizations and scopes each nonce to its authorizer", async function () {
    const { token, receiver, recipient, spender, domain, authorization, supply } = await networkHelpers.loadFixture(deployTokenFixture);
    const a = authorization();
    const b = authorization();
    const sigA = await signAuthorization(receiver, domain, a);
    const sigB = await signAuthorization(receiver, domain, b);
    await token[TRANSFER_BYTES](...authorizationArgs(b), sigB);
    await token[TRANSFER_BYTES](...authorizationArgs(a), sigA);
    const c = authorization({ from: recipient.address, to: spender.address, nonce: a.nonce });
    await token[TRANSFER_BYTES](...authorizationArgs(c), await signAuthorization(recipient, domain, c));
    expect(await token.balanceOf(receiver)).to.equal(supply - 20n);
    expect(await token.balanceOf(recipient)).to.equal(10n);
    expect(await token.balanceOf(spender)).to.equal(10n);
    expect(await token.totalSupply()).to.equal(supply);
    expect(await token.nonces(receiver)).to.equal(0n);
  });

  it("rolls back nonce consumption if the transfer fails, allowing a funded retry", async function () {
    const { token, receiver, recipient, spender, domain, authorization } = await networkHelpers.loadFixture(deployTokenFixture);
    const a = authorization({ from: recipient.address, to: spender.address });
    const signature = await signAuthorization(recipient, domain, a);
    await expect(token[TRANSFER_BYTES](...authorizationArgs(a), signature))
      .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    expect(await token.authorizationState(a.from, a.nonce)).to.equal(false);
    await token.connect(receiver).transfer(recipient, a.value);
    await token[TRANSFER_BYTES](...authorizationArgs(a), signature);
    expect(await token.balanceOf(spender)).to.equal(a.value);
  });

  it("rejects zero addresses and malformed signatures without changing authorization state", async function () {
    const { token, receiver, domain, authorization } = await networkHelpers.loadFixture(deployTokenFixture);
    const a = authorization({ to: ethers.ZeroAddress });
    await expect(token[TRANSFER_BYTES](...authorizationArgs(a), await signAuthorization(receiver, domain, a)))
      .to.be.revertedWithCustomError(token, "ERC20InvalidReceiver");
    expect(await token.authorizationState(a.from, a.nonce)).to.equal(false);
    const b = authorization({ from: ethers.ZeroAddress });
    await expect(token[TRANSFER_BYTES](...authorizationArgs(b), "0x"))
      .to.be.revertedWithCustomError(token, "ERC20InvalidSender");
    await expect(token[CANCEL_BYTES](ethers.ZeroAddress, b.nonce, "0x"))
      .to.be.revertedWithCustomError(token, "ERC20InvalidSender");
    const c = authorization();
    await expect(token[TRANSFER_BYTES](...authorizationArgs(c), "0x1234"))
      .to.be.revertedWithCustomError(token, "ERC3009InvalidSignature");
    expect(await token.authorizationState(c.from, c.nonce)).to.equal(false);
  });

  it("requires cancellation to be signed by the correct authorizer for that nonce", async function () {
    const { token, receiver, spender, domain, authorization } = await networkHelpers.loadFixture(deployTokenFixture);
    const a = authorization();
    for (const signature of [
      await spender.signTypedData(domain, cancelTypes, { authorizer: a.from, nonce: a.nonce }),
      await receiver.signTypedData(domain, cancelTypes, { authorizer: a.from, nonce: ethers.ZeroHash }),
      await signAuthorization(receiver, domain, a),
    ]) {
      await expect(token[CANCEL_BYTES](a.from, a.nonce, signature))
        .to.be.revertedWithCustomError(token, "ERC3009InvalidSignature");
    }
    expect(await token.authorizationState(a.from, a.nonce)).to.equal(false);
  });

  for (const mode of [1, 2]) {
    it(`does not consume a nonce when ERC-1271 validation ${mode === 1 ? "fails" : "reverts"}`, async function () {
      const { token, wallet, walletSigner, domain, authorization } = await networkHelpers.loadFixture(deployTokenFixture);
      const a = authorization({ from: await wallet.getAddress() });
      const signature = wrapWalletSignature(await signAuthorization(walletSigner, domain, a));
      const cancellation = wrapWalletSignature(await walletSigner.signTypedData(domain, cancelTypes, { authorizer: a.from, nonce: a.nonce }));
      await wallet.connect(walletSigner).setSignatureMode(mode);
      await expect(token[TRANSFER_BYTES](...authorizationArgs(a), signature))
        .to.be.revertedWithCustomError(token, "ERC3009InvalidSignature");
      await expect(token[CANCEL_BYTES](a.from, a.nonce, cancellation))
        .to.be.revertedWithCustomError(token, "ERC3009InvalidSignature");
      expect(await token.authorizationState(a.from, a.nonce)).to.equal(false);
    });
  }
});
