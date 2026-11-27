/**
 * One step of a governance action through the OpenZeppelin v5 TimelockController:
 * schedule it, report the wait, execute it, or report it done. The operation is keyed by
 * a deterministic salt, so the same command run again continues where it left off. When
 * the signer lacks the role a step needs, the exact call for the proposer or executor
 * Safe is returned instead. Nothing is sent unless `confirm` is true, and `guard` runs
 * before every step that would send, whoever the sender is.
 *
 * ExpiringTimelockController (deployments from 2026-11-06) refuses an operation more than
 * GRACE_PERIOD (7 days) after it became ready, while getOperationState still reports it as
 * Ready so the proposers can cancel it. Such an operation is reported as "expired" and
 * nothing is sent. A timelock deployed earlier has no grace period; the step detects that
 * and executes as before.
 */
import { ethers } from "hardhat";
import type { ContractTransactionReceipt, Signer } from "ethers";
import { readGracePeriod } from "./gracePeriod";
import type { ExpiringTimelockController, TimelockController } from "../../typechain-types";

export type TimelockStep =
  | "dry-run"
  | "scheduled"
  | "awaiting-proposer"
  | "waiting"
  | "executed"
  | "awaiting-executor"
  | "expired"
  | "done";

/**
 * The governance timelock: an ExpiringTimelockController from 2026-11-06, a stock
 * TimelockController before. advanceTimelock reads and sends through the expiring ABI either
 * way, so a TimelockOperationExpired revert decodes by name.
 */
export type GovernanceTimelock = TimelockController | ExpiringTimelockController;

/** The TimelockController.schedule / execute arguments, ready for a Safe transaction builder. */
export interface TimelockOperation {
  target: string;
  data: string;
  predecessor: string;
  salt: string;
  delay: bigint;
}

export interface TimelockStepRequest {
  timelock: GovernanceTimelock;
  signer: Signer;
  target: string;
  data: string;
  salt: string;
  /** The governed function, for the log. */
  label: string;
  confirm: boolean;
  /** Runs before schedule and before execute with the phase; throw to refuse the step. */
  guard: (phase: GuardPhase) => Promise<void>;
  log: (line: string) => void;
  /**
   * How to start again once an expired operation is cancelled. Defaults to the advice for a
   * salt derived from a memo; a caller whose salt has no memo says what applies instead.
   */
  restartAdvice?: string;
}

const MEMO_RESTART_ADVICE =
  "Then re-run: once it is cancelled the same memo schedules it afresh and it waits out the full delay again; " +
  "a different memo schedules a new operation without the cancel.";

export interface TimelockStepOutcome {
  step: TimelockStep;
  operationId: string;
  operation: TimelockOperation;
  /** Unix seconds at which a scheduled operation becomes executable. */
  readyAt?: number;
  /** Unix seconds after which the timelock refuses the operation; absent without a grace period. */
  expiresAt?: number;
  txHash?: string;
}

/** A contract that hands its GOVERNANCE_ROLE to the timelock at the handover. */
interface Governed {
  GOVERNANCE_ROLE(): Promise<string>;
  hasRole(role: string, account: string): Promise<boolean>;
}

export type GovernancePath = { path: "direct" } | { path: "timelock"; timelock: GovernanceTimelock };

export type GuardPhase = "schedule" | "execute";

type Logger = (line: string) => void;

interface Context {
  req: TimelockStepRequest;
  /** req.timelock bound to the ExpiringTimelockController ABI. */
  timelock: ExpiringTimelockController;
  signerAddress: string;
  operationId: string;
  operation: TimelockOperation;
}

// OpenZeppelin v5 TimelockController.OperationState
const OPERATION_UNSET = 0n;
const OPERATION_WAITING = 1n;
const OPERATION_READY = 2n;
const OPERATION_DONE = 3n;

/** keccak256(abi.encode(domain, ...values)): distinct per action type, recipient, value and memo. */
export function operationSalt(domain: string, types: readonly string[], values: readonly unknown[]): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", ...types], [domain, ...values])
  );
}

/** Who may act on a governed contract: the signer directly (pre-handover) or the timelock. */
export async function resolveGovernancePath(
  governed: Governed,
  signerAddress: string,
  timelock: GovernanceTimelock | null
): Promise<GovernancePath> {
  const role = await governed.GOVERNANCE_ROLE();
  if (await governed.hasRole(role, signerAddress)) return { path: "direct" };
  if (!timelock) {
    throw new Error(`${signerAddress} does not hold GOVERNANCE_ROLE and no timelock was given.`);
  }
  const timelockAddress = await timelock.getAddress();
  if (!(await governed.hasRole(role, timelockAddress))) {
    throw new Error(`Neither the signer nor the timelock ${timelockAddress} holds GOVERNANCE_ROLE.`);
  }
  return { path: "timelock", timelock };
}

export async function advanceTimelock(req: TimelockStepRequest): Promise<TimelockStepOutcome> {
  const timelock = await ethers.getContractAt("ExpiringTimelockController", await req.timelock.getAddress(), req.signer);
  const operation: TimelockOperation = {
    target: req.target,
    data: req.data,
    predecessor: ethers.ZeroHash,
    salt: req.salt,
    delay: await timelock.getMinDelay(),
  };
  const operationId = await timelock.hashOperation(operation.target, 0n, operation.data, operation.predecessor, operation.salt);
  const ctx: Context = { req, timelock, signerAddress: await req.signer.getAddress(), operationId, operation };
  const state = await timelock.getOperationState(operationId);
  req.log(`Timelock ${await timelock.getAddress()} holds GOVERNANCE_ROLE; ${req.label} operation ${operationId}.`);
  switch (state) {
    case OPERATION_UNSET:
      return scheduleOperation(ctx);
    case OPERATION_WAITING:
      return reportWaiting(ctx);
    case OPERATION_READY:
      return executeUnlessExpired(ctx);
    case OPERATION_DONE:
      req.log("Already executed. A further run of this action needs a different memo.");
      return { step: "done", operationId, operation };
    default:
      throw new Error(`Unknown timelock operation state ${state}.`);
  }
}

async function reportWaiting(ctx: Context): Promise<TimelockStepOutcome> {
  const { req, operationId, operation } = ctx;
  const readyAt = Number(await ctx.timelock.getTimestamp(operationId));
  const grace = await gracePeriodOf(ctx.timelock);
  const expiresAt = grace === undefined ? undefined : readyAt + grace;
  req.log(
    `Scheduled and waiting: executable from ${iso(readyAt)}` +
      (expiresAt === undefined ? "." : ` until ${iso(expiresAt)}, after which the timelock refuses it.`)
  );
  req.log(`To withdraw the proposal instead, a timelock canceller (the proposer Safe) calls cancel(${operationId}).`);
  return { step: "waiting", operationId, operation, readyAt, expiresAt };
}

/**
 * ExpiringTimelockController.GRACE_PERIOD in seconds, or undefined for a timelock deployed
 * before 2026-11-06, which has none. Called only after getMinDelay and getOperationState have
 * answered from the same address, so a call that reverts with no data means the function is
 * missing (TimelockController has no fallback). Any other failure, a dropped or timed out
 * request above all, is rethrown: taking it for "no grace period" would go on to execute.
 */
async function gracePeriodOf(timelock: ExpiringTimelockController): Promise<number | undefined> {
  const grace = await readGracePeriod(() => timelock.GRACE_PERIOD());
  return grace === undefined ? undefined : Number(grace);
}

/** A Ready operation past the grace period cannot execute: report it instead of sending. */
async function executeUnlessExpired(ctx: Context): Promise<TimelockStepOutcome> {
  const { req, operationId, operation } = ctx;
  const grace = await gracePeriodOf(ctx.timelock);
  if (grace === undefined) {
    req.log("This timelock predates 2026-11-06 and has no grace period: a matured operation stays executable until it runs or is cancelled.");
    return executeOperation(ctx, undefined);
  }
  const readyAt = Number(await ctx.timelock.getTimestamp(operationId));
  const expiresAt = readyAt + grace;
  if (!(await ctx.timelock.isOperationExpired(operationId))) return executeOperation(ctx, expiresAt);
  const timelockAddress = await ctx.timelock.getAddress();
  req.log(
    `Expired: executable from ${iso(readyAt)} until ${iso(expiresAt)}; the timelock now refuses it for good ` +
      "(TimelockOperationExpired). Nothing was sent."
  );
  req.log(
    `To act, a timelock canceller (the proposer Safe, which holds CANCELLER_ROLE) first clears it from the queue ` +
      `with cancel(${operationId}):`
  );
  req.log(`  to:     ${timelockAddress}`);
  req.log(`  method: cancel`);
  req.log(`  id:     ${operationId}`);
  req.log(req.restartAdvice ?? MEMO_RESTART_ADVICE);
  return { step: "expired", operationId, operation, readyAt, expiresAt };
}

async function scheduleOperation(ctx: Context): Promise<TimelockStepOutcome> {
  const { req, operation, operationId, timelock } = ctx;
  await req.guard("schedule");
  const base = { operationId, operation };
  if (!(await timelock.hasRole(await timelock.PROPOSER_ROLE(), ctx.signerAddress))) {
    req.log(`${ctx.signerAddress} is not a timelock proposer. The proposer Safe must submit:`);
    describeCall(req.log, await timelock.getAddress(), "schedule", operation, true);
    return { step: "awaiting-proposer", ...base };
  }
  req.log(`Would schedule ${req.label} with a ${operation.delay / 3600n}h delay.`);
  if (!req.confirm) return { step: "dry-run", ...base };
  const tx = await timelock
    .connect(req.signer)
    .schedule(operation.target, 0n, operation.data, operation.predecessor, operation.salt, operation.delay);
  const readyAt = await readyAtFrom(await tx.wait(), timelock, operationId, operation.delay);
  req.log(
    readyAt === undefined
      ? `Scheduled in ${tx.hash}; this gateway has not shown the ready time yet, re-run to see it.`
      : `Scheduled in ${tx.hash}; executable from ${new Date(readyAt * 1000).toISOString()}.`
  );
  return { step: "scheduled", ...base, readyAt, txHash: tx.hash };
}

async function executeOperation(ctx: Context, expiresAt: number | undefined): Promise<TimelockStepOutcome> {
  const { req, operation, operationId, timelock } = ctx;
  await req.guard("execute");
  const base = { operationId, operation, expiresAt };
  const executorRole = await timelock.EXECUTOR_ROLE();
  const mayExecute =
    (await timelock.hasRole(executorRole, ctx.signerAddress)) || (await timelock.hasRole(executorRole, ethers.ZeroAddress));
  const window = expiresAt === undefined ? "" : ` It can run until ${iso(expiresAt)}; after that the timelock refuses it.`;
  if (!mayExecute) {
    req.log(`Delay elapsed, but ${ctx.signerAddress} is not a timelock executor.${window} The executor Safe must submit:`);
    describeCall(req.log, await timelock.getAddress(), "execute", operation, false);
    return { step: "awaiting-executor", ...base };
  }
  req.log(`Delay elapsed: executing.${window}`);
  if (!req.confirm) return { step: "dry-run", ...base };
  const tx = await timelock
    .connect(req.signer)
    .execute(operation.target, 0n, operation.data, operation.predecessor, operation.salt);
  await tx.wait();
  req.log(`Executed in ${tx.hash}.`);
  return { step: "executed", ...base, txHash: tx.hash };
}

/**
 * The ready time from the mined block, not a fresh read: public RPC gateways balance
 * across nodes without read-after-write consistency, so a read straight after the
 * receipt can land on a node that has not seen the schedule yet. If the block is not
 * visible either, such a node answers zero for the operation, which is reported as
 * unknown rather than as 1970.
 */
async function readyAtFrom(
  receipt: ContractTransactionReceipt | null,
  timelock: ExpiringTimelockController,
  operationId: string,
  delay: bigint
): Promise<number | undefined> {
  const block = receipt ? await ethers.provider.getBlock(receipt.blockNumber) : null;
  if (block) return block.timestamp + Number(delay);
  const fromChain = Number(await timelock.getTimestamp(operationId));
  return fromChain > 0 ? fromChain : undefined;
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function describeCall(log: Logger, timelock: string, method: string, op: TimelockOperation, withDelay: boolean): void {
  log(`  to:          ${timelock}`);
  log(`  method:      ${method}`);
  log(`  target:      ${op.target}`);
  log(`  value:       0`);
  log(`  data:        ${op.data}`);
  log(`  predecessor: ${op.predecessor}`);
  log(`  salt:        ${op.salt}`);
  if (withDelay) log(`  delay:       ${op.delay}`);
}
