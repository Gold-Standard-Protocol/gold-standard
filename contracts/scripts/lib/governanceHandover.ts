/**
 * The governance handover as a plan: the transactions still owed, given who administers each
 * contract now. scripts/lib/handoverCeremony.ts runs it for scripts/transfer-governance.ts, and
 * test/GovernanceHandover.test.ts stops it after each of its ten transactions and runs it again.
 *
 * The handover has to be resumable and re-verifiable after a partial failure. The script
 * once sent every transaction unconditionally, behind a census that expected the
 * deployer on every contract. A run that stopped after its first confirmation (a dropped
 * endpoint, a fee spike, an empty wallet) could not be repeated: the census failed on each
 * contract already handed over, and transferGovernance reverts for a deployer that is no longer
 * admin. The snapshot flag was never written either, so the ceremony could not record a handover
 * it had to finish by hand. Each transfer is one transaction that grants the timelock and revokes
 * the caller, so the holder of DEFAULT_ADMIN_ROLE says whether it landed. The SiloFactory alone
 * takes two, and both keys holding the role says its renounce is still owed.
 */
import { ROLE_IDS } from "./roleCensus";
import type { HandoverLabel, HandoverState } from "./roleCensus";

/** The contracts handed over by one transferGovernance call; the SiloFactory has no such function. */
export type TransferLabel = Exclude<HandoverLabel, "siloFactory">;

/**
 * The order the transactions go out in. The stablecoin first: if a run stops, the role that
 * matters most to have moved is the one that decides who may mint. The wrapper belongs to
 * it: a deployer left as its admin could grant itself PROPOSER_ROLE and drive the timelock
 * after the handover. The SiloFactory last, in its two transactions.
 */
export const HANDOVER_ORDER: ReadonlyArray<HandoverLabel> = [
  "stablecoin",
  "oracle",
  "vault",
  "stabilityModule",
  "surplusBuffer",
  "stabilityPool",
  "reserve",
  "governance",
  "siloFactory",
];

/** The contract behind each label, for log lines and refusals. */
export const HANDOVER_CONTRACT_NAMES: Readonly<Record<HandoverLabel, string>> = {
  stablecoin: "GoldStablecoin",
  oracle: "GoldOracle",
  vault: "GoldVault",
  stabilityModule: "StabilityModule",
  surplusBuffer: "SurplusBuffer",
  stabilityPool: "StabilityPool",
  reserve: "GoldStabilityReserve",
  governance: "GoldGovernance",
  siloFactory: "SiloFactory",
};

/** A broadcast transaction; `wait` resolves with its receipt once it is mined and rejects if it reverted. */
export interface SentTransaction {
  wait(): Promise<{ blockNumber: number } | null>;
}

/** Pins a read to one block, so that every answer describes the same state. */
export interface ReadAt {
  blockTag?: number;
}

export interface RoleReader {
  /** `at` is always passed, empty when the read is not pinned: the contracts' own typings take it that way. */
  hasRole(role: string, account: string, at: ReadAt): Promise<boolean>;
}

/** A governed contract whose transferGovernance grants the timelock and revokes the caller at once. */
export interface TransferableContract extends RoleReader {
  transferGovernance(timelock: string): Promise<SentTransaction>;
}

/** The SiloFactory: plain AccessControl, handed over by a grant and then a renounce. */
export interface SiloFactoryContract extends RoleReader {
  grantRole(role: string, account: string): Promise<SentTransaction>;
  renounceRole(role: string, account: string): Promise<SentTransaction>;
}

/** The nine governed contracts, connected to the deployer. */
export type HandoverContracts = Record<TransferLabel, TransferableContract> & { siloFactory: SiloFactoryContract };

export interface HandoverParties {
  deployer: string;
  timelock: string;
}

/** Who holds DEFAULT_ADMIN_ROLE on one contract. */
export interface AdminHolders {
  deployer: boolean;
  timelock: boolean;
}

export type HandoverAdmins = Record<HandoverLabel, AdminHolders>;
export type HandoverStates = Record<HandoverLabel, HandoverState>;

/** One transaction of the handover. */
export type HandoverStep = { action: "transferGovernance"; label: TransferLabel } | { action: "grantRole" | "renounceRole"; label: "siloFactory" };

async function adminHolders(contract: RoleReader, parties: HandoverParties, at: ReadAt): Promise<AdminHolders> {
  const deployer = await contract.hasRole(ROLE_IDS.DEFAULT_ADMIN_ROLE, parties.deployer, at);
  const timelock = await contract.hasRole(ROLE_IDS.DEFAULT_ADMIN_ROLE, parties.timelock, at);
  return { deployer, timelock };
}

/**
 * Reads, for every governed contract, whether the deployer and the timelock hold
 * DEFAULT_ADMIN_ROLE. With `blockTag` all eighteen reads describe that one block. Without it
 * each read takes the head of its own moment, and a transfer mined between the two reads of
 * one contract shows both keys as admin: a state the handover never leaves, which stopped a
 * healthy rerun and blamed a third party.
 */
export async function readHandoverAdmins(contracts: HandoverContracts, parties: HandoverParties, blockTag?: number): Promise<HandoverAdmins> {
  const at: ReadAt = blockTag === undefined ? {} : { blockTag };
  return {
    stablecoin: await adminHolders(contracts.stablecoin, parties, at),
    oracle: await adminHolders(contracts.oracle, parties, at),
    vault: await adminHolders(contracts.vault, parties, at),
    stabilityModule: await adminHolders(contracts.stabilityModule, parties, at),
    surplusBuffer: await adminHolders(contracts.surplusBuffer, parties, at),
    stabilityPool: await adminHolders(contracts.stabilityPool, parties, at),
    reserve: await adminHolders(contracts.reserve, parties, at),
    governance: await adminHolders(contracts.governance, parties, at),
    siloFactory: await adminHolders(contracts.siloFactory, parties, at),
  };
}

/** The state the holders describe, or undefined when the handover never leaves a contract that way. */
function stateOf(label: HandoverLabel, holders: AdminHolders): HandoverState | undefined {
  if (holders.deployer && holders.timelock) return label === "siloFactory" ? "granted" : undefined;
  if (holders.deployer) return "pending";
  return holders.timelock ? "done" : undefined;
}

function refusal(label: HandoverLabel, holders: AdminHolders): string {
  const name = HANDOVER_CONTRACT_NAMES[label];
  return holders.deployer
    ? `${name}: the deployer and the timelock both hold DEFAULT_ADMIN_ROLE, and transferGovernance grants one and revokes the other in a single transaction`
    : `${name}: neither the deployer nor the timelock holds DEFAULT_ADMIN_ROLE`;
}

/**
 * Where each contract stands. Throws, naming every contract concerned, when the holders describe
 * a state this handover never leaves behind: somebody else has moved a role, so the script stops
 * instead of guessing what is owed.
 */
export function handoverStates(admins: HandoverAdmins): HandoverStates {
  const refused: string[] = [];
  const state = (label: HandoverLabel): HandoverState => {
    const found = stateOf(label, admins[label]);
    if (found === undefined) refused.push(refusal(label, admins[label]));
    return found ?? "pending"; // never returned: a refusal throws below
  };
  const states: HandoverStates = {
    stablecoin: state("stablecoin"),
    oracle: state("oracle"),
    vault: state("vault"),
    stabilityModule: state("stabilityModule"),
    surplusBuffer: state("surplusBuffer"),
    stabilityPool: state("stabilityPool"),
    reserve: state("reserve"),
    governance: state("governance"),
    siloFactory: state("siloFactory"),
  };
  if (refused.length > 0) {
    throw new Error(`DEFAULT_ADMIN_ROLE is held in a way the handover never leaves it:\n${refused.map((line) => `    ${line}`).join("\n")}`);
  }
  return states;
}

/** The transactions still owed, in HANDOVER_ORDER; empty once every contract is the timelock's. */
export function planHandover(states: HandoverStates): HandoverStep[] {
  return HANDOVER_ORDER.flatMap((label): HandoverStep[] => {
    const state = states[label];
    if (label === "siloFactory") {
      if (state === "done") return [];
      const renounce: HandoverStep = { action: "renounceRole", label };
      return state === "granted" ? [renounce] : [{ action: "grantRole", label }, renounce];
    }
    if (state === "granted") {
      throw new Error(`${HANDOVER_CONTRACT_NAMES[label]} cannot stand between a grant and a renounce: transferGovernance does both in one transaction`);
    }
    return state === "pending" ? [{ action: "transferGovernance", label }] : [];
  });
}

/**
 * True once the timelock, and not the deployer, administers every governed contract. Read from
 * the holders and not from handoverStates, which throws on a pair it cannot place: the
 * verification that follows the last transaction must name each failing contract instead.
 */
export function adminsHandedOver(admins: HandoverAdmins): boolean {
  return HANDOVER_ORDER.every((label) => !admins[label].deployer && admins[label].timelock);
}

function send(contracts: HandoverContracts, parties: HandoverParties, step: HandoverStep): Promise<SentTransaction> {
  if (step.action === "transferGovernance") return contracts[step.label].transferGovernance(parties.timelock);
  return step.action === "grantRole"
    ? contracts.siloFactory.grantRole(ROLE_IDS.DEFAULT_ADMIN_ROLE, parties.timelock)
    : contracts.siloFactory.renounceRole(ROLE_IDS.DEFAULT_ADMIN_ROLE, parties.deployer);
}

/**
 * Sends each step and waits for it to mine before the next, so a failure leaves a state
 * handoverStates can read and planHandover can continue from: nothing is sent after a step
 * that failed. Returns the block the last step was mined in, which the verification that
 * follows must not read behind.
 */
export async function runHandover(
  contracts: HandoverContracts,
  parties: HandoverParties,
  steps: ReadonlyArray<HandoverStep>,
  log: (line: string) => void = () => undefined
): Promise<number | undefined> {
  let minedAt: number | undefined;
  for (const [index, step] of steps.entries()) {
    log(`[${index + 1}/${steps.length}] ${HANDOVER_CONTRACT_NAMES[step.label]}.${step.action}...`);
    const receipt = await (await send(contracts, parties, step)).wait();
    if (receipt) minedAt = receipt.blockNumber;
  }
  return minedAt;
}
