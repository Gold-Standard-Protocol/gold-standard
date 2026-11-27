import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-gas-reporter";
import "solidity-coverage";

// `research/` holds contracts that are compiled and tested but never deployed by the
// production scripts (see research/README.md). They sit outside `src` so the deployable
// tree is exactly `src`, and are added to the compilation here so their tests, and the
// preflight tests that prove such a feed is refused, can still build them by name.
const solidityFilesUnder = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return solidityFilesUnder(path);
        return entry.name.endsWith(".sol") ? [path] : [];
      })
    : [];

subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS).setAction(async (_args, hre, runSuper) => {
  const sources: string[] = await runSuper();
  return [...sources, ...solidityFilesUnder(join(hre.config.paths.root, "research"))];
});

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.38",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    // The in-process network `hardhat test` uses. E2E_NODE_CHAIN_ID lets `npx hardhat node`
    // present another chain id: the dapp end-to-end suite (apps/dapp-e2e) runs the node
    // as 11155111 so the dapp, which knows only Sepolia and mainnet, treats it as Sepolia.
    // Namespaced so nothing else in a shell can change what `hardhat test` runs against.
    hardhat: {
      chainId: Number(process.env.E2E_NODE_CHAIN_ID ?? 31337),
      // Fusaka caps a transaction at 2^24 gas. EDR's estimator probes up to the block gas
      // limit when its first guess fails (a vault close refunds so much that the guess is a
      // third of the real need), and a probe above the cap is rejected as "transaction gas
      // limit greater than the cap" on a Sepolia fork. A fork node therefore runs with the
      // block limit at the cap so every probe is legal. Only for `hardhat node --fork`: the
      // in-process test network keeps its default, since the same-block accrual tests stall
      // under the lower limit.
      ...(process.argv.includes("--fork") ? { blockGasLimit: 16_777_216 } : {}),
    },
    // Local ceremony rehearsal. Runs the REAL deploy.ts / verify-deployment.ts
    // against a throwaway chain (`npx hardhat node`) so the whole ceremony is
    // proven before any testnet ETH is spent. Accounts come from the node's
    // own unlocked set, so no key is ever configured here.
    localhost: {
      url: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
      chainId: 31337,
      // Estimates are taken against the pending block and the fee accrues before the
      // transaction lands; the buffer is refunded when unused (see rehearse-testnet-flow.ts).
      gasMultiplier: 1.3,
      // A fork of a public network warms its cache on the first state-changing calls, which
      // means thousands of header and storage fetches from a rate-limited gateway. One request
      // can take minutes before the fork answers, and the default 40 s client timeout turns
      // that warm-up into a spurious HeadersTimeoutError (seen on the attack drill).
      timeout: 600_000,
    },
    // The dapp end-to-end node: `E2E_NODE_CHAIN_ID=11155111 npx hardhat node --port 8546`,
    // driven by apps/dapp-e2e/tools/up.mjs. Accounts are the node's own unlocked set, so
    // the deployer and the test wallet both sign without any key being configured.
    e2e: {
      url: process.env.E2E_RPC_URL || "http://127.0.0.1:8546",
      chainId: 11155111,
    },
    sepolia: {
      url: process.env.RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 11155111,
      gasMultiplier: 1.3,
    },
    mainnet: {
      url: process.env.RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 1,
      // As on sepolia: an estimate taken a block early can fall short once fees accrue, and
      // the vault's registry hook refuses a call left with too little gas.
      // Unused gas is refunded.
      gasMultiplier: 1.3,
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    outputFile: process.env.GAS_REPORT_FILE || undefined,
    noColors: !!process.env.GAS_REPORT_FILE,
    excludeContracts: ["MockAggregatorV3", "MockERC20"],
  },
};

export default config;
