/**
 * Print the two Safe transactions that exempt a vault owner from the origination fee through the
 * timelock (docs/MAINNET.md section 5): the proposer Safe's schedule call now, the executor
 * Safe's execute call once the delay has passed and within the timelock's grace period after
 * that (48 hours and 7 days at launch; both are read from the chain). Read-only: nothing is
 * sent; paste the output into the Safe Transaction Builder (custom data).
 *
 *   EXEMPT_ACCOUNT=<vault owner> npx hardhat run scripts/print-fee-exemption-proposal.ts --network mainnet
 *
 *   EXEMPT_ACCOUNT  the address that will own the vault (the protocol's own Safe for its seed vault)
 *   EXEMPT          true (default) to exempt it, false to remove the exemption
 *   EXEMPT_MEMO     optional label; part of the salt, so the same change can be scheduled again later
 *
 * The governed call is GoldVault.setOriginationFeeExempt(account, exempt). The GoldGovernance
 * wrapper has no helper for it, so both transactions go to the timelock itself, where the
 * proposer Safe holds PROPOSER_ROLE and the executor Safe EXECUTOR_ROLE. The operation id is
 * printed and checked against the timelock's own hashOperation; run the same command again at
 * any time to see whether the operation is scheduled, ready, executed or expired. An expired
 * operation is printed as expired, with the proposer Safe's cancel first and a fresh schedule
 * and execute pair after it, never as one the executor Safe can still sign.
 */
import { ethers, network } from "hardhat";
import { resolve } from "node:path";
import { assertTimelockMatchesGovernance, loadSnapshot, parseAddress } from "./lib/deploymentContext";
import { daysText, hoursText } from "./lib/ceilingProposal";
import {
  ExemptionReading,
  FeeExemption,
  SafeTransaction,
  encodeCancel,
  encodeExecute,
  encodeSchedule,
  executionWindow,
  expiredSince,
  parseExempt,
  readExemption,
  timelockRoleHolders,
} from "./lib/feeExemptionProposal";
import { describeError } from "./lib/redact";

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

function printTransaction(title: string, tx: SafeTransaction): void {
  console.log(title);
  console.log(`   to:      ${tx.to}`);
  console.log(`   value:   ${tx.value}`);
  console.log(`   data:    ${tx.data}`);
  console.log(`   decoded: ${tx.decoded}\n`);
}

/** The Safe a step needs, from the snapshot's list, checked against the role on the timelock. */
async function signerLine(timelock: string, role: "proposer" | "executor", recorded: readonly string[]): Promise<string> {
  const roleName = role === "proposer" ? "PROPOSER_ROLE" : "EXECUTOR_ROLE";
  if (recorded.length === 0) return `an account that holds the timelock's ${roleName} (the snapshot records no ${role})`;
  const holders = await timelockRoleHolders(ethers.provider, timelock, role, recorded);
  if (holders.length === 0) {
    throw new Error(`None of the snapshot's ${role}s (${recorded.join(", ")}) holds ${roleName} on the timelock ${timelock}; the snapshot and the chain disagree. Nothing is printed.`);
  }
  const open = role === "executor" && holders.includes(ethers.ZeroAddress);
  return open ? "anyone: the timelock has an open executor" : `the ${role} Safe ${holders.join(" or ")} (holds the timelock's ${roleName})`;
}

function windowLines(reading: ExemptionReading, scheduleStep: number): string[] {
  const window = executionWindow(reading);
  const closing = window.latest === undefined ? "with no closing time (this timelock has no grace period)" : `until ${iso(window.latest)}, after which the timelock refuses it`;
  return window.exact
    ? [`Scheduled. Executable from ${iso(window.earliest)} ${closing}.`]
    : [
        `Earliest execution: ${hoursText(reading.delay)} after transaction ${scheduleStep} is mined. If it were mined in the latest block, that is ${iso(window.earliest)}, ${closing}.`,
        `Every hour the proposer Safe takes to sign moves both times later by an hour. Run this command again after transaction ${scheduleStep} confirms for the exact times.`,
      ];
}

/** The opening of the output for an operation the timelock has expired: what happened and the cancel that clears it. */
async function printExpired(proposal: FeeExemption, reading: ExemptionReading, proposers: readonly string[]): Promise<void> {
  const since = expiredSince(reading);
  console.log(`This operation was scheduled and has expired${since === undefined ? "" : `: it could be executed until ${iso(since)}`}.`);
  console.log("The timelock refuses to execute it (TimelockOperationExpired) and still holds its id, so it cannot be scheduled again until it is cancelled.\n");
  printTransaction(`1. Now: ${await signerLine(proposal.timelock, "proposer", proposers)} cancels the expired operation:`, encodeCancel(proposal));
  console.log("Check before signing the cancel: it goes to the timelock with value 0 and its id is the operation id above.\n");
}

async function main(): Promise<void> {
  const account = parseAddress("EXEMPT_ACCOUNT", process.env.EXEMPT_ACCOUNT);
  const exempt = parseExempt(process.env.EXEMPT);
  const memo = (process.env.EXEMPT_MEMO ?? "").trim();
  const snap = loadSnapshot(resolve(__dirname, "../deployments", `${network.name}.json`));
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (snap.chainId !== chainId) throw new Error(`Chain mismatch: snapshot ${snap.chainId}, connected ${chainId}.`);
  if (snap.addresses.vault === undefined) throw new Error("The snapshot lacks addresses.vault.");
  await assertTimelockMatchesGovernance(snap.addresses.governance, snap.addresses.timelock);

  const proposal: FeeExemption = { timelock: snap.addresses.timelock, vault: snap.addresses.vault, account, exempt, memo };
  const reading = await readExemption(ethers.provider, proposal);
  if (!reading.timelockGoverns) {
    throw new Error(
      `The timelock ${proposal.timelock} does not hold GOVERNANCE_ROLE on the vault yet: the governance handover has not run. ` +
        "Before the handover the deployer makes this call directly; this printer is for the Safes afterwards. Nothing is printed."
    );
  }

  const change = exempt ? `Exempt ${account} from the origination fee` : `Remove the origination fee exemption of ${account}`;
  console.log(`${change} on ${network.name}${memo ? ` (memo "${memo}")` : ""}.`);
  console.log(`The vault ${reading.exemptNow ? "exempts" : "does not exempt"} this account now.`);
  console.log(`Operation id: ${reading.operationId} (matches the timelock's hashOperation)`);
  console.log("Target the vault, value 0, no predecessor, salt keccak256(abi.encode(\"origination-fee-exempt\", account, exempt, memo)).\n");

  if (reading.state === "done") {
    console.log("This operation has already executed. To make the same change again later, set EXEMPT_MEMO to a new label.");
    return;
  }
  if (reading.state === "unset" && reading.exemptNow === exempt) {
    throw new Error(`The vault already ${exempt ? "exempts" : "does not exempt"} ${account}; there is nothing to schedule. Nothing is printed.`);
  }

  // The schedule and execute steps are numbered 1 and 2, or 2 and 3 when a cancel of the expired operation comes first.
  const scheduleStep = reading.expired ? 2 : 1;
  const executeStep = scheduleStep + 1;
  if (reading.expired) {
    await printExpired(proposal, reading, snap.governanceSafes.proposers);
    if (reading.exemptNow === exempt) {
      console.log(`The vault already ${exempt ? "exempts" : "does not exempt"} ${account}, so nothing is scheduled after the cancel.`);
      return;
    }
    printTransaction(`${scheduleStep}. After the cancel confirms: ${await signerLine(proposal.timelock, "proposer", snap.governanceSafes.proposers)} schedules it again:`, encodeSchedule(proposal, reading.delay));
  } else if (reading.state === "unset") {
    printTransaction(`${scheduleStep}. Now: ${await signerLine(proposal.timelock, "proposer", snap.governanceSafes.proposers)} schedules it:`, encodeSchedule(proposal, reading.delay));
  } else {
    console.log(`${scheduleStep}. Already scheduled; transaction ${scheduleStep} is not needed again.\n`);
  }
  for (const line of windowLines(reading, scheduleStep)) console.log(line);
  console.log("");
  printTransaction(`${executeStep}. Then: ${await signerLine(proposal.timelock, "executor", snap.governanceSafes.executors)} executes it:`, encodeExecute(proposal));

  console.log(`Check before signing: transactions ${scheduleStep} and ${executeStep} go to the timelock with value 0, the Safe's own decoding shows the`);
  console.log(`target, account and exempt flag of the decoded lines above, and transaction ${executeStep} repeats transaction ${scheduleStep}'s salt.`);
  if (reading.gracePeriod !== undefined) {
    console.log(`An operation not executed within ${daysText(reading.gracePeriod)} of becoming ready is refused for good (TimelockOperationExpired).`);
    if (!reading.expired) {
      console.log(`The proposer Safe then clears it, and transaction ${scheduleStep} is submitted again:`);
      printTransaction("   cancel:", encodeCancel(proposal));
    }
  }
  console.log(`After transaction ${executeStep} lands, GoldVault.originationFeeExempt(account) reads ${String(exempt)}.`);
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
