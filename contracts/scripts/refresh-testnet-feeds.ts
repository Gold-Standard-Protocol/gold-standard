import { ethers, network } from "hardhat";
import { resolvePriceUsd8 } from "./lib/marketGoldPrice";
import { describeErrorStack } from "./lib/redact";

/**
 * Re-stamp the mock aggregators so a testnet soak does not go stale.
 *
 * GoldOracle rejects any round older than stalenessThreshold (90000s = 25h).
 * Real Chainlink feeds heartbeat on their own; the Sepolia mocks do not, so
 * every read starts reverting "No reliable price" a day after deployment and the
 * whole system looks broken for a reason that is purely a test artefact.
 * Run this on a schedule (or before each soak session).
 *
 * Optionally moves the price to exercise real behaviour:
 *   PRICE_USD=3800 npx hardhat run scripts/refresh-testnet-feeds.ts --network sepolia
 *
 * All three feeds take the same price, a gold-wide move, so the oracle prices it at once;
 * use walk-testnet-price.ts for a gradual move a running keeper can follow.
 */
async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId === 1) {
    throw new Error("Refusing to write mock prices on mainnet.");
  }

  const labels = ["PAXG_FEED", "XAUT_FEED", "XAU_USD_ANCHOR_FEED"] as const;
  // PRICE_USD=market re-stamps at the live PAXG price (walk-testnet-price.ts walks gradually).
  const priceUsd = process.env.PRICE_USD;
  const marketPrice = priceUsd ? await resolvePriceUsd8(priceUsd) : undefined;
  const now = Math.floor(Date.now() / 1000);

  console.log(`Network: ${network.name}\n`);

  for (const label of labels) {
    const addr = process.env[label];
    if (!addr) {
      console.log(`${label}: unset, skipping`);
      continue;
    }
    const feed = await ethers.getContractAt("MockAggregatorV3", addr);
    const current = await feed.latestRoundData();
    const answer = marketPrice ?? (current[1] as bigint);
    const roundId = (current[0] as bigint) + 1n;
    await (
      await feed.setLatestRoundData(roundId, answer, now, now, roundId)
    ).wait();
    console.log(
      `${label} round ${roundId} @ $${ethers.formatUnits(answer, 8)} (updatedAt ${now})`
    );
  }

  console.log(
    "\nAll three feeds share a price, so every token stays inside its gold band of XAU/USD."
  );
}

main().catch((error) => {
  console.error(describeErrorStack(error));
  process.exitCode = 1;
});
