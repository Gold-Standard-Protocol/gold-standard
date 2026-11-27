const store = new Map<string, string>();
const get = jest.fn(async (key: string): Promise<string | undefined> => store.get(key));

// The route reads through Keyv, whose get rejects on a store failure, as the indexer does.
jest.mock('../config/cacheManager', () => ({
  getCacheHandle: () => ({ keyv: { get: (key: string) => get(key) } }),
}));

// Importing the router bootstraps the indexer; keep the queue out of these tests.
jest.mock('../indexer/queue', () => ({
  initVaultIndexWorker: jest.fn(),
  scheduleVaultIndex: jest.fn(async () => undefined),
}));

import {
  MAX_STORED_OWNERS,
  VAULT_OWNERS_STALE_AFTER_MS,
  vaultOwnersCursorKey,
  vaultOwnersSetKey,
  vaultOwnersSyncedAtKey,
  vaultOwnersTruncatedKey,
} from '../indexer/vaultOwnerIndexer';
import { VAULT_OWNERS_MEMO_MS, vaultsRouter } from './vaults';

const CHAIN = 11155111;
const OWNER = '0x00000000000000000000000000000000000000aa';
const UNAVAILABLE = { status: 'unavailable', owners: [], lastIndexedBlock: null };

const owners = () => vaultsRouter.createCaller({}).owners({ chainId: CHAIN });

describe('vaultsRouter.owners', () => {
  let errorLog: jest.SpyInstance;
  let clock: jest.SpyInstance;
  let now = 1_800_000_000_000;

  /** An index whose last run reached its target block `ageMs` ago. */
  const indexed = (set: string | undefined, cursor = '1234', ageMs = 0): void => {
    if (set !== undefined) store.set(vaultOwnersSetKey(CHAIN), set);
    store.set(vaultOwnersCursorKey(CHAIN), cursor);
    store.set(vaultOwnersSyncedAtKey(CHAIN), String(now - ageMs));
  };

  beforeEach(() => {
    store.clear();
    get.mockClear();
    // Each case starts past the previous one's memo.
    now += VAULT_OWNERS_MEMO_MS * 10;
    clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
    clock.mockRestore();
  });

  it('serves the indexed owners with status ok', async () => {
    indexed(JSON.stringify([OWNER]));
    const result = await owners();
    expect(result.status).toBe('ok');
    expect(result.lastIndexedBlock).toBe('1234');
    expect(result.owners).toHaveLength(1);
  });

  it('reports an indexed chain with no vaults as ok, not as an outage', async () => {
    indexed('[]');
    const result = await owners();
    expect(result).toEqual({ status: 'ok', owners: [], lastIndexedBlock: '1234' });
  });

  // Every case below answered 'ok', so the
  // Liquidations page showed an old, partial or empty list and never walked the registry.
  it('reports an index whose last finished run is older than the threshold as unavailable', async () => {
    indexed(JSON.stringify([OWNER]), '1234', VAULT_OWNERS_STALE_AFTER_MS);
    expect(await owners()).toEqual(UNAVAILABLE);
  });

  it('reports an index with no sync stamp as unavailable', async () => {
    indexed(JSON.stringify([OWNER]));
    store.delete(vaultOwnersSyncedAtKey(CHAIN));
    expect(await owners()).toEqual(UNAVAILABLE);
  });

  it('reports a first sync or rebuild that has not finished as unavailable', async () => {
    indexed(JSON.stringify([OWNER]));
    store.set(vaultOwnersSyncedAtKey(CHAIN), 'syncing');
    expect(await owners()).toEqual(UNAVAILABLE);
  });

  it('reports a rebuild that has not published its first chunk as unavailable', async () => {
    indexed(undefined, 'rebuilding');
    expect(await owners()).toEqual(UNAVAILABLE);
  });

  it('reports a cursor without its owner set as unavailable, not as no vaults', async () => {
    indexed(undefined);
    expect(await owners()).toEqual(UNAVAILABLE);
  });

  it('reports an unreadable owner set as unavailable', async () => {
    indexed('{not json');
    expect(await owners()).toEqual(UNAVAILABLE);
  });

  // Each call, and each call in a batch, read
  // and parsed the full set from Redis again.
  it('answers concurrent and repeated calls within the memo from one read of each key', async () => {
    indexed(JSON.stringify([OWNER]));
    const results = await Promise.all([owners(), owners(), owners()]);
    now += VAULT_OWNERS_MEMO_MS - 1;
    results.push(await owners());
    expect(results.every((result) => result.status === 'ok')).toBe(true);
    expect(get.mock.calls.filter(([key]) => key === vaultOwnersSetKey(CHAIN))).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(4);

    now += 1;
    store.set(vaultOwnersSetKey(CHAIN), JSON.stringify([OWNER, '0x00000000000000000000000000000000000000bb']));
    expect((await owners()).owners).toHaveLength(2);
  });

  it('does not read the set at all when the mark already says it is truncated', async () => {
    indexed(JSON.stringify([OWNER]));
    store.set(vaultOwnersTruncatedKey(CHAIN), '1');
    expect(await owners()).toEqual(UNAVAILABLE);
    expect(get.mock.calls.map(([key]) => key)).not.toContain(vaultOwnersSetKey(CHAIN));
  });

  // A Redis outage resolves both reads to null. That is "nothing is known", and the page
  // used to render it as "no vaults are eligible for liquidation".
  it('reports the index as unavailable when neither key is present', async () => {
    const result = await owners();
    expect(result).toEqual({ status: 'unavailable', owners: [], lastIndexedBlock: null });
  });

  it('reports the index as unavailable when the cache read fails', async () => {
    get.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const result = await owners();
    expect(result).toEqual({ status: 'unavailable', owners: [], lastIndexedBlock: null });
    expect(errorLog).toHaveBeenCalled();
  });

  // A capped set is the lowest addresses, which depositors choose, so
  // serving it as 'ok' told the Liquidations page that no vault was eligible. 'unavailable'
  // sends the page to the on-chain VaultRegistry instead, in every dapp build.
  it('reports a set the indexer marked truncated as unavailable', async () => {
    indexed(JSON.stringify([OWNER]));
    store.set(vaultOwnersTruncatedKey(CHAIN), '1');
    const result = await owners();
    expect(result).toEqual({ status: 'unavailable', owners: [], lastIndexedBlock: null });
  });

  it('reports a set already at the cap as unavailable even without the mark', async () => {
    const atCap = Array.from(
      { length: MAX_STORED_OWNERS },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`
    );
    indexed(JSON.stringify(atCap));
    const result = await owners();
    expect(result.status).toBe('unavailable');
    expect(result.owners).toEqual([]);
  });

  it('serves a set the indexer marked complete as ok', async () => {
    indexed(JSON.stringify([OWNER]));
    store.set(vaultOwnersTruncatedKey(CHAIN), '0');
    const result = await owners();
    expect(result.status).toBe('ok');
    expect(result.owners).toHaveLength(1);
  });
});
