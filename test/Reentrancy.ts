import { expect } from "chai";
import type { Interface } from "ethers";
import {
  createContext, authorizationArgs, signAuthorization, permitTypes, cancelTypes,
  PERMIT_BYTES, PERMIT_VRS, TRANSFER_BYTES, TRANSFER_VRS, RECEIVE_BYTES, RECEIVE_VRS, CANCEL_BYTES, CANCEL_VRS,
} from "./helpers/token.js";

const { connection, ethers, networkHelpers, deployTokenFixture } = await createContext();
after(async () => connection.close());

type TokenInterface = { interface: Interface };
const ok = (data: string, expectedResult?: string) => ({
  data, expectedSuccess: true, checkResult: expectedResult !== undefined, expectedResult: expectedResult ?? "0x",
});
const fails = (data: string, expectedResult?: string) => ({ ...ok(data, expectedResult), expectedSuccess: false });
const read = (token: TokenInterface, name: string, args: readonly unknown[], result: readonly unknown[]) =>
  ok(token.interface.encodeFunctionData(name, args), token.interface.encodeFunctionResult(name, result));
const error = (token: TokenInterface, name: string, args: readonly unknown[]) =>
  token.interface.encodeErrorResult(name, args);

async function reentrancyFixture() {
  const base = await deployTokenFixture();
  const tokenAddress = await base.token.getAddress();
  const callback = await ethers.deployContract("ReentrantCallbacksMock", [tokenAddress]);
  const nested = await ethers.deployContract("ReentrantCallbacksMock", [tokenAddress]);
  const signatureWallet = await ethers.deployContract("ReentrantSignatureWalletMock", [tokenAddress]);
  const callbackAddress = await callback.getAddress();
  const nestedAddress = await nested.getAddress();
  const signatureWalletAddress = await signatureWallet.getAddress();
  const abi: Interface = base.token.interface;
  const encode = (name: string, args: readonly unknown[] = []) => abi.encodeFunctionData(name, args);
  return { ...base, callback, nested, signatureWallet, callbackAddress, nestedAddress, signatureWalletAddress, encode };
}

async function signatureAttackFixture() {
  const f = await reentrancyFixture();
  const { token, receiver, recipient, spender, signatureWalletAddress, callbackAddress, encode, domain, deadline, authorization } = f;
  await token.connect(receiver).transfer(signatureWalletAddress, 20n);
  await token.connect(receiver).approve(signatureWalletAddress, 20n);
  const permit = ethers.Signature.from(await receiver.signTypedData(domain, permitTypes,
    { owner: receiver.address, spender: spender.address, value: 1n, nonce: 0n, deadline }));
  const a = authorization();
  const receive = authorization({ to: signatureWalletAddress });
  const transferSig = ethers.Signature.from(await signAuthorization(receiver, domain, a));
  const receiveSig = ethers.Signature.from(await signAuthorization(receiver, domain, receive, "ReceiveWithAuthorization"));
  const cancel = authorization();
  const cancelSig = ethers.Signature.from(await receiver.signTypedData(domain, cancelTypes,
    { authorizer: receiver.address, nonce: cancel.nonce }));
  const permitArgs = [receiver.address, spender.address, 1n, deadline];
  const actions = [
    ["approve(address,uint256)", [spender.address, 1n]],
    ["transfer(address,uint256)", [recipient.address, 1n]],
    ["transferFrom(address,address,uint256)", [receiver.address, recipient.address, 1n]],
    [PERMIT_BYTES, [...permitArgs, permit.serialized]],
    [PERMIT_VRS, [...permitArgs, permit.v, permit.r, permit.s]],
    [TRANSFER_BYTES, [...authorizationArgs(a), transferSig.serialized]],
    [TRANSFER_VRS, [...authorizationArgs(a), transferSig.v, transferSig.r, transferSig.s]],
    [RECEIVE_BYTES, [...authorizationArgs(receive), receiveSig.serialized]],
    [RECEIVE_VRS, [...authorizationArgs(receive), receiveSig.v, receiveSig.r, receiveSig.s]],
    [CANCEL_BYTES, [receiver.address, cancel.nonce, cancelSig.serialized]],
    [CANCEL_VRS, [receiver.address, cancel.nonce, cancelSig.v, cancelSig.r, cancelSig.s]],
    ["transferAndCall(address,uint256)", [callbackAddress, 1n]],
    ["transferAndCall(address,uint256,bytes)", [callbackAddress, 1n, "0x1234"]],
    ["transferFromAndCall(address,address,uint256)", [receiver.address, callbackAddress, 1n]],
    ["transferFromAndCall(address,address,uint256,bytes)", [receiver.address, callbackAddress, 1n, "0x1234"]],
    ["approveAndCall(address,uint256)", [callbackAddress, 1n]],
    ["approveAndCall(address,uint256,bytes)", [callbackAddress, 1n, "0x1234"]],
  ] satisfies [string, unknown[]][];
  return { ...f, actions: actions.map(([name, args]) => ({ name, data: encode(name, args) })), a, receive, cancel };
}

describe("Token: adversarial reentrancy review", function () {
  for (const withData of [false, true]) {
    it(`keeps balances coherent when transferAndCall${withData ? "(data)" : ""} reenters`, async function () {
      const { token, receiver, recipient, supply, callback, callbackAddress, encode } =
        await networkHelpers.loadFixture(reentrancyFixture);
      await callback.configure([
        read(token, "balanceOf", [receiver.address], [supply - 100n]),
        read(token, "balanceOf", [callbackAddress], [100n]),
        fails(encode("transferFrom", [receiver.address, recipient.address, 1n]),
          error(token, "ERC20InsufficientAllowance", [callbackAddress, 0n, 1n])),
        fails(encode("transfer", [recipient.address, 101n]),
          error(token, "ERC20InsufficientBalance", [callbackAddress, 100n, 101n])),
        ok(encode("transfer", [recipient.address, 40n])),
        read(token, "balanceOf", [callbackAddress], [60n]),
        read(token, "balanceOf", [recipient.address], [40n]),
      ]);
      if (withData) await token.connect(receiver)["transferAndCall(address,uint256,bytes)"](callbackAddress, 100n, "0x1234");
      else await token.connect(receiver)["transferAndCall(address,uint256)"](callbackAddress, 100n);
      expect(await token.balanceOf(receiver)).to.equal(supply - 100n);
      expect(await token.balanceOf(callbackAddress)).to.equal(60n);
      expect(await token.balanceOf(recipient)).to.equal(40n);
      expect(await token.totalSupply()).to.equal(supply);
      expect(await callback.callbackCount()).to.equal(1n);
    });

    it(`spends allowance before transferFromAndCall${withData ? "(data)" : ""} can reenter`, async function () {
      const { token, receiver, recipient, supply, callback, callbackAddress, encode } =
        await networkHelpers.loadFixture(reentrancyFixture);
      await token.connect(receiver).approve(callbackAddress, 120n);
      await callback.configure([
        read(token, "allowance", [receiver.address, callbackAddress], [20n]),
        read(token, "balanceOf", [callbackAddress], [100n]),
        read(token, "balanceOf", [receiver.address], [supply - 100n]),
        fails(encode("transferFrom", [receiver.address, recipient.address, 21n]),
          error(token, "ERC20InsufficientAllowance", [callbackAddress, 20n, 21n])),
        ok(encode("transferFrom", [receiver.address, recipient.address, 20n])),
        fails(encode("transferFrom", [receiver.address, recipient.address, 1n]),
          error(token, "ERC20InsufficientAllowance", [callbackAddress, 0n, 1n])),
        read(token, "allowance", [receiver.address, callbackAddress], [0n]),
      ]);
      await callback.execute(encode(withData
        ? "transferFromAndCall(address,address,uint256,bytes)" : "transferFromAndCall(address,address,uint256)",
      withData ? [receiver.address, callbackAddress, 100n, "0x1234"] : [receiver.address, callbackAddress, 100n]));
      expect(await token.balanceOf(receiver)).to.equal(supply - 120n);
      expect(await token.balanceOf(callbackAddress)).to.equal(100n);
      expect(await token.balanceOf(recipient)).to.equal(20n);
      expect(await token.allowance(receiver, callbackAddress)).to.equal(0n);
      expect(await token.totalSupply()).to.equal(supply);
    });

    it(`does not restore a spent allowance after approveAndCall${withData ? "(data)" : ""} returns`, async function () {
      const { token, receiver, recipient, supply, callback, callbackAddress, encode } =
        await networkHelpers.loadFixture(reentrancyFixture);
      await callback.configure([
        read(token, "allowance", [receiver.address, callbackAddress], [100n]),
        read(token, "balanceOf", [receiver.address], [supply]),
        ok(encode("transferFrom", [receiver.address, recipient.address, 40n])),
        read(token, "allowance", [receiver.address, callbackAddress], [60n]),
        ok(encode("transferFrom", [receiver.address, recipient.address, 60n])),
        fails(encode("transferFrom", [receiver.address, recipient.address, 1n]),
          error(token, "ERC20InsufficientAllowance", [callbackAddress, 0n, 1n])),
      ]);
      if (withData) await token.connect(receiver)["approveAndCall(address,uint256,bytes)"](callbackAddress, 100n, "0x1234");
      else await token.connect(receiver)["approveAndCall(address,uint256)"](callbackAddress, 100n);
      expect(await token.allowance(receiver, callbackAddress)).to.equal(0n);
      expect(await token.balanceOf(receiver)).to.equal(supply - 100n);
      expect(await token.balanceOf(recipient)).to.equal(100n);
      expect(await token.totalSupply()).to.equal(supply);
    });
  }

  it("preserves balances across three nested callback levels", async function () {
    const { token, receiver, recipient, supply, callback, nested, callbackAddress, nestedAddress, encode } =
      await networkHelpers.loadFixture(reentrancyFixture);
    await nested.configure([
      read(token, "balanceOf", [nestedAddress], [70n]),
      ok(encode("transferAndCall(address,uint256)", [callbackAddress, 20n])),
      read(token, "balanceOf", [callbackAddress], [50n]),
    ]);
    await callback.configure([
      ok(encode("transferAndCall(address,uint256)", [nestedAddress, 70n])),
      read(token, "balanceOf", [callbackAddress], [50n]),
      fails(encode("transfer", [recipient.address, 51n]),
        error(token, "ERC20InsufficientBalance", [callbackAddress, 50n, 51n])),
      ok(encode("transfer", [recipient.address, 50n])),
      read(token, "balanceOf", [callbackAddress], [0n]),
    ]);
    await token.connect(receiver)["transferAndCall(address,uint256)"](callbackAddress, 100n);
    expect(await callback.callbackCount()).to.equal(2n);
    expect(await nested.callbackCount()).to.equal(1n);
    expect(await token.balanceOf(callbackAddress)).to.equal(0n);
    expect(await token.balanceOf(nestedAddress)).to.equal(50n);
    expect(await token.balanceOf(recipient)).to.equal(50n);
    expect(await token.balanceOf(receiver)).to.equal(supply - 100n);
    expect(await token.totalSupply()).to.equal(supply);
  });

  for (const method of ["transferAndCall(address,uint256)", "approveAndCall(address,uint256)"] as const) {
    for (const response of [1, 2]) {
      it(`rolls back nested transfers and signatures when ${method} ${response === 1 ? "returns bad magic" : "reverts"}`, async function () {
        const { token, receiver, recipient, supply, callback, callbackAddress, encode, domain, deadline, authorization } =
          await networkHelpers.loadFixture(reentrancyFixture);
        await token.connect(receiver).approve(callbackAddress, 7n);
        const payment = authorization();
        const cancellation = authorization();
        const permit = await receiver.signTypedData(domain, permitTypes,
          { owner: receiver.address, spender: callbackAddress, value: 50n, nonce: 0n, deadline });
        const cancel = await receiver.signTypedData(domain, cancelTypes, { authorizer: receiver.address, nonce: cancellation.nonce });
        await callback.configure([
          ok(encode(PERMIT_BYTES, [receiver.address, callbackAddress, 50n, deadline, permit])),
          ok(encode("transferFrom", [receiver.address, recipient.address, 50n])),
          ok(encode(TRANSFER_BYTES, [...authorizationArgs(payment), await signAuthorization(receiver, domain, payment)])),
          ok(encode(CANCEL_BYTES, [receiver.address, cancellation.nonce, cancel])),
          read(token, "nonces", [receiver.address], [1n]),
          read(token, "authorizationState", [receiver.address, payment.nonce], [true]),
        ]);
        await callback.setResponse(response);
        const tx = token.connect(receiver)[method](callbackAddress, 10n);
        if (response === 2) await expect(tx).to.be.revertedWithCustomError(callback, "CallbackRejected");
        else await expect(tx).to.be.revertedWithCustomError(token,
          method.startsWith("transfer") ? "ERC1363InvalidReceiver" : "ERC1363InvalidSpender");
        expect(await token.balanceOf(receiver)).to.equal(supply);
        expect(await token.balanceOf(recipient)).to.equal(0n);
        expect(await token.balanceOf(callbackAddress)).to.equal(0n);
        expect(await token.allowance(receiver, callbackAddress)).to.equal(7n);
        expect(await token.nonces(receiver)).to.equal(0n);
        expect(await token.authorizationState(receiver, payment.nonce)).to.equal(false);
        expect(await token.authorizationState(receiver, cancellation.nonce)).to.equal(false);
        expect(await callback.callbackCount()).to.equal(0n);
        expect(await token.totalSupply()).to.equal(supply);
      });
    }
  }

  it("enforces shared permit nonces across overloads during a callback", async function () {
    const { token, receiver, recipient, callback, callbackAddress, encode, domain, deadline, supply } =
      await networkHelpers.loadFixture(reentrancyFixture);
    const permit = await receiver.signTypedData(domain, permitTypes,
      { owner: receiver.address, spender: callbackAddress, value: 20n, nonce: 0n, deadline });
    const p = ethers.Signature.from(permit);
    const nextPermit = await receiver.signTypedData(domain, permitTypes,
      { owner: receiver.address, spender: callbackAddress, value: 10n, nonce: 1n, deadline });
    const next = ethers.Signature.from(nextPermit);
    await callback.configure([
      ok(encode(PERMIT_BYTES, [receiver.address, callbackAddress, 20n, deadline, permit])),
      ok(encode("transferFrom", [receiver.address, recipient.address, 20n])),
      fails(encode(PERMIT_VRS, [receiver.address, callbackAddress, 20n, deadline, p.v, p.r, p.s])),
      ok(encode(PERMIT_VRS, [receiver.address, callbackAddress, 10n, deadline, next.v, next.r, next.s])),
      ok(encode("transferFrom", [receiver.address, recipient.address, 10n])),
      fails(encode(PERMIT_BYTES, [receiver.address, callbackAddress, 10n, deadline, nextPermit]),
        error(token, "ERC7597InvalidSignature", [receiver.address])),
      read(token, "nonces", [receiver.address], [2n]),
      read(token, "allowance", [receiver.address, callbackAddress], [0n]),
    ]);
    await token.connect(receiver)["transferAndCall(address,uint256)"](callbackAddress, 1n);
    expect(await token.nonces(receiver)).to.equal(2n);
    expect(await token.balanceOf(receiver)).to.equal(supply - 31n);
    expect(await token.balanceOf(recipient)).to.equal(30n);
    expect(await token.balanceOf(callbackAddress)).to.equal(1n);
    expect(await token.totalSupply()).to.equal(supply);
  });

  for (const kind of ["transfer", "receive", "cancel"] as const) {
    it(`rejects ERC-3009 replay and cross-function reuse after a nested ${kind}`, async function () {
      const { token, receiver, recipient, callback, callbackAddress, encode, domain, authorization, supply } =
        await networkHelpers.loadFixture(reentrancyFixture);
      const a = authorization({ to: callbackAddress });
      const signature = await signAuthorization(receiver, domain, a,
        kind === "receive" ? "ReceiveWithAuthorization" : "TransferWithAuthorization");
      const { v, r, s } = ethers.Signature.from(signature);
      const cancel = await receiver.signTypedData(domain, cancelTypes, { authorizer: receiver.address, nonce: a.nonce });
      const first = kind === "cancel" ? encode(CANCEL_BYTES, [receiver.address, a.nonce, cancel])
        : encode(kind === "receive" ? RECEIVE_BYTES : TRANSFER_BYTES, [...authorizationArgs(a), signature]);
      const used = error(token, "ERC3009AuthorizationAlreadyUsed", [receiver.address, a.nonce]);
      await callback.configure([
        ok(first),
        fails(first, used),
        fails(encode(TRANSFER_VRS, [...authorizationArgs(a), v, r, s]), used),
        fails(encode(RECEIVE_VRS, [...authorizationArgs(a), v, r, s]), used),
        fails(encode(CANCEL_BYTES, [receiver.address, a.nonce, cancel]), used),
        read(token, "authorizationState", [receiver.address, a.nonce], [true]),
      ]);
      await token.connect(receiver)["transferAndCall(address,uint256)"](callbackAddress, 1n);
      const moved = kind === "cancel" ? 1n : 11n;
      expect(await token.balanceOf(receiver)).to.equal(supply - moved);
      expect(await token.balanceOf(callbackAddress)).to.equal(moved);
      expect(await token.balanceOf(recipient)).to.equal(0n);
      expect(await token.nonces(receiver)).to.equal(0n);
      expect(await token.totalSupply()).to.equal(supply);
    });
  }

  it("uses valid attack payloads covering every state-changing token entry point", async function () {
    const { token, signatureWallet, actions } = await networkHelpers.loadFixture(signatureAttackFixture);
    const abi: Interface = token.interface;
    const mutable = abi.fragments.filter(fragment => fragment.type === "function")
      .map(fragment => abi.getFunction(fragment.format("sighash"))!)
      .filter(fragment => !["view", "pure"].includes(fragment.stateMutability))
      .map(fragment => fragment.format("sighash"));
    expect(actions.map(action => action.name).sort()).to.deep.equal(mutable.sort());
    // A successful ordinary call is the positive control for every rejected reentry.
    // Restore between controls: they share the same valid signatures and nonce zero.
    for (const action of actions) {
      const snapshot = await networkHelpers.takeSnapshot();
      await signatureWallet.execute(action.data, { gasLimit: 1_000_000 });
      await snapshot.restore();
    }
  });

  for (const outer of ["permit", "transfer-bytes", "transfer-vrs", "receive-bytes", "receive-vrs", "cancel-bytes", "cancel-vrs"] as const) {
    it(`blocks all 17 state-changing reentries during ERC-1271 validation of ${outer}`, async function () {
      const { token, receiver, recipient, spender, supply, signatureWallet, signatureWalletAddress, actions,
        callback, a: nestedTransfer, receive: nestedReceive, cancel: nestedCancel, authorization, encode, domain, deadline } =
        await networkHelpers.loadFixture(signatureAttackFixture);
      const a = authorization({ from: signatureWalletAddress });
      const isPermit = outer === "permit";
      const isCancel = outer.startsWith("cancel");
      const isReceive = outer.startsWith("receive");
      const isVrs = outer.endsWith("vrs");
      const signature = isVrs ? ethers.concat([ethers.ZeroHash, ethers.ZeroHash, "0x1b"]) : "0x1234";
      let digest: string;
      let data: string;
      if (isPermit) {
        digest = ethers.TypedDataEncoder.hash(domain, permitTypes,
          { owner: signatureWalletAddress, spender: spender.address, value: 7n, nonce: 0n, deadline });
        data = encode(PERMIT_BYTES, [signatureWalletAddress, spender.address, 7n, deadline, signature]);
      } else if (isCancel) {
        digest = ethers.TypedDataEncoder.hash(domain, cancelTypes, { authorizer: signatureWalletAddress, nonce: a.nonce });
        data = encode(isVrs ? CANCEL_VRS : CANCEL_BYTES, isVrs
          ? [signatureWalletAddress, a.nonce, 27, ethers.ZeroHash, ethers.ZeroHash]
          : [signatureWalletAddress, a.nonce, signature]);
      } else {
        const typeHash = isReceive ? await token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH() : await token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH();
        const structHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
          [typeHash, ...authorizationArgs(a)],
        ));
        digest = ethers.keccak256(ethers.concat(["0x1901", ethers.TypedDataEncoder.hashDomain(domain), structHash]));
        data = encode(isReceive ? (isVrs ? RECEIVE_VRS : RECEIVE_BYTES) : (isVrs ? TRANSFER_VRS : TRANSFER_BYTES),
          [...authorizationArgs(a), ...(isVrs ? [27, ethers.ZeroHash, ethers.ZeroHash] : [signature])]);
      }
      await signatureWallet.configureSignature(digest, signature, false);
      await signatureWallet.configure([
        // Read-only reentry is possible: permit has consumed its nonce, but its
        // allowance is not written yet. Authorization validation precedes consumption.
        read(token, "nonces", [signatureWalletAddress], [isPermit ? 1n : 0n]),
        read(token, "allowance", [signatureWalletAddress, spender.address], [0n]),
        read(token, "authorizationState", [signatureWalletAddress, a.nonce], [false]),
        read(token, "balanceOf", [signatureWalletAddress], [20n]),
        ...actions.map(action => fails(action.data, "0x")),
      ]);
      // Each exceptional write burns its subcall gas. This explicit local gas
      // budget ensures the wallet can finish the entire 17-entry attack matrix.
      await recipient.sendTransaction({ to: await token.getAddress(), data, gasLimit: 8_000_000 });
      expect(await token.nonces(signatureWalletAddress)).to.equal(isPermit ? 1n : 0n);
      expect(await token.allowance(signatureWalletAddress, spender)).to.equal(isPermit ? 7n : 0n);
      expect(await token.authorizationState(signatureWalletAddress, a.nonce)).to.equal(!isPermit);
      expect(await token.balanceOf(signatureWalletAddress)).to.equal(isPermit || isCancel ? 20n : 10n);
      expect(await token.balanceOf(recipient)).to.equal(isPermit || isCancel ? 0n : 10n);
      expect(await token.balanceOf(receiver)).to.equal(supply - 20n);
      expect(await token.nonces(receiver)).to.equal(0n);
      expect(await token.allowance(receiver, signatureWalletAddress)).to.equal(20n);
      expect(await token.allowance(receiver, spender)).to.equal(0n);
      for (const nested of [nestedTransfer, nestedReceive, nestedCancel]) {
        expect(await token.authorizationState(receiver, nested.nonce)).to.equal(false);
      }
      expect(await callback.callbackCount()).to.equal(0n);
      expect(await token.totalSupply()).to.equal(supply);
    });
  }

  it("rolls back the permit nonce if a reentering signature wallet rejects validation", async function () {
    const { token, signatureWallet, signatureWalletAddress, spender, actions, domain, deadline } =
      await networkHelpers.loadFixture(signatureAttackFixture);
    const digest = ethers.TypedDataEncoder.hash(domain, permitTypes,
      { owner: signatureWalletAddress, spender: spender.address, value: 7n, nonce: 0n, deadline });
    await signatureWallet.configureSignature(digest, "0x1234", true);
    await signatureWallet.configure([
      read(token, "nonces", [signatureWalletAddress], [1n]),
      fails(actions.find(action => action.name === "transfer(address,uint256)")!.data, "0x"),
    ]);
    await expect(token[PERMIT_BYTES](signatureWalletAddress, spender.address, 7n, deadline, "0x1234"))
      .to.be.revertedWithCustomError(token, "ERC7597InvalidSignature");
    expect(await token.nonces(signatureWalletAddress)).to.equal(0n);
    expect(await token.allowance(signatureWalletAddress, spender)).to.equal(0n);
    expect(await token.balanceOf(signatureWalletAddress)).to.equal(20n);
  });
});
