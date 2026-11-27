/**
 * Calldata for exempting a vault owner from the origination fee after the governance handover
 * (docs/MAINNET.md section 5): GoldVault.setOriginationFeeExempt(account, exempt), a
 * GOVERNANCE_ROLE call, which only the timelock can make once the deployer has handed over.
 *
 * The GoldGovernance wrapper has no propose helper for this call, so it goes to the timelock
 * itself, the way scripts/withdraw-surplus.ts and scripts/set-origination-fee.ts send theirs
 * (lib/timelockStep.ts). GoldGovernance's constructor gives each configured proposer
 * PROPOSER_ROLE and each configured executor EXECUTOR_ROLE on the timelock directly, so:
 *
 *   1. the proposer Safe calls timelock.schedule(vault, 0, data, predecessor, salt, delay);
 *   2. once the delay has passed, and within the timelock's grace period after that, the
 *      executor Safe calls timelock.execute(vault, 0, data, predecessor, salt).
 *
 * Conventions, the same as every other direct timelock operation in these scripts: value 0, no
 * predecessor (bytes32 zero), the delay the timelock's own getMinDelay() (48 hours at launch),
 * and a salt that is keccak256(abi.encode("origination-fee-exempt", account, exempt, memo)), so
 * the same request always maps to the same operation id and a reprint finds it on chain.
 */
import { AbiCoder, Contract, Interface, ZeroAddress, ZeroHash, getAddress, keccak256 } from "ethers";
import type { Provider } from "ethers";
import { readGracePeriod, revertedWithoutData } from "./gracePeriod";

export interface FeeExemption {
  timelock: string;
  vault: string;
  /** The vault owner to exempt, or to stop exempting. */
  account: string;
  exempt: boolean;
  /** Optional label; part of the salt, so the same change can be scheduled again later under another memo. */
  memo: string;
}

export interface SafeTransaction {
  to: string;
  value: "0";
  data: string;
  /** The call in words, for the signers to read against the Safe's own decoding. */
  decoded: string;
}

const SALT_DOMAIN = "origination-fee-exempt";

const vaultInterface = new Interface([
  "function setOriginationFeeExempt(address account, bool exempt)",
  "function originationFeeExempt(address account) view returns (bool)",
  "function GOVERNANCE_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);

const timelockInterface = new Interface([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
  "function cancel(bytes32 id)",
  "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function getMinDelay() view returns (uint256)",
  "function getOperationState(bytes32 id) view returns (uint8)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function GRACE_PERIOD() view returns (uint256)",
  "function isOperationExpired(bytes32 id) view returns (bool)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);

/** EXEMPT as typed: true (the default) grants the exemption, false removes it. Nothing else is read as either. */
export function parseExempt(raw: string | undefined): boolean {
  const value = (raw ?? "true").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`EXEMPT must be true or false, got "${raw}"`);
}

/** The vault's own guard, checked here so a Safe never signs an operation that reverts two days later. */
export function assertExemptionShape(p: FeeExemption): void {
  if (getAddress(p.account) === ZeroAddress) throw new Error('account must not be the zero address; the vault refuses it with "Zero address"');
  if (getAddress(p.vault) === ZeroAddress || getAddress(p.timelock) === ZeroAddress) throw new Error("vault and timelock must not be the zero address");
}

/** The governed call the timelock makes on the vault. */
export function encodeVaultCall(p: FeeExemption): string {
  return vaultInterface.encodeFunctionData("setOriginationFeeExempt", [p.account, p.exempt]);
}

/** Deterministic per (account, exempt, memo), by the convention of lib/timelockStep.ts operationSalt. */
export function exemptionSalt(p: Pick<FeeExemption, "account" | "exempt" | "memo">): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["string", "address", "bool", "string"], [SALT_DOMAIN, p.account, p.exempt, p.memo]));
}

/** TimelockController.hashOperation, computed locally: keccak256(abi.encode(target, value, data, predecessor, salt)). */
export function operationId(p: FeeExemption): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256", "bytes", "bytes32", "bytes32"], [p.vault, 0n, encodeVaultCall(p), ZeroHash, exemptionSalt(p)]));
}

const innerCallText = (p: FeeExemption): string => `GoldVault.setOriginationFeeExempt(account ${getAddress(p.account)}, exempt ${p.exempt})`;

/** What the proposer Safe signs: `to` the timelock, `data` the schedule call. `delay` is the timelock's getMinDelay(). */
export function encodeSchedule(p: FeeExemption, delay: bigint): SafeTransaction {
  assertExemptionShape(p);
  if (delay < 0n) throw new Error("delay must not be negative");
  const salt = exemptionSalt(p);
  return {
    to: getAddress(p.timelock),
    value: "0",
    data: timelockInterface.encodeFunctionData("schedule", [p.vault, 0n, encodeVaultCall(p), ZeroHash, salt, delay]),
    decoded: `TimelockController.schedule(target ${getAddress(p.vault)}, value 0, data ${innerCallText(p)}, predecessor ${ZeroHash}, salt ${salt}, delay ${delay})`,
  };
}

/** What the executor Safe signs once the delay has passed: the same target, data, predecessor and salt. */
export function encodeExecute(p: FeeExemption): SafeTransaction {
  assertExemptionShape(p);
  const salt = exemptionSalt(p);
  return {
    to: getAddress(p.timelock),
    value: "0",
    data: timelockInterface.encodeFunctionData("execute", [p.vault, 0n, encodeVaultCall(p), ZeroHash, salt]),
    decoded: `TimelockController.execute(target ${getAddress(p.vault)}, value 0, payload ${innerCallText(p)}, predecessor ${ZeroHash}, salt ${salt})`,
  };
}

/** What the proposer Safe signs to withdraw the operation, or to clear one the timelock has expired. */
export function encodeCancel(p: FeeExemption): SafeTransaction {
  const id = operationId(p);
  return { to: getAddress(p.timelock), value: "0", data: timelockInterface.encodeFunctionData("cancel", [id]), decoded: `TimelockController.cancel(id ${id})` };
}

export type OperationState = "unset" | "waiting" | "ready" | "done";
const STATES: readonly OperationState[] = ["unset", "waiting", "ready", "done"];

/** The operation and its surroundings as the chain shows them now. */
export interface ExemptionReading {
  /** The id the timelock computes; always equal to operationId(p), which the reader asserts. */
  operationId: string;
  state: OperationState;
  /** The delay a schedule call must carry: the timelock's getMinDelay(), in seconds. */
  delay: bigint;
  /** Absent on a timelock deployed before 2026-11-06, which has no grace period. */
  gracePeriod: bigint | undefined;
  /** Unix seconds from which a scheduled operation executes; absent while it is unset or once it is done. */
  readyAt: number | undefined;
  /**
   * The operation became ready more than the grace period ago: the timelock still reports it as
   * ready (so `state` is "ready") but refuses to execute it, and only a cancel clears it. Always
   * false on a timelock without a grace period.
   */
  expired: boolean;
  /** The timestamp of the latest block, in Unix seconds. */
  chainTime: number;
  /** Whether the vault exempts the account now. */
  exemptNow: boolean;
  /** Whether the timelock holds the vault's GOVERNANCE_ROLE, that is, whether the handover is done. */
  timelockGoverns: boolean;
}

/** Reads the timelock and the vault; throws when the timelock's operation id differs from the local one. */
export async function readExemption(provider: Provider, p: FeeExemption): Promise<ExemptionReading> {
  assertExemptionShape(p);
  const timelock = new Contract(p.timelock, timelockInterface, provider);
  const vault = new Contract(p.vault, vaultInterface, provider);
  const local = operationId(p);
  const onChain = String(await timelock.hashOperation(p.vault, 0n, encodeVaultCall(p), ZeroHash, exemptionSalt(p)));
  if (onChain.toLowerCase() !== local.toLowerCase()) throw new Error(`The timelock computes operation id ${onChain}, the printer ${local}; nothing is printed.`);
  const [delay, stateIndex, timestamp, exemptNow, governanceRole, head] = await Promise.all([
    timelock.getMinDelay() as Promise<bigint>,
    timelock.getOperationState(local) as Promise<bigint>,
    timelock.getTimestamp(local) as Promise<bigint>,
    vault.originationFeeExempt(p.account) as Promise<boolean>,
    vault.GOVERNANCE_ROLE() as Promise<string>,
    provider.getBlock("latest"),
  ]);
  if (!head) throw new Error("The endpoint returned no latest block.");
  const state = STATES[Number(stateIndex)];
  if (state === undefined) throw new Error(`Unknown timelock operation state ${stateIndex}.`);
  const gracePeriod = await readGracePeriod(async () => BigInt(await timelock.GRACE_PERIOD()));
  const readyAt = state === "waiting" || state === "ready" ? Number(timestamp) : undefined;
  const expired = pastGracePeriod({ readyAt, gracePeriod, chainTime: head.timestamp }) || (await readExpired(timelock, local));
  return {
    operationId: local,
    state,
    delay,
    gracePeriod,
    readyAt,
    expired,
    chainTime: head.timestamp,
    exemptNow,
    timelockGoverns: (await vault.hasRole(governanceRole, p.timelock)) as boolean,
  };
}

/** The timelock's own rule (isOperationExpired) applied to the latest block: ready for longer than the grace period. */
function pastGracePeriod(reading: Pick<ExemptionReading, "readyAt" | "gracePeriod" | "chainTime">): boolean {
  if (reading.readyAt === undefined || reading.gracePeriod === undefined) return false;
  return BigInt(reading.chainTime) - BigInt(reading.readyAt) > reading.gracePeriod;
}

/**
 * The timelock's isOperationExpired(id). A timelock deployed before 2026-11-06 lacks the function
 * and never expires an operation, so a revert with no data reads as false; it is called only
 * after the same address has answered other timelock reads. Any other failure is rethrown:
 * taking it for "not expired" would print an execute call the timelock refuses.
 */
async function readExpired(timelock: Contract, id: string): Promise<boolean> {
  try {
    return (await timelock.isOperationExpired(id)) as boolean;
  } catch (error: unknown) {
    if (revertedWithoutData(error)) return false;
    throw error;
  }
}

/** Unix seconds of the last moment an expired operation could have executed; undefined unless the reading is expired. */
export function expiredSince(reading: Pick<ExemptionReading, "expired" | "readyAt" | "gracePeriod">): number | undefined {
  if (!reading.expired || reading.readyAt === undefined || reading.gracePeriod === undefined) return undefined;
  return reading.readyAt + Number(reading.gracePeriod);
}

/** Which of `accounts` hold the timelock's PROPOSER_ROLE (schedule) or EXECUTOR_ROLE (execute). */
export async function timelockRoleHolders(provider: Provider, timelockAddress: string, role: "proposer" | "executor", accounts: readonly string[]): Promise<string[]> {
  const timelock = new Contract(timelockAddress, timelockInterface, provider);
  const roleId = String(role === "proposer" ? await timelock.PROPOSER_ROLE() : await timelock.EXECUTOR_ROLE());
  const held = await Promise.all(accounts.map((account) => timelock.hasRole(roleId, account) as Promise<boolean>));
  return accounts.filter((_, index) => held[index]);
}

/**
 * When the execute call may run, in Unix seconds. For an operation already scheduled the times
 * are exact; for one not yet scheduled they assume the schedule call is mined at `chainTime`, so
 * the real times are later by however long the proposer Safe takes to sign. An expired operation
 * has no window left: the times are those of the fresh schedule that follows its cancel.
 */
export function executionWindow(
  reading: Pick<ExemptionReading, "readyAt" | "chainTime" | "delay" | "gracePeriod"> & Partial<Pick<ExemptionReading, "expired">>
): { earliest: number; latest: number | undefined; exact: boolean } {
  const scheduledAt = reading.expired ? undefined : reading.readyAt;
  const earliest = scheduledAt ?? reading.chainTime + Number(reading.delay);
  return { earliest, latest: reading.gracePeriod === undefined ? undefined : earliest + Number(reading.gracePeriod), exact: scheduledAt !== undefined };
}
