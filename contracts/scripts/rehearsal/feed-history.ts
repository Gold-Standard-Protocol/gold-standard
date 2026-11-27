/**
 * Reads the real Chainlink PAXG/USD and XAU/USD proxies' round history on the fork (run before
 * scripts/rehearsal/baseline.ts points them at mocks) and reports, over the last FEED_HISTORY_DAYS
 * (default 30) days, the largest gap between consecutive rounds' updatedAt, weekends included,
 * against the oracle's 90,000 s staleness threshold. Read-only.
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/feed-history.ts --network localhost
 */
import { Contract } from "ethers";
import { ADDR, assertFork, latestTs, provider } from "./lib";
import { describeErrorStack } from "../lib/redact";

const ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function getRoundData(uint80) view returns (uint80,int256,uint256,uint256,uint80)",
  "function description() view returns (string)",
];
const DAYS = Number(process.env.FEED_HISTORY_DAYS ?? 30);
const LIMIT = 90_000;
const iso = (t: number): string => `${new Date(t * 1000).toISOString().slice(0, 16)}Z ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(t * 1000).getUTCDay()]}`;

async function history(address: string, now: number): Promise<string> {
  const proxy = new Contract(address, ABI, provider);
  const [latestId, , , latestAt] = await proxy.latestRoundData();
  const phase = latestId >> 64n;
  const since = now - DAYS * 86_400;
  const stamps: number[] = [Number(latestAt)];
  let agg = latestId & ((1n << 64n) - 1n);
  while (agg > 1n) {
    agg -= 1n;
    const [, , , updatedAt] = await proxy.getRoundData((phase << 64n) | agg);
    stamps.push(Number(updatedAt));
    if (Number(updatedAt) < since) break;
  }
  const covered = agg <= 1n && stamps[stamps.length - 1] >= since ? " (phase start reached: history before it not read)" : "";
  let worst = { gap: now - stamps[0], from: stamps[0], to: now };
  for (let i = 0; i + 1 < stamps.length; i++) {
    const gap = stamps[i] - stamps[i + 1];
    if (gap > worst.gap) worst = { gap, from: stamps[i + 1], to: stamps[i] };
  }
  const days = stamps.filter((t) => t >= since).length;
  return `${await proxy.description()} (${address}): ${days} rounds in ${DAYS} days${covered}; largest gap ${worst.gap} s (${(worst.gap / 3600).toFixed(2)} h) from ${iso(worst.from)} to ${iso(worst.to)}, ${((worst.gap / LIMIT) * 100).toFixed(1)}% of the ${LIMIT} s limit, headroom ${LIMIT - worst.gap} s`;
}

async function main(): Promise<void> {
  const fork = await assertFork();
  const now = await latestTs();
  console.log(`Feed round history on the fork (block ${fork.block}, ${iso(now)}):`);
  for (const a of [ADDR.PAXG_USD, ADDR.XAU_USD]) console.log(`  PASS  ${await history(a, now)}`);
}

main().catch((e) => {
  console.error(describeErrorStack(e));
  process.exit(1);
});
