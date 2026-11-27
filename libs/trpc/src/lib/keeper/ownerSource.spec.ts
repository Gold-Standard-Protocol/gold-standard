import { getAddress } from 'viem';
import { createRedisCache } from '../config/cacheManager';
import type { RedisCacheHandle } from '../config/cacheManager';
import { vaultOwnersSetKey, vaultOwnersTruncatedKey } from '../indexer/vaultOwnerIndexer';
import { createRedisVaultOwnerSource } from './ownerSource';
import type { OwnerSetStore } from './ownerSource';
import type { KeeperLogger, KeeperReadClient } from './ports';
import { combineVaultOwnerSources, createRegistryVaultOwnerSource } from './registryOwnerSource';

const OWNER = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const LISTED = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
const REGISTRY = getAddress('0x1111111111111111111111111111111111111111');

interface LoggedEvent {
  level: 'info' | 'warn' | 'error';
  event: string;
  fields?: Record<string, unknown>;
}

const rejectingStore: OwnerSetStore = {
  get: async () => {
    throw new Error('connection refused');
  },
};

const createStubLogger = (): { log: KeeperLogger; events: LoggedEvent[] } => {
  const events: LoggedEvent[] = [];
  return {
    log: {
      info: (event, fields) => {
        events.push({ level: 'info', event, fields });
      },
      warn: (event, fields) => {
        events.push({ level: 'warn', event, fields });
      },
      error: (event, fields) => {
        events.push({ level: 'error', event, fields });
      },
    },
    events,
  };
};

describe('createRedisVaultOwnerSource', () => {
  it('parses the indexer set from the injected store', async () => {
    const { log, events } = createStubLogger();
    const source = createRedisVaultOwnerSource(11155111, log, {
      get: async (key) =>
        key === vaultOwnersSetKey(11155111) ? JSON.stringify([OWNER.toLowerCase()]) : null,
    });
    await expect(source.getOwners()).resolves.toEqual([OWNER]);
    expect(events).toEqual([]);
  });

  it('reports a store that rejects as a failed read', async () => {
    const { log } = createStubLogger();
    const source = createRedisVaultOwnerSource(11155111, log, {
      get: async () => {
        throw new Error('connection refused');
      },
    });
    await expect(source.readOwners()).resolves.toEqual({
      label: "the indexer's owner set",
      owners: [],
      failed: true,
      truncated: false,
    });
  });

  it('returns an empty list with a warn when the store rejects', async () => {
    const { log, events } = createStubLogger();
    const source = createRedisVaultOwnerSource(11155111, log, {
      get: async () => {
        throw new Error('connection refused');
      },
    });
    await expect(source.getOwners()).resolves.toEqual([]);
    expect(events).toEqual([
      {
        level: 'warn',
        event: 'keeper.job-error',
        fields: { job: 'vault-owner-source', reason: 'connection refused' },
      },
    ]);
  });

  // The capped set holds the lowest addresses, which depositors
  // choose, so it can hold none of the real borrowers. Its owners are still walked, and
  // the keeper says the list is incomplete.
  describe('over a set the indexer marked truncated', () => {
    const truncatedStore = {
      get: async (key: string) => {
        if (key === vaultOwnersSetKey(11155111)) return JSON.stringify([OWNER]);
        if (key === vaultOwnersTruncatedKey(11155111)) return '1';
        return null;
      },
    };

    it('pages at error level while Redis is the only owner list, and still returns the owners', async () => {
      const { log, events } = createStubLogger();
      const source = createRedisVaultOwnerSource(11155111, log, truncatedStore);
      await expect(source.getOwners()).resolves.toEqual([OWNER]);
      expect(events.map((entry) => `${entry.level}:${entry.event}`)).toEqual(['error:keeper.job-error']);
      expect(events[0]?.fields).toMatchObject({ job: 'vault-owner-source' });
      expect(String(events[0]?.fields?.['reason'])).toContain('VAULT_REGISTRY_ADDRESS');
    });

    it('warns rather than pages when read through the union, which judges the tick', async () => {
      const { log, events } = createStubLogger();
      const source = createRedisVaultOwnerSource(11155111, log, truncatedStore, {
        readThroughUnion: true,
      });
      await expect(source.getOwners()).resolves.toEqual([OWNER]);
      expect(events.map((entry) => `${entry.level}:${entry.event}`)).toEqual(['warn:keeper.job-error']);
    });

    it('reports the set as truncated in its reading', async () => {
      const { log } = createStubLogger();
      const source = createRedisVaultOwnerSource(11155111, log, truncatedStore, {
        readThroughUnion: true,
      });
      await expect(source.readOwners()).resolves.toEqual({
        label: "the indexer's owner set",
        owners: [OWNER],
        failed: false,
        truncated: true,
      });
    });

    // A keeper with VAULT_REGISTRY_ADDRESS set whose
    // registry read fails this tick sweeps only this set. Both sources logged at warn, so
    // nothing paged although the truncated set was then the keeper's only owner list.
    describe('beside a VaultRegistry walk', () => {
      const registryRead = (fails: boolean): KeeperReadClient => ({
        readContract: async (call) => {
          if (fails) throw new Error('rpc down');
          return call.functionName === 'vaultOwnerCount' ? 1n : [LISTED];
        },
      });
      const keeperOwners = (
        registryFails: boolean,
        log: KeeperLogger,
        store: OwnerSetStore = truncatedStore
      ) =>
        combineVaultOwnerSources(
          [
            createRegistryVaultOwnerSource(REGISTRY, registryRead(registryFails), log),
            createRedisVaultOwnerSource(11155111, log, store, { readThroughUnion: true }),
          ],
          log
        );
      const levels = (events: readonly LoggedEvent[]): string[] =>
        events.map((entry) => `${entry.level}:${String(entry.fields?.['job'])}`);

      it('pages when the registry read fails on the tick the set is truncated', async () => {
        const { log, events } = createStubLogger();
        await expect(keeperOwners(true, log).getOwners()).resolves.toEqual([OWNER]);
        expect(levels(events)).toEqual([
          'warn:vault-registry-owner-source',
          'warn:vault-owner-source',
          'error:vault-owner-sources',
        ]);
        const paged = events.find((entry) => entry.level === 'error');
        expect(String(paged?.fields?.['reason'])).toContain('reading the VaultRegistry failed');
      });

      it('keeps the truncated set at warn when the registry read succeeds', async () => {
        const { log, events } = createStubLogger();
        await expect(keeperOwners(false, log).getOwners()).resolves.toEqual([LISTED, OWNER]);
        expect(levels(events)).toEqual(['warn:vault-owner-source']);
      });

      // With both reads failing the keeper had no owners,
      // two warns and then vault.no-owners at info, so nothing paged.
      it('pages once when the registry read fails and the store rejects on the same tick', async () => {
        const { log, events } = createStubLogger();
        const owners = keeperOwners(true, log, rejectingStore);
        await expect(owners.getOwners()).resolves.toEqual([]);
        expect(levels(events)).toEqual([
          'warn:vault-registry-owner-source',
          'warn:vault-owner-source',
          'error:vault-owner-sources',
        ]);
        const paged = events.find((entry) => entry.level === 'error');
        expect(String(paged?.fields?.['reason'])).toContain('no owner list was read this tick');
      });
    });

    // A keeper with Redis and no VAULT_REGISTRY_ADDRESS reads its one source through the
    // union too, which pages the tick once; the source itself warns.
    describe('as the only owner list, read through the union', () => {
      const levels = (events: readonly LoggedEvent[]): string[] =>
        events.map((entry) => `${entry.level}:${String(entry.fields?.['job'])}`);
      const redisOnly = (store: OwnerSetStore, log: KeeperLogger) =>
        combineVaultOwnerSources(
          [createRedisVaultOwnerSource(11155111, log, store, { readThroughUnion: true })],
          log
        );

      it('pages a truncated set once', async () => {
        const { log, events } = createStubLogger();
        await expect(redisOnly(truncatedStore, log).getOwners()).resolves.toEqual([OWNER]);
        expect(levels(events)).toEqual(['warn:vault-owner-source', 'error:vault-owner-sources']);
      });

      it('pages a store that rejects once', async () => {
        const { log, events } = createStubLogger();
        await expect(redisOnly(rejectingStore, log).getOwners()).resolves.toEqual([]);
        expect(levels(events)).toEqual(['warn:vault-owner-source', 'error:vault-owner-sources']);
      });
    });

    it('says nothing about a set marked complete', async () => {
      const { log, events } = createStubLogger();
      const source = createRedisVaultOwnerSource(11155111, log, {
        get: async (key) =>
          key === vaultOwnersSetKey(11155111)
            ? JSON.stringify([OWNER])
            : key === vaultOwnersTruncatedKey(11155111)
              ? '0'
              : null,
      });
      await expect(source.getOwners()).resolves.toEqual([OWNER]);
      expect(events).toEqual([]);
    });
  });

  // An absent set key read as an empty full list, so a
  // keeper whose registry read kept failing stayed silent beside it. The indexer writes the
  // set on every run, an empty one included, so an absent key never means no vaults.
  describe('over a set the indexer has not written', () => {
    const levels = (events: readonly LoggedEvent[]): string[] =>
      events.map((entry) => `${entry.level}:${String(entry.fields?.['job'])}`);
    const storeWith = (set: string | null): OwnerSetStore => ({
      get: async (key) => (key === vaultOwnersSetKey(11155111) ? set : null),
    });
    const registryRead = (fails: boolean): KeeperReadClient => ({
      readContract: async (call) => {
        if (fails) throw new Error('no code at the registry');
        return call.functionName === 'vaultOwnerCount' ? 1n : [LISTED];
      },
    });
    const union = (log: KeeperLogger, store: OwnerSetStore, registry?: KeeperReadClient) =>
      combineVaultOwnerSources(
        [
          ...(registry ? [createRegistryVaultOwnerSource(REGISTRY, registry, log)] : []),
          createRedisVaultOwnerSource(11155111, log, store, { readThroughUnion: true }),
        ],
        log
      );

    it.each([
      ['absent', null],
      ['empty text', ''],
      ['not JSON', 'not json'],
      ['not an array', '{"owners":[]}'],
    ])('reports a set that is %s as a failed read, with a warn naming the likely causes', async (_case, set) => {
      const { log, events } = createStubLogger();
      const source = createRedisVaultOwnerSource(11155111, log, storeWith(set), { readThroughUnion: true });
      await expect(source.readOwners()).resolves.toEqual({
        label: "the indexer's owner set",
        owners: [],
        failed: true,
        truncated: false,
      });
      expect(levels(events)).toEqual(['warn:vault-owner-source']);
      expect(String(events[0]?.fields?.['reason'])).toContain('KEY_NAMESPACE or GOLD_VAULT_ADDRESS');
    });

    it('reads a stored empty set as a full list and says nothing', async () => {
      const { log, events } = createStubLogger();
      await expect(union(log, storeWith('[]')).getOwners()).resolves.toEqual([]);
      expect(events).toEqual([]);
    });

    it('pages once when the registry read fails beside an absent set', async () => {
      const { log, events } = createStubLogger();
      await expect(union(log, storeWith(null), registryRead(true)).getOwners()).resolves.toEqual([]);
      expect(levels(events)).toEqual([
        'warn:vault-registry-owner-source',
        'warn:vault-owner-source',
        'error:vault-owner-sources',
      ]);
      const paged = events.find((entry) => entry.level === 'error');
      expect(String(paged?.fields?.['reason'])).toContain('no owner list was read this tick');
    });

    it('does not page beside a registry that was read', async () => {
      const { log, events } = createStubLogger();
      await expect(union(log, storeWith(null), registryRead(false)).getOwners()).resolves.toEqual([LISTED]);
      expect(levels(events)).toEqual(['warn:vault-owner-source']);
    });
  });

  describe('with no Redis listening', () => {
    let handle: RedisCacheHandle;

    beforeAll(() => {
      handle = createRedisCache(
        { host: '127.0.0.1', port: 1, maxRetriesPerRequest: null },
        { onStatus: () => undefined }
      );
    });

    afterAll(() => {
      handle.close();
    });

    it('completes the read with a warning instead of crashing the process', async () => {
      const { log, events } = createStubLogger();
      const source = createRedisVaultOwnerSource(11155111, log, {
        get: (key) => handle.keyv.get<string>(key),
      });
      const started = Date.now();
      await expect(source.getOwners()).resolves.toEqual([]);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(events.map((entry) => entry.event)).toEqual(['keeper.job-error']);
      expect(events[0]?.fields).toMatchObject({ job: 'vault-owner-source' });
    }, 20_000);
  });
});
