/**
 * The governance handover from the signer gate onwards: read where it stands, take the census,
 * send what is owed, verify, record. scripts/transfer-governance.ts supplies the chain and the
 * deployment snapshot; test/GovernanceHandover.test.ts supplies the production fixture and
 * fakes, so the path a resumed run takes is tested and not only the plan beneath it.
 */
import {
  HANDOVER_CONTRACT_NAMES,
  HANDOVER_ORDER,
  HandoverAdmins,
  HandoverContracts,
  HandoverParties,
  HandoverStates,
  adminsHandedOver,
  handoverStates,
  planHandover,
  readHandoverAdmins,
  runHandover,
} from "./governanceHandover";
import { GRACE_PERIOD_READ_FAILED } from "./roleCensus";
import type { CensusCheck, CensusPolicy } from "./roleCensus";
import { describeError } from "./redact";

/** The authority a census is taken under: the deployer wherever it is still admin, or the timelock everywhere. */
export type CensusStage = Pick<CensusPolicy, "transferred" | "handover">;

export interface HandoverCeremony {
  contracts: HandoverContracts;
  parties: HandoverParties;
  /** The chain's head block. */
  headBlock(): Promise<number>;
  /** The role census as of `block`. It prints its own lines. */
  census(stage: CensusStage, block: number): Promise<ReadonlyArray<Pick<CensusCheck, "pass">>>;
  /** The check that the timelock gives a matured operation a deadline. */
  gracePeriod(): Promise<CensusCheck>;
  /** Marks the deployment snapshot as transferred. Called once, after every check has passed. */
  recordTransferred(): void;
  log(line: string): void;
}

/** A refusal for the operator to read. Nothing was recorded; the message says whether anything was sent. */
export class HandoverRefused extends Error {}

/** Where each contract stands, or a refusal naming every contract whose admin the handover cannot explain. */
function statesOrRefuse(admins: HandoverAdmins): HandoverStates {
  try {
    return handoverStates(admins);
  } catch (err) {
    throw new HandoverRefused(
      `${describeError(err)}\n  Nothing was sent. An admin role has moved in a way this script never moves one; investigate before running it again.`
    );
  }
}

/** The checks that must pass before the first transaction of this run; the handover cannot be undone after it. */
async function checkBeforeSending(ceremony: HandoverCeremony, states: HandoverStates, block: number): Promise<void> {
  const { log } = ceremony;
  // On a contract the deployer still administers, a role the ceremony did not intend can still
  // be revoked by the deployer. After the handover only the timelock could, 48 hours later.
  log("  Role census before the handover (the deployer as the authority where it is still admin)...");
  const before = await ceremony.census({ transferred: false, handover: states }, block);
  if (before.some((check) => !check.pass)) {
    throw new HandoverRefused(
      "A role has a holder the ceremony did not intend (FAIL lines above). This run sent nothing.\n" +
        "  transferGovernance revokes the deployer alone, so that holder would keep its role\n" +
        "  after the handover. Revoke it, or explain it, before running this script again.\n" +
        "  On a contract already handed over only the timelock can revoke it."
    );
  }
  // The timelock is immutable, so one without the grace period cannot be fixed after the handover.
  const grace = await ceremony.gracePeriod();
  log(`    [${grace.pass ? "OK" : "FAIL"}] ${grace.name}: ${grace.detail}`);
  if (!grace.pass && grace.detail.startsWith(GRACE_PERIOD_READ_FAILED)) {
    throw new HandoverRefused("The timelock's GRACE_PERIOD() could not be read; nothing was sent. Run this script again on another endpoint.");
  }
  if (!grace.pass) {
    throw new HandoverRefused("The timelock lets a matured operation wait forever; redeploy with the current GoldGovernance before handing over.");
  }
}

/**
 * Carries the handover from wherever the chain shows it to stand, and records it once every
 * check has passed. Throws HandoverRefused for a state it will not act on or cannot verify, and
 * rethrows the failure of a transaction it sent; in neither case is anything recorded.
 *
 * The plan and the census before sending describe one block, so a transaction that confirms
 * while the script is reading cannot make the two disagree. The verification reads a second
 * block, never behind the last transaction this run mined: an endpoint that answers from a
 * node still behind it then fails the read outright instead of showing the deployer as admin.
 */
export async function carryOutHandover(ceremony: HandoverCeremony): Promise<void> {
  const { contracts, parties, log } = ceremony;

  // The chain, not the snapshot, says what is owed: an earlier run may have stopped part way.
  const plannedAt = await ceremony.headBlock();
  const states = statesOrRefuse(await readHandoverAdmins(contracts, parties, plannedAt));
  const steps = planHandover(states);
  const handedOver = HANDOVER_ORDER.filter((label) => states[label] === "done").map((label) => HANDOVER_CONTRACT_NAMES[label]);
  const resumed = handedOver.length > 0 || states.siloFactory === "granted";
  if (handedOver.length > 0) log(`  Already handed over: ${handedOver.join(", ")}.`);
  if (states.siloFactory === "granted") log("  SiloFactory: the grant to the timelock landed; the deployer's renounce is still owed.");

  let minedAt: number | undefined;
  if (steps.length === 0) {
    log("  The timelock already administers every contract, so nothing is left to send.");
  } else {
    if (resumed) log(`  Continuing with the ${steps.length} transaction(s) still owed.\n`);
    await checkBeforeSending(ceremony, states, plannedAt);
    try {
      minedAt = await runHandover(contracts, parties, steps, (line) => log(`  ${line}`));
    } catch (err) {
      log(
        "\n  The handover stopped part way. Wait for any transaction still pending to confirm, then run\n" +
          "  this script again: it reads each contract's admin from the chain and sends only what is still owed.\n"
      );
      throw err;
    }
  }

  log("\n  Verifying role state on-chain...");
  const verifiedAt = Math.max(await ceremony.headBlock(), minedAt ?? 0);
  const admins = await readHandoverAdmins(contracts, parties, verifiedAt);
  for (const label of HANDOVER_ORDER) {
    const { deployer, timelock } = admins[label];
    const detail = `deployer=${deployer ? "STILL ADMIN" : "revoked"}, timelock=${timelock ? "admin" : "MISSING"}`;
    log(`    [${!deployer && timelock ? "OK" : "FAIL"}] ${label}: ${detail}`);
  }

  // The pairwise reads above cannot see a second holder; the census can.
  log("\n  Role census after the handover (the timelock as the authority)...");
  const after = await ceremony.census({ transferred: true }, verifiedAt);
  if (!adminsHandedOver(admins) || after.some((check) => !check.pass)) {
    throw new HandoverRefused(
      "Verification FAILED: a contract is not in the state the handover leaves it in (FAIL lines above).\n" +
        "  The snapshot was NOT marked as transferred. If a transaction may not have been seen yet, wait\n" +
        "  for it to confirm and run this script again: it sends only what is still owed. Otherwise\n" +
        "  investigate the failing contract(s) before going any further."
    );
  }
  ceremony.recordTransferred();
}
