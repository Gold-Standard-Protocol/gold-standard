import type { Address } from 'viem';
import { getCacheHandle } from '../config/cacheManager';
import {
  isOwnerSetTruncated,
  MAX_STORED_OWNERS,
  parseOwnerSnapshot,
  vaultOwnersSetKey,
  vaultOwnersTruncatedKey,
} from '../indexer/vaultOwnerIndexer';
import { KEEPER_EVENTS } from './alerts';
import { describeError } from './decode';
import type { KeeperLogger } from './ports';
// Types only: registryOwnerSource.ts must never load this file, but this file may name its types.
import type { OwnerSourceReading, ReportingVaultOwnerSource } from './registryOwnerSource';

/** The one read the owner source needs; the shared cache by default, a stub in specs. */
export interface OwnerSetStore {
  get(key: string): Promise<string | null | undefined>;
}

// Read through Keyv rather than cache-manager: cache-manager swallows a store
// failure and answers null, which would make an outage look like an empty set.
const sharedStore: OwnerSetStore = {
  get: (key) => getCacheHandle().keyv.get<string>(key),
};

export interface RedisOwnerSourceOptions {
  /**
   * True when the keeper reads this source through combineVaultOwnerSources, which pages
   * every tick on which no full owner list was read, so a truncated indexer set is reported
   * here at warn rather than paged twice. Beside a VaultRegistry walk that was read the
   * tick stays quiet; with no other full list the union pages it. A source read on its own
   * leaves this unset and pages a truncated set itself.
   */
  readThroughUnion?: boolean;
}

const LABEL = "the indexer's owner set";

/**
 * Production VaultOwnerSource: reads the exact chain-scoped Redis set the
 * indexer writes and parses it with the indexer's own parseOwnerSnapshot, so
 * the keeper never rescans logs. The indexer writes the set on every run, an
 * empty one included, so an absent or unreadable set names no vault: the indexer
 * is not running, it lapsed, or the keeper and the API disagree on KEY_NAMESPACE
 * or GOLD_VAULT_ADDRESS. That read counts as failed, never as an empty full list,
 * so the union pages a tick on which the registry read failed beside it. The client is created on the first read, so a
 * keeper that never builds this source never opens a Redis socket. While Redis
 * is unreachable every read rejects within the client's bounded retry (see
 * createRedisCache) and this source returns an empty list with a warn, so the
 * registry source and the breaker and price jobs carry on.
 *
 * A set the indexer marked truncated holds the lowest addresses, which depositors
 * choose, so it can hold none of the real borrowers.
 * Its owners are still returned, since each may be a vault, but every read says the
 * list is incomplete: at warn when read through the union, which pages the tick unless
 * a registry walk read a full list, and at error when read on its own. Its reading marks
 * the set truncated, which is what the union judges.
 */
export const createRedisVaultOwnerSource = (
  chainId: number,
  log: KeeperLogger,
  store: OwnerSetStore = sharedStore,
  options: RedisOwnerSourceOptions = {}
): ReportingVaultOwnerSource => {
  const readOwners = async (): Promise<OwnerSourceReading> => {
    try {
      const [raw, rawTruncated] = await Promise.all([
        store.get(vaultOwnersSetKey(chainId)),
        store.get(vaultOwnersTruncatedKey(chainId)),
      ]);
      const owners = parseOwnerSnapshot(raw);
      if (owners === undefined) {
        log.warn(KEEPER_EVENTS.jobError, {
          job: 'vault-owner-source',
          reason: `the indexer's owner set for chain ${chainId} is absent or unreadable, so it names no vault: the indexer has not written it, it lapsed, or KEY_NAMESPACE or GOLD_VAULT_ADDRESS differ between the keeper and the API`,
        });
        return { label: LABEL, owners: [], failed: true, truncated: false };
      }
      const truncated = isOwnerSetTruncated(rawTruncated, owners.length);
      if (truncated) {
        const fields = {
          job: 'vault-owner-source',
          reason: `the indexer's owner set is truncated at ${MAX_STORED_OWNERS} entries and is not the full list of open vaults; only the VaultRegistry names them all, so set VAULT_REGISTRY_ADDRESS on every keeper`,
        };
        if (options.readThroughUnion === true) {
          log.warn(KEEPER_EVENTS.jobError, fields);
        } else {
          log.error(KEEPER_EVENTS.jobError, fields);
        }
      }
      return { label: LABEL, owners, failed: false, truncated };
    } catch (error) {
      log.warn(KEEPER_EVENTS.jobError, {
        job: 'vault-owner-source',
        reason: describeError(error),
      });
      return { label: LABEL, owners: [], failed: true, truncated: false };
    }
  };
  return {
    readOwners,
    getOwners: async (): Promise<Address[]> => (await readOwners()).owners,
  };
};
