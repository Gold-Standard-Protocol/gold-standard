import type { RedisCacheHandle } from '../config/cacheManager';
import type { IndexerCacheStore } from './vaultOwnerIndexer';

/**
 * The indexer's store over the shared cache. Reads go through
 * Keyv, as keeper/ownerSource.ts already does. cache-manager's get swallows a store failure
 * and answers null, so a Redis blip looked like a first run: the indexer started again at
 * the deploy block and wrote a near-empty owner set over the real one. Through Keyv the
 * read rejects and the run aborts, as indexVaultOwners expects of its store. Writes stay
 * on cache-manager, whose set already rejects on a store failure.
 */
export const createIndexerCacheStore = (
  handle: () => Pick<RedisCacheHandle, 'cache' | 'keyv'>
): IndexerCacheStore => ({
  get: async (key) => (await handle().keyv.get<string>(key)) ?? null,
  set: (key, value, ttlMs) => handle().cache.set(key, value, ttlMs),
});
