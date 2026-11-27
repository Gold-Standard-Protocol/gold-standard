/**
 * Set GoldVault's origination fee, originationFeeBps: the share of each mint the vault keeps
 * and banks in the SurplusBuffer while the borrower owes the full amount. 5 bps at launch
 * (project decision 2026-11-02), governed within 0 to MAX_ORIGINATION_FEE_BPS (100).
 *
 * Same two paths as the governed reserve minimum (lib/minReserve.ts): the signer directly
 * before the governance handover, the timelock after it, one step per run
 * (lib/timelockStep.ts). The guard runs before every step that would send. It refuses a
 * value outside the cap, a non-zero fee while the vault has no SurplusBuffer (the vault
 * would refuse it too), and, when the value is chosen, the value already set. At the execute
 * step a value set in the meantime executes as a no-op so the operation closes.
 */
import { ethers } from "hardhat";
import type { Signer } from "ethers";
import type { GoldVault } from "../../typechain-types";
import {
  advanceTimelock,
  GovernanceTimelock,
  GuardPhase,
  operationSalt,
  resolveGovernancePath,
  TimelockOperation,
  TimelockStep,
} from "./timelockStep";

export type OriginationFeeStep = "set" | TimelockStep;

export interface OriginationFeeRequest {
  vault: GoldVault;
  timelock: GovernanceTimelock | null;
  signer: Signer;
  bps: bigint;
  /** Optional label; part of the timelock operation key. */
  memo: string;
  confirm: boolean;
  log?: (line: string) => void;
}

export interface OriginationFeeOutcome {
  step: OriginationFeeStep;
  path: "direct" | "timelock";
  operationId?: string;
  operation?: TimelockOperation;
  readyAt?: number;
  txHash?: string;
}

type Logger = (line: string) => void;

export function originationFeeSalt(bps: bigint, memo: string): string {
  return operationSalt("origination-fee", ["uint256", "string"], [bps, memo]);
}

/** "0.05%" for 5 bps. */
export function feePercent(bps: bigint): string {
  return `${(Number(bps) / 100).toString()}%`;
}

/** The arbitrage-free ceiling a mint fee puts on GSUSD, 1 / (1 - fee), to four decimals. */
export function pegCeiling(bps: bigint): string {
  return (10_000 / (10_000 - Number(bps))).toFixed(4);
}

export async function runSetOriginationFee(req: OriginationFeeRequest): Promise<OriginationFeeOutcome> {
  const log = req.log ?? (() => undefined);
  const max = await req.vault.MAX_ORIGINATION_FEE_BPS();
  if (req.bps < 0n || req.bps > max) throw new Error(`The fee must be between 0 and ${max} bps; got ${req.bps}.`);
  const signerAddress = await req.signer.getAddress();
  const route = await resolveGovernancePath(req.vault, signerAddress, req.timelock);
  if (route.path === "direct") return setDirect(req, log);
  const outcome = await advanceTimelock({
    timelock: route.timelock,
    signer: req.signer,
    target: await req.vault.getAddress(),
    data: req.vault.interface.encodeFunctionData("setOriginationFeeBps", [req.bps]),
    salt: originationFeeSalt(req.bps, req.memo),
    label: "setOriginationFeeBps",
    confirm: req.confirm,
    guard: (phase) => requirePolicy(req, log, phase),
    log,
  });
  return { path: "timelock", ...outcome };
}

async function requirePolicy(req: OriginationFeeRequest, log: Logger, phase: GuardPhase): Promise<void> {
  const [current, buffer] = await Promise.all([req.vault.originationFeeBps(), req.vault.surplusBuffer()]);
  log(
    `Origination fee ${current} bps (${feePercent(current)}), requested ${req.bps} bps (${feePercent(req.bps)}); ` +
      `GSUSD's arbitrage ceiling becomes $${pegCeiling(req.bps)}.`
  );
  if (req.bps > 0n && buffer === ethers.ZeroAddress) {
    throw new Error("The vault has no SurplusBuffer: a non-zero fee would be burned, so the vault refuses it.");
  }
  if (current === req.bps) {
    if (phase === "schedule") throw new Error(`originationFeeBps is already ${current}.`);
    log("Already at this value; executing anyway closes the scheduled operation.");
  }
}

async function setDirect(req: OriginationFeeRequest, log: Logger): Promise<OriginationFeeOutcome> {
  await requirePolicy(req, log, "schedule");
  log("Signer holds GOVERNANCE_ROLE directly (pre-handover): a single setOriginationFeeBps call.");
  if (!req.confirm) return { step: "dry-run", path: "direct" };
  const tx = await req.vault.connect(req.signer).setOriginationFeeBps(req.bps);
  await tx.wait();
  log(`Fee set in ${tx.hash}.`);
  return { step: "set", path: "direct", txHash: tx.hash };
}
