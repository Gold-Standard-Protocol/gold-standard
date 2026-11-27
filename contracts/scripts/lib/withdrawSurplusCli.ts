/**
 * The pure parts of scripts/withdraw-surplus.ts: what it accepts and the closing line it
 * prints. Snapshot, chain and signer handling live in lib/deploymentContext.ts.
 */
import { ZeroAddress } from "ethers";
import { ForkEnv, parseAddress, parseForkEnv, parseGsusd } from "./deploymentContext";
import type { Snapshot } from "./deploymentContext";
import type { RefusedRecipient, WithdrawalOutcome } from "./surplusWithdrawal";

export interface WithdrawalEnv extends ForkEnv {
  to: string;
  amount: bigint;
  memo: string;
  confirm: boolean;
  allowEoaRecipient: boolean;
}

export function parseWithdrawalEnv(env: NodeJS.ProcessEnv): WithdrawalEnv {
  const to = parseAddress("WITHDRAW_TO", env.WITHDRAW_TO);
  const amount = parseGsusd("WITHDRAW_GSUSD", env.WITHDRAW_GSUSD);
  const memo = (env.WITHDRAW_MEMO ?? "").trim();
  if (memo.length === 0) {
    throw new Error("Set WITHDRAW_MEMO to label this withdrawal (a quarter or an invoice reference).");
  }
  return {
    to,
    amount,
    memo,
    confirm: env.CONFIRM === "YES",
    allowEoaRecipient: env.WITHDRAW_TO_EOA === "YES",
    ...parseForkEnv(env),
  };
}

/**
 * The addresses a withdrawal must never pay, as far as the snapshot names them: the deployer and
 * the proposer, executor and guardian Safes. Surplus goes to the operations Safe, which is none
 * of these (docs/MAINNET.md section 1): revenue in a governance Safe mixes the two, and the
 * deployer key is retired after the ceremony. The zero address (an open executor) is skipped; a
 * snapshot that does not record a party simply contributes nothing.
 */
export function refusedRecipients(snap: Pick<Snapshot, "deployer" | "governanceSafes">): RefusedRecipient[] {
  const named: RefusedRecipient[] = [
    { label: "the deployer", address: snap.deployer },
    ...snap.governanceSafes.proposers.map((address) => ({ label: "the proposer Safe", address })),
    ...snap.governanceSafes.executors.map((address) => ({ label: "the executor Safe", address })),
    ...(snap.governanceSafes.guardian === undefined ? [] : [{ label: "the guardian Safe", address: snap.governanceSafes.guardian }]),
  ];
  return named.filter((party) => party.address !== "" && party.address !== ZeroAddress);
}

export function summarise(outcome: WithdrawalOutcome): string {
  switch (outcome.step) {
    case "dry-run":
      return "Dry run: nothing sent. Re-run with CONFIRM=YES to send.";
    case "withdrawn":
    case "executed":
      return "Withdrawal complete.";
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
      return "Nothing to do: this withdrawal already executed.";
  }
}
