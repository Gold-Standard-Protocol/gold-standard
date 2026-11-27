import type { Address } from 'viem';
import { goldVaultKeeperAbi } from './abis';
import { KEEPER_EVENTS } from './alerts';
import { classifyCallError } from './callErrors';
import type { KeeperConfig } from './config';
import { describeError, expectBigInt } from './decode';
import type { KeeperBatchResult, KeeperContractCall, KeeperJobDeps } from './ports';

// The debt sweep that opens every liquidation tick: one multicall per chunk of
// owners, a retry, then single reads, so one failing chunk never hides a
// liquidatable vault in another.

/** Owners per multicall when the read client supports batching. */
const OWNER_READ_CHUNK = 200;
/** Most owners named in a vault.owners-unread event; the count carries the rest. */
const UNREAD_OWNERS_NAMED = 50;

export interface DebtSweep {
  debts: Map<Address, bigint>;
  /** Owners whose debt could not be read by batch, retry or single read. */
  unread: Address[];
}

const debtCall = (config: KeeperConfig, owner: Address): KeeperContractCall => ({
  address: config.goldVaultAddress,
  abi: goldVaultKeeperAbi,
  functionName: 'getVaultCurrentDebt',
  args: [owner],
});

/** One batch for a chunk, retried once; undefined when both attempts throw. */
const readChunkWithRetry = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  chunk: readonly Address[]
): Promise<KeeperBatchResult[] | undefined> => {
  const batch = deps.read.readContracts;
  if (batch === undefined) return undefined;
  const calls = chunk.map((owner) => debtCall(config, owner));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await batch.call(deps.read, calls);
    } catch (error) {
      deps.log.warn(KEEPER_EVENTS.jobError, {
        job: 'liquidation-watch',
        detail: `debt batch of ${chunk.length} owners failed (attempt ${attempt + 1} of 2)`,
        reason: describeError(error),
      });
    }
  }
  return undefined;
};

/** Owner-by-owner reads for a chunk whose batches failed; failures are reported, not thrown. */
const readChunkSingly = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  chunk: readonly Address[]
): Promise<DebtSweep> => {
  const debts = new Map<Address, bigint>();
  const unread: Address[] = [];
  for (const owner of chunk) {
    try {
      debts.set(
        owner,
        expectBigInt(await deps.read.readContract(debtCall(config, owner)), 'getVaultCurrentDebt')
      );
    } catch {
      unread.push(owner);
    }
  }
  return { debts, unread };
};

const mergeSweeps = (left: DebtSweep, right: DebtSweep): DebtSweep => ({
  debts: new Map([...left.debts, ...right.debts]),
  unread: [...left.unread, ...right.unread],
});

/** A batch's answers: the debts it read and the owners whose entries failed or did not decode. */
interface BatchEntries {
  debts: Map<Address, bigint>;
  failed: Address[];
  /** True when a failed entry is a transport failure, which a second batch may clear. */
  retryable: boolean;
  /** The first failure's reason, for the log line. */
  reason: string | undefined;
}

const collectEntries = (
  chunk: readonly Address[],
  results: readonly KeeperBatchResult[]
): BatchEntries => {
  const debts = new Map<Address, bigint>();
  const failed: Address[] = [];
  let retryable = false;
  let reason: string | undefined;
  chunk.forEach((owner, index) => {
    const entry = results[index];
    if (entry?.status === 'success') {
      try {
        debts.set(owner, expectBigInt(entry.result, 'getVaultCurrentDebt'));
        return;
      } catch (error) {
        reason ??= describeError(error);
      }
    } else {
      const failure = classifyCallError(entry?.error ?? new Error('no batch entry for this owner'));
      retryable ||= failure.kind === 'unreachable';
      reason ??= failure.kind === 'revert' ? failure.reason : failure.detail;
    }
    failed.push(owner);
  });
  return { debts, failed, retryable, reason };
};

/**
 * One chunk's debts. viem's multicall with allowFailure never throws for a rate-limited or
 * dropped aggregate3 call: it fails every entry of that call instead, so a sweep that
 * retried only on a throw never retried in production, and an owner whose entry failed was
 * neither read nor counted as unread. Failed
 * entries now get one more batch when any failure was the transport's, then single reads,
 * and an owner that still cannot be read is returned as unread.
 */
const readChunk = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  chunk: readonly Address[]
): Promise<DebtSweep> => {
  const results = await readChunkWithRetry(deps, config, chunk);
  if (results === undefined) return readChunkSingly(deps, config, chunk);
  const first = collectEntries(chunk, results);
  if (first.failed.length === 0) return { debts: first.debts, unread: [] };
  deps.log.warn(KEEPER_EVENTS.jobError, {
    job: 'liquidation-watch',
    detail: `${first.failed.length} of ${chunk.length} debt reads failed inside a batch; ${
      first.retryable ? 'retrying them in one batch, then' : 'reading them'
    } one by one`,
    reason: first.reason,
  });
  let sweep: DebtSweep = { debts: first.debts, unread: [] };
  let pending = first.failed;
  if (first.retryable) {
    const retried = await readChunkWithRetry(deps, config, pending);
    if (retried !== undefined) {
      const second = collectEntries(pending, retried);
      sweep = mergeSweeps(sweep, { debts: second.debts, unread: [] });
      pending = second.failed;
    }
  }
  return pending.length === 0 ? sweep : mergeSweeps(sweep, await readChunkSingly(deps, config, pending));
};

/**
 * Debts for every owner in multicall batches, or undefined when the client cannot batch.
 * A chunk whose batch fails twice is read owner by owner, and so are the owners whose
 * entries failed inside a batch, after one more batch when the failure was the transport's.
 * Owners that still cannot be read are returned in `unread`, so every owner is either read
 * or counted.
 */
export const readDebtsInBatches = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  owners: readonly Address[]
): Promise<DebtSweep | undefined> => {
  if (deps.read.readContracts === undefined) return undefined;
  let sweep: DebtSweep = { debts: new Map(), unread: [] };
  for (let start = 0; start < owners.length; start += OWNER_READ_CHUNK) {
    const chunk = owners.slice(start, start + OWNER_READ_CHUNK);
    sweep = mergeSweeps(sweep, await readChunk(deps, config, chunk));
  }
  return sweep;
};

export const reportSweep = (
  deps: KeeperJobDeps,
  job: string,
  owners: readonly Address[],
  sweep: DebtSweep
): void => {
  let withDebt = 0;
  for (const debt of sweep.debts.values()) if (debt > 0n) withDebt++;
  deps.log.info(KEEPER_EVENTS.vaultOwnerSweep, {
    job,
    owners: owners.length,
    read: sweep.debts.size,
    withDebt,
    unread: sweep.unread.length,
  });
  if (sweep.unread.length > 0) {
    deps.log.warn(KEEPER_EVENTS.vaultOwnersUnread, {
      job,
      count: sweep.unread.length,
      owners: sweep.unread.slice(0, UNREAD_OWNERS_NAMED),
      detail:
        'Debt could not be read for these owners after a batch retry and single reads; they were not walked this tick.',
    });
  }
};
