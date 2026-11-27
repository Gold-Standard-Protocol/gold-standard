/**
 * Set GoldVault's origination fee, the share of each mint the vault keeps for the
 * SurplusBuffer while the borrower owes the full amount. 5 bps at launch (deploy.ts,
 * ORIGINATION_FEE_BPS); this script is how governance moves it afterwards, within 0 to 100.
 *
 * Works before and after the governance handover: one direct call while the signer holds
 * GOVERNANCE_ROLE, otherwise a timelock operation advanced one step per run (schedule,
 * wait 48h, execute), with the Safe transaction printed whenever the signer lacks the
 * proposer or executor role. Without CONFIRM=YES nothing is sent. The value already set is
 * refused at scheduling. After the change lands, run refresh-deployment-snapshot.ts.
 *
 *   ORIGINATION_FEE_BPS=5 MEMO="launch fee" CONFIRM=YES \
 *     npx hardhat run scripts/set-origination-fee.ts --network <net>
 *
 * Fork rehearsal: add FORK_OF=<net> and IMPERSONATE=<address> against a Hardhat fork
 * (see withdraw-surplus.ts); both are refused on a real chain.
 */
import { ethers, network } from "hardhat";
import { connectDeployment, parseForkEnv } from "./lib/deploymentContext";
import { OriginationFeeOutcome, runSetOriginationFee } from "./lib/originationFee";
import { describeError } from "./lib/redact";

/** The closing instruction for each outcome; `networkName` is the --network the run used. */
function summarise(outcome: OriginationFeeOutcome, networkName: string): string {
  switch (outcome.step) {
    case "dry-run":
      return "Dry run: nothing sent. Re-run with CONFIRM=YES to send.";
    case "set":
    case "executed":
      // The snapshot refresh records originationFeeBps.
      return (
        `Origination fee updated. Run \`npx hardhat run scripts/refresh-deployment-snapshot.ts --network ${networkName}\` so the ` +
        "snapshot records it, then verify-deployment.ts and print-agent-manifest.ts. On mainnet a fee other than the " +
        "launch value also needs ALLOW_ORIGINATION_FEE=1 for verify-deployment.ts."
      );
    case "scheduled":
      return "Scheduled. Run the same command again after the delay to execute.";
    case "waiting":
      return "Still inside the delay. Run the same command again once it has passed.";
    case "awaiting-proposer":
      return "Waiting on the proposer Safe to schedule (call above). Re-run afterwards to track it.";
    case "awaiting-executor":
      return "Waiting on the executor Safe to execute (call above).";
    case "expired":
      return "Expired: the timelock refuses it now. Cancel it from the proposer Safe (call above), then re-run with the same memo to schedule it afresh.";
    case "done":
      return "Nothing to do: this change already executed.";
  }
}

function parseBps(raw: string | undefined): bigint {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    throw new Error("Set ORIGINATION_FEE_BPS to a whole number of basis points, for example 5.");
  }
  return BigInt(raw.trim());
}

async function main() {
  const bps = parseBps(process.env.ORIGINATION_FEE_BPS);
  const memo = (process.env.MEMO ?? "").trim();
  const confirm = process.env.CONFIRM === "YES";
  const { snapName, snap, signer, fork } = await connectDeployment(parseForkEnv(process.env));

  if (!snap.addresses.vault) throw new Error(`The ${snapName} snapshot has no addresses.vault.`);
  const vault = await ethers.getContractAt("GoldVault", snap.addresses.vault, signer);
  const timelock = await ethers.getContractAt("TimelockController", snap.addresses.timelock, signer);

  console.log(
    `${snapName}${fork ? " (fork)" : ""}: signer ${await signer.getAddress()}${confirm ? "" : " (dry run)"}, ` +
      `origination fee -> ${bps} bps${memo ? ` (memo "${memo}")` : ""}`
  );
  const outcome = await runSetOriginationFee({
    vault,
    timelock,
    signer,
    bps,
    memo,
    confirm,
    log: (line) => console.log(`  ${line}`),
  });
  console.log(summarise(outcome, network.name));
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
