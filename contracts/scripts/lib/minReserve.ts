/**
 * Set the SurplusBuffer's optional governed GSUSD minimum, minGsusdReserve.
 *
 * The 2% policy floor (docs/BUSINESS_MODEL.md section 5) no longer depends on this value:
 * SurplusBuffer enforces 2% of max(live supply, one day smoothed supply) by itself
 * (AUTO_FLOOR_BPS), and withdrawGsusd keeps the higher of that and minGsusdReserve
 * (effectiveMinGsusdReserve). minGsusdReserve is therefore an optional higher minimum that
 * only binds above the automatic floor, for example to hold a fixed sum through a supply
 * contraction. Zero, the launch value, leaves the automatic floor alone in force.
 *
 * Same two paths as the withdrawal: the signer directly before the governance handover,
 * the timelock after it, one step per run (lib/timelockStep.ts). The guard runs before
 * every step that would send. It refuses a negative value and, when the value is chosen
 * (a direct call or the schedule step), the value the buffer already holds. At the execute
 * step a value set in the meantime executes as a no-op so the operation closes. A value at
 * or below the automatic floor is allowed with a note that it changes nothing today: no
 * setting can take the effective floor below 2%.
 */
import type { Signer } from "ethers";
import type { SurplusBuffer } from "../../typechain-types";
import { formatGsusd } from "./deploymentContext";
import {
  advanceTimelock,
  GovernanceTimelock,
  GuardPhase,
  operationSalt,
  resolveGovernancePath,
  TimelockOperation,
  TimelockStep,
} from "./timelockStep";
import { describeError } from "./redact";

export type MinReserveStep = "set" | TimelockStep;

/** The automatic floor in basis points, SurplusBuffer.AUTO_FLOOR_BPS. */
export const AUTO_FLOOR_BPS = 200n;
const BPS = 10_000n;

export interface MinReserveRequest {
  buffer: SurplusBuffer;
  timelock: GovernanceTimelock | null;
  signer: Signer;
  floor: bigint;
  /** Optional label; part of the timelock operation key. */
  memo: string;
  confirm: boolean;
  log?: (line: string) => void;
}

export interface MinReserveOutcome {
  step: MinReserveStep;
  path: "direct" | "timelock";
  operationId?: string;
  operation?: TimelockOperation;
  readyAt?: number;
  txHash?: string;
}

type Logger = (line: string) => void;

/** The policy floor: 2% of outstanding supply, rounded down, the least verify-deployment accepts. */
export function policyFloor(supply: bigint): bigint {
  return (supply * 2n) / 100n;
}

/**
 * SurplusBuffer.autoMinGsusdReserve mirrored off chain: AUTO_FLOOR_BPS of the larger of the
 * live and the one day smoothed supply, rounded up.
 */
export function autoFloor(supply: bigint, smoothedSupply: bigint): bigint {
  const base = supply > smoothedSupply ? supply : smoothedSupply;
  return (base * AUTO_FLOOR_BPS + BPS - 1n) / BPS;
}

/** SurplusBuffer.effectiveMinGsusdReserve mirrored off chain. */
export function effectiveFloor(supply: bigint, smoothedSupply: bigint, governedMinimum: bigint): bigint {
  const automatic = autoFloor(supply, smoothedSupply);
  return governedMinimum > automatic ? governedMinimum : automatic;
}

/**
 * What verify-deployment reads from the chain, all at one block. `autoFloorBps` and
 * `effective` are null when the buffer predates the automatic floor and lacks the getters.
 */
export interface ReserveFloorReading {
  supply: bigint;
  smoothedSupply: bigint;
  minReserve: bigint;
  autoFloorBps: bigint | null;
  effective: bigint | null;
}

export type ReservePolicyVerdict = { level: "pass" | "fail"; detail: string };

/**
 * verify-deployment's reading of the floor against the policy. The floor is automatic, so
 * the check asserts that the contract enforces it: the buffer has the automatic floor, its
 * rate is 2%, and the floor it reports is exactly max(minGsusdReserve, 2% of max(supply,
 * smoothed supply)), which is never below 2% of the live supply. A zero governed minimum is
 * the expected launch value and passes.
 */
export function reservePolicyVerdict(reading: ReserveFloorReading): ReservePolicyVerdict {
  const { supply, smoothedSupply, minReserve, autoFloorBps, effective } = reading;
  if (autoFloorBps === null || effective === null) {
    return {
      level: "fail",
      detail:
        "this SurplusBuffer predates the automatic reserve floor (no AUTO_FLOOR_BPS or effectiveMinGsusdReserve): " +
        `only minGsusdReserve (${minReserve}) stands between governance and the first-loss reserve.`,
    };
  }
  if (autoFloorBps !== AUTO_FLOOR_BPS) {
    return { level: "fail", detail: `AUTO_FLOOR_BPS is ${autoFloorBps}, the policy is ${AUTO_FLOOR_BPS} (2%)` };
  }
  const expected = effectiveFloor(supply, smoothedSupply, minReserve);
  if (effective !== expected || effective < policyFloor(supply)) {
    return {
      level: "fail",
      detail:
        `effectiveMinGsusdReserve is ${effective}, expected ${expected} ` +
        `(2% of max(supply ${supply}, smoothed ${smoothedSupply}), or minGsusdReserve ${minReserve} if higher)`,
    };
  }
  const binding = minReserve > autoFloor(supply, smoothedSupply) ? "the governed minimum binds" : "the automatic 2% binds";
  return {
    level: "pass",
    detail: `contract enforces a floor of ${effective} on supply ${supply} (smoothed ${smoothedSupply}); ${binding}`,
  };
}

export function minReserveSalt(floor: bigint, memo: string): string {
  return operationSalt("min-gsusd-reserve", ["uint256", "string"], [floor, memo]);
}

export async function runSetMinReserve(req: MinReserveRequest): Promise<MinReserveOutcome> {
  const log = req.log ?? (() => undefined);
  if (req.floor < 0n) throw new Error("Floor cannot be negative.");
  const signerAddress = await req.signer.getAddress();
  const route = await resolveGovernancePath(req.buffer, signerAddress, req.timelock);
  if (route.path === "direct") return setDirect(req, log);
  const outcome = await advanceTimelock({
    timelock: route.timelock,
    signer: req.signer,
    target: await req.buffer.getAddress(),
    data: req.buffer.interface.encodeFunctionData("setMinGsusdReserve", [req.floor]),
    salt: minReserveSalt(req.floor, req.memo),
    label: "setMinGsusdReserve",
    confirm: req.confirm,
    guard: (phase) => requirePolicy(req, log, phase),
    log,
  });
  return { path: "timelock", ...outcome };
}

async function readAutomaticFloor(buffer: SurplusBuffer): Promise<bigint> {
  try {
    return await buffer.autoMinGsusdReserve();
  } catch (error: unknown) {
    const reason = describeError(error);
    throw new Error(
      `This SurplusBuffer predates the automatic 2% floor (autoMinGsusdReserve failed: ${reason}). ` +
        "This script manages the governed minimum of a buffer that has it; redeploy the buffer first."
    );
  }
}

async function requirePolicy(req: MinReserveRequest, log: Logger, phase: GuardPhase): Promise<void> {
  const [automatic, current] = await Promise.all([readAutomaticFloor(req.buffer), req.buffer.minGsusdReserve()]);
  log(
    `Automatic floor ${formatGsusd(automatic)} (2% of supply, enforced on chain), ` +
      `governed minimum ${formatGsusd(current)}, requested ${formatGsusd(req.floor)}.`
  );
  if (current === req.floor) {
    if (phase === "schedule") throw new Error(`minGsusdReserve is already ${formatGsusd(current)}.`);
    log("Already at this value; executing anyway closes the scheduled operation.");
    return;
  }
  if (req.floor === 0n) {
    log("Zero clears the governed minimum: the automatic 2% floor alone stays in force.");
  } else if (req.floor <= automatic) {
    log(
      `At or below the automatic floor, so it changes nothing today; it binds only if supply ` +
        `falls until 2% of it is below ${formatGsusd(req.floor)}.`
    );
  }
  if (req.floor < current) {
    log("Lowering the governed minimum: the effective floor still never falls below 2% of supply.");
  }
}

async function setDirect(req: MinReserveRequest, log: Logger): Promise<MinReserveOutcome> {
  await requirePolicy(req, log, "schedule");
  log("Signer holds GOVERNANCE_ROLE directly (pre-handover): a single setMinGsusdReserve call.");
  if (!req.confirm) return { step: "dry-run", path: "direct" };
  const tx = await req.buffer.connect(req.signer).setMinGsusdReserve(req.floor);
  await tx.wait();
  log(`Floor set in ${tx.hash}.`);
  return { step: "set", path: "direct", txHash: tx.hash };
}
