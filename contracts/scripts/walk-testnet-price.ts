/**
 * Testnet only: walk the mock gold price to a target in oracle-safe steps.
 *
 * The three mock feeds move together, so every step is a gold-wide move that keeps PAXG
 * and XAUT inside their gold band and the oracle prices it at once, whatever its size.
 * The walk still goes in steps of at most 9% so a running keeper sees the fall gradually,
 * as it would on a real market; it pokes the oracle after each step so lastKnownPrice
 * follows, and prints the ratio of any vaults you care about, which is how a liquidation
 * rehearsal is set up on Sepolia.
 *
 *   TARGET_PRICE_USD=2800 WATCH_VAULTS=0xabc,0xdef \
 *     npx hardhat run scripts/walk-testnet-price.ts --network sepolia
 *
 * TARGET_PRICE_USD=market tracks the live PAXG price from CoinGecko, which is how the
 * Sepolia oracle is kept in line with real gold between sessions.
 */
import { ethers, network } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePriceUsd8 } from "./lib/marketGoldPrice";
import { describeErrorStack } from "./lib/redact";
import { refuseOnMainnet } from "./lib/testnetGuard";

const MAX_STEP_BPS = 900n; // 9% per step: a gradual walk the keeper can follow

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  refuseOnMainnet(chainId, network.name, "Refusing to write mock prices on mainnet.");
  // TARGET_PRICE_USD=market walks the mocks to the live PAXG price (CoinGecko).
  const target = await resolvePriceUsd8(process.env.TARGET_PRICE_USD);
  const snap = JSON.parse(readFileSync(resolve(__dirname, "../deployments", `${network.name}.json`), "utf8"));
  const watch = (process.env.WATCH_VAULTS ?? "").split(",").map((a) => a.trim()).filter(Boolean);

  const feeds = await Promise.all(
    [snap.config.paxgFeed, snap.config.xautFeed, snap.config.anchorFeed]
      .filter(Boolean)
      .map((addr: string) => ethers.getContractAt("MockAggregatorV3", addr))
  );
  const oracle = await ethers.getContractAt("GoldOracle", snap.addresses.oracle);
  const vault = await ethers.getContractAt("GoldVault", snap.addresses.vault);
  const tokens = [snap.config.paxgToken, snap.config.xautToken].filter(Boolean) as string[];

  let price = (await feeds[0].latestRoundData())[1] as bigint;
  console.log(`Network ${network.name}: $${ethers.formatUnits(price, 8)} -> $${ethers.formatUnits(target, 8)}`);

  const report = async () => {
    for (const owner of watch) {
      const ratio = await vault.getCollateralisationRatio(owner);
      const shown = ratio > 10n ** 12n ? "no debt" : `${(Number(ratio) / 10_000).toFixed(2)}%`;
      console.log(`    ${owner.slice(0, 6)}…${owner.slice(-4)} ratio ${shown}`);
    }
  };

  while (price !== target) {
    const maxMove = (price * MAX_STEP_BPS) / 10_000n;
    const diff = target > price ? target - price : price - target;
    const step = diff < maxMove ? diff : maxMove;
    price = target > price ? price + step : price - step;
    const now = Math.floor(Date.now() / 1000);
    for (const feed of feeds) {
      const round = ((await feed.latestRoundData())[0] as bigint) + 1n;
      await (await feed.setLatestRoundData(round, price, now, now, round)).wait();
    }
    // Advance lastKnownPrice so the next step is judged against this one.
    for (const token of tokens) {
      await (await oracle.getTokenPrice(token)).wait();
    }
    console.log(`  feeds @ $${ethers.formatUnits(price, 8)}, oracle poked`);
    await report();
  }
  console.log("Done. Liquidation threshold is 110%; the Liquidate page polls every minute.");
}

main().catch((error) => {
  console.error(describeErrorStack(error));
  process.exit(1);
});
