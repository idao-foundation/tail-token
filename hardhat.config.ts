import "dotenv/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: "0.8.38",
    settings: {
      // BSC supports Cancun, required by the installed OpenZeppelin EIP-712 utilities.
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    local: {
      type: "edr-simulated",
      chainType: "generic",
      chainId: 31337,
      hardfork: "cancun",
    },
    bsc: {
      type: "http",
      chainType: "generic",
      chainId: 56,
      url: process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org",
      // The deployment script loads, validates, and uses its own ethers Wallet.
      accounts: [],
    },
  },
  typechain: {
    outDir: "types/ethers-contracts",
  },
});
