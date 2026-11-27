/**
 * Set the SurplusBuffer's optional governed GSUSD minimum, minGsusdReserve.
 *
 * The 2% policy floor (docs/BUSINESS_MODEL.md section 5) does not depend on this script:
 * the buffer keeps 2% of max(live supply, one day smoothed supply) by itself, and
 * withdrawGsusd enforces the higher of that and minGsusdReserve. No routine run is needed.
 * Use this only to hold a higher fixed minimum, for example through an expected supply
 * contraction; zero (the launch value) leaves the automatic floor alone in force, and no
 * value can take the effective floor below 2%.
 *
 * Works before and after the governance handover: one direct call while the signer holds
 * GOVERNANCE_ROLE, otherwise a timelock operation advanced one step per run (schedule,
 * wait 48h, execute), with the Safe transaction printed whenever the signer lacks the
 * proposer or executor role. Without CONFIRM=YES nothing is sent. The value already set is
 * refused at scheduling; a value at or below the automatic floor is allowed with a note that
 * it changes nothing today. After the change lands, run refresh-deployment-snapshot.ts.
 *
 *   MIN_RESERVE_GSUSD=30000 MEMO="hold 30k through the migration" CONFIRM=YES \
 *     npx hardhat run scripts/set-min-reserve.ts --network <net>
 *
 * Fork rehearsal: add FORK_OF=<net> and IMPERSONATE=<address> against a Hardhat fork
 * (see withdraw-surplus.ts); both are refused on a real chain.
 */
import { ethers } from "hardhat";
import { connectDeployment, formatGsusd, parseForkEnv, parseGsusd } from "./lib/deploymentContext";
import { MinReserveOutcome, runSetMinReserve } from "./lib/minReserve";
import { describeError } from "./lib/redact";

function summarise(outcome: MinReserveOutcome): string {
  switch (outcome.step) {
    case "dry-run":
      return "Dry run: nothing sent. Re-run with CONFIRM=YES to send.";
    case "set":
    case "executed":
      return "Governed minimum updated. Run refresh-deployment-snapshot.ts so the snapshot follows.";
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

async function main() {
  const floor = parseGsusd("MIN_RESERVE_GSUSD", process.env.MIN_RESERVE_GSUSD, true);
  const memo = (process.env.MEMO ?? "").trim();
  const confirm = process.env.CONFIRM === "YES";
  const { snapName, snap, signer, fork } = await connectDeployment(parseForkEnv(process.env));

  const buffer = await ethers.getContractAt("SurplusBuffer", snap.addresses.surplusBuffer, signer);
  const timelock = await ethers.getContractAt("TimelockController", snap.addresses.timelock, signer);

  console.log(
    `${snapName}${fork ? " (fork)" : ""}: signer ${await signer.getAddress()}${confirm ? "" : " (dry run)"}, ` +
      `governed minimum -> ${formatGsusd(floor)}${memo ? ` (memo "${memo}")` : ""}`
  );
  if (process.env.ALLOW_BELOW_POLICY !== undefined) {
    console.log("  ALLOW_BELOW_POLICY is no longer read: the 2% floor is automatic and no value can lower it.");
  }
  const outcome = await runSetMinReserve({
    buffer,
    timelock,
    signer,
    floor,
    memo,
    confirm,
    log: (line) => console.log(`  ${line}`),
  });
  console.log(summarise(outcome));
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
