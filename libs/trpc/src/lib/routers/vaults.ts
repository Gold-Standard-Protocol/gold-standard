import { getCacheHandle } from '../config/cacheManager';
import { createIndexerCacheStore } from '../indexer/cacheStore';
import { initVaultIndexWorker, scheduleVaultIndex } from '../indexer/queue';
import {
  isOwnerIndexFresh,
  isOwnerSetTruncated,
  parseCursor,
  parseOwnerSnapshot,
  vaultOwnersCursorKey,
  vaultOwnersSetKey,
  vaultOwnersSyncedAtKey,
  vaultOwnersTruncatedKey,
} from '../indexer/vaultOwnerIndexer';
import { publicProcedure, router } from '../trpc';
import { vaultOwnersSchema } from '../validators/vaults';

/**
 * 'ok' when the indexer holds a readable set and a cursor for this chain and its last run
 * reached its target block within VAULT_OWNERS_STALE_AFTER_MS. 'unavailable' when the
 * cache read failed or holds nothing at all: an empty success was rendered by the dapp as
 * "no vaults are eligible for liquidation", a verdict where there was only missing data.
 * Also 'unavailable' when the set is truncated at the indexer's cap: the cap keeps the lowest
 * addresses, which depositors choose, so the set
 * can hold none of the real borrowers. And 'unavailable' when the index has stalled, or a
 * first sync or a rebuild has not finished:
 * the set then misses every vault opened since, or most of history. The dapp then walks
 * the on-chain VaultRegistry, and a dapp build that predates these rules does the same,
 * which a new status would not.
 */
export type VaultOwnersStatus = 'ok' | 'unavailable';

export interface VaultOwnersResponse {
  status: VaultOwnersStatus;
  owners: string[];
  lastIndexedBlock: string | null;
}

const UNAVAILABLE: VaultOwnersResponse = {
  status: 'unavailable',
  owners: [],
  lastIndexedBlock: null,
};

/**
 * How long one answer is shared. Every call, and every call of a batch, used to read and
 * parse the full set from Redis again, although the
 * indexer changes it at most once a minute. Far inside both that minute and the staleness
 * threshold, so the memo never turns a stale index into a fresh answer for long.
 */
export const VAULT_OWNERS_MEMO_MS = 5_000;

// Reads go through Keyv, as the indexer's do: cache-manager's get answers null on a store
// failure, so a failed read of the set alone looked like an indexed chain with no vaults.
const ownerStore = createIndexerCacheStore(getCacheHandle);

/**
 * Serves the vault owner set maintained by the indexer worker. Every cached
 * entry is re-validated through viem isAddress/getAddress (inside
 * parseOwnerSnapshot) as defence in depth against cache poisoning. The small keys
 * are read first, so a stale, rebuilding or truncated index never pulls the set. A
 * failure still answers rather than throwing, so the dapp keeps working, but it says
 * the index is unavailable instead of claiming there are no owners.
 */
const fetchVaultOwners = async (
  chainId: number,
  now: number
): Promise<VaultOwnersResponse> => {
  try {
    const [rawCursor, rawTruncated, rawSyncedAt] = await Promise.all([
      ownerStore.get(vaultOwnersCursorKey(chainId)),
      ownerStore.get(vaultOwnersTruncatedKey(chainId)),
      ownerStore.get(vaultOwnersSyncedAtKey(chainId)),
    ]);
    const cursor = parseCursor(rawCursor);
    // No finished run recently, or a rebuild in progress: whatever set is stored may
    // miss vaults, so it is not an answer. Nor is a capped index.
    if (
      cursor === undefined ||
      !isOwnerIndexFresh(rawSyncedAt, now) ||
      isOwnerSetTruncated(rawTruncated, 0)
    ) {
      return { ...UNAVAILABLE };
    }
    const owners = parseOwnerSnapshot(await ownerStore.get(vaultOwnersSetKey(chainId)));
    if (owners === undefined || isOwnerSetTruncated(rawTruncated, owners.length)) {
      return { ...UNAVAILABLE };
    }
    return { status: 'ok', owners, lastIndexedBlock: cursor.toString() };
  } catch (error) {
    console.error('Failed to read vault owners from cache:', error);
    return { ...UNAVAILABLE };
  }
};

/** Answers shared per chain for VAULT_OWNERS_MEMO_MS; the schema admits two chain ids. */
const recentAnswers = new Map<number, { expiresAt: number; answer: Promise<VaultOwnersResponse> }>();

const vaultOwners = (chainId: number): Promise<VaultOwnersResponse> => {
  const now = Date.now();
  const recent = recentAnswers.get(chainId);
  if (recent !== undefined && recent.expiresAt > now) {
    return recent.answer;
  }
  // fetchVaultOwners never rejects, so concurrent callers can share the pending read.
  const answer = fetchVaultOwners(chainId, now);
  recentAnswers.set(chainId, { expiresAt: now + VAULT_OWNERS_MEMO_MS, answer });
  return answer;
};

export const vaultsRouter = router({
  owners: publicProcedure
    .input(vaultOwnersSchema)
    .query(
      async ({ input }): Promise<VaultOwnersResponse> =>
        vaultOwners(input.chainId)
    ),
});

// Bootstrap the indexer alongside the router it feeds. The shared entry
// point (libs/trpc/src/index.ts) starts the price worker at module load; the
// vault index worker lives here because that file is owned by the foundation
// layer. Both calls are no-ops when the indexer environment is unset.
// Schedule first, worker second: the reset wipes the queue, and a worker that had
// already picked up a soon-to-be-wiped job logged a missing key at boot.
scheduleVaultIndex()
  .catch((error) => {
    console.error('Failed to schedule the vault owner index job:', error);
  })
  .finally(() => {
    initVaultIndexWorker();
  });
