/**
 * Withdraw GSUSD surplus above the reserve floor to the operations Safe
 * (docs/BUSINESS_MODEL.md section 5, item 4). The floor is the buffer's own
 * effectiveMinGsusdReserve: the automatic 2% of max(live supply, one day smoothed supply),
 * or the governed minGsusdReserve when that is higher, exactly what withdrawGsusd enforces.
 *
 * Two paths, chosen by who holds GOVERNANCE_ROLE on the SurplusBuffer:
 *   - the signer (before the governance handover): one direct withdrawGsusd call;
 *   - the timelock (after it): schedule, wait the delay, execute, one step per run.
 * The timelock operation is keyed by (recipient, amount, memo), so the same command run
 * again after the delay finds it and executes it; see lib/timelockStep.ts.
 *
 * Guards, before anything else: the amount is positive, the memo is set, the recipient is
 * a contract (the Safe) unless `allowEoaRecipient` is set, and is neither the buffer nor
 * the timelock nor any address in `refuseRecipients` (the deployer and the governance Safes
 * the snapshot records: surplus goes to the operations Safe, which is none of them). Nothing is sent unless `confirm` is true. The floor check runs before
 * every step that would send, whoever the sender is: a withdrawal that would revert
 * on-chain is refused here with the numbers, and no Safe call is handed out for it either.
 */
import { ethers } from "hardhat";
import type { Signer } from "ethers";
import type { SurplusBuffer } from "../../typechain-types";
import { formatGsusd } from "./deploymentContext";
import {
  advanceTimelock,
  GovernanceTimelock,
  operationSalt,
  resolveGovernancePath,
  TimelockOperation,
  TimelockStep,
} from "./timelockStep";

export type { TimelockOperation } from "./timelockStep";
export type WithdrawalStep = "withdrawn" | TimelockStep;

export interface WithdrawalRequest {
  buffer: SurplusBuffer;
  timelock: GovernanceTimelock | null;
  signer: Signer;
  to: string;
  amount: bigint;
  /** Labels the withdrawal and keys the timelock operation. Required. */
  memo: string;
  confirm: boolean;
  /** The policy recipient is the operations Safe, a contract. Set this to pay an EOA anyway. */
  allowEoaRecipient?: boolean;
  /** Addresses the withdrawal must not pay, each with the name the refusal gives it. */
  refuseRecipients?: readonly RefusedRecipient[];
  log?: (line: string) => void;
}

export interface RefusedRecipient {
  /** How the refusal names the address, for example "the proposer Safe". */
  label: string;
  address: string;
}

export interface WithdrawalOutcome {
  step: WithdrawalStep;
  path: "direct" | "timelock";
  operationId?: string;
  operation?: TimelockOperation;
  readyAt?: number;
  txHash?: string;
}

export interface Headroom {
  balance: bigint;
  /** The effective floor withdrawGsusd enforces. */
  floor: bigint;
  /** Its automatic part: 2% of max(live supply, smoothed supply). */
  automaticFloor: bigint;
  /** Its optional governed part, minGsusdReserve. */
  governedMinimum: bigint;
  withdrawable: bigint;
}

type Logger = (line: string) => void;

export async function readHeadroom(buffer: SurplusBuffer): Promise<Headroom> {
  const [balance, floor, automaticFloor, governedMinimum] = await Promise.all([
    buffer.gsusdBalance(),
    buffer.effectiveMinGsusdReserve(),
    buffer.autoMinGsusdReserve(),
    buffer.minGsusdReserve(),
  ]);
  return { balance, floor, automaticFloor, governedMinimum, withdrawable: balance > floor ? balance - floor : 0n };
}

/** Deterministic per (recipient, amount, memo): re-running the command finds its own operation. */
export function withdrawalSalt(to: string, amount: bigint, memo: string): string {
  return operationSalt("surplus-withdrawal", ["address", "uint256", "string"], [to, amount, memo]);
}

export async function runSurplusWithdrawal(req: WithdrawalRequest): Promise<WithdrawalOutcome> {
  const log = req.log ?? (() => undefined);
  await validateRequest(req, log);
  const signerAddress = await req.signer.getAddress();
  const headroom = await readHeadroom(req.buffer);
  log(
    `Buffer ${formatGsusd(headroom.balance)}, floor ${formatGsusd(headroom.floor)} ` +
      `(automatic 2% ${formatGsusd(headroom.automaticFloor)}, governed minimum ${formatGsusd(headroom.governedMinimum)}), ` +
      `withdrawable ${formatGsusd(headroom.withdrawable)}.`
  );
  log(`Requested ${formatGsusd(req.amount)} to ${req.to} (memo "${req.memo}").`);

  const route = await resolveGovernancePath(req.buffer, signerAddress, req.timelock);
  if (route.path === "direct") return withdrawDirect(req, log);
  const outcome = await advanceTimelock({
    timelock: route.timelock,
    signer: req.signer,
    target: await req.buffer.getAddress(),
    data: req.buffer.interface.encodeFunctionData("withdrawGsusd", [req.to, req.amount]),
    salt: withdrawalSalt(req.to, req.amount, req.memo),
    label: "withdrawGsusd",
    confirm: req.confirm,
    guard: () => requireHeadroom(req.buffer, req.amount),
    log,
  });
  return { path: "timelock", ...outcome };
}

async function validateRequest(req: WithdrawalRequest, log: Logger): Promise<void> {
  if (req.amount <= 0n) throw new Error("Amount must be positive.");
  if (req.memo.trim().length === 0) {
    throw new Error("Memo is required: it labels the withdrawal and keys the timelock operation.");
  }
  if (!ethers.isAddress(req.to) || req.to === ethers.ZeroAddress) {
    throw new Error(`Bad recipient: ${req.to}`);
  }
  const to = req.to.toLowerCase();
  if (to === (await req.buffer.getAddress()).toLowerCase()) {
    throw new Error("Recipient is the buffer itself.");
  }
  if (req.timelock && to === (await req.timelock.getAddress()).toLowerCase()) {
    throw new Error("Recipient is the timelock.");
  }
  const reserved = (req.refuseRecipients ?? []).filter((party) => party.address.toLowerCase() === to);
  if (reserved.length > 0) {
    throw new Error(
      `Recipient ${req.to} is ${reserved.map((party) => party.label).join(" and ")}. Surplus is withdrawn to the operations Safe, ` +
        "which is a separate Safe from the proposer, executor and guardian Safes and from the deployer; set WITHDRAW_TO to it."
    );
  }
  const isContract = (await ethers.provider.getCode(req.to)) !== "0x";
  if (!isContract && !req.allowEoaRecipient) {
    throw new Error(
      `Recipient ${req.to} has no code. The operations Safe is a contract; ` +
        `set WITHDRAW_TO_EOA=YES to pay an externally owned account anyway.`
    );
  }
  log(`Recipient ${req.to} is ${isContract ? "a contract" : "an externally owned account"}.`);
}

async function requireHeadroom(buffer: SurplusBuffer, amount: bigint): Promise<void> {
  const { balance, floor, withdrawable } = await readHeadroom(buffer);
  if (amount > withdrawable) {
    throw new Error(
      `Requested ${formatGsusd(amount)} exceeds the ${formatGsusd(withdrawable)} above the floor ` +
        `(balance ${formatGsusd(balance)}, floor ${formatGsusd(floor)}).`
    );
  }
}

async function withdrawDirect(req: WithdrawalRequest, log: Logger): Promise<WithdrawalOutcome> {
  await requireHeadroom(req.buffer, req.amount);
  log("Signer holds GOVERNANCE_ROLE directly (pre-handover): a single withdrawGsusd call.");
  if (!req.confirm) return { step: "dry-run", path: "direct" };
  const tx = await req.buffer.connect(req.signer).withdrawGsusd(req.to, req.amount);
  await tx.wait();
  log(`Withdrawn in ${tx.hash}.`);
  return { step: "withdrawn", path: "direct", txHash: tx.hash };
}
