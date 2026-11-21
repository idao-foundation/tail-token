import { expect } from "chai";
import { artifacts } from "hardhat";

function withoutInternalTypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutInternalTypes);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      // Compare the wire ABI rather than Solidity-only type annotations.
      .filter(([key]) => key !== "internalType")
      .map(([key, item]) => [key, withoutInternalTypes(item)]));
  }
  return value;
}

function entries(abi: readonly { type: string }[], kind: string) {
  return abi.filter(item => item.type === kind)
    .map(item => JSON.stringify(withoutInternalTypes(item)))
    .sort();
}

describe("IToken: standalone interface matches the deployed ABI", function () {
  for (const kind of ["function", "event", "error"] as const) {
    it(`matches every ${kind}, including types, names, mutability and indexing`, async function () {
      const [token, tokenInterface] = await Promise.all([
        artifacts.readArtifact("Token"),
        artifacts.readArtifact("IToken"),
      ]);
      expect(entries(tokenInterface.abi, kind)).to.deep.equal(entries(token.abi, kind));
    });
  }
});
