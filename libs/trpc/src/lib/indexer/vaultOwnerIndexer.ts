import { getAddress, isAddress, parseAbiItem } from 'viem';
import type { Address } from 'viem';
import { describeError } from '../config/redact';
import { KEY_NAMESPACE } from '../config/redisConfig';
import type { IndexerConfig } from './config';

// Namespaced, chain-scoped keys so shared Redis instances (staging vs
// production) and future chains can never collide on the same entries. The
// namespace lives with the Redis settings, which load libs/trpc/.env first.
export { DEFAULT_NAMESPACE, KEY_NAMESPACE } from '../config/redisConfig';

// Keys are also scoped by the vault address. Without it, a redeploy on the same
// chain kept serving the previous vault's owner set and resumed from its cursor,
// which sat past the new vault's first deposits: the Liquidate page listed the old
// deployment's borrowers and none of the new ones.
const vaultScope = (): string =>
  (process.env['GOLD_VAULT_ADDRESS']?.trim().toLowerCase() || 'unset');

export const vaultOwnersSetKey = (chainId: number): string =>
  `${KEY_NAMESPACE}:vault-owners:${chainId}:${vaultScope()}:set`;
export const vaultOwnersCursorKey = (chainId: number): string =>
  `${KEY_NAMESPACE}:vault-owners:${chainId}:${vaultScope()}:lastBlock`;
/** '1' while the stored set is capped and so is not the full owner list, '0' otherwise. */
export const vaultOwnersTruncatedKey = (chainId: number): string =>
  `${KEY_NAMESPACE}:vault-owners:${chainId}:${vaultScope()}:truncated`;

/**
 * When a run last reached its target block, as Date.now() in decimal. Without it
 * nothing told a reader that the index had stopped advancing, or
 * that a first sync or a rebuild had published only its first chunks, so the API kept
 * answering 'ok' from it. A scan from the deploy block wipes the stamp before it publishes
 * anything, and only a run that finishes writes it again.
 */
export const vaultOwnersSyncedAtKey = (chainId: number): string =>
  `${KEY_NAMESPACE}:vault-owners:${chainId}:${vaultScope()}:syncedAt`;

// The small keys are rewritten on every successful run (every minute) and the set when
// it changes or once a day (VAULT_OWNERS_SET_REFRESH_MS), so the TTL only matters when
// the indexer has been down for a week; rescanning from the deploy block is then the
// safe recovery path.
export const VAULT_OWNERS_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

/**
 * How often an unchanged owner set is rewritten anyway, to keep its TTL moving. Whole-project
 * The whole set was re-validated, re-sorted and rewritten
 * every minute although no owner had been added, a multi-megabyte write near the cap.
 */
export const VAULT_OWNERS_SET_REFRESH_MS = 1000 * 60 * 60 * 24;

/**
 * How old the sync stamp may be before readers treat the index as stalled: five runs of
 * the one-minute schedule. Past it the API reports the index unavailable, so the dapp walks
 * the on-chain VaultRegistry instead of showing a list that misses every newer vault.
 */
export const VAULT_OWNERS_STALE_AFTER_MS = 1000 * 60 * 5;

/** Clock skew between API hosts that share one Redis, tolerated on a stamp from the future. */
const SYNC_STAMP_SKEW_MS = 1000 * 60;

/** Written over the stamp while a scan from the deploy block has not finished. */
const NOT_SYNCED = 'syncing';

/** True when a sync stamp is a time within VAULT_OWNERS_STALE_AFTER_MS of `now`. */
export const isOwnerIndexFresh = (rawSyncedAt: string | null | undefined, now: number): boolean => {
  if (!rawSyncedAt || !/^\d+$/.test(rawSyncedAt)) {
    return false;
  }
  const syncedAt = Number(rawSyncedAt);
  return now - syncedAt < VAULT_OWNERS_STALE_AFTER_MS && syncedAt - now <= SYNC_STAMP_SKEW_MS;
};

// Public Sepolia RPCs cap eth_getLogs ranges; stay safely inside the cap.
export const MAX_BLOCK_RANGE = 10_000n;

/**
 * The narrowest window the scan halves down to after a provider refuses a range as too
 * wide. Providers cap eth_getLogs anywhere from 10,000 blocks
 * down to a few hundred; a refusal at 100 blocks is not about the span, so the run stops
 * there, as every failure did before, and the next run resumes from the cursor.
 */
export const MIN_BLOCK_RANGE = 100n;

/** What providers and clients answer when a getLogs window or its result is too large. */
const RANGE_REFUSAL =
  /block range|blocks range|ranges? over \d[\d,]* blocks|range \d[\d,]* exceeds|range (is )?too (large|wide|big)|max(imum)? (block )?range|range limit|more than \d+ results|too many (results|logs|blocks)|response size exceeded|exceeds defined limit|limit exceeded|code -32005/i;

/**
 * What providers answer when they throttle, whatever the code.
 * Viem maps every JSON-RPC -32005 to "Request exceeds defined
 * limit.", and Infura answers a rate limit with that code, so a throttle matched
 * RANGE_REFUSAL and halved the window down to MIN_BLOCK_RANGE, multiplying the requests
 * against a provider that was already refusing them. A throttle now ends the run like any
 * other failure; viem has already retried it with backoff, and the next run resumes from
 * the cursor a minute later.
 */
const RATE_LIMIT =
  /rate.?limit|request rate|too many requests|requests per second|compute units|throttl|status 429/i;

/** The messages, codes and HTTP statuses of an error and the causes it wraps, as one string. */
const errorText = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    const { code, status } = current as { code?: unknown; status?: unknown };
    if (code !== undefined) parts.push(`code ${String(code)}`);
    if (status !== undefined) parts.push(`status ${String(status)}`);
    current = current.cause;
  }
  if (current !== undefined && !(current instanceof Error)) parts.push(String(current));
  return parts.join(' ');
};

/** True when a getLogs failure says the window was too wide rather than that the call failed. */
export const isRangeError = (error: unknown): boolean => {
  const text = errorText(error);
  return !RATE_LIMIT.test(text) && RANGE_REFUSAL.test(text);
};

/** Half a refused window, never below MIN_BLOCK_RANGE. */
export const narrowerSpan = (refused: bigint): bigint => {
  const half = refused / 2n;
  return half > MIN_BLOCK_RANGE ? half : MIN_BLOCK_RANGE;
};

/**
 * The window a scan starts with: INDEXER_MAX_BLOCK_RANGE when it is set, never above
 * MAX_BLOCK_RANGE and never below one block, otherwise MAX_BLOCK_RANGE.
 */
export const startingSpan = (configured: bigint | undefined): bigint => {
  if (configured === undefined) return MAX_BLOCK_RANGE;
  if (configured < 1n) return 1n;
  return configured < MAX_BLOCK_RANGE ? configured : MAX_BLOCK_RANGE;
};

/**
 * Most owners the stored set holds. The set is permissionless (one unit deposited
 * joins it) and is parsed on every API and keeper read, so it is bounded here. Past
 * the cap the lowest checksummed addresses are kept. A depositor chooses its address,
 * so these are not the oldest owners and can be none of the real borrowers. The set is therefore
 * marked truncated, the mark is
 * rewritten on every run, a warning is logged on every run while it stands and
 * readers treat a marked set as incomplete: the API reports it unavailable, so the
 * dapp walks the on-chain VaultRegistry, the authoritative owner list, instead when its
 * build names one, and otherwise says the positions cannot be shown.
 */
export const MAX_STORED_OWNERS = 50_000;

const TRUNCATED_MARK = '1';
const COMPLETE_MARK = '0';

/**
 * True when a stored owner set is not the full list: the indexer marked it truncated, or
 * it already holds MAX_STORED_OWNERS entries, as a set capped before the mark existed
 * does. Shared by the indexer, the API and the keeper so they can never disagree.
 *
 * Two outcomes are conservative on purpose. A set of exactly MAX_STORED_OWNERS genuine
 * owners counts as truncated although it may be complete, since nothing in the set tells
 * the two apart. The mark is sticky: once a run sets it, every later run writes it again
 * until the stored set is deleted and rebuilt from the logs. Both fail safe. A set read as
 * truncated makes the API report the index unavailable, so the dapp walks the on-chain
 * VaultRegistry instead when its build names one, and otherwise says the positions cannot
 * be shown. A registry that fills the dapp's REGISTRY_MAX_PAGES pages makes that walk say
 * the same rather than show part of them. A keeper whose only owner list is this set pages
 * its operator. One that also walks the registry logs a warn, and pages on a tick whose
 * registry walk fails or loses pages, since this set is then the only list it sweeps. The cost is a
 * slower read, never a partial list presented as complete.
 */
export const isOwnerSetTruncated = (
  rawMark: string | null | undefined,
  ownerCount: number
): boolean => rawMark === TRUNCATED_MARK || ownerCount >= MAX_STORED_OWNERS;

/** Parsed sets kept by raw string; the same 2 MB string is parsed once, not per request. */
const PARSE_MEMO_BOUND = 4;

// Every vault interaction begins with a collateral deposit and vaults are
// keyed one-per-address by msg.sender, so this single event discovers every
// owner. Liquidatable state is read live on the client afterwards.
export const collateralDepositedEvent = parseAbiItem(
  'event CollateralDeposited(address indexed user, address indexed token, uint256 amount)'
);

/** Minimal surface of a viem PublicClient, injectable for tests. */
export interface VaultLogClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: Address;
    event: typeof collateralDepositedEvent;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly { args: { user?: Address } }[]>;
}

/** Minimal surface of the cache layer, injectable for tests. */
export interface IndexerCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<unknown>;
}

/**
 * Merges two owner lists into a new sorted, deduplicated, checksummed array.
 * Invalid entries are dropped (defence in depth: neither cached JSON nor
 * decoded log args are trusted blindly). Inputs are never mutated.
 */
export const mergeOwners = (
  existing: readonly string[],
  discovered: readonly string[]
): Address[] => {
  const next = new Set<Address>();
  for (const candidate of [...existing, ...discovered]) {
    if (typeof candidate === 'string' && isAddress(candidate)) {
      next.add(getAddress(candidate));
    }
  }
  return [...next].sort();
};

const parseOwnersUncached = (raw: string): Address[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error('Cached vault owner set is not an array; ignoring it.');
      return [];
    }
    return mergeOwners(
      parsed.filter((value): value is string => typeof value === 'string'),
      []
    );
  } catch (error) {
    console.error('Failed to parse cached vault owner set:', error);
    return [];
  }
};

const parseMemo = new Map<string, readonly Address[]>();

/**
 * Parses the cached owner JSON, dropping anything that is not an address. The
 * result is memoised by raw string (a small bound, oldest out), because the same
 * unchanged set was re-parsed and re-checksummed on every read: 650 ms per request
 * at 50,000 entries. Callers get their own copy, so the memo is never mutated.
 */
export const parseStoredOwners = (raw: string | null | undefined): Address[] => {
  if (!raw) {
    return [];
  }
  const memoised = parseMemo.get(raw);
  if (memoised !== undefined) {
    return [...memoised];
  }
  const parsed = parseOwnersUncached(raw);
  if (parseMemo.size >= PARSE_MEMO_BOUND) {
    const oldest = parseMemo.keys().next();
    if (!oldest.done) parseMemo.delete(oldest.value);
  }
  parseMemo.set(raw, parsed);
  return [...parsed];
};

/**
 * The stored owner snapshot, or undefined when it is unusable: absent, empty text,
 * malformed JSON or JSON that is not an array (an object, null). A valid [] is a real
 * snapshot of no owners. parseStoredOwners reads all of these as [], which is right
 * for a reader but not for the indexer: pairing an empty list with a surviving cursor
 * resumed near the head and left every earlier owner out for good.
 */
export const parseOwnerSnapshot = (raw: string | null | undefined): Address[] | undefined => {
  if (raw === null || raw === undefined || raw === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return Array.isArray(parsed) ? parseStoredOwners(raw) : undefined;
};

/**
 * Written over the cursor while a lost snapshot is rebuilt. It is not a block number,
 * so parseCursor reads it as absent and an interrupted rebuild starts again from the
 * deploy block instead of resuming past history it never re-read.
 */
const REBUILDING_CURSOR = 'rebuilding';

/** Parses the cached block cursor; undefined when absent or malformed. */
export const parseCursor = (raw: string | null | undefined): bigint | undefined => {
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }
  return BigInt(raw);
};

/** Truncates to the documented cap, warning so the operator sees the set is bounded. */
const capStoredOwners = (owners: readonly Address[]): Address[] => {
  if (owners.length <= MAX_STORED_OWNERS) {
    return [...owners];
  }
  console.warn(
    `Vault owner set holds ${owners.length} entries; keeping the ${MAX_STORED_OWNERS} lowest addresses and marking the set truncated. The VaultRegistry remains the complete list.`
  );
  return owners.slice(0, MAX_STORED_OWNERS);
};

const ownersInLogs = (logs: readonly { args: { user?: Address } }[]): Address[] =>
  logs.flatMap((log) => {
    const user = log.args.user;
    return typeof user === 'string' && isAddress(user) ? [getAddress(user)] : [];
  });

/**
 * The stored owners with the discovered ones added, sorted, or undefined when every one
 * is already stored. The stored list came through parseOwnerSnapshot and the discovered
 * one through ownersInLogs, so both are validated and checksummed already: only the new
 * logs are checked, not the whole set again.
 */
const addOwners = (
  stored: readonly Address[],
  discovered: readonly Address[]
): Address[] | undefined => {
  if (discovered.length === 0) {
    return undefined;
  }
  const known = new Set(stored);
  const added = [...new Set(discovered)].filter((owner) => !known.has(owner));
  return added.length === 0 ? undefined : [...stored, ...added].sort();
};

const sameOwners = (left: readonly Address[], right: readonly Address[]): boolean =>
  left.length === right.length && left.every((owner, index) => owner === right[index]);

interface IndexProgress {
  owners: Address[];
  cursor: bigint | undefined;
  /** Sticky: once the union passed the cap, the stored set is not the full owner list. */
  truncated: boolean;
  /** True when `owners` differs from the stored set, which must then be rewritten. */
  ownersChanged: boolean;
}

/** When this process last wrote each owner set, per store, so an unchanged set is rewritten once a day. */
const setWrittenAt = new WeakMap<IndexerCacheStore, Map<string, number>>();

const isSetRefreshDue = (store: IndexerCacheStore, key: string, now: number): boolean => {
  const writtenAt = setWrittenAt.get(store)?.get(key);
  return writtenAt === undefined || now - writtenAt >= VAULT_OWNERS_SET_REFRESH_MS;
};

const noteSetWritten = (store: IndexerCacheStore, key: string, now: number): void => {
  const byKey = setWrittenAt.get(store) ?? new Map<string, number>();
  byKey.set(key, now);
  setWrittenAt.set(store, byKey);
};

// The truncation mark first, owners second, cursor third. A capped set is never
// published without its mark: a failure after the mark leaves a set that is read as
// incomplete one run early, never one read as complete. If the cursor write fails the
// next run rescans an already-merged range, which the dedupe makes idempotent. The set
// itself is written only when it changed or its daily TTL refresh is due; the
// first run of a process always writes it, since nothing says when it was last written.
const persistProgress = async (
  store: IndexerCacheStore,
  chainId: number,
  progress: IndexProgress
): Promise<IndexProgress> => {
  await store.set(
    vaultOwnersTruncatedKey(chainId),
    progress.truncated ? TRUNCATED_MARK : COMPLETE_MARK,
    VAULT_OWNERS_CACHE_TTL_MS
  );
  const setKey = vaultOwnersSetKey(chainId);
  const now = Date.now();
  if (progress.ownersChanged || isSetRefreshDue(store, setKey, now)) {
    await store.set(setKey, JSON.stringify(progress.owners), VAULT_OWNERS_CACHE_TTL_MS);
    noteSetWritten(store, setKey, now);
  }
  if (progress.cursor !== undefined) {
    await store.set(
      vaultOwnersCursorKey(chainId),
      progress.cursor.toString(),
      VAULT_OWNERS_CACHE_TTL_MS
    );
  }
  return { ...progress, ownersChanged: false };
};

/** Stamps a run that reached its target block; written after the cursor. */
const stampSynced = (store: IndexerCacheStore, chainId: number): Promise<unknown> =>
  store.set(vaultOwnersSyncedAtKey(chainId), String(Date.now()), VAULT_OWNERS_CACHE_TTL_MS);

/** Never move the cursor backwards: a window re-read must not rewind an earlier run. */
const advanceCursor = (cursor: bigint | undefined, scannedTo: bigint): bigint =>
  cursor !== undefined && cursor > scannedTo ? cursor : scannedTo;

/**
 * Incrementally indexes vault owners from CollateralDeposited logs.
 * Resumes from the cached cursor (or the deploy block on first run) and
 * chunks getLogs calls under public RPC range caps, halving a window the
 * provider refuses as too wide down to MIN_BLOCK_RANGE. Progress is persisted
 * after every chunk, so a provider that fails part way through a long first
 * sync costs that chunk, not the whole sync: the next run resumes from the
 * cursor. A deploy block above the chain head is reported as an error rather
 * than scanned as nothing. A missing or unreadable owner snapshot is rebuilt from
 * the deploy block whatever the cursor says, and the cursor is invalidated before
 * the first rebuilt snapshot is published. A run that reaches its target block stamps
 * the time, and a scan from the deploy block wipes the stamp before its first chunk is
 * published, so readers can tell a current index from a stalled or partial one. Never throws.
 */
export const indexVaultOwners = async (
  client: VaultLogClient,
  store: IndexerCacheStore,
  config: IndexerConfig
): Promise<void> => {
  try {
    const [rawOwners, rawCursor, rawTruncated] = await Promise.all([
      store.get(vaultOwnersSetKey(config.chainId)),
      store.get(vaultOwnersCursorKey(config.chainId)),
      store.get(vaultOwnersTruncatedKey(config.chainId)),
    ]);
    const head = await client.getBlockNumber();
    if (config.deployBlock > head) {
      console.error(
        `Vault owner indexing refused: deploy block ${config.deployBlock} is above the chain head ${head}; check GOLD_VAULT_DEPLOY_BLOCK against the deployment.`
      );
      return;
    }
    const storedOwners = parseOwnerSnapshot(rawOwners);
    const storedCursor = parseCursor(rawCursor);
    if (storedOwners === undefined && storedCursor !== undefined) {
      console.warn(
        `Vault owner snapshot is missing or unreadable; rebuilding from the deploy block ${config.deployBlock} rather than resuming from the cursor at ${storedCursor}.`
      );
      // Before any rebuilt snapshot is published: a partial snapshot paired with the
      // old advanced cursor, after a failed cursor write, would skip history again.
      await store.set(
        vaultOwnersCursorKey(config.chainId),
        REBUILDING_CURSOR,
        VAULT_OWNERS_CACHE_TTL_MS
      );
    }
    let progress: IndexProgress = {
      owners: storedOwners ?? [],
      cursor: storedOwners === undefined ? undefined : storedCursor,
      // The mark describes the stored set, so a rebuild from the deploy block starts
      // unmarked and marks itself again if it passes the cap.
      truncated:
        storedOwners !== undefined && isOwnerSetTruncated(rawTruncated, storedOwners.length),
      // A missing or unreadable snapshot is published as soon as the run persists.
      ownersChanged: storedOwners === undefined,
    };
    if (progress.truncated) {
      console.warn(
        `Vault owner set is truncated at ${MAX_STORED_OWNERS} entries, so the API reports the index unavailable and readers walk the VaultRegistry. Deleting the set rebuilds it from the logs, which marks it again while they name more owners than the cap.`
      );
    }

    const confirmations = BigInt(config.confirmations);
    // Re-read a confirmation window behind the cursor and stop the same distance short
    // of the head: a log node behind the block-number node, or a reorg of the newest
    // blocks, can no longer leave a deposit in a range the cursor has moved past. The
    // merge dedupes, so re-reading is free of side effects.
    const resumeFrom =
      progress.cursor !== undefined ? progress.cursor + 1n - confirmations : config.deployBlock;
    const fromBlock = resumeFrom > config.deployBlock ? resumeFrom : config.deployBlock;
    const toBlock = head > confirmations ? head - confirmations : 0n;
    if (fromBlock > toBlock) {
      // Nothing new to scan: rewrite the keys so their TTL keeps moving.
      await persistProgress(store, config.chainId, progress);
      await stampSynced(store, config.chainId);
      return;
    }
    // A first sync or a rebuild publishes part of the history with each chunk. An earlier
    // stamp would let readers take that part for the whole list, so it goes first.
    let stampToWipe = progress.cursor === undefined;

    // Windows of at most `span` blocks. A provider that refuses a window as too wide gets
    // the same start again at half the width, and the narrower width holds for the rest
    // of the run; the same chunk used to fail every run.
    let span = startingSpan(config.maxBlockRange);
    let next = fromBlock;
    while (next <= toBlock) {
      const end = next + span - 1n < toBlock ? next + span - 1n : toBlock;
      let logs: readonly { args: { user?: Address } }[];
      try {
        logs = await client.getLogs({
          address: config.goldVaultAddress,
          event: collateralDepositedEvent,
          fromBlock: next,
          toBlock: end,
        });
      } catch (error) {
        const width = end - next + 1n;
        if (width > MIN_BLOCK_RANGE && isRangeError(error)) {
          span = narrowerSpan(width);
          console.warn(
            `eth_getLogs refused ${width} blocks from block ${next} as too wide; retrying in windows of ${span} blocks.`
          );
          continue;
        }
        // The description, never the error: viem carries the request URL, and with it the
        // provider key, in the message and as a property of its own.
        console.error(
          `Vault owner indexing stopped at block ${next}; progress up to the stored cursor is kept and the next run resumes there:`,
          describeError(error)
        );
        return;
      }
      const merged = addOwners(progress.owners, ownersInLogs(logs));
      const owners = merged === undefined ? progress.owners : capStoredOwners(merged);
      progress = {
        owners,
        cursor: advanceCursor(progress.cursor, end),
        truncated: progress.truncated || (merged?.length ?? 0) > MAX_STORED_OWNERS,
        // A capped set that leaves the new owners out again is unchanged.
        ownersChanged: progress.ownersChanged || !sameOwners(owners, progress.owners),
      };
      if (stampToWipe) {
        await store.set(vaultOwnersSyncedAtKey(config.chainId), NOT_SYNCED, VAULT_OWNERS_CACHE_TTL_MS);
        stampToWipe = false;
      }
      progress = await persistProgress(store, config.chainId, progress);
      next = end + 1n;
    }
    await stampSynced(store, config.chainId);
  } catch (error) {
    console.error(
      'Vault owner indexing failed; the stored cursor is left for the next run:',
      describeError(error)
    );
  }
};
