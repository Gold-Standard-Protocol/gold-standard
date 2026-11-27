/**
 * The in-progress journal of scripts/deploy.ts, deployments/<network>.inprogress.json, and the
 * file gates around it. The ceremony writes the journal after every creation and every wiring
 * step, and once more with the hash of a transaction it has just sent, so a run that stops part
 * way leaves the address book on disk and DEPLOY_RESUME=1 carries it on from there. The journal
 * is bound to the chain, the deployer and the parameters hash: a resume under anything else is
 * refused. Nothing here touches the chain; lib/deployCeremony.ts verifies the journal against it.
 */
import { copyFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const DEPLOY_JOURNAL_SCHEMA = "goldstandard-deploy-journal/1";

/** A contract the ceremony created: where, by which transaction, in which block. */
export interface JournalCreation {
  address: string;
  txHash: string;
  block: number;
}

/** A wiring step that is in place: by this run's transaction, or found already in place (no hash). */
export interface JournalStep {
  txHash?: string;
  block?: number;
}

/** The last transaction sent whose outcome the journal has not recorded yet. */
export interface JournalPending {
  kind: "creation" | "step";
  id: string;
  txHash: string;
  /** The deployer's nonce it was sent at; a creation the network does not know is sent again at this nonce. */
  nonce?: number;
  /**
   * A creation sent again, or replaced by hand and named with DEPLOY_REPLACED_CREATION: the other
   * hashes sent at the same nonce, any one of which may be the one mined.
   */
  earlier?: string[];
  /** keccak256 of a creation's data, so a replacement named later can be shown to create the same contract. Absent from older journals. */
  dataHash?: string;
}

export interface DeployJournal {
  schema: typeof DEPLOY_JOURNAL_SCHEMA;
  network: string;
  chainId: number;
  deployer: string;
  parametersHash: string;
  startedAt: string;
  /** The head block before the first creation; the role census replays grants from here at the latest. */
  startBlock: number;
  creations: Readonly<Record<string, JournalCreation>>;
  steps: Readonly<Record<string, JournalStep>>;
  pending?: JournalPending;
}

export interface JournalBinding {
  chainId: number;
  deployer: string;
  parametersHash: string;
}

/** The file deploy.ts journals into, next to deployments/<network>.json. */
export const deployJournalName = (network: string): string => `${network}.inprogress.json`;

export function newDeployJournal(input: JournalBinding & { network: string; startedAt: string; startBlock: number }): DeployJournal {
  return {
    schema: DEPLOY_JOURNAL_SCHEMA,
    network: input.network,
    chainId: input.chainId,
    deployer: input.deployer,
    parametersHash: input.parametersHash,
    startedAt: input.startedAt,
    startBlock: input.startBlock,
    creations: {},
    steps: {},
  };
}

export function withPending(journal: DeployJournal, pending: JournalPending): DeployJournal {
  return { ...journal, pending };
}

/** A copy of the journal with no pending transaction. */
export function withoutPending(journal: DeployJournal): DeployJournal {
  const copy: DeployJournal = { ...journal };
  delete copy.pending;
  return copy;
}

/** Records a creation; the transaction it settles is no longer pending. */
export function withCreation(journal: DeployJournal, id: string, creation: JournalCreation): DeployJournal {
  return { ...withoutPending(journal), creations: { ...journal.creations, [id]: creation } };
}

/** Records a step; the transaction it settles is no longer pending. */
export function withStep(journal: DeployJournal, id: string, step: JournalStep): DeployJournal {
  return { ...withoutPending(journal), steps: { ...journal.steps, [id]: step } };
}

/** The highest block any journaled transaction was mined in; reads on a resume are never older. */
export function journalHighestBlock(journal: DeployJournal): number {
  const blocks = [
    journal.startBlock,
    ...Object.values(journal.creations).map((c) => c.block),
    ...Object.values(journal.steps).map((s) => s.block ?? 0),
  ];
  return Math.max(...blocks);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseDeployJournal(text: string): DeployJournal {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || raw.schema !== DEPLOY_JOURNAL_SCHEMA) {
    throw new Error(`deploy journal has schema ${isRecord(raw) ? String(raw.schema) : "none"}, expected ${DEPLOY_JOURNAL_SCHEMA}`);
  }
  const { network, chainId, deployer, parametersHash, startedAt, startBlock, creations, steps, pending } = raw;
  if (typeof network !== "string" || typeof chainId !== "number" || typeof deployer !== "string" || typeof parametersHash !== "string" || typeof startedAt !== "string" || typeof startBlock !== "number") {
    throw new Error("deploy journal lacks its network, chain, deployer, parameters hash or start block");
  }
  if (!isRecord(creations) || !isRecord(steps)) throw new Error("deploy journal lacks its creations or steps");
  for (const [id, c] of Object.entries(creations)) {
    if (!isRecord(c) || typeof c.address !== "string" || typeof c.txHash !== "string" || typeof c.block !== "number") {
      throw new Error(`deploy journal creation ${id} lacks its address, transaction or block`);
    }
  }
  for (const [id, s] of Object.entries(steps)) {
    if (!isRecord(s) || (s.txHash !== undefined && typeof s.txHash !== "string") || (s.block !== undefined && typeof s.block !== "number")) {
      throw new Error(`deploy journal step ${id} is malformed`);
    }
  }
  if (pending !== undefined && (!isRecord(pending) || (pending.kind !== "creation" && pending.kind !== "step") || typeof pending.id !== "string" || typeof pending.txHash !== "string" || (pending.nonce !== undefined && !Number.isSafeInteger(pending.nonce)) || (pending.dataHash !== undefined && typeof pending.dataHash !== "string") || (pending.earlier !== undefined && (!Array.isArray(pending.earlier) || !pending.earlier.every((h) => typeof h === "string"))))) {
    throw new Error("deploy journal has a malformed pending transaction");
  }
  return raw as unknown as DeployJournal;
}

/** Why a journal must not be resumed here: empty when it was written for this chain, this deployer and these parameters. */
export function journalBindingProblems(journal: DeployJournal, binding: JournalBinding): string[] {
  const problems: string[] = [];
  if (journal.chainId !== binding.chainId) problems.push(`the journal is for chain ${journal.chainId}, this run is on chain ${binding.chainId}`);
  if (journal.deployer.toLowerCase() !== binding.deployer.toLowerCase()) problems.push(`the journal was written by deployer ${journal.deployer}, this run signs as ${binding.deployer}`);
  if (journal.parametersHash !== binding.parametersHash) {
    problems.push(`the journal was written under parameters hash ${journal.parametersHash}, the environment now hashes to ${binding.parametersHash}; resume with the environment the ceremony started with`);
  }
  return problems;
}

export interface DeployFileGateInput {
  /** Mainnet, or REQUIRE_PREFLIGHT_RECORD=1: the same networks on which the preflight record is mandatory. */
  mandatory: boolean;
  snapshotExists: boolean;
  /** PREFLIGHT_ALLOW_EXISTING_SNAPSHOT=1. */
  allowExistingSnapshot: boolean;
  journalExists: boolean;
  /** DEPLOY_RESUME=1. */
  resume: boolean;
}

export type DeployStart = "fresh" | "resume" | "fresh-discarding-journal";

/**
 * Whether deploy.ts may start, and how. On a mandatory network an existing address book is
 * never replaced without PREFLIGHT_ALLOW_EXISTING_SNAPSHOT=1, and a stopped ceremony is never
 * started over without the operator saying which: resume, or move the journal aside. Elsewhere
 * (testnets, forks, the end-to-end harness, which redeploys on a fresh node every boot) a
 * journal is used only with DEPLOY_RESUME=1 and is otherwise replaced.
 */
export function deployFileGate(input: DeployFileGateInput): { start: DeployStart; problems: string[] } {
  const problems: string[] = [];
  if (input.mandatory && input.snapshotExists && !input.allowExistingSnapshot) {
    problems.push(
      "deployments/<network>.json already exists: a second deploy would replace the address book of a live system. " +
        "Move it aside, or set PREFLIGHT_ALLOW_EXISTING_SNAPSHOT=1 to acknowledge (the old file is kept as a dated copy)"
    );
  }
  if (input.resume && !input.journalExists) problems.push("DEPLOY_RESUME=1 but there is no deployments/<network>.inprogress.json to resume");
  if (!input.resume && input.journalExists && input.mandatory) {
    problems.push(
      "deployments/<network>.inprogress.json exists: a ceremony stopped part way. Run again with DEPLOY_RESUME=1 to carry it on " +
        "(it verifies every journaled step against the chain and sends only what is still owed), or move the journal aside to start over"
    );
  }
  const start: DeployStart = input.resume && input.journalExists ? "resume" : input.journalExists ? "fresh-discarding-journal" : "fresh";
  return { start, problems };
}

/** Writes through a temporary file and a rename, so a crash never leaves a half-written file behind. */
export function writeFileAtomic(file: string, text: string): void {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

/** The dated copy a replaced snapshot is kept under, e.g. mainnet.replaced-2026-11-11T09-30-00-000Z.json. */
export function replacedSnapshotName(file: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(dirname(file), basename(file).replace(/\.json$/, `.replaced-${stamp}.json`));
}

/** Writes the snapshot atomically; with `keepReplaced`, an existing file is first copied aside. Returns that copy's path. */
export function writeSnapshot(file: string, text: string, keepReplaced: boolean, now: Date = new Date()): string | undefined {
  let kept: string | undefined;
  if (keepReplaced && existsSync(file)) {
    kept = replacedSnapshotName(file, now);
    copyFileSync(file, kept);
  }
  writeFileAtomic(file, text);
  return kept;
}
