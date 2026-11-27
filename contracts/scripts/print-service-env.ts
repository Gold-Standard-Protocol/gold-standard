/**
 * Print the environment blocks of the dapp build, the API and the keeper for a deployment,
 * from deployments/<network>.json, so no address is ever retyped (docs/LAUNCH.md step 3.6).
 * Secrets and endpoints are left as placeholders. Nothing is written or sent.
 *
 *   npx hardhat run scripts/print-service-env.ts --network mainnet
 *
 * The API block's CORS_ORIGINS carries both launch origins, https://goldstandardfinance.eth.limo and
 * https://goldstandard.finance. SITE_URL replaces them: one origin or a comma-separated list.
 *
 * On mainnet the dapp block leaves out VITE_UNISWAP_ROUTER, VITE_UNISWAP_QUOTER and
 * VITE_DEX_POOL_FEE, so the swap page shows the reserve alone: the market tab needs a seeded
 * GSUSD/PAXG pool. DEX_MARKET=1 prints them once that pool exists. Sepolia always prints them.
 *
 * The API block carries the Usage Ledger's variables. LEDGER_START_TIMESTAMP is the timestamp
 * of the deployment block, read from the network's RPC endpoint; when that read fails the
 * line is printed as a placeholder and a note says so. The two liquidity variables are
 * printed as comments, to be set once the official GSUSD/USDC pool exists.
 */
import { ethers, network } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeError } from "./lib/redact";
import { parseSiteOrigins, serviceEnv, ServiceEnvSnapshot } from "./lib/serviceEnv";

/** DEX_MARKET is 1 or unset: turning the market tab on is written out, never inferred from "true" or "yes". */
function parseDexMarket(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  if (raw.trim() !== "1") throw new Error(`DEX_MARKET is "${raw}"; set DEX_MARKET=1 to print the market tab's variables, or unset it.`);
  return true;
}

/** The deployment block's timestamp, or undefined (with a note on standard error) when the chain cannot be asked. */
async function deployTimestampOf(deployBlock: number): Promise<number | undefined> {
  try {
    const block = await ethers.provider.getBlock(deployBlock);
    if (block === null) throw new Error(`block ${deployBlock} was not found`);
    return block.timestamp;
  } catch (error) {
    console.error(
      `Note: the timestamp of the deployment block ${deployBlock} could not be read (${describeError(error)}); LEDGER_START_TIMESTAMP is printed as a placeholder to fill in.`
    );
    return undefined;
  }
}

async function main(): Promise<void> {
  const path = resolve(__dirname, "../deployments", `${network.name}.json`);
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as ServiceEnvSnapshot;
  const env = serviceEnv(snapshot, {
    siteOrigins: parseSiteOrigins(process.env.SITE_URL),
    dexMarket: parseDexMarket(process.env.DEX_MARKET),
    deployTimestamp: await deployTimestampOf(snapshot.deployBlock),
  });
  console.log(`# dapp: apps/dapp/.env.production.local on the build machine (every value is baked into the bundle)\n${env.dapp}`);
  console.log(`# api: the API service's environment file\n${env.api}`);
  console.log(`# keeper: the keeper service's environment file (the only place the keeper key exists)\n${env.keeper}`);
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
