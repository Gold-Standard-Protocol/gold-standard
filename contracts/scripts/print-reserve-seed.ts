/**
 * Print the two Safe transactions that seed the Gold Stability Reserve with gold (docs/MAINNET.md
 * section 5): the token's approve, then the reserve's seedCollateral. Read-only: nothing is sent;
 * paste the output into the Safe Transaction Builder (custom data), both in one batch or one
 * after the other, from the Safe that holds the gold.
 *
 *   SEED_AMOUNT=25 npx hardhat run scripts/print-reserve-seed.ts --network mainnet
 *
 *   SEED_AMOUNT  the amount in whole tokens ("25", "0.5"); scaled by the decimals read from the token
 *   SEED_TOKEN   paxg (default), xaut or a token address; refused unless the reserve accepts it
 *   SEED_FROM    optional: the Safe that will send both; its balance and allowance are then checked
 *
 * seedCollateral has no role check: any holder may add gold to the reserve, so the sender is
 * whichever Safe holds the tokens (the operations Safe, in the launch plan), not a governance
 * Safe and not the timelock. The amount is a treasury decision; this script takes it as given.
 *
 * Never send the token to the reserve with a plain transfer: it is not counted and cannot be
 * recovered. The script prints the same warning with every run.
 */
import { ethers, network } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSnapshot } from "./lib/deploymentContext";
import { describeError } from "./lib/redact";
import { DIRECT_TRANSFER_WARNING, assertSeedable, encodeApprove, encodeSeed, parseSeedAmount, readHolder, readSeedContext, resolveSeedToken } from "./lib/reserveSeed";

interface SeedSnapshot {
  reserve: string;
  paxgToken: string;
  xautToken: string;
}

/** The reserve and token addresses of deployments/<network>.json, after loadSnapshot has checked its shape. */
function readSeedSnapshot(path: string, connectedChainId: number): SeedSnapshot {
  const snap = loadSnapshot(path);
  if (snap.chainId !== connectedChainId) throw new Error(`Chain mismatch: snapshot ${snap.chainId}, connected ${connectedChainId}.`);
  if (snap.addresses.reserve === undefined) throw new Error(`Snapshot ${path} lacks addresses.reserve.`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as { config?: { paxgToken?: unknown; xautToken?: unknown } };
  const { paxgToken, xautToken } = raw.config ?? {};
  if (typeof paxgToken !== "string" || !ethers.isAddress(paxgToken) || typeof xautToken !== "string" || !ethers.isAddress(xautToken)) {
    throw new Error(`Snapshot ${path} lacks config.paxgToken or config.xautToken.`);
  }
  return { reserve: snap.addresses.reserve, paxgToken, xautToken };
}

function printTransaction(title: string, tx: { to: string; value: string; data: string; decoded: string }): void {
  console.log(title);
  console.log(`   to:      ${tx.to}`);
  console.log(`   value:   ${tx.value}`);
  console.log(`   data:    ${tx.data}`);
  console.log(`   decoded: ${tx.decoded}\n`);
}

async function main(): Promise<void> {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const snap = readSeedSnapshot(resolve(__dirname, "../deployments", `${network.name}.json`), chainId);
  const token = resolveSeedToken(process.env.SEED_TOKEN, snap);
  const context = await readSeedContext(ethers.provider, snap.reserve, token);
  // Before anything is printed: calldata for a token the reserve refuses would only revert in the Safe.
  assertSeedable(token, context);
  const amount = parseSeedAmount(process.env.SEED_AMOUNT, context.decimals, context.symbol);
  const seed = { reserve: snap.reserve, token, amount };
  const shown = `${ethers.formatUnits(amount, context.decimals)} ${context.symbol}`;

  console.log(`Seed the Gold Stability Reserve on ${network.name} with ${shown} (${context.symbol} has ${context.decimals} decimals, read from the token).`);
  console.log(`Reserve ${snap.reserve} counts ${ethers.formatUnits(context.collateralBalance, context.decimals)} ${context.symbol} now.\n`);
  console.log(`${"!".repeat(78)}\n${DIRECT_TRANSFER_WARNING.join("\n")}\n${"!".repeat(78)}\n`);
  console.log("Sender: the Safe that holds the tokens (the operations Safe in the launch plan). seedCollateral");
  console.log("is permissionless and needs no role, so neither a governance Safe nor the timelock is involved.");
  console.log("Both transactions come from that one Safe, in this order.\n");

  const from = process.env.SEED_FROM?.trim();
  if (from) {
    if (!ethers.isAddress(from)) throw new Error(`SEED_FROM is not an address: ${from}`);
    const holder = await readHolder(ethers.provider, seed, from);
    console.log(`SEED_FROM ${ethers.getAddress(from)} holds ${ethers.formatUnits(holder.balance, context.decimals)} ${context.symbol}; its allowance to the reserve is ${ethers.formatUnits(holder.allowance, context.decimals)}.`);
    if (holder.balance < amount) throw new Error(`SEED_FROM holds less than ${shown}; transaction 2 would revert. Nothing is printed.`);
    if (holder.allowance !== 0n) console.log("Transaction 1 replaces that allowance with the exact amount.");
    console.log("");
  }

  printTransaction(`1. ${context.symbol} token: allow the reserve to pull exactly ${shown} (approve):`, encodeApprove(seed, context));
  printTransaction(`2. Reserve: pull the tokens and count them as reserve (seedCollateral):`, encodeSeed(seed, context));
  console.log("Check before signing: transaction 1 goes to the token, transaction 2 to the reserve, both with value 0,");
  console.log("and the Safe's own decoding shows the same spender, token and amount as the decoded lines above.");
  console.log(`After both confirm, GoldStabilityReserve.collateralBalance(${token}) rises by what arrived, and the`);
  console.log("allowance returns to zero. Then: npx hardhat run scripts/verify-deployment.ts --network " + network.name);
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
