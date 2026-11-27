import { ethers, network } from "hardhat";
import { describeErrorStack } from "./lib/redact";

/**
 * Testnet mock deployment (Sepolia dry-run only).
 *
 * Sepolia has no real PAXG or XAUT and no gold Chainlink feeds, so the dry-run
 * needs its own tokens and aggregators before `deploy.ts` can run. This script
 * deploys them and prints the exact env block to paste into
 * `contracts/.env.sepolia`, matching docs/DEPLOYMENT_RUNBOOK.md section 1.1.
 *
 * Deployed here:
 *   - MockERC20 "Pax Gold" (PAXG), 18 decimals   — mirrors mainnet PAXG
 *   - MockERC20 "Tether Gold" (XAUT), 6 decimals — mirrors mainnet XAUT
 *   - MockAggregatorV3 x3, all 8 decimals        — PAXG/USD, XAUT/USD, XAU/USD anchor
 *
 * All three feeds are seeded at the same price so PAXG and XAUT sit inside their gold
 * band of XAU/USD from the first read. `refresh-testnet-feeds.ts` re-stamps their
 * timestamps, which the 25h staleness bound requires during a multi-day soak.
 *
 * HARD REFUSAL ON MAINNET. Mock collateral on mainnet would be a fake-gold
 * stablecoin; the guard is not a convenience.
 */

// $4,000/oz in 8 decimals. Gold's actual level matters far less than all three
// feeds agreeing, which is what keeps the anchor cross-check happy.
const INITIAL_GOLD_PRICE = 400_000_000_000n;

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId === 1) {
    throw new Error(
      "Refusing to deploy mock gold tokens to mainnet. This script is for the Sepolia dry-run only."
    );
  }

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Network:  ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH\n`);
  if (balance === 0n) {
    throw new Error(
      "Deployer has zero ETH. Fund it from a Sepolia faucet before deploying."
    );
  }

  const MockToken = await ethers.getContractFactory("MockERC20");
  const MockAgg = await ethers.getContractFactory("MockAggregatorV3");

  console.log("--- Mock collateral tokens ---");
  const paxg = await MockToken.deploy("Pax Gold", "PAXG", 18);
  await paxg.waitForDeployment();
  console.log("PAXG (18 dec):", await paxg.getAddress());

  const xaut = await MockToken.deploy("Tether Gold", "XAUT", 6);
  await xaut.waitForDeployment();
  console.log("XAUT (6 dec):", await xaut.getAddress());

  console.log("\n--- Mock Chainlink aggregators (8 decimals) ---");
  const feeds: Record<string, string> = {};
  for (const label of ["PAXG_FEED", "XAUT_FEED", "XAU_USD_ANCHOR_FEED"]) {
    const feed = await MockAgg.deploy(8);
    await feed.waitForDeployment();
    const now = Math.floor(Date.now() / 1000);
    // roundId, answer, startedAt, updatedAt, answeredInRound — answeredInRound
    // must be >= roundId or GoldOracle rejects the round as stale.
    await (await feed.setLatestRoundData(1, INITIAL_GOLD_PRICE, now, now, 1)).wait();
    feeds[label] = await feed.getAddress();
    console.log(`${label}:`, feeds[label]);
  }

  console.log("\n=== Paste into contracts/.env.sepolia ===\n");
  console.log(`PAXG_TOKEN=${await paxg.getAddress()}`);
  console.log(`XAUT_TOKEN=${await xaut.getAddress()}`);
  console.log(`PAXG_FEED=${feeds['PAXG_FEED']}`);
  console.log(`XAUT_FEED=${feeds['XAUT_FEED']}`);
  console.log(`XAU_USD_ANCHOR_FEED=${feeds['XAU_USD_ANCHOR_FEED']}`);
  console.log(`
# The guarded testnet profile: ceilings stay at ZERO through deploy and are raised
# via the timelock. Mainnet uses LAUNCH_CAPS=open instead (docs/MAINNET.md); to
# rehearse open, unset these ceilings and the XAUT lines (docs/DEPLOYMENT_RUNBOOK.md 1.1).
PAXG_DEBT_CEILING=0
XAUT_DEBT_CEILING=0
STALENESS_THRESHOLD=90000
SILO_CAP=100000000000000000000
MIN_GSUSD_RESERVE=0
`);
  console.log("=== Also paste into your dapp .env (apps/dapp/.env.local) ===\n");
  console.log("VITE_TARGET_CHAIN_ID=11155111");
  console.log("# The remaining VITE_* addresses come from deploy.ts output.\n");

  console.log(
    "Mint test collateral to any address with:\n" +
      `  npx hardhat run scripts/mint-testnet-collateral.ts --network ${network.name}\n`
  );
}

main().catch((error) => {
  console.error(describeErrorStack(error));
  process.exitCode = 1;
});
