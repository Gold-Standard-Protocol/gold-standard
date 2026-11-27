/**
 * The deploy ceremony itself: create the contracts, wire them, register PAXG, seed the oracle
 * and build the deployment snapshot. scripts/deploy.ts supplies the gates, the journal file and
 * the snapshot file; test/DeployCeremony.test.ts runs this on the Hardhat network, stops it part
 * way and resumes it, so the path a resumed ceremony takes is tested.
 *
 * Resumable. The journal (lib/deployJournal.ts) is saved after every creation and every wiring
 * step, and with the hash of each transaction before its receipt is awaited. A run handed a
 * journal first settles the transaction it was waiting on, then checks every journaled entry
 * against the chain (the creation receipt is the deployer's and names the address, code is
 * there; a step's receipt succeeded and, where the setting is readable, the chain shows the
 * configured value) and sends only what is still owed. A step whose setting the chain already
 * shows is recorded without a transaction, which also covers one that landed after the journal
 * lost track of it; the steps that cannot be sent twice (collateral registration, the silo lock,
 * fee initialisation) all have such a check. Creations have no setting to check, so a pending
 * creation the endpoint does not know is sent again at its own nonce rather than dropped.
 *
 * Waits. No wait is open-ended: a transaction that is not mined within the wait timeout (20
 * minutes unless DEPLOY_WAIT_TIMEOUT_MINUTES says otherwise) stops the run with its hash and
 * nonce and the way to resume. The ceremony never replaces a transaction, a creation least of
 * all. A creation the operator replaced by hand reaches the journal only through
 * adoptReplacedCreation, which checks it against the chain first.
 *
 * Reads. Every read after a transaction is pinned to the block of the last receipt this run
 * has seen and retried: a load-balanced endpoint that answers from a node still behind that
 * block fails the read instead of answering with the state before the transaction, and the
 * retry waits for it to catch up. Transactions wait for one confirmation, as
 * before; the ceremony is budgeted at fifteen minutes for at most forty-six of them: eleven
 * creations (twelve contracts, since GoldGovernance creates its timelock) and up to thirty-five
 * further transactions (lib/preflight.ts WIRING_TRANSACTIONS), one of which has the
 * GoldStablecoinDeployer create the token, the thirteenth contract.
 */
import { config as hardhatConfig, ethers } from "hardhat";
import { getCreateAddress, isError, keccak256, ZeroAddress, ZeroHash } from "ethers";
import type { BaseContract, ContractTransactionResponse, Provider, TransactionReceipt, TransactionRequest } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { LaunchParameters, parameterHash, parameterRecord } from "./launchEnv";
import {
  DeployJournal,
  JournalCreation,
  JournalPending,
  JournalStep,
  journalHighestBlock,
  withCreation,
  withPending,
  withStep,
  withoutPending,
} from "./deployJournal";
import { describeError } from "./redact";
import type { StablecoinAddressPlan } from "./stablecoinAddress";

export interface DeployConfig extends LaunchParameters {
  reserveRestrictedSpreadPpm: bigint;
  reserveSpreadCurve: { coverageAtLeastPpm: bigint; spreadPpm: bigint }[];
}

/**
 * The launch parameters plus what the ceremony fixes itself: the reserve spread curve and
 * restricted spread, the first libs/peg-sim run's starting curve, all governance-settable afterwards.
 */
export function deployConfig(params: LaunchParameters): DeployConfig {
  return {
    ...params,
    reserveRestrictedSpreadPpm: 20_000n,
    reserveSpreadCurve: [
      { coverageAtLeastPpm: 150_000n, spreadPpm: 5_000n }, // top tier at the MIN_SPREAD floor (0.5%), never below the feeds' deviation triggers
      { coverageAtLeastPpm: 100_000n, spreadPpm: 5_000n },
      { coverageAtLeastPpm: 50_000n, spreadPpm: 7_500n },
      { coverageAtLeastPpm: 20_000n, spreadPpm: 12_500n },
    ],
  };
}

/** A refusal for the operator to read: the journal and the chain disagree, or a read never settled. */
export class DeployRefused extends Error {}

/** The block every read is pinned to. */
export interface ReadAt {
  blockTag: number;
}

export interface ReadRetry {
  attempts: number;
  delayMs: number;
}

/** About twelve seconds, one mainnet block, before a read that keeps failing stops the ceremony. */
export const READ_RETRY: ReadRetry = { attempts: 7, delayMs: 2_000 };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `read` at `at`, tried `retry.attempts` times. A node behind the pinned block errors rather
 * than answering with older state, so an error is worth retrying; one that persists is a refusal.
 */
export async function pinnedRead<T>(read: (at: ReadAt) => Promise<T>, at: ReadAt, retry: ReadRetry, what: string): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= retry.attempts; attempt++) {
    try {
      return await read(at);
    } catch (err) {
      last = err;
      if (attempt < retry.attempts) await sleep(retry.delayMs);
    }
  }
  throw new DeployRefused(
    `${what}: the read at block ${at.blockTag} failed ${retry.attempts} times (${describeError(last).slice(0, 200)}). ` +
      "Nothing further was sent. Run again with DEPLOY_RESUME=1, on another endpoint if this one keeps failing."
  );
}

/** How long the ceremony waits for one transaction to be mined before it stops and says so; DEPLOY_WAIT_TIMEOUT_MINUTES overrides it. */
export const WAIT_TIMEOUT_MINUTES = 20;

/**
 * DEPLOY_WAIT_TIMEOUT_MINUTES as typed: a whole number of minutes from 1 to 1440, or the default
 * when unset. Anything else is refused, never read as "wait for ever".
 */
export function parseWaitTimeoutMinutes(raw: string | undefined): number {
  if (raw === undefined) return WAIT_TIMEOUT_MINUTES;
  const value = raw.trim();
  const minutes = /^[1-9]\d{0,3}$/.test(value) ? Number(value) : 0;
  if (minutes < 1 || minutes > 1440) {
    throw new Error(`DEPLOY_WAIT_TIMEOUT_MINUTES must be a whole number of minutes from 1 to 1440, got "${raw}"; remove the line for the ${WAIT_TIMEOUT_MINUTES} minute default`);
  }
  return minutes;
}

/**
 * What the operator reads when a transaction is not mined in time. Nothing was replaced and
 * nothing further was sent: the journal still holds the transaction and a resume waits for it.
 */
export function waitTimeoutMessage(pending: { kind: "creation" | "step"; id: string; hashes: readonly string[]; nonce: number | undefined }, timeoutMs: number): string {
  const waited = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${timeoutMs} ms`;
  const nonce = pending.nonce === undefined ? "an unrecorded nonce" : `nonce ${pending.nonce}`;
  const replaced =
    pending.kind === "creation"
      ? "If this contract creation is replaced by hand all the same (the same nonce, the same creation data, a higher fee), wait until the replacement is mined, " +
        "then resume with DEPLOY_RESUME=1 DEPLOY_REPLACED_CREATION=<its hash>: the resume checks it against the chain and adopts it."
      : "If this step is replaced by hand all the same, wait until the replacement is mined and resume with DEPLOY_RESUME=1: the resume reads the setting from the chain.";
  return (
    `${pending.id}: ${pending.hashes.length === 1 ? "transaction" : "transactions"} ${pending.hashes.join(", ")} (deployer ${nonce}) ${pending.hashes.length === 1 ? "was" : "were"} not mined within ${waited}. ` +
    "It is most likely still pending because the network fee rose above the fee it was sent with. Nothing further was sent and nothing was replaced; the journal keeps it. " +
    "To resume: wait until the explorer shows it mined, then run the same command again with DEPLOY_RESUME=1, which reads its outcome and sends only what is still owed. " +
    "Running the resume earlier is safe; it waits again. Do not speed it up or cancel it from a wallet: the ceremony never replaces a transaction by itself. " +
    replaced
  );
}

/** The step in which the GoldStablecoinDeployer creates the token: a call, journaled as a step. */
export const STABLECOIN_STEP = "stablecoinDeployer.deploy(salt)";

/** The ids of the ceremony's creations, in the order it creates them; the journal keys them by these. */
export const CREATION_IDS = [
  // First, so its address follows from the deployer's nonce at the start and nothing else:
  // the token's address is computed from it before anything is sent (lib/stablecoinAddress.ts).
  "stablecoinDeployer",
  "xautInactiveFeed",
  "oracle",
  "stabilityModule",
  "vault",
  "surplusBuffer",
  "stabilityPool",
  "reserve",
  "siloFactory",
  "governance",
  "vaultRegistry",
] as const;
export type CreationId = (typeof CREATION_IDS)[number];

/**
 * The creation transactions still owed, for the gas estimate (the preflight's and the deploy's
 * balance check). Constructors that only store an address get a contract address as a filler;
 * when XAUT_FEED is unset its InactiveFeed does not exist yet, so the oracle's estimate stands
 * PAXG_FEED in for it (the constructor reads only decimals()). The token is created by a call to
 * the GoldStablecoinDeployer, which cannot be estimated before that contract exists: a plain
 * creation of GoldStablecoin stands in for it, owed until STABLECOIN_STEP is in `done`.
 */
export async function ceremonyCreationTransactions(params: LaunchParameters, done: ReadonlySet<string> = new Set()): Promise<TransactionRequest[]> {
  const filler = params.paxgToken;
  const factory = (name: string) => ethers.getContractFactory(name);
  const build: Record<CreationId, () => Promise<TransactionRequest>> = {
    stablecoinDeployer: async () => (await factory("GoldStablecoinDeployer")).getDeployTransaction(),
    xautInactiveFeed: async () => (await factory("InactiveFeed")).getDeployTransaction(),
    oracle: async () =>
      (await factory("GoldOracle")).getDeployTransaction(params.paxgFeed, params.xautFeed === "" ? params.paxgFeed : params.xautFeed, params.paxgToken, params.xautToken, params.stalenessThreshold),
    stabilityModule: async () => (await factory("StabilityModule")).getDeployTransaction(),
    vault: async () => (await factory("GoldVault")).getDeployTransaction(filler, filler, filler),
    surplusBuffer: async () => (await factory("SurplusBuffer")).getDeployTransaction(filler),
    stabilityPool: async () => (await factory("StabilityPool")).getDeployTransaction(filler),
    reserve: async () => (await factory("GoldStabilityReserve")).getDeployTransaction(filler, filler),
    siloFactory: async () => (await factory("SiloFactory")).getDeployTransaction(params.siloCap),
    governance: async () => (await factory("GoldGovernance")).getDeployTransaction(params.proposers, params.executors, filler, filler, filler),
    vaultRegistry: async () => (await factory("VaultRegistry")).getDeployTransaction(filler),
  };
  const owed = CREATION_IDS.filter((id) => !done.has(id) && (id !== "xautInactiveFeed" || params.xautFeed === ""));
  const creations = await Promise.all(owed.map((id) => build[id]()));
  return done.has(STABLECOIN_STEP) ? creations : [...creations, await (await factory("GoldStablecoin")).getDeployTransaction()];
}

export interface DeployCeremonyInput {
  cfg: DeployConfig;
  chainId: number;
  networkName: string;
  deployer: HardhatEthersSigner;
  /** A new journal, or the one a stopped run left. */
  journal: DeployJournal;
  /** Persists the journal; called after every change to it. */
  save(journal: DeployJournal): void;
  log(line: string): void;
  /** Runs before each transaction with its creation or step id; the tests stop a run here. */
  beforeSend?(id: string): void | Promise<void>;
  readRetry?: ReadRetry;
  /** How long to wait for one transaction to be mined, in milliseconds; WAIT_TIMEOUT_MINUTES when absent. */
  waitTimeoutMs?: number;
  /** The token's CREATE2 salt and the address it is meant to give; the zero salt and no expectation when absent. */
  stablecoin?: StablecoinAddressPlan;
}

/** deployments/<network>.json as deploy.ts writes it. */
export interface DeploymentSnapshot {
  chainId: number;
  network: string;
  deployer: string;
  deployedAt: string;
  deployBlock: number;
  creationBlocks: Record<string, number>;
  addresses: Record<string, string>;
  config: Record<string, unknown>;
  build: { solc: string; settings: unknown; runtimeCodeHashes: Record<string, string> };
  governanceTransferred: false;
  /** The contract that created the token with CREATE2, and the salt it used. */
  stablecoinDeployer: { address: string; salt: string };
}

/** What create() hands a factory's deploy: the nonce to send a held creation again at, or nothing. */
interface DeployOverrides {
  nonce?: number;
}

const same = (a: string | null | undefined, b: string): boolean => (a ?? "").toLowerCase() === b.toLowerCase();

/** Every hash the pending entry was sent under: the latest first, then those sent before it at the same nonce. */
const pendingHashes = (pending: JournalPending): string[] => [pending.txHash, ...(pending.earlier ?? [])];

/** The journal, the chain and the transactions of one run. */
class Ceremony {
  private journal: DeployJournal;
  private minedAt: number;
  private readonly provider = ethers.provider;
  private readonly retry: ReadRetry;
  private readonly waitTimeoutMs: number;

  constructor(private readonly input: DeployCeremonyInput, head: number) {
    this.waitTimeoutMs = input.waitTimeoutMs ?? WAIT_TIMEOUT_MINUTES * 60_000;
    this.journal = input.journal;
    // Never behind anything this ceremony has mined, and never so far back that a node without
    // archive state could not answer: a resume may come hours after the journal's last entry.
    this.minedAt = Math.max(head, journalHighestBlock(input.journal));
    this.retry = input.readRetry ?? READ_RETRY;
  }

  get entries(): DeployJournal {
    return this.journal;
  }

  log(line: string): void {
    this.input.log(line);
  }

  private save(journal: DeployJournal): void {
    this.journal = journal;
    this.input.save(journal);
  }

  private mined(receipt: TransactionReceipt): void {
    this.minedAt = Math.max(this.minedAt, receipt.blockNumber);
  }

  /** A read pinned to the last receipt this run has seen, retried while the endpoint catches up. */
  read<T>(what: string, read: (at: ReadAt) => Promise<T>): Promise<T> {
    return pinnedRead(read, { blockTag: this.minedAt }, this.retry, what);
  }

  /**
   * The receipt of `tx` once mined. A transaction still unmined after the wait timeout stops the
   * run with its hash and nonce; it is never replaced here, and the journal keeps it for a resume.
   */
  private async mine(pending: Pick<JournalPending, "kind" | "id" | "nonce">, tx: { hash: string; wait(confirms?: number, timeout?: number): Promise<TransactionReceipt | null> }): Promise<TransactionReceipt | null> {
    try {
      return await tx.wait(1, this.waitTimeoutMs);
    } catch (err) {
      if (isError(err, "TIMEOUT")) throw new DeployRefused(waitTimeoutMessage({ kind: pending.kind, id: pending.id, nonce: pending.nonce, hashes: [tx.hash] }, this.waitTimeoutMs));
      throw err;
    }
  }

  private receipt(what: string, txHash: string): Promise<TransactionReceipt> {
    return this.read(what, async () => {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt) throw new Error(`no receipt for ${txHash}`);
      return receipt;
    });
  }

  /**
   * The receipt of a transaction sent before the stop, once mined; undefined when the endpoint
   * still does not know it after the read retries. A node behind the block that mined it answers
   * null to both reads, so one null proves nothing. A creation sent again has several
   * hashes at one nonce; whichever of them has a receipt is its outcome.
   */
  private async outcomeOf(pending: JournalPending): Promise<TransactionReceipt | undefined> {
    const hashes = pendingHashes(pending);
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      for (const txHash of hashes) {
        const tx = await this.provider.getTransaction(txHash);
        if (tx && hashes.length > 1 && pending.nonce !== undefined) return this.landed(pending.id, hashes, pending.nonce);
        if (tx) {
          try {
            return (await this.mine(pending, tx)) ?? undefined;
          } catch (err) {
            if (isError(err, "CALL_EXCEPTION") && err.receipt) return err.receipt;
            throw err;
          }
        }
        const receipt = await this.provider.getTransactionReceipt(txHash);
        if (receipt) return receipt;
      }
      if (attempt < this.retry.attempts) await sleep(this.retry.delayMs);
    }
    return undefined;
  }

  /**
   * The receipt of whichever of `hashes`, all sent at the deployer's nonce `nonce`, is mined.
   * tx.wait() on one of them never returns once another takes the nonce: ethers gives a
   * deployment response no start block to look for a replacement from. So every
   * receipt is polled, and a nonce the endpoint keeps showing as spent with none of them mined
   * stops the run; the journal keeps all the hashes for the resume.
   */
  private async landed(id: string, hashes: readonly string[], nonce: number): Promise<TransactionReceipt> {
    const deployer = this.input.deployer.address;
    const deadline = Date.now() + this.waitTimeoutMs;
    let spent = 0;
    for (;;) {
      for (const txHash of hashes) {
        const receipt = await this.provider.getTransactionReceipt(txHash);
        if (receipt) return receipt;
      }
      if (Date.now() >= deadline) throw new DeployRefused(waitTimeoutMessage({ kind: "creation", id, hashes, nonce }, this.waitTimeoutMs));
      if ((await this.provider.getTransactionCount(deployer, "latest")) > nonce && ++spent >= this.retry.attempts) {
        throw new DeployRefused(
          `${id}: the deployer's nonce ${nonce} is spent, yet the endpoint shows no receipt for any transaction sent at it (${hashes.join(", ")}). ` +
            "Nothing further was sent. Run again with DEPLOY_RESUME=1: the journal keeps every one of them, and the resume adopts whichever was mined."
        );
      }
      await sleep(this.retry.delayMs);
    }
  }

  /**
   * A creation the endpoint still does not know. Dropping it and creating the contract again
   * would leave two copies if it did land and this endpoint has not caught up, and creations have
   * no setting to check. So it stays pending and create() sends it again at its own nonce: of the
   * original and the copy, at most one can be mined. A nonce the chain shows as spent is refused.
   */
  private async holdUnknownCreation(pending: JournalPending, nonce: number): Promise<void> {
    const deployer = this.input.deployer.address;
    const mined = await this.read("the deployer's nonce", () => this.provider.getTransactionCount(deployer, "latest"));
    if (mined > nonce) {
      const address = getCreateAddress({ from: deployer, nonce });
      const code = await this.read(`code at ${address}`, () => this.provider.getCode(address, "latest"));
      throw new DeployRefused(
        `${pending.id}: the network does not know transaction ${pendingHashes(pending).join(" or ")}, yet the deployer's nonce ${nonce} it was sent at is spent ` +
          `(the transaction at that nonce ${code === "0x" ? `left no code at ${address}` : `created ${address}`}). Nothing was sent. ` +
          "Run again with DEPLOY_RESUME=1 once the endpoint shows the transaction. If the creation was replaced by hand from a wallet, find the replacement at that nonce on the explorer " +
          "and resume with DEPLOY_RESUME=1 DEPLOY_REPLACED_CREATION=<its hash>: it is adopted only if the chain shows it mined, sent by the deployer at this nonce, and creating a contract from the same data."
      );
    }
    if (mined < nonce) {
      throw new DeployRefused(
        `${pending.id}: the endpoint shows the deployer's nonce at ${mined}, behind the nonce ${nonce} of transaction ${pending.txHash}. ` +
          "Nothing was sent. Run again with DEPLOY_RESUME=1, on another endpoint if this one keeps lagging."
      );
    }
    this.log(`  the network does not know it; ${pending.id} is sent again at the same nonce ${nonce}, so at most one of the two can land.`);
  }

  /** Records the outcome of the transaction the journal was waiting on when the last run stopped. */
  async settlePending(): Promise<void> {
    const pending = this.journal.pending;
    if (!pending) return;
    this.log(`The last run stopped waiting on ${pending.id} (${pending.txHash}); reading its outcome...`);
    const receipt = await this.outcomeOf(pending);
    if (!receipt && pending.kind === "creation" && pending.nonce !== undefined) {
      await this.holdUnknownCreation(pending, pending.nonce);
      return;
    }
    if (!receipt || receipt.status !== 1) {
      this.log(`  ${receipt ? "it reverted" : "the network does not know it"}; ${pending.id} is checked against the chain and sent again if still owed.`);
      this.save(withoutPending(this.journal));
      return;
    }
    this.mined(receipt);
    if (pending.kind === "creation") {
      if (!receipt.contractAddress) throw new DeployRefused(`${pending.id}: transaction ${receipt.hash} created no contract`);
      this.save(withCreation(this.journal, pending.id, { address: receipt.contractAddress, txHash: receipt.hash, block: receipt.blockNumber }));
    } else {
      this.save(withStep(this.journal, pending.id, { txHash: receipt.hash, block: receipt.blockNumber }));
    }
    this.log(`  it landed in block ${receipt.blockNumber}; recorded.`);
  }

  private async verifyCreation(id: string, entry: JournalCreation): Promise<void> {
    const receipt = await this.receipt(`journal check of ${id}`, entry.txHash);
    const problems: string[] = [];
    if (receipt.status !== 1) problems.push("its creation transaction reverted");
    if (!same(receipt.from, this.input.deployer.address)) problems.push(`its creation transaction was sent by ${receipt.from}`);
    if (!same(receipt.contractAddress, entry.address)) problems.push(`its creation transaction created ${receipt.contractAddress ?? "nothing"}`);
    const code = await this.read(`code of ${id}`, (at) => this.provider.getCode(entry.address, at.blockTag));
    if (code === "0x") problems.push("there is no code at the address");
    if (problems.length > 0) {
      throw new DeployRefused(`The journal places ${id} at ${entry.address} (transaction ${entry.txHash}), but ${problems.join("; ")}. Nothing was sent; investigate before running again.`);
    }
  }

  private async verifyStep(id: string, entry: JournalStep, done?: (at: ReadAt) => Promise<boolean>): Promise<void> {
    if (entry.txHash) {
      const receipt = await this.receipt(`journal check of ${id}`, entry.txHash);
      if (receipt.status !== 1 || !same(receipt.from, this.input.deployer.address)) {
        throw new DeployRefused(`The journal records ${id} as transaction ${entry.txHash}, which the chain shows as ${receipt.status !== 1 ? "reverted" : `sent by ${receipt.from}`}. Nothing was sent; investigate before running again.`);
      }
    }
    if (done && !(await this.read(`journal check of ${id}`, done))) {
      throw new DeployRefused(`The journal records ${id} as done, but the chain does not show its setting. Nothing was sent; investigate before running again.`);
    }
  }

  /**
   * The contract `id`: verified from the journal, or created now and journaled. A creation
   * settlePending held is sent again at the nonce of the one the network did not know; the
   * journal keeps the hashes sent before it, and whichever of them is mined is adopted.
   */
  async create<T extends BaseContract>(id: CreationId, label: string, deploy: (overrides: DeployOverrides) => Promise<T>, attach: (address: string) => Promise<T>): Promise<T> {
    const entry = this.journal.creations[id];
    if (entry) {
      await this.verifyCreation(id, entry);
      this.log(`${label} ${entry.address} (journaled, verified)`);
      return attach(entry.address);
    }
    const pending = this.journal.pending;
    const held = pending?.kind === "creation" && pending.id === id && pending.nonce !== undefined ? pending : undefined;
    await this.input.beforeSend?.(id);
    const contract = await deploy(held ? { nonce: held.nonce } : {});
    const tx = contract.deploymentTransaction();
    if (!tx) throw new Error(`${id}: the factory returned no deployment transaction`);
    // A copy identical to the original has the original's hash; only distinct hashes are kept.
    const earlier = held ? pendingHashes(held).filter((h) => h !== tx.hash) : [];
    // The hash of the creation data ties a replacement named later (adoptReplacedCreation) to this contract.
    this.save(withPending(this.journal, { kind: "creation", id, txHash: tx.hash, nonce: tx.nonce, dataHash: keccak256(tx.data), ...(earlier.length > 0 ? { earlier } : {}) }));
    const receipt = earlier.length > 0 ? await this.landed(id, [tx.hash, ...earlier], tx.nonce) : await this.mine({ kind: "creation", id, nonce: tx.nonce }, tx);
    if (!receipt?.contractAddress) throw new Error(`${id}: transaction ${receipt?.hash ?? tx.hash} created no contract`);
    this.mined(receipt);
    this.save(withCreation(this.journal, id, { address: receipt.contractAddress, txHash: receipt.hash, block: receipt.blockNumber }));
    this.log(`${label} ${receipt.contractAddress}`);
    return receipt.hash === tx.hash ? contract : attach(receipt.contractAddress);
  }

  /**
   * One wiring transaction. `done` reads whether the chain already shows the setting: then
   * nothing is sent. A step with no `done` is an idempotent setter, sent again when unjournaled.
   */
  async step(id: string, send: () => Promise<ContractTransactionResponse>, done?: (at: ReadAt) => Promise<boolean>): Promise<void> {
    const entry = this.journal.steps[id];
    if (entry) {
      await this.verifyStep(id, entry, done);
      return;
    }
    if (done && (await this.read(id, done))) {
      this.save(withStep(this.journal, id, {}));
      this.log(`  ${id}: already in place on chain`);
      return;
    }
    await this.input.beforeSend?.(id);
    const tx = await send();
    this.save(withPending(this.journal, { kind: "step", id, txHash: tx.hash, nonce: tx.nonce }));
    const receipt = await this.mine({ kind: "step", id, nonce: tx.nonce }, tx);
    if (!receipt) throw new Error(`${id}: transaction ${tx.hash} has no receipt`);
    this.mined(receipt);
    this.save(withStep(this.journal, id, { txHash: receipt.hash, block: receipt.blockNumber }));
  }

  creationBlock(id: CreationId): number {
    const entry = this.journal.creations[id];
    if (!entry) throw new Error(`${id} was never created`);
    return entry.block;
  }
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Tells a stopped ceremony about a contract creation that was replaced by hand: `txHash` joins the
 * hashes the journal's pending creation may have been mined under, and the resume adopts whichever
 * of them the chain holds. The ceremony itself never replaces a transaction, so this is the one
 * way a replacement enters the journal, and only after the chain confirms every part of the claim:
 * the transaction is mined, the deployer sent it, at the pending creation's nonce, as a contract
 * creation, from the same creation data. Returns the journal to save; throws DeployRefused, with
 * the journal untouched, when any part does not hold.
 */
export async function adoptReplacedCreation(provider: Provider, journal: DeployJournal, txHash: string): Promise<DeployJournal> {
  const refuse = (why: string): never => {
    throw new DeployRefused(`DEPLOY_REPLACED_CREATION ${txHash} is not adopted: ${why}. The journal is unchanged and nothing was sent.`);
  };
  if (!TX_HASH.test(txHash)) refuse("it is not a transaction hash (0x and 64 hex digits)");
  const pending = journal.pending;
  if (!pending) return refuse("the journal is not waiting on any transaction, so there is no creation to replace; run with DEPLOY_RESUME=1 alone");
  if (pending.kind !== "creation") return refuse(`the journal is waiting on the step ${pending.id}, not on a contract creation; a replaced step needs no flag, run with DEPLOY_RESUME=1 alone`);
  if (pending.nonce === undefined) return refuse(`the journal does not record the nonce ${pending.id} was sent at`);
  if (pendingHashes(pending).some((hash) => same(hash, txHash))) return journal;

  const tx = await provider.getTransaction(txHash);
  if (!tx) return refuse("the endpoint does not know this transaction; check the hash, and wait until the explorer shows it mined");
  const problems: string[] = [];
  if (!same(tx.from, journal.deployer)) problems.push(`it was sent by ${tx.from}, not by the deployer ${journal.deployer}`);
  if (tx.nonce !== pending.nonce) problems.push(`it was sent at nonce ${tx.nonce}, and ${pending.id} was sent at nonce ${pending.nonce}`);
  if (tx.to !== null) problems.push(`it is a call to ${tx.to}, not a contract creation`);
  if (pending.dataHash !== undefined && keccak256(tx.data) !== pending.dataHash) problems.push(`its creation data differs from the data ${pending.id} was sent with, so it would create a different contract`);
  if (problems.length > 0) return refuse(problems.join("; "));
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return refuse("it is not mined yet; wait until the explorer shows it in a block, then run again");
  return withPending(journal, { ...pending, earlier: [...(pending.earlier ?? []), txHash] });
}

/**
 * Runs the ceremony from wherever the journal shows it to stand and returns the snapshot for
 * deployments/<network>.json. The governance handover is not part of it (scripts/transfer-governance.ts).
 */
export async function runDeployCeremony(input: DeployCeremonyInput): Promise<DeploymentSnapshot> {
  const { cfg, deployer, chainId } = input;
  const c = new Ceremony(input, await ethers.provider.getBlockNumber());
  const log = (line: string): void => c.log(line);
  const resumed = Object.keys(input.journal.creations).length + Object.keys(input.journal.steps).length > 0 || input.journal.pending !== undefined;
  // A journal written by a build with other creations (one that created the token directly,
  // say) cannot be carried on: this run would create a second token beside contracts that
  // already point at the first.
  const foreign = Object.keys(input.journal.creations).filter((id) => !(CREATION_IDS as readonly string[]).includes(id));
  if (foreign.length > 0) {
    throw new DeployRefused(`The journal holds ${foreign.join(", ")}, which this version of the ceremony does not create: it was written by another version. Nothing was sent. Resume it with the version that wrote it, or start a new ceremony.`);
  }
  // On mainnet the token's address is fixed in advance; deploy.ts requires the pair, and so does the ceremony.
  if (chainId === 1 && input.stablecoin?.expected === undefined) {
    throw new DeployRefused("The mainnet ceremony creates the token at an address fixed in advance, and none was given (GSUSD_SALT and GSUSD_ADDRESS). Nothing was sent.");
  }
  if (resumed) log(`Resuming the ceremony started ${input.journal.startedAt}: every journaled entry is checked against the chain first.`);
  await c.settlePending();

  // 0. The contract that creates the token. First, so its address is the one the token's
  //    address was computed from.
  log("\n--- Token deployer ---");
  const tokenDeployer = await c.create(
    "stablecoinDeployer",
    "GoldStablecoinDeployer:",
    async (o) => (await ethers.getContractFactory("GoldStablecoinDeployer", deployer)).deploy(o),
    (a) => ethers.getContractAt("GoldStablecoinDeployer", a, deployer)
  );
  const tokenDeployerAddr = await tokenDeployer.getAddress();

  // 1. Core: Oracle, Stablecoin, StabilityModule
  log("\n--- Core contracts ---");
  // XAUT's oracle entry: under open or backstop with XAUT_FEED unset, an InactiveFeed (8 decimals, an
  // all-zero round that every validated read treats as stopped), so XAUT prices nothing. The
  // XAU/USD address cannot serve: setAnchorFeed refuses an anchor a token uses as its feed.
  const xautFeedDeployed = cfg.xautFeed === "";
  let xautFeed = cfg.xautFeed;
  if (xautFeedDeployed) {
    const inactive = await c.create("xautInactiveFeed", "InactiveFeed (XAUT):", async (o) => (await ethers.getContractFactory("InactiveFeed", deployer)).deploy(o), (a) => ethers.getContractAt("InactiveFeed", a, deployer));
    xautFeed = await inactive.getAddress();
  }
  const oracle = await c.create(
    "oracle",
    "GoldOracle:        ",
    async (o) => (await ethers.getContractFactory("GoldOracle", deployer)).deploy(cfg.paxgFeed, xautFeed, cfg.paxgToken, cfg.xautToken, cfg.stalenessThreshold, o),
    (a) => ethers.getContractAt("GoldOracle", a, deployer)
  );
  // The token, created by the deployer contract at the address its salt gives. The contract is
  // asked first: a salt that does not give the expected address stops the ceremony here, with
  // nothing created at the wrong address, and a corrected salt resumes it.
  const plan = input.stablecoin ?? { salt: ZeroHash, expected: undefined };
  const predicted = await c.read("GoldStablecoinDeployer.predict", (at) => tokenDeployer.predict(plan.salt, at));
  const existing = await c.read("GoldStablecoinDeployer.token", (at) => tokenDeployer.token(at));
  if (existing !== ZeroAddress && plan.expected !== undefined && !same(existing, plan.expected)) {
    throw new DeployRefused(`GSUSD_ADDRESS is ${plan.expected}, but the GoldStablecoinDeployer at ${tokenDeployerAddr} has already created the token, at ${existing}, and creates no other. Nothing further was sent; investigate before running again.`);
  }
  if (existing === ZeroAddress && plan.expected !== undefined && !same(predicted, plan.expected)) {
    const hash = await c.read("GoldStablecoinDeployer.initCodeHash", (at) => tokenDeployer.initCodeHash(at));
    throw new DeployRefused(
      `GSUSD_ADDRESS is ${plan.expected}, but the GoldStablecoinDeployer at ${tokenDeployerAddr} would create the token at ${predicted} with GSUSD_SALT. ` +
        `The token was not created. Find the salt again (cast create2 --deployer ${tokenDeployerAddr} --init-code-hash ${hash}), set GSUSD_SALT and GSUSD_ADDRESS, and run again with DEPLOY_RESUME=1.`
    );
  }
  await c.step(STABLECOIN_STEP, () => tokenDeployer.deploy(plan.salt), async (at) => (await tokenDeployer.token(at)) !== ZeroAddress);
  const stablecoinAddr = await c.read("GoldStablecoinDeployer.token", (at) => tokenDeployer.token(at));
  if (!same(stablecoinAddr, predicted)) {
    throw new DeployRefused(`The GoldStablecoinDeployer at ${tokenDeployerAddr} created the token at ${stablecoinAddr}, not at ${predicted}, the address this salt gives: an earlier run used another salt. Nothing further was sent; investigate before running again.`);
  }
  const stablecoin = await ethers.getContractAt("GoldStablecoin", stablecoinAddr, deployer);
  // The token gives its admin role to its creator, the deployer contract, which passes it on
  // and gives up its own in the same transaction. The ceremony goes no further unless that holds.
  const ADMIN_ROLE = await c.read("DEFAULT_ADMIN_ROLE", (at) => stablecoin.DEFAULT_ADMIN_ROLE(at));
  const [deployerIsAdmin, deployerContractIsAdmin] = await Promise.all([
    c.read("GoldStablecoin admin", (at) => stablecoin.hasRole(ADMIN_ROLE, deployer.address, at)),
    c.read("GoldStablecoin admin", (at) => stablecoin.hasRole(ADMIN_ROLE, tokenDeployerAddr, at)),
  ]);
  if (!deployerIsAdmin || deployerContractIsAdmin) {
    throw new DeployRefused(`GoldStablecoin at ${stablecoinAddr}: ${!deployerIsAdmin ? "the deployer does not hold its admin role" : "the deployer contract still holds its admin role"}. Nothing further was sent; investigate before running again.`);
  }
  log(`GoldStablecoin:     ${stablecoinAddr} (created by the deployer contract)`);
  const stabilityModule = await c.create("stabilityModule", "StabilityModule:   ", async (o) => (await ethers.getContractFactory("StabilityModule", deployer)).deploy(o), (a) => ethers.getContractAt("StabilityModule", a, deployer));
  const oracleAddr = await oracle.getAddress();
  const stabilityModuleAddr = await stabilityModule.getAddress();

  // 2. Vault
  log("\n--- Vault ---");
  const vault = await c.create(
    "vault",
    "GoldVault:         ",
    async (o) => (await ethers.getContractFactory("GoldVault", deployer)).deploy(oracleAddr, stablecoinAddr, stabilityModuleAddr, o),
    (a) => ethers.getContractAt("GoldVault", a, deployer)
  );
  const vaultAddr = await vault.getAddress();

  // 3. New modules
  log("\n--- New modules ---");
  const surplusBuffer = await c.create("surplusBuffer", "SurplusBuffer:     ", async (o) => (await ethers.getContractFactory("SurplusBuffer", deployer)).deploy(stablecoinAddr, o), (a) => ethers.getContractAt("SurplusBuffer", a, deployer));
  const stabilityPool = await c.create("stabilityPool", "StabilityPool:     ", async (o) => (await ethers.getContractFactory("StabilityPool", deployer)).deploy(stablecoinAddr, o), (a) => ethers.getContractAt("StabilityPool", a, deployer));
  const reserve = await c.create("reserve", "GoldStabilityReserve:", async (o) => (await ethers.getContractFactory("GoldStabilityReserve", deployer)).deploy(stablecoinAddr, oracleAddr, o), (a) => ethers.getContractAt("GoldStabilityReserve", a, deployer));
  const surplusBufferAddr = await surplusBuffer.getAddress();
  const stabilityPoolAddr = await stabilityPool.getAddress();
  const reserveAddr = await reserve.getAddress();

  // 4. Silo factory
  log("\n--- Collateral siloing ---");
  const siloFactory = await c.create("siloFactory", "SiloFactory:       ", async (o) => (await ethers.getContractFactory("SiloFactory", deployer)).deploy(cfg.siloCap, o), (a) => ethers.getContractAt("SiloFactory", a, deployer));
  const siloFactoryAddr = await siloFactory.getAddress();

  // 5. Governance
  log("\n--- Governance ---");
  const governance = await c.create(
    "governance",
    "GoldGovernance:    ",
    async (o) => (await ethers.getContractFactory("GoldGovernance", deployer)).deploy(cfg.proposers, cfg.executors, vaultAddr, oracleAddr, stabilityModuleAddr, o),
    (a) => ethers.getContractAt("GoldGovernance", a, deployer)
  );
  // Pinned to the governance receipt's block: an endpoint behind it would otherwise run this
  // against empty code, revert, and stop the ceremony between its creations and its wiring.
  const timelockAddr = await c.read("GoldGovernance.getTimelockAddress", (at) => governance.getTimelockAddress(at));
  log(`Timelock:           ${timelockAddr}`);

  // 6. Role wiring
  log("\n--- Role wiring ---");
  const grant = async (id: string, contract: { grantRole(role: string, account: string): Promise<ContractTransactionResponse>; hasRole(role: string, account: string, at: ReadAt): Promise<boolean> }, role: string, account: string, line: string): Promise<void> => {
    await c.step(id, () => contract.grantRole(role, account), (at) => contract.hasRole(role, account, at));
    log(line);
  };
  const constant = (what: string, read: (at: ReadAt) => Promise<string>): Promise<string> => c.read(what, read);
  const MINTER_ROLE = await constant("MINTER_ROLE", (at) => stablecoin.MINTER_ROLE(at));
  const VAULT_ROLE_SM = await constant("VAULT_ROLE", (at) => stabilityModule.VAULT_ROLE(at));
  const VAULT_ROLE_SB = await constant("VAULT_ROLE", (at) => surplusBuffer.VAULT_ROLE(at));
  const VAULT_ROLE_SP = await constant("VAULT_ROLE", (at) => stabilityPool.VAULT_ROLE(at));
  const VAULT_ROLE_RS = await constant("VAULT_ROLE", (at) => reserve.VAULT_ROLE(at));
  const VAULT_ROLE_SF = await constant("VAULT_ROLE", (at) => siloFactory.VAULT_ROLE(at));

  await grant("stablecoin.grantRole(MINTER_ROLE, vault)", stablecoin, MINTER_ROLE, vaultAddr, "Granted MINTER_ROLE to vault");
  await grant("stabilityModule.grantRole(VAULT_ROLE, vault)", stabilityModule, VAULT_ROLE_SM, vaultAddr, "Granted StabilityModule.VAULT_ROLE to vault");
  await grant("surplusBuffer.grantRole(VAULT_ROLE, vault)", surplusBuffer, VAULT_ROLE_SB, vaultAddr, "Granted SurplusBuffer.VAULT_ROLE to vault");
  await grant("surplusBuffer.grantRole(VAULT_ROLE, reserve)", surplusBuffer, VAULT_ROLE_SB, reserveAddr, "Granted SurplusBuffer.VAULT_ROLE to reserve (for spread deposits)");
  await grant("reserve.grantRole(VAULT_ROLE, vault)", reserve, VAULT_ROLE_RS, vaultAddr, "Granted GoldStabilityReserve.VAULT_ROLE to vault (for penalty gold)");
  await grant("stabilityPool.grantRole(VAULT_ROLE, vault)", stabilityPool, VAULT_ROLE_SP, vaultAddr, "Granted StabilityPool.VAULT_ROLE to vault");
  await grant("siloFactory.grantRole(VAULT_ROLE, vault)", siloFactory, VAULT_ROLE_SF, vaultAddr, "Granted SiloFactory.VAULT_ROLE to vault");
  // Custody lock: from here no key can grant or revoke VAULT_ROLE, so collateral can
  // only ever leave a silo through the vault. One way; SILO_LOCK_VAULT_ROLE=false skips it
  // for throwaway local runs only.
  if (cfg.lockSiloVaultRole) {
    await c.step("siloFactory.lockVaultRole(vault)", () => siloFactory.lockVaultRole(vaultAddr), (at) => siloFactory.vaultRoleLocked(at));
    log("Locked SiloFactory.VAULT_ROLE (permanent)");
  } else {
    if (chainId === 1) {
      throw new Error("SILO_LOCK_VAULT_ROLE=false is not permitted on mainnet: an unlocked VAULT_ROLE is a drain key.");
    }
    log("WARNING: SiloFactory.VAULT_ROLE left unlocked (SILO_LOCK_VAULT_ROLE=false)");
  }

  // 7. Wire modules into vault
  log("\n--- Wiring modules into vault ---");
  await c.step("vault.setSurplusBuffer", () => vault.setSurplusBuffer(surplusBufferAddr), async (at) => same(await vault.surplusBuffer(at), surplusBufferAddr));
  await c.step("vault.setStabilityPool", () => vault.setStabilityPool(stabilityPoolAddr), async (at) => same(await vault.stabilityPool(at), stabilityPoolAddr));
  await c.step("vault.setStabilityReserve", () => vault.setStabilityReserve(reserveAddr), async (at) => same(await vault.stabilityReserve(at), reserveAddr));
  await c.step("vault.setReservePenaltyShare", () => vault.setReservePenaltyShare(cfg.reservePenaltyShareBps), async (at) => (await vault.reservePenaltyShareBps(at)) === cfg.reservePenaltyShareBps);
  // After setSurplusBuffer: the vault refuses a non-zero fee with no buffer to bank it in.
  await c.step("vault.setOriginationFeeBps", () => vault.setOriginationFeeBps(cfg.originationFeeBps), async (at) => (await vault.originationFeeBps(at)) === cfg.originationFeeBps);
  await c.step("vault.setSiloFactory", () => vault.setSiloFactory(siloFactoryAddr), async (at) => same(await vault.siloFactory(at), siloFactoryAddr));
  log("Vault wired to SurplusBuffer, StabilityPool, GoldStabilityReserve, SiloFactory");
  log(`Vault origination fee ${cfg.originationFeeBps} bps`);

  // The registry is a pure index (no funds, no roles): the on-chain list of open vaults and
  // the views a liquidator or an agent needs with nothing but the contracts.
  const vaultRegistry = await c.create("vaultRegistry", "VaultRegistry:     ", async (o) => (await ethers.getContractFactory("VaultRegistry", deployer)).deploy(vaultAddr, o), (a) => ethers.getContractAt("VaultRegistry", a, deployer));
  const vaultRegistryAddr = await vaultRegistry.getAddress();
  await c.step("vault.setVaultRegistry", () => vault.setVaultRegistry(vaultRegistryAddr), async (at) => same(await vault.vaultRegistry(at), vaultRegistryAddr));
  log("VaultRegistry wired");

  // Reserve: fee sink, assets, spread curve, aggregate cap. The reserve is EMPTY at
  // deploy; seedCollateral is permissionless and sized by libs/peg-sim.
  const assetConfigured = (token: string, minReserve: bigint) => async (at: ReadAt): Promise<boolean> => {
    const asset = await reserve.assets(token, at);
    return asset.supported && asset.minReserve === minReserve && asset.dailyCapPpm === cfg.reserveDailyCapPpm;
  };
  await c.step("reserve.setSurplusBuffer", () => reserve.setSurplusBuffer(surplusBufferAddr), async (at) => same(await reserve.surplusBuffer(at), surplusBufferAddr));
  await c.step("reserve.setAssetConfig(PAXG)", () => reserve.setAssetConfig(cfg.paxgToken, true, cfg.reserveMinReservePaxg, cfg.reserveDailyCapPpm), assetConfigured(cfg.paxgToken, cfg.reserveMinReservePaxg));
  if (cfg.xautActive) {
    await c.step("reserve.setAssetConfig(XAUT)", () => reserve.setAssetConfig(cfg.xautToken, true, cfg.reserveMinReserveXaut, cfg.reserveDailyCapPpm), assetConfigured(cfg.xautToken, cfg.reserveMinReserveXaut));
  } else {
    log("XAUT dormant: not a reserve asset");
  }
  // Replaces the whole curve, so sending it again is harmless.
  await c.step("reserve.setSpreadCurve", () => reserve.setSpreadCurve(cfg.reserveSpreadCurve, cfg.reserveRestrictedSpreadPpm));
  await c.step("reserve.setAggregateDailyCap", () => reserve.setAggregateDailyCap(cfg.reserveAggregateDailyCapUsd), async (at) => (await reserve.aggregateDailyCapUsd(at)) === cfg.reserveAggregateDailyCapUsd);
  log("GoldStabilityReserve configured (empty; seed with seedCollateral)");

  // 7a. Oracle anchor wiring — must happen while the deployer still holds
  // GOVERNANCE_ROLE (i.e. before the governance transfer). When no anchor is
  // set, the oracle's cross-feed consistency check is disabled entirely, so
  // production deploys should always set XAU_USD_ANCHOR_FEED.
  if (cfg.anchorFeed) {
    await c.step("oracle.setAnchorFeed", () => oracle.setAnchorFeed(cfg.anchorFeed), async (at) => same(await oracle.anchorFeed(at), cfg.anchorFeed));
    log(`Oracle anchor feed set to ${cfg.anchorFeed}`);
  } else {
    log("WARNING: XAU_USD_ANCHOR_FEED unset — oracle anchor consistency check is DISABLED.");
  }

  // 7a-band. PAXG's gold band (gates borrowing and reserve swaps) and liquidation cap, in the
  // same window as the anchor (GOVERNANCE_ROLE, still the deployer's). Both start at the oracle's
  // defaults; a setter runs only for a value that differs.
  await c.step("oracle.setGoldBand(PAXG)", () => oracle.setGoldBand(cfg.paxgToken, cfg.paxgGoldBandPpm), async (at) => (await oracle.goldBandPpm(cfg.paxgToken, at)) === cfg.paxgGoldBandPpm);
  await c.step("oracle.setLiquidationClamp(PAXG)", () => oracle.setLiquidationClamp(cfg.paxgToken, cfg.paxgLiquidationClampPpm), async (at) => (await oracle.liquidationClampPpm(cfg.paxgToken, at)) === cfg.paxgLiquidationClampPpm);
  log(`PAXG gold band ${cfg.paxgGoldBandPpm} ppm, liquidation cap ${cfg.paxgLiquidationClampPpm} ppm`);

  // 7a-ter. Arm the two vault circuit breakers. Both are no-ops at 0 and
  // no script previously set either, so on mainnet they stayed disarmed permanently.
  // Same pre-handover window as the anchor: setters are GOVERNANCE_ROLE-gated and the
  // deployer still holds it here. verify-deployment.ts asserts both against constants.
  await c.step("vault.setBadDebtPauseThreshold", () => vault.setBadDebtPauseThreshold(cfg.badDebtPauseThreshold), async (at) => (await vault.badDebtPauseThreshold(at)) === cfg.badDebtPauseThreshold);
  log(`Vault bad-debt auto-pause threshold set to ${cfg.badDebtPauseThreshold}`);
  await c.step("vault.setPerBlockMintCap", () => vault.setPerBlockMintCap(cfg.perBlockMintCap), async (at) => (await vault.perBlockMintCap(at)) === cfg.perBlockMintCap);
  log(`Vault per-block mint cap set to ${cfg.perBlockMintCap}`);
  await c.step("vault.setMinDebt", () => vault.setMinDebt(cfg.minDebt), async (at) => (await vault.minDebt(at)) === cfg.minDebt);
  await c.step("vault.setUnderwaterDiscount", () => vault.setUnderwaterDiscount(cfg.underwaterDiscountPpm), async (at) => (await vault.underwaterDiscountPpm(at)) === cfg.underwaterDiscountPpm);
  log(`Vault minimum debt ${ethers.formatEther(cfg.minDebt)} GSUSD; underwater discount ${cfg.underwaterDiscountPpm} ppm`);

  // 7a-quater. Collateral reserve floor. setMinGsusdReserve was wired but
  // setMinCollateralReserve was never called at all, so penalty gold in the buffer was
  // the one reserve governance could drain to zero with no floor whatsoever. Zero is
  // still the honest default at zero supply; this makes it settable in the ceremony
  // rather than forgotten.
  if (cfg.minCollateralReserve > 0n) {
    await c.step("surplusBuffer.setMinCollateralReserve(PAXG)", () => surplusBuffer.setMinCollateralReserve(cfg.paxgToken, cfg.minCollateralReserve), async (at) => (await surplusBuffer.minCollateralReserve(cfg.paxgToken, at)) === cfg.minCollateralReserve);
    log(`SurplusBuffer PAXG reserve floor set to ${cfg.minCollateralReserve}`);
  } else {
    log("SurplusBuffer collateral reserve floor left at 0 (honest at zero supply).");
  }

  // 7a-bis. SurplusBuffer reserve floor. The 2% policy floor (BUSINESS_MODEL.md section 5)
  // is automatic: the buffer keeps 2% of max(live, one day smoothed) supply by itself.
  // minGsusdReserve is only an optional higher governed minimum; 0 (the default, and the
  // only value the mainnet preflight accepts) leaves the automatic floor alone in force.
  if (cfg.minGsusdReserve > 0n) {
    await c.step("surplusBuffer.setMinGsusdReserve", () => surplusBuffer.setMinGsusdReserve(cfg.minGsusdReserve), async (at) => (await surplusBuffer.minGsusdReserve(at)) === cfg.minGsusdReserve);
    log(`SurplusBuffer governed minimum (minGsusdReserve) set to ${cfg.minGsusdReserve}`);
  }
  const autoFloorBps = await c.read("SurplusBuffer.AUTO_FLOOR_BPS", (at) => surplusBuffer.AUTO_FLOOR_BPS(at));
  const effectiveFloor = await c.read("SurplusBuffer.effectiveMinGsusdReserve", (at) => surplusBuffer.effectiveMinGsusdReserve(at));
  log(`SurplusBuffer reserve floor: automatic, ${autoFloorBps} bps of supply; effective now ${effectiveFloor}`);

  // 7b. Guardian wiring — emergency pause role, bypasses timelock.
  // Must be granted BEFORE governance transfers, because grantGuardianRole is
  // gated on DEFAULT_ADMIN_ROLE (held by deployer pre-transfer).
  log("\n--- Guardian wiring ---");
  const guarded = [
    ["vault", vault],
    ["oracle", oracle],
    ["reserve", reserve],
    ["stabilityPool", stabilityPool],
  ] as const;
  for (const [name, contract] of guarded) {
    const GUARDIAN_ROLE = await c.read(`${name}.GUARDIAN_ROLE`, (at) => contract.GUARDIAN_ROLE(at));
    await c.step(`${name}.grantGuardianRole`, () => contract.grantGuardianRole(cfg.guardian), (at) => contract.hasRole(GUARDIAN_ROLE, cfg.guardian, at));
  }
  log(`Granted GUARDIAN_ROLE on vault, oracle, reserve, pool to ${cfg.guardian}`);

  // 8. Register collateral types. None of these can be sent twice ("Already exists",
  // "Already initialised", "Already added"), so each has its on-chain check.
  log("\n--- Registering collateral types ---");
  const register = async (label: "PAXG" | "XAUT", token: string, params: LaunchParameters["paxg"]): Promise<void> => {
    const id = ethers.keccak256(ethers.solidityPacked(["address"], [token]));
    await c.step(`vault.addCollateralType(${label})`, () => vault.addCollateralType(token, params.minRatio, params.liqRatio, params.liqPenalty, params.debtCeiling), async (at) => (await vault.collateralTypes(id, at)).active);
    await c.step(`stabilityModule.initCollateral(${label})`, () => stabilityModule.initCollateral(id, params.stabilityFeeBps), async (at) => (await stabilityModule.rateAccumulator(id, at)) !== 0n);
    await c.step(`stabilityPool.addCollateralToken(${label})`, () => stabilityPool.addCollateralToken(token), (at) => stabilityPool.isCollateralToken(token, at));
  };
  await register("PAXG", cfg.paxgToken, cfg.paxg);
  log("Registered PAXG (collateral type, stability fee, pool token)");

  // XAUT dormant (open or backstop): the oracle constructor registered it, since its address is an
  // immutable, on an InactiveFeed, so it prices nothing ("No reliable price"). No collateral
  // type, stability fee, pool token or reserve asset; activation is one later governance batch
  // through the timelock, which replaces the feed.
  if (cfg.xautActive) {
    await register("XAUT", cfg.xautToken, cfg.xaut);
    log("Registered XAUT (collateral type, stability fee, pool token)");
  } else {
    log("XAUT dormant: oracle entry only; no collateral type, stability fee or pool token");
  }

  // 8b. Seed the oracle's lastKnownPrice anchors. getTokenPrice is the permissionless,
  // state-changing read that GoldVault.getCollateralisationRatio, the keeper's degraded
  // path and the dapp all price off; until it has run once per token the anchor is zero
  // and the keeper warns `oracle.price-stale` on every pass. Seeding here also proves each
  // feed answers before the ceremony is declared complete. A refusal is reported, not
  // fatal: the snapshot below must still be written, and verify-deployment then fails
  // `oracle:<token>.lastKnownPrice-seeded` until governance or the keeper pokes it.
  const seeded: Array<[string, string]> = [["PAXG", cfg.paxgToken]];
  if (cfg.xautActive) seeded.push(["XAUT", cfg.xautToken]);
  for (const [label, token] of seeded) {
    try {
      await c.step(`oracle.seedLastKnownPrice(${label})`, () => oracle.getTokenPrice(token), async (at) => (await oracle.getLastKnownPrice(token, at)) !== 0n);
      const anchor = await c.read(`oracle.getLastKnownPrice(${label})`, (at) => oracle.getLastKnownPrice(token, at));
      log(`Seeded lastKnownPrice for ${label}: ${ethers.formatUnits(anchor, 8)}`);
    } catch (error) {
      if (error instanceof DeployRefused) throw error;
      const reason = describeError(error).slice(0, 160);
      log(`WARNING: could not seed lastKnownPrice for ${label} (${reason}); poke getTokenPrice before the keeper goes live`);
    }
  }

  return snapshotOf(c, input, {
    addresses: {
      oracle: oracleAddr,
      stablecoin: stablecoinAddr,
      stabilityModule: stabilityModuleAddr,
      vault: vaultAddr,
      surplusBuffer: surplusBufferAddr,
      stabilityPool: stabilityPoolAddr,
      reserve: reserveAddr,
      siloFactory: siloFactoryAddr,
      vaultRegistry: vaultRegistryAddr,
      governance: await governance.getAddress(),
      timelock: timelockAddr,
    },
    xautFeed,
    xautFeedDeployed,
    stablecoinDeployer: { address: tokenDeployerAddr, salt: plan.salt },
    stablecoinBlock: Number(await c.read("GoldStablecoinDeployer.tokenBlock", (at) => tokenDeployer.tokenBlock(at))),
  });
}

async function snapshotOf(
  c: Ceremony,
  input: DeployCeremonyInput,
  built: { addresses: Record<string, string>; xautFeed: string; xautFeedDeployed: boolean; stablecoinDeployer: { address: string; salt: string }; stablecoinBlock: number }
): Promise<DeploymentSnapshot> {
  const { cfg } = input;
  const { addresses, xautFeed, xautFeedDeployed } = built;
  // Each contract's own creation block, from its journaled receipt. verify-deployment.ts and
  // transfer-governance.ts replay every role grant from the first of them (the role census):
  // deployBlock is the vault's, later than the oracle's, the stablecoin's and the stability
  // module's, so a grant made in between would be missed from there. The timelock is created
  // inside the GoldGovernance constructor.
  const creationBlocks = {
    oracle: c.creationBlock("oracle"),
    // The token is created by a call to the deployer contract, which records the block.
    stablecoin: built.stablecoinBlock,
    stabilityModule: c.creationBlock("stabilityModule"),
    vault: c.creationBlock("vault"),
    surplusBuffer: c.creationBlock("surplusBuffer"),
    stabilityPool: c.creationBlock("stabilityPool"),
    reserve: c.creationBlock("reserve"),
    siloFactory: c.creationBlock("siloFactory"),
    vaultRegistry: c.creationBlock("vaultRegistry"),
    governance: c.creationBlock("governance"),
    timelock: c.creationBlock("governance"),
  };
  const runtimeCodeHashes: Record<string, string> = {};
  for (const [name, address] of Object.entries(addresses)) {
    const code = await c.read(`code of ${name}`, (at) => ethers.provider.getCode(address, at.blockTag));
    runtimeCodeHashes[name] = ethers.keccak256(code);
  }
  return {
    chainId: input.chainId,
    network: input.networkName,
    deployer: input.deployer.address,
    deployedAt: new Date().toISOString(),
    // The block the indexer, the dapp's activity feed (VITE_DEPLOY_BLOCK) and verify-deployment
    // start from: the vault's own creation block, never a later head, which would hide the
    // first vaults.
    deployBlock: creationBlocks.vault,
    creationBlocks,
    addresses,
    config: {
      launchCaps: cfg.launchCaps,
      paxgToken: cfg.paxgToken,
      xautToken: cfg.xautToken,
      paxgFeed: cfg.paxgFeed,
      xautFeed,
      // True when deploy.ts created XAUT's InactiveFeed itself (open or backstop with XAUT_FEED unset).
      xautFeedDeployed,
      anchorFeed: cfg.anchorFeed,
      xautActive: cfg.xautActive,
      paxgBackstopMax: cfg.paxgBackstopMax.toString(),
      backstopRehearsal: cfg.backstopRehearsal,
      paxgGoldBandPpm: cfg.paxgGoldBandPpm.toString(),
      paxgLiquidationClampPpm: cfg.paxgLiquidationClampPpm.toString(),
      minGsusdReserve: cfg.minGsusdReserve.toString(),
      reservePenaltyShareBps: cfg.reservePenaltyShareBps.toString(),
      originationFeeBps: cfg.originationFeeBps.toString(),
      minDebt: cfg.minDebt.toString(),
      underwaterDiscountPpm: cfg.underwaterDiscountPpm.toString(),
      reserveDailyCapPpm: cfg.reserveDailyCapPpm.toString(),
      reserveAggregateDailyCapUsd: cfg.reserveAggregateDailyCapUsd.toString(),
      // Recorded from 2026-11-11 so verify-deployment compares each with the chain by equality;
      // before, a wiring call that passed the wrong value printed OK.
      reserveMinReservePaxg: cfg.reserveMinReservePaxg.toString(),
      reserveMinReserveXaut: cfg.reserveMinReserveXaut.toString(),
      reserveSpreadCurve: cfg.reserveSpreadCurve.map((step) => ({ coverageAtLeastPpm: step.coverageAtLeastPpm.toString(), spreadPpm: step.spreadPpm.toString() })),
      reserveRestrictedSpreadPpm: cfg.reserveRestrictedSpreadPpm.toString(),
      minCollateralReserve: cfg.minCollateralReserve.toString(),
      badDebtPauseThreshold: cfg.badDebtPauseThreshold.toString(),
      perBlockMintCap: cfg.perBlockMintCap.toString(),
      lockSiloVaultRole: cfg.lockSiloVaultRole,
      proposers: cfg.proposers,
      executors: cfg.executors,
      guardian: cfg.guardian,
      stalenessThreshold: cfg.stalenessThreshold,
      siloCap: cfg.siloCap.toString(),
      paxg: {
        minRatio: cfg.paxg.minRatio,
        liqRatio: cfg.paxg.liqRatio,
        liqPenalty: cfg.paxg.liqPenalty,
        debtCeiling: cfg.paxg.debtCeiling.toString(),
        stabilityFeeBps: cfg.paxg.stabilityFeeBps,
      },
      xaut: {
        minRatio: cfg.xaut.minRatio,
        liqRatio: cfg.xaut.liqRatio,
        liqPenalty: cfg.xaut.liqPenalty,
        debtCeiling: cfg.xaut.debtCeiling.toString(),
        stabilityFeeBps: cfg.xaut.stabilityFeeBps,
      },
      // The hash of every effective parameter, as printed above and as the preflight recorded it.
      parametersHash: parameterHash(parameterRecord(cfg)),
    },
    // The compiler and settings that produced this bytecode, and the runtime code hash at each
    // address, so source verification and a later rebuild can be checked against the chain.
    build: {
      solc: hardhatConfig.solidity.compilers[0].version,
      settings: hardhatConfig.solidity.compilers[0].settings,
      runtimeCodeHashes,
    },
    governanceTransferred: false,
    stablecoinDeployer: built.stablecoinDeployer,
  };
}
