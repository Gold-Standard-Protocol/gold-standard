/**
 * Calldata for the first governed change after launch: raising a collateral's debt ceiling
 * through the GoldGovernance wrapper (docs/LAUNCH.md step 5). After the handover the
 * proposer Safe schedules `proposeDebtCeilingUpdate` and, once the delay has passed (48 hours
 * at launch; `readExecuteWindow` reads the live value), an executor submits `executeProposal`
 * with the same inner vault call and the salt the wrapper used: `bytes32(proposalNonce)` as it
 * stood when the proposal was scheduled.
 *
 * The operation carries the ceiling alone. It used to re-send the ratios read when it was
 * printed, and a timelock operation then never expired, so executing it after a ratio change
 * made while it waited restored the old ratios. The timelock
 * now refuses an operation 7 days after it becomes ready, so execute within that window.
 */
import { Contract, Interface, ZeroAddress, getAddress, id, isHexString, zeroPadValue, toBeHex } from "ethers";
import type { Provider } from "ethers";
import { readGracePeriod } from "./gracePeriod";

/** The largest ceiling the vault accepts: no limit in practice, since debt is bounded by collateral. */
export const UNLIMITED_CEILING = (1n << 256n) - 1n;

/** CEILING_GSUSD as typed: whole GSUSD, or "unlimited" / "max" for no ceiling at all. */
export function parseCeiling(raw: string | undefined): bigint {
  const value = raw?.trim();
  if (!value) throw new Error('Set CEILING_GSUSD, the new ceiling in whole GSUSD (for example 250000), or "unlimited".');
  if (value.toLowerCase() === "unlimited" || value.toLowerCase() === "max") return UNLIMITED_CEILING;
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`CEILING_GSUSD must be a number of GSUSD or "unlimited", got "${value}"`);
  const [whole, fraction = ""] = value.split(".");
  // GSUSD has 18 decimals; a longer fraction cannot be represented and must not be rounded away in silence.
  if (fraction.length > 18) throw new Error(`CEILING_GSUSD carries ${fraction.length} decimal places; GSUSD has 18`);
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
}

export interface CeilingProposal {
  governance: string;
  vault: string;
  token: string;
  debtCeiling: bigint;
}

export interface SafeTransaction {
  to: string;
  value: "0";
  data: string;
}

const governanceInterface = new Interface([
  "function proposeDebtCeilingUpdate(address collateralToken, uint256 debtCeiling)",
  "function executeProposal(address target, bytes data, bytes32 salt)",
]);

const vaultInterface = new Interface(["function setDebtCeiling(address token, uint256 debtCeiling)"]);

/** The wrapper's own guards, checked here so a Safe never signs a transaction that reverts. */
export function assertProposalShape(p: CeilingProposal): void {
  if (getAddress(p.token) === ZeroAddress) throw new Error("token must not be the zero address");
  if (p.debtCeiling < 0n) throw new Error("debtCeiling must not be negative");
}

/** What the proposer Safe signs: `to` the wrapper, `data` the schedule call. */
export function encodeSchedule(p: CeilingProposal): SafeTransaction {
  assertProposalShape(p);
  const data = governanceInterface.encodeFunctionData("proposeDebtCeilingUpdate", [p.token, p.debtCeiling]);
  return { to: p.governance, value: "0", data };
}

/** The inner vault call the wrapper schedules, which `executeProposal` takes back as `data`. */
export function encodeVaultCall(p: CeilingProposal): string {
  return vaultInterface.encodeFunctionData("setDebtCeiling", [p.token, p.debtCeiling]);
}

/** The salt the wrapper used: its proposalNonce at scheduling time, as bytes32. */
export function proposalSalt(nonce: bigint): string {
  return zeroPadValue(toBeHex(nonce), 32);
}

/** What the executor signs after the delay: `executeProposal(vault, innerCall, salt)`. */
export function encodeExecute(p: CeilingProposal, nonceAtSchedule: bigint): SafeTransaction {
  const data = governanceInterface.encodeFunctionData("executeProposal", [p.vault, encodeVaultCall(p), proposalSalt(nonceAtSchedule)]);
  return { to: p.governance, value: "0", data };
}

// ---------------------------------------------------------------- execute window

/** When step 2 may run, in seconds: from `delay` after step 1 confirms, for `gracePeriod` after that. */
export interface ExecuteWindow {
  delay: bigint;
  /** Absent on a timelock deployed before 2026-11-06, which has no grace period. */
  gracePeriod: bigint | undefined;
}

const windowInterface = new Interface([
  "function MIN_DELAY() view returns (uint256)",
  "function timelock() view returns (address)",
  "function getMinDelay() view returns (uint256)",
  "function GRACE_PERIOD() view returns (uint256)",
]);

/**
 * The delay GoldGovernance._schedule applies: its own MIN_DELAY or the timelock's minimum
 * delay, whichever is larger, so a delay governance has raised through updateDelay counts.
 */
export function scheduleDelay(wrapperMinDelay: bigint, timelockMinDelay: bigint): bigint {
  return wrapperMinDelay > timelockMinDelay ? wrapperMinDelay : timelockMinDelay;
}

/** The live window: the wrapper's MIN_DELAY, its timelock's getMinDelay and GRACE_PERIOD. */
export async function readExecuteWindow(provider: Provider, governance: string): Promise<ExecuteWindow> {
  const wrapper = new Contract(governance, windowInterface, provider);
  const timelock = new Contract(String(await wrapper.timelock()), windowInterface, provider);
  const delay = scheduleDelay(BigInt(await wrapper.MIN_DELAY()), BigInt(await timelock.getMinDelay()));
  const gracePeriod = await readGracePeriod(async () => BigInt(await timelock.GRACE_PERIOD()));
  return { delay, gracePeriod };
}

const HOUR = 3600n;
const DAY = 24n * HOUR;

function plural(count: bigint, unit: string): string {
  return `${count} ${unit}${count === 1n ? "" : "s"}`;
}

/** Whole hours where the value is one ("48 hours"), seconds otherwise. */
export function hoursText(seconds: bigint): string {
  return seconds > 0n && seconds % HOUR === 0n ? plural(seconds / HOUR, "hour") : plural(seconds, "second");
}

/** Whole days where the value is one ("7 days"), hours or seconds otherwise. */
export function daysText(seconds: bigint): string {
  return seconds > 0n && seconds % DAY === 0n ? plural(seconds / DAY, "day") : hoursText(seconds);
}

/**
 * A span as a noun phrase: `many` and the count for several units ("those 7 days"), `one` and
 * the bare unit for a single one ("that day"), so a one day grace period does not read "the 1 day".
 */
export function spanText(seconds: bigint, one: string, many: string): string {
  const text = daysText(seconds);
  return text.startsWith("1 ") ? `${one} ${text.slice(2)}` : `${many} ${text}`;
}

/** Step 2's window as the printer words it. */
export function executeWindowText(window: ExecuteWindow): string {
  const from = `from ${hoursText(window.delay)} after step 1 confirms`;
  return window.gracePeriod === undefined
    ? `${from}, with no closing time (this timelock has no grace period)`
    : `${from} and within ${spanText(window.gracePeriod, "the", "the")} after that`;
}

// ---------------------------------------------------------------- deployment probe

/** OpenZeppelin v5 AccessControl's refusal: AccessControlUnauthorizedAccount, selector 0xe2517d3f. */
const accessControlInterface = new Interface(["error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)"]);

/**
 * True only when `revertData` is AccessControlUnauthorizedAccount(address(0), role): the probed
 * function exists and its own role check refused the zero address. Nothing else counts. The
 * vault and the wrapper deployed before 2026-11-06 have neither setDebtCeiling nor
 * proposeDebtCeilingUpdate and no fallback, so a call to either reverts with no data; an
 * address without code answers successfully with no data at all.
 */
export function revealsGuardedFunction(revertData: string | undefined, role: string): boolean {
  if (revertData === undefined || !isHexString(revertData)) return false;
  try {
    const decoded = accessControlInterface.parseError(revertData);
    if (decoded?.name !== "AccessControlUnauthorizedAccount") return false;
    const [account, neededRole] = decoded.args as unknown as [string, string];
    return account === ZeroAddress && neededRole.toLowerCase() === role.toLowerCase();
  } catch {
    // Truncated or malformed data under the right selector is not a refusal either.
    return false;
  }
}

/** The revert data of a failed eth_call, wherever the provider in use puts it. */
export function revertDataOf(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): string | undefined => {
    if (depth > 4 || value === null || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record.data === "string" && isHexString(record.data)) return record.data;
    for (const key of ["data", "error", "info", "cause"]) {
      const found = visit(record[key], depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(error, 0);
}

/** eth_call `data` on `target` from the zero address; true when the function's role check answered. */
async function probeGuarded(provider: Provider, target: string, data: string, role: string): Promise<boolean> {
  try {
    await provider.call({ to: target, from: ZeroAddress, data });
    // Success is never the answer of a role-guarded function to the zero address: an address
    // without code, or a fallback that accepts anything, answers like this.
    return false;
  } catch (error) {
    return revealsGuardedFunction(revertDataOf(error), role);
  }
}

export interface DebtCeilingDeployment {
  vault: string;
  /** The GoldGovernance wrapper; omit it where the script calls the vault directly. */
  governance?: string;
  /** A collateral token the probe names; the role check refuses before it is read. */
  token: string;
}

/**
 * Stops a script built for setDebtCeiling before it prints or sends anything to a deployment
 * that predates it, such as the Sepolia deployment of 2026-11-03: there the printed calldata
 * would revert after the timelock delay, or the ramp would revert without a reason.
 */
export async function assertDebtCeilingSupported(provider: Provider, d: DebtCeilingDeployment): Promise<void> {
  const vaultCall = vaultInterface.encodeFunctionData("setDebtCeiling", [d.token, 0n]);
  if (!(await probeGuarded(provider, d.vault, vaultCall, id("GOVERNANCE_ROLE")))) {
    throw new Error(
      `This deployment predates setDebtCeiling; redeploy required. GoldVault ${d.vault} does not answer ` +
        "setDebtCeiling(address,uint256) with its GOVERNANCE_ROLE check, so the call would revert " +
        "(or the RPC returned no revert data; retry on another endpoint)."
    );
  }
  if (d.governance === undefined) return;
  const proposeCall = governanceInterface.encodeFunctionData("proposeDebtCeilingUpdate", [d.token, 0n]);
  if (!(await probeGuarded(provider, d.governance, proposeCall, id("PROPOSER_ROLE")))) {
    throw new Error(
      `This deployment predates setDebtCeiling; redeploy required. GoldGovernance ${d.governance} does not answer ` +
        "proposeDebtCeilingUpdate(address,uint256) with its PROPOSER_ROLE check, so the schedule call would revert " +
        "(or the RPC returned no revert data; retry on another endpoint)."
    );
  }
}
