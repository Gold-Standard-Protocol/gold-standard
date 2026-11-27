/**
 * Print the two Safe transactions that raise a collateral's debt ceiling through the
 * timelock (docs/LAUNCH.md step 5): the proposer Safe's schedule call now, the executor's
 * execute call once the delay has passed and within the timelock's grace period after that
 * (48 hours and 7 days at launch; both are read from the chain, since governance can raise
 * the delay). Read-only: nothing is sent; paste the output into the Safe Transaction Builder
 * (custom data).
 *
 *   CEILING_GSUSD=250000 npx hardhat run scripts/print-ceiling-proposal.ts --network mainnet
 *   CEILING_GSUSD=unlimited ... lifts the ceiling entirely (the open launch profile, or a guarded
 *   deployment that is done ramping); COLLATERAL=xaut targets XAUT (default paxg)
 *   NONCE_AT_SCHEDULE=<n> reprints the execute call for a proposal scheduled earlier
 *
 * The operation carries the ceiling alone (proposeDebtCeilingUpdate, then GoldVault.setDebtCeiling),
 * so a ratio change made while it waits stands when it executes.
 * After the execute lands: npx hardhat run scripts/refresh-deployment-snapshot.ts --network <net>
 */
import { ethers, network } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertDebtCeilingSupported,
  encodeExecute,
  encodeSchedule,
  executeWindowText,
  parseCeiling,
  readExecuteWindow,
  spanText,
  UNLIMITED_CEILING,
} from "./lib/ceilingProposal";
import { describeError } from "./lib/redact";

async function main(): Promise<void> {
  const raw = process.env.CEILING_GSUSD?.trim() ?? "";
  const debtCeiling = parseCeiling(raw);
  const shown = debtCeiling === UNLIMITED_CEILING ? "unlimited" : `${raw} GSUSD`;
  const collateral = (process.env.COLLATERAL ?? "paxg").toLowerCase();
  if (collateral !== "paxg" && collateral !== "xaut") throw new Error("COLLATERAL must be paxg or xaut.");

  const snap = JSON.parse(readFileSync(resolve(__dirname, "../deployments", `${network.name}.json`), "utf8"));
  const token: string = collateral === "paxg" ? snap.config.paxgToken : snap.config.xautToken;
  // Before anything is printed: a deployment from before 2026-11-06 has neither function, and
  // calldata printed for it would revert only after the delay.
  await assertDebtCeilingSupported(ethers.provider, { vault: snap.addresses.vault, governance: snap.addresses.governance, token });
  const vault = await ethers.getContractAt("GoldVault", snap.addresses.vault);
  const governance = await ethers.getContractAt("GoldGovernance", snap.addresses.governance);
  // collateralTypes is keyed by keccak256(abi.encodePacked(token)), the vault's _collateralId.
  const current = await vault.collateralTypes(ethers.solidityPackedKeccak256(["address"], [token]));
  const nonce = process.env.NONCE_AT_SCHEDULE ? BigInt(process.env.NONCE_AT_SCHEDULE) : await governance.proposalNonce();
  // The delay GoldGovernance._schedule will use, max(MIN_DELAY, timelock.getMinDelay()), and the
  // timelock's grace period, both as they stand now.
  const window = await readExecuteWindow(ethers.provider, snap.addresses.governance);

  const proposal = {
    governance: snap.addresses.governance,
    vault: snap.addresses.vault,
    token,
    debtCeiling,
  };
  const schedule = encodeSchedule(proposal);
  const execute = encodeExecute(proposal, nonce);

  const was = current.debtCeiling === UNLIMITED_CEILING ? "unlimited" : `${ethers.formatEther(current.debtCeiling)} GSUSD`;
  console.log(`${collateral.toUpperCase()} ceiling ${was} -> ${shown} on ${network.name}`);
  console.log("the operation sets the ceiling only; the ratios are not part of it");
  console.log(`wrapper proposalNonce at schedule: ${nonce}\n`);
  console.log("1. Proposer Safe, now (proposeDebtCeilingUpdate):");
  console.log(`   to:    ${schedule.to}`);
  console.log(`   value: 0`);
  console.log(`   data:  ${schedule.data}\n`);
  console.log(`2. Executor, ${executeWindowText(window)} (executeProposal):`);
  console.log(`   to:    ${execute.to}`);
  console.log(`   value: 0`);
  console.log(`   data:  ${execute.data}\n`);
  console.log("If another proposal is scheduled between the two steps, reprint step 2 with NONCE_AT_SCHEDULE set to the nonce above.");
  if (window.gracePeriod !== undefined) {
    console.log(
      `After ${spanText(window.gracePeriod, "that", "those")} the timelock refuses step 2 (TimelockOperationExpired): the proposer Safe ` +
        "cancels the operation and step 1 is submitted again."
    );
  }
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
