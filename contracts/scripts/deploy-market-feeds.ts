/**
 * Research tool, outside the mainnet ceremony: the GoldOracle prices on Chainlink PAXG/USD and
 * XAU/USD alone, and neither adapter this script deploys is used in production (the launch
 * parser refuses MARKET_FEEDS and every confirmation feed variable).
 *
 * Deploys one adapter per name in MARKET_FEEDS, a UniswapV3TwapFeed for a block naming a pool
 * or a PythMarketFeed for one naming the Pyth contract (the variables each kind needs are
 * listed in scripts/lib/marketFeeds.ts and .env.mainnet.example), raises each TWAP pool's
 * observation cardinality to one slot per 12 s block over the window plus a margin when it is
 * short and records every adapter in deployments/<network>-feeds.json. Rerunning
 * it is safe: a recorded adapter with the same parameters is reused, one whose parameters
 * changed is refused and a pool already raised far enough is left alone.
 *
 *   set -a; source .env.mainnet; set +a
 *   npx hardhat run scripts/deploy-market-feeds.ts --network mainnet
 *
 * A pool whose cardinality was just raised answers 0 (OBSERVE_FAILED) until its new slots have
 * filled over a full window.
 */
import { ethers, network } from "hardhat";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatFindings } from "./lib/findings";
import {
  deployMarketFeeds,
  feedsSnapshotName,
  parseFeedsSnapshot,
  parseMarketFeedSpecs,
  pythStatusMeaning,
  readPythFeed,
  readTwapFeed,
  twapStatusMeaning,
} from "./lib/marketFeeds";
import { describeError } from "./lib/redact";

async function main(): Promise<void> {
  const { specs, findings } = parseMarketFeedSpecs(process.env);
  if (!specs) {
    console.error(formatFindings(findings));
    throw new Error("The market feed environment is not usable; fix the FAIL lines above.");
  }
  const [signer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const deployments = resolve(__dirname, "..", "deployments");
  const snapshotPath = resolve(deployments, feedsSnapshotName(network.name));
  const existing = existsSync(snapshotPath) ? parseFeedsSnapshot(readFileSync(snapshotPath, "utf8")) : undefined;
  console.log(`Market feeds on "${network.name}" (chain ${chainId}) as ${signer.address}; ${specs.length} adapter(s).`);

  mkdirSync(deployments, { recursive: true });
  const result = await deployMarketFeeds({
    specs,
    signer,
    factories: {
      twap: await ethers.getContractFactory("UniswapV3TwapFeed", signer),
      pyth: await ethers.getContractFactory("PythMarketFeed", signer),
    },
    chainId,
    network: network.name,
    existing,
    save: (snapshot) => writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`),
    log: (line) => console.log(`  ${line}`),
  });

  console.log(`\nDeployed ${result.deployed.length}, reused ${result.reused.length}, raised ${result.raised.length} pool(s). Snapshot ${snapshotPath}`);
  console.log("\nCurrent readings (a TWAP adapter answers 0 until its pool's observations span the window; a Pyth adapter until an update is relayed):");
  for (const spec of specs) {
    const address = result.snapshot.feeds[spec.name].address;
    let state = "unreadable";
    if (spec.kind === "PYTH") {
      const reading = await readPythFeed(ethers.provider, address);
      if (reading) state = reading.status === "OK" ? `$${ethers.formatUnits(reading.answer, 8)}` : `${reading.status}: ${pythStatusMeaning(reading.status)}`;
    } else {
      const reading = await readTwapFeed(ethers.provider, address);
      if (reading) state = reading.status === "OK" ? `$${ethers.formatUnits(reading.answer, 8)}` : `${reading.status}: ${twapStatusMeaning(reading.status)}`;
    }
    console.log(`  ${spec.name}=${address}  ${state}`);
  }
  console.log("\nThese adapters are for research only; the mainnet ceremony does not use them.");
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
