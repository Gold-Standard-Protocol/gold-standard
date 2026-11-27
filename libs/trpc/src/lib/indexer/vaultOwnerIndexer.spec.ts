import { inspect } from 'node:util';
import { getAddress, HttpRequestError, LimitExceededRpcError, RpcRequestError } from 'viem';
import type { Address } from 'viem';
import type { IndexerConfig } from './config';
import {
  indexVaultOwners,
  isOwnerIndexFresh,
  isOwnerSetTruncated,
  isRangeError,
  MAX_BLOCK_RANGE,
  MIN_BLOCK_RANGE,
  MAX_STORED_OWNERS,
  mergeOwners,
  parseCursor,
  parseStoredOwners,
  VAULT_OWNERS_SET_REFRESH_MS,
  VAULT_OWNERS_STALE_AFTER_MS,
  vaultOwnersCursorKey,
  vaultOwnersSetKey,
  vaultOwnersSyncedAtKey,
  vaultOwnersTruncatedKey,
  startingSpan,
} from './vaultOwnerIndexer';
import type { IndexerCacheStore, VaultLogClient } from './vaultOwnerIndexer';

const OWNER_A = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const OWNER_B = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
const VAULT = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');

const TEST_CONFIG: IndexerConfig = {
  rpcUrl: 'https://sepolia.example.org/rpc',
  goldVaultAddress: VAULT,
  deployBlock: 100n,
  chainId: 11155111,
  // The range arithmetic is pinned with no confirmation window; the window has its
  // own cases below.
  confirmations: 0,
};

const VAULT_OWNERS_SET_KEY = vaultOwnersSetKey(TEST_CONFIG.chainId);
const VAULT_OWNERS_CURSOR_KEY = vaultOwnersCursorKey(TEST_CONFIG.chainId);

interface StubStore {
  store: IndexerCacheStore;
  data: Map<string, string>;
  sets: { key: string; value: string; ttlMs?: number }[];
}

const createStubStore = (initial: Record<string, string> = {}): StubStore => {
  const data = new Map(Object.entries(initial));
  const sets: StubStore['sets'] = [];
  return {
    store: {
      get: async (key) => data.get(key) ?? null,
      set: async (key, value, ttlMs) => {
        data.set(key, value);
        sets.push({ key, value, ttlMs });
        return value;
      },
    },
    data,
    sets,
  };
};

interface StubClient {
  client: VaultLogClient;
  calls: { fromBlock: bigint; toBlock: bigint }[];
}

const createStubClient = (
  blockNumber: bigint,
  logsPerCall: { args: { user?: Address } }[][]
): StubClient => {
  const calls: StubClient['calls'] = [];
  return {
    client: {
      getBlockNumber: async () => blockNumber,
      getLogs: async ({ fromBlock, toBlock }) => {
        calls.push({ fromBlock, toBlock });
        return logsPerCall[calls.length - 1] ?? [];
      },
    },
    calls,
  };
};

describe('mergeOwners', () => {
  it('deduplicates and checksums without mutating its inputs', () => {
    const existing = [OWNER_A.toLowerCase()];
    const discovered = [OWNER_A, OWNER_B.toLowerCase()];
    const existingSnapshot = [...existing];
    const discoveredSnapshot = [...discovered];

    const merged = mergeOwners(existing, discovered);

    expect(merged).toEqual([OWNER_A, OWNER_B].sort());
    expect(existing).toEqual(existingSnapshot);
    expect(discovered).toEqual(discoveredSnapshot);
  });

  it('drops entries that are not valid addresses', () => {
    const merged = mergeOwners(['not-an-address', '0x1234'], [OWNER_B]);
    expect(merged).toEqual([OWNER_B]);
  });
});

describe('parseStoredOwners', () => {
  it('parses a valid JSON array and normalises entries', () => {
    const raw = JSON.stringify([OWNER_A.toLowerCase(), OWNER_A]);
    expect(parseStoredOwners(raw)).toEqual([OWNER_A]);
  });

  it('returns an empty list for null, malformed JSON and non-arrays', () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    expect(parseStoredOwners(null)).toEqual([]);
    expect(parseStoredOwners('{not json')).toEqual([]);
    expect(parseStoredOwners('{"a":1}')).toEqual([]);
    consoleError.mockRestore();
  });

  it('filters poisoned entries out of the cached set', () => {
    const raw = JSON.stringify([OWNER_A, 'javascript:alert(1)', 42]);
    expect(parseStoredOwners(raw)).toEqual([OWNER_A]);
  });
});

describe('parseCursor', () => {
  it('parses a decimal block number', () => {
    expect(parseCursor('12345')).toBe(12345n);
  });

  it('returns undefined for absent or malformed values', () => {
    expect(parseCursor(null)).toBeUndefined();
    expect(parseCursor('')).toBeUndefined();
    expect(parseCursor('-5')).toBeUndefined();
    expect(parseCursor('0x10')).toBeUndefined();
    expect(parseCursor('abc')).toBeUndefined();
  });
});

describe('indexVaultOwners', () => {
  it('scans from the deploy block on first run and persists owners and cursor', async () => {
    const { store, data } = createStubStore();
    const { client, calls } = createStubClient(150n, [
      [{ args: { user: OWNER_A } }, { args: { user: OWNER_B } }],
    ]);

    await indexVaultOwners(client, store, TEST_CONFIG);

    expect(calls).toEqual([{ fromBlock: 100n, toBlock: 150n }]);
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? '[]')).toEqual(
      [OWNER_A, OWNER_B].sort()
    );
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe('150');
  });

  it('resumes from the cached cursor and merges with existing owners', async () => {
    const { store, data } = createStubStore({
      [VAULT_OWNERS_SET_KEY]: JSON.stringify([OWNER_A]),
      [VAULT_OWNERS_CURSOR_KEY]: '150',
    });
    const { client, calls } = createStubClient(200n, [
      [{ args: { user: OWNER_B } }],
    ]);

    await indexVaultOwners(client, store, TEST_CONFIG);

    expect(calls).toEqual([{ fromBlock: 151n, toBlock: 200n }]);
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? '[]')).toEqual(
      [OWNER_A, OWNER_B].sort()
    );
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe('200');
  });

  it('chunks wide ranges into MAX_BLOCK_RANGE windows', async () => {
    const from = TEST_CONFIG.deployBlock;
    const to = from + MAX_BLOCK_RANGE * 2n + 5n;
    const { store } = createStubStore();
    const { client, calls } = createStubClient(to, [[], [], []]);

    await indexVaultOwners(client, store, TEST_CONFIG);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      fromBlock: from,
      toBlock: from + MAX_BLOCK_RANGE - 1n,
    });
    expect(calls[2]?.toBlock).toBe(to);
  });

  it('drops logs whose decoded user is missing or invalid', async () => {
    const { store, data } = createStubStore();
    const { client } = createStubClient(150n, [
      [
        { args: { user: OWNER_A } },
        { args: {} },
        { args: { user: 'nonsense' as Address } },
      ],
    ]);

    await indexVaultOwners(client, store, TEST_CONFIG);

    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? '[]')).toEqual([
      OWNER_A,
    ]);
  });

  it('keeps the cursor when no new blocks exist', async () => {
    const { store, data } = createStubStore({
      [VAULT_OWNERS_SET_KEY]: JSON.stringify([OWNER_A]),
      [VAULT_OWNERS_CURSOR_KEY]: '200',
    });
    const { client, calls } = createStubClient(200n, []);

    await indexVaultOwners(client, store, TEST_CONFIG);

    expect(calls).toEqual([]);
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe('200');
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? '[]')).toEqual([
      OWNER_A,
    ]);
  });

  it('stops a confirmation window short of the head and re-reads it behind the cursor', async () => {
    const config: IndexerConfig = { ...TEST_CONFIG, confirmations: 6 };
    const { store, data } = createStubStore({
      [VAULT_OWNERS_SET_KEY]: JSON.stringify([OWNER_A]),
      [VAULT_OWNERS_CURSOR_KEY]: '150',
    });
    // The head says 200, but the deposit at 149 was only visible on a node that had
    // caught up after the previous run stored its cursor.
    const { client, calls } = createStubClient(200n, [
      [{ args: { user: OWNER_B } }],
    ]);

    await indexVaultOwners(client, store, config);

    expect(calls).toEqual([{ fromBlock: 145n, toBlock: 194n }]);
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? '[]')).toEqual(
      [OWNER_A, OWNER_B].sort()
    );
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe('194');
  });

  it('never scans before the deploy block or moves the cursor backwards', async () => {
    const config: IndexerConfig = { ...TEST_CONFIG, confirmations: 6 };
    const { store, data } = createStubStore({
      [VAULT_OWNERS_SET_KEY]: '[]',
      [VAULT_OWNERS_CURSOR_KEY]: '102',
    });
    // Head 104: nothing is confirmed beyond the cursor, so the window re-read is all
    // there is, and the cursor must stay where it was.
    const { client, calls } = createStubClient(104n, [[]]);

    await indexVaultOwners(client, store, config);

    expect(calls).toEqual([]);
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe('102');
  });

  it('leaves the cache untouched and does not throw when getLogs fails', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { store, sets } = createStubStore({
      [VAULT_OWNERS_SET_KEY]: JSON.stringify([OWNER_A]),
      [VAULT_OWNERS_CURSOR_KEY]: '150',
    });
    const failingClient: VaultLogClient = {
      getBlockNumber: async () => 200n,
      getLogs: async () => {
        throw new Error('rpc down');
      },
    };

    await expect(
      indexVaultOwners(failingClient, store, TEST_CONFIG)
    ).resolves.toBeUndefined();

    expect(sets).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('persists every successful chunk so a failing provider cannot stall a first sync', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { store, data, sets } = createStubStore();
    const head = TEST_CONFIG.deployBlock + MAX_BLOCK_RANGE * 6n - 1n;
    const failAt = TEST_CONFIG.deployBlock + MAX_BLOCK_RANGE * 4n;
    const calls: bigint[] = [];
    const client: VaultLogClient = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock }) => {
        calls.push(fromBlock);
        if (fromBlock === failAt) throw new Error('rpc down');
        return fromBlock === TEST_CONFIG.deployBlock ? [{ args: { user: OWNER_A } }] : [];
      },
    };

    await indexVaultOwners(client, store, TEST_CONFIG);

    // Four chunks succeeded: the owner from the first is stored, the cursor sits at the
    // end of the fourth, and nothing was written for the failed chunk.
    expect(calls).toHaveLength(5);
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? '[]')).toEqual([OWNER_A]);
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe((failAt - 1n).toString());
    expect(sets.filter((entry) => entry.key === VAULT_OWNERS_CURSOR_KEY)).toHaveLength(4);
    expect(consoleError).toHaveBeenCalledTimes(1);

    // The next run resumes from the cursor rather than the deploy block.
    calls.length = 0;
    const recovered: VaultLogClient = { ...client, getLogs: async ({ fromBlock }) => {
      calls.push(fromBlock);
      return [];
    } };
    await indexVaultOwners(recovered, store, TEST_CONFIG);
    expect(calls[0]).toBe(failAt);
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe(head.toString());
    consoleError.mockRestore();
  });

  it('reports a deploy block above the chain head instead of scanning nothing', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { store, sets } = createStubStore();
    const client: VaultLogClient = {
      getBlockNumber: async () => 25_000_000n,
      getLogs: async () => {
        throw new Error('should not be called');
      },
    };

    await indexVaultOwners(client, store, { ...TEST_CONFIG, deployBlock: 250_000_000n });

    expect(sets).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('above the chain head'));
    consoleError.mockRestore();
  });

  it('caps the stored set at MAX_STORED_OWNERS with a warning', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store, data } = createStubStore();
    const flood = Array.from({ length: MAX_STORED_OWNERS + 5 }, (_, index) => ({
      args: { user: getAddress(`0x${(index + 1).toString(16).padStart(40, '0')}`) },
    }));
    const { client } = createStubClient(150n, [flood]);

    await indexVaultOwners(client, store, TEST_CONFIG);

    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? '[]')).toHaveLength(MAX_STORED_OWNERS);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining(`${MAX_STORED_OWNERS}`));
    consoleWarn.mockRestore();
  });
});

// The cap keeps the lowest checksummed addresses, which a depositor
// chooses by grinding, so a capped set must be marked and never read as the full list.
describe('indexVaultOwners truncation mark', () => {
  const VAULT_OWNERS_TRUNCATED_KEY = vaultOwnersTruncatedKey(TEST_CONFIG.chainId);
  const ownerAt = (index: number): Address =>
    getAddress(`0x${(index + 1).toString(16).padStart(40, '0')}`);
  const flood = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ args: { user: ownerAt(index) } }));

  let consoleWarn: jest.SpyInstance;
  beforeEach(() => {
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    consoleWarn.mockRestore();
  });

  it('marks the set complete on every run that stays within the cap', async () => {
    const { store, data } = createStubStore();
    const { client } = createStubClient(150n, [[{ args: { user: OWNER_A } }]]);

    await indexVaultOwners(client, store, TEST_CONFIG);

    expect(data.get(VAULT_OWNERS_TRUNCATED_KEY)).toBe('0');
  });

  it('marks the set truncated once the union passes the cap, before the capped set is written', async () => {
    const { store, data, sets } = createStubStore();
    const { client } = createStubClient(150n, [flood(MAX_STORED_OWNERS + 1)]);

    await indexVaultOwners(client, store, TEST_CONFIG);

    expect(data.get(VAULT_OWNERS_TRUNCATED_KEY)).toBe('1');
    const mark = sets.findIndex((entry) => entry.key === VAULT_OWNERS_TRUNCATED_KEY);
    const owners = sets.findIndex((entry) => entry.key === VAULT_OWNERS_SET_KEY);
    expect(mark).toBeLessThan(owners);
    expect(sets[mark]?.ttlMs).toBe(sets[owners]?.ttlMs);
  });

  it('keeps the mark on later runs, quiet or not, with a warning each time', async () => {
    const { store, data, sets } = createStubStore({
      [VAULT_OWNERS_SET_KEY]: JSON.stringify([OWNER_A]),
      [VAULT_OWNERS_CURSOR_KEY]: '200',
      [VAULT_OWNERS_TRUNCATED_KEY]: '1',
    });

    await indexVaultOwners(createStubClient(200n, []).client, store, TEST_CONFIG);
    expect(sets.filter((entry) => entry.key === VAULT_OWNERS_TRUNCATED_KEY).map((entry) => entry.value)).toEqual(['1']);

    await indexVaultOwners(createStubClient(250n, [[{ args: { user: OWNER_B } }]]).client, store, TEST_CONFIG);
    expect(data.get(VAULT_OWNERS_TRUNCATED_KEY)).toBe('1');
    expect(consoleWarn).toHaveBeenCalledTimes(2);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('truncated'));
  });

  it('treats a stored set already at the cap as truncated, as one written before the mark existed', async () => {
    const atCap = Array.from({ length: MAX_STORED_OWNERS }, (_, index) => ownerAt(index));
    const { store, data } = createStubStore({
      [VAULT_OWNERS_SET_KEY]: JSON.stringify(atCap),
      [VAULT_OWNERS_CURSOR_KEY]: '200',
    });

    await indexVaultOwners(createStubClient(200n, []).client, store, TEST_CONFIG);

    expect(data.get(VAULT_OWNERS_TRUNCATED_KEY)).toBe('1');
  });

  it('starts a rebuild of a lost snapshot unmarked and marks it again only if it passes the cap', async () => {
    const { store, data } = createStubStore({
      [VAULT_OWNERS_CURSOR_KEY]: '150',
      [VAULT_OWNERS_TRUNCATED_KEY]: '1',
    });

    await indexVaultOwners(createStubClient(200n, [[{ args: { user: OWNER_A } }]]).client, store, TEST_CONFIG);

    expect(data.get(VAULT_OWNERS_TRUNCATED_KEY)).toBe('0');
  });

  it.each([
    ['1', 0, true],
    ['0', MAX_STORED_OWNERS, true],
    [null, MAX_STORED_OWNERS - 1, false],
    ['0', 3, false],
    ['garbage', 3, false],
  ])('isOwnerSetTruncated(%p, %p) is %p', (flag, count, expected) => {
    expect(isOwnerSetTruncated(flag, count)).toBe(expected);
  });
});

describe('indexVaultOwners snapshot recovery', () => {
  let consoleWarn: jest.SpyInstance;
  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });

  const isBlockNumber = (value: string): boolean => /^\d+$/.test(value);

  it.each([
    ['absent', undefined],
    ['empty text', ''],
    ['malformed JSON', '[not json'],
    ['a JSON object', '{"owners":[]}'],
    ['JSON null', 'null'],
  ])('rebuilds from the deploy block when the snapshot is %s', async (_label, snapshot) => {
    const initial: Record<string, string> = { [VAULT_OWNERS_CURSOR_KEY]: '150' };
    const { store, data, sets } = createStubStore(
      snapshot === undefined ? initial : { ...initial, [VAULT_OWNERS_SET_KEY]: snapshot }
    );
    const { client, calls } = createStubClient(200n, [
      [{ args: { user: OWNER_A } }, { args: { user: OWNER_B } }],
    ]);

    await indexVaultOwners(client, store, TEST_CONFIG);

    expect(calls).toEqual([{ fromBlock: 100n, toBlock: 200n }]);
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? 'null')).toEqual([OWNER_A, OWNER_B].sort());
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe('200');
    // The surviving cursor was invalidated before any rebuilt snapshot was published.
    const firstOwnerWrite = sets.findIndex((entry) => entry.key === VAULT_OWNERS_SET_KEY);
    const invalidation = sets.findIndex(
      (entry) => entry.key === VAULT_OWNERS_CURSOR_KEY && !isBlockNumber(entry.value)
    );
    expect(invalidation).toBeGreaterThanOrEqual(0);
    expect(invalidation).toBeLessThan(firstOwnerWrite);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('rebuilding from the deploy block'));
  });

  it('trusts a valid empty snapshot and resumes from the cursor', async () => {
    const { store, data, sets } = createStubStore({
      [VAULT_OWNERS_SET_KEY]: '[]',
      [VAULT_OWNERS_CURSOR_KEY]: '150',
    });
    const { client, calls } = createStubClient(200n, [[{ args: { user: OWNER_B } }]]);

    await indexVaultOwners(client, store, TEST_CONFIG);

    expect(calls).toEqual([{ fromBlock: 151n, toBlock: 200n }]);
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? 'null')).toEqual([OWNER_B]);
    expect(sets.every((entry) => entry.key !== VAULT_OWNERS_CURSOR_KEY || isBlockNumber(entry.value))).toBe(true);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('recovers across chunks and an interrupted run without reusing the stale cursor', async () => {
    const head = TEST_CONFIG.deployBlock + MAX_BLOCK_RANGE * 3n - 1n;
    const secondChunk = TEST_CONFIG.deployBlock + MAX_BLOCK_RANGE;
    const { store, data } = createStubStore({ [VAULT_OWNERS_CURSOR_KEY]: head.toString() });
    const calls: bigint[] = [];
    const flaky: VaultLogClient = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock }) => {
        calls.push(fromBlock);
        if (fromBlock === secondChunk) throw new Error('rpc down');
        return fromBlock === TEST_CONFIG.deployBlock ? [{ args: { user: OWNER_A } }] : [];
      },
    };

    await indexVaultOwners(flaky, store, TEST_CONFIG);

    // The first chunk is published with its own cursor, never the stale one at the head.
    expect(calls).toEqual([TEST_CONFIG.deployBlock, secondChunk]);
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? 'null')).toEqual([OWNER_A]);
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe((secondChunk - 1n).toString());

    calls.length = 0;
    const healthy: VaultLogClient = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock }) => {
        calls.push(fromBlock);
        return fromBlock === secondChunk ? [{ args: { user: OWNER_B } }] : [];
      },
    };
    await indexVaultOwners(healthy, store, TEST_CONFIG);

    expect(calls).toEqual([secondChunk, secondChunk + MAX_BLOCK_RANGE]);
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? 'null')).toEqual([OWNER_A, OWNER_B].sort());
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe(head.toString());
  });

  it('restarts the rebuild from the deploy block when a cursor write fails after a partial snapshot', async () => {
    const { store: inner, data } = createStubStore({ [VAULT_OWNERS_CURSOR_KEY]: '150' });
    const failingCursor: IndexerCacheStore = {
      get: inner.get,
      set: async (key, value, ttlMs) => {
        if (key === VAULT_OWNERS_CURSOR_KEY && isBlockNumber(value)) {
          throw new Error('redis write failed');
        }
        return inner.set(key, value, ttlMs);
      },
    };
    const first = createStubClient(200n, [[{ args: { user: OWNER_A } }]]);

    await indexVaultOwners(first.client, failingCursor, TEST_CONFIG);

    // A partial snapshot was published, but the old advanced cursor did not survive it.
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? 'null')).toEqual([OWNER_A]);
    expect(isBlockNumber(data.get(VAULT_OWNERS_CURSOR_KEY) ?? '')).toBe(false);

    const second = createStubClient(200n, [[{ args: { user: OWNER_B } }]]);
    await indexVaultOwners(second.client, inner, TEST_CONFIG);

    expect(second.calls).toEqual([{ fromBlock: 100n, toBlock: 200n }]);
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? 'null')).toEqual([OWNER_A, OWNER_B].sort());
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe('200');
  });

  it('keeps recovering across ticks with no confirmed blocks to scan', async () => {
    const config: IndexerConfig = { ...TEST_CONFIG, confirmations: 6 };
    const { store, data } = createStubStore({ [VAULT_OWNERS_CURSOR_KEY]: '150' });
    // Head 104 less six confirmations sits below the deploy block: nothing to scan yet.
    const idle = createStubClient(104n, []);

    await indexVaultOwners(idle.client, store, config);

    expect(idle.calls).toEqual([]);
    expect(isBlockNumber(data.get(VAULT_OWNERS_CURSOR_KEY) ?? '')).toBe(false);

    const later = createStubClient(200n, [[{ args: { user: OWNER_A } }]]);
    await indexVaultOwners(later.client, store, config);

    expect(later.calls).toEqual([{ fromBlock: 100n, toBlock: 194n }]);
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe('194');
  });
});

describe('parseStoredOwners memoisation', () => {
  it('parses an unchanged raw string once and hands out independent copies', () => {
    const raw = JSON.stringify(
      Array.from({ length: 2_000 }, (_, index) =>
        getAddress(`0x${(0x10000 + index).toString(16).padStart(40, '0')}`)
      )
    );
    const parse = jest.spyOn(JSON, 'parse');
    const first = parseStoredOwners(raw);
    const second = parseStoredOwners(raw);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    first.length = 0;
    expect(parseStoredOwners(raw)).toHaveLength(2_000);
    parse.mockRestore();
  });

  it('drops poisoned entries: prototype keys, padding, 0X prefixes, huge strings and non-strings', () => {
    const good = getAddress(`0x${'3'.padStart(40, '0')}`);
    const raw = JSON.stringify([
      '__proto__',
      ` ${getAddress(`0x${'1'.padStart(40, '0')}`)}`,
      `0X${getAddress(`0x${'2'.padStart(40, '0')}`).slice(2)}`,
      good.toLowerCase(),
      'x'.repeat(100_000),
      7,
      null,
      good,
    ]);
    expect(parseStoredOwners(raw)).toEqual([good]);
  });
});

describe('isRangeError', () => {
  it.each([
    'query returned more than 10000 results',
    'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range',
    'eth_getLogs and eth_newFilter are limited to a 10,000 blocks range',
    'exceed maximum block range: 5000',
    'block range is too wide',
    'Block range too large',
    'Exceeded max range limit',
    'Request exceeds defined limit.',
    'too many logs in the response',
    // The wording of three free plans, as they answered on 2026-11-20.
    'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work',
    'ranges over 100 blocks are not supported on free plan',
    'range 50000 exceeds limit of 10000',
  ])('recognises "%s" as a window that was too wide', (message) => {
    expect(isRangeError(new Error(message))).toBe(true);
  });

  it('looks through the causes viem wraps an RPC error in, and at the limit code', () => {
    const rpc = Object.assign(new Error('Limit exceeded'), { code: -32005 });
    expect(isRangeError(new Error('HTTP request failed.', { cause: rpc }))).toBe(true);
    const coded = Object.assign(new Error('Request failed'), { code: -32005 });
    expect(isRangeError(coded)).toBe(true);
  });

  it.each(['rpc down', 'fetch failed', 'HTTP request failed. Status: 503', 'execution reverted'])(
    'does not mistake "%s" for a range refusal',
    (message) => {
      expect(isRangeError(new Error(message))).toBe(false);
    }
  );
});

describe('startingSpan', () => {
  it('is the full range when INDEXER_MAX_BLOCK_RANGE is unset', () => {
    expect(startingSpan(undefined)).toBe(MAX_BLOCK_RANGE);
  });

  it('is the configured width, never above the full range and never below one block', () => {
    expect(startingSpan(10n)).toBe(10n);
    expect(startingSpan(1n)).toBe(1n);
    expect(startingSpan(MAX_BLOCK_RANGE)).toBe(MAX_BLOCK_RANGE);
    expect(startingSpan(MAX_BLOCK_RANGE + 1n)).toBe(MAX_BLOCK_RANGE);
    expect(startingSpan(0n)).toBe(1n);
    expect(startingSpan(-5n)).toBe(1n);
  });
});

describe('indexVaultOwners on a provider with a narrower getLogs cap', () => {
  const PROVIDER_CAP = 2_000n;

  const cappedClient = (head: bigint, cap: bigint) => {
    const calls: { fromBlock: bigint; toBlock: bigint }[] = [];
    const client: VaultLogClient = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock }) => {
        calls.push({ fromBlock, toBlock });
        if (toBlock - fromBlock + 1n > cap) {
          throw new Error(`Log response size exceeded. You can make eth_getLogs requests with up to a ${cap} block range`);
        }
        return fromBlock === TEST_CONFIG.deployBlock ? [{ args: { user: OWNER_A } }] : [];
      },
    };
    return { client, calls };
  };

  it('halves the window until the provider accepts it and finishes the run at that width', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const head = TEST_CONFIG.deployBlock + 5_000n - 1n;
    const { client, calls } = cappedClient(head, PROVIDER_CAP);
    const { store, data } = createStubStore();

    await indexVaultOwners(client, store, TEST_CONFIG);

    const widths = calls.map((call) => call.toBlock - call.fromBlock + 1n);
    // 10,000 (clamped to the 5,000 left), 2,500 refused; then 1,250-block windows to the head.
    expect(widths).toEqual([5_000n, 2_500n, 1_250n, 1_250n, 1_250n, 1_250n]);
    expect(calls.at(-1)?.toBlock).toBe(head);
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? 'null')).toEqual([OWNER_A]);
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe(head.toString());
    expect(consoleWarn).toHaveBeenCalledTimes(2);
    consoleWarn.mockRestore();
  });

  it('never asks for more than INDEXER_MAX_BLOCK_RANGE, so a ten-block provider refuses nothing', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const head = TEST_CONFIG.deployBlock + 45n - 1n;
    const { client, calls } = cappedClient(head, 10n);
    const { store, data } = createStubStore();

    await indexVaultOwners(client, store, { ...TEST_CONFIG, maxBlockRange: 10n });

    const widths = calls.map((call) => call.toBlock - call.fromBlock + 1n);
    expect(widths).toEqual([10n, 10n, 10n, 10n, 5n]);
    expect(calls[0]?.fromBlock).toBe(TEST_CONFIG.deployBlock);
    expect(calls.at(-1)?.toBlock).toBe(head);
    // every window starts where the last one ended: no block is skipped or read twice
    calls.slice(1).forEach((call, index) => expect(call.fromBlock).toBe((calls[index]?.toBlock ?? 0n) + 1n));
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? 'null')).toEqual([OWNER_A]);
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe(head.toString());
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });

  it('a steady-state run with six confirmations fits two ten-block windows', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config: IndexerConfig = { ...TEST_CONFIG, confirmations: 6, maxBlockRange: 10n };
    const { store } = createStubStore();
    // first run to a head, then the chain moves five blocks (one minute of mainnet)
    const first = cappedClient(TEST_CONFIG.deployBlock + 30n, 10n);
    await indexVaultOwners(first.client, store, config);
    const second = cappedClient(TEST_CONFIG.deployBlock + 35n, 10n);
    await indexVaultOwners(second.client, store, config);

    const widths = second.calls.map((call) => call.toBlock - call.fromBlock + 1n);
    // six blocks re-read behind the cursor plus five new ones: eleven blocks, in 10 and 1
    expect(widths).toEqual([10n, 1n]);
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it('does not narrow a refused window below the configured width when that is under the minimum', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const head = TEST_CONFIG.deployBlock + 45n - 1n;
    const { client, calls } = cappedClient(head, 5n);
    const { store, sets } = createStubStore();

    await expect(indexVaultOwners(client, store, { ...TEST_CONFIG, maxBlockRange: 10n })).resolves.toBeUndefined();

    expect(calls.map((call) => call.toBlock - call.fromBlock + 1n)).toEqual([10n]);
    expect(sets).toEqual([]);
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });

  it('stops as before once the window is at the minimum and still refused', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const head = TEST_CONFIG.deployBlock + MAX_BLOCK_RANGE - 1n;
    const { client, calls } = cappedClient(head, 0n);
    const { store, sets } = createStubStore();

    await expect(indexVaultOwners(client, store, TEST_CONFIG)).resolves.toBeUndefined();

    const widths = calls.map((call) => call.toBlock - call.fromBlock + 1n);
    expect(widths).toEqual([10_000n, 5_000n, 2_500n, 1_250n, 625n, 312n, 156n, MIN_BLOCK_RANGE]);
    expect(calls.every((call) => call.fromBlock === TEST_CONFIG.deployBlock)).toBe(true);
    expect(sets).toEqual([]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });

  it('does not halve on a failure that is not about the window', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const calls: bigint[] = [];
    const client: VaultLogClient = {
      getBlockNumber: async () => TEST_CONFIG.deployBlock + MAX_BLOCK_RANGE - 1n,
      getLogs: async ({ fromBlock, toBlock }) => {
        calls.push(toBlock - fromBlock + 1n);
        throw new Error('rpc down');
      },
    };
    const { store } = createStubStore();

    await indexVaultOwners(client, store, TEST_CONFIG);

    expect(calls).toEqual([MAX_BLOCK_RANGE]);
    consoleError.mockRestore();
  });
});

describe('indexVaultOwners keeps the RPC key out of its log', () => {
  const KEY = 'k3yThatMustNotReachTheLog';

  // viem builds a transport error around the request URL, in its message and again as an
  // own `url` property, and a provider key sits in that URL's path.
  const keyedFailure = (): HttpRequestError =>
    new HttpRequestError({
      url: `https://eth-mainnet.example.org/v2/${KEY}`,
      status: 503,
      details: 'Service Unavailable',
    });

  // What console.error prints: a string as it is, anything else as node inspects it.
  const printed = (calls: readonly unknown[][]): string =>
    calls
      .map((args) => args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg))).join(' '))
      .join('\n');

  it('redacts the URL of a chunk that fails', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { store } = createStubStore();
    const client: VaultLogClient = {
      getBlockNumber: async () => 200n,
      getLogs: async () => {
        throw keyedFailure();
      },
    };

    await indexVaultOwners(client, store, TEST_CONFIG);

    const output = printed(consoleError.mock.calls);
    expect(output).toContain('Vault owner indexing stopped at block 100');
    expect(output).toContain('https://eth-mainnet.example.org/<redacted>');
    expect(output).toContain('Service Unavailable');
    expect(output).not.toContain(KEY);
    consoleError.mockRestore();
  });

  it('redacts the URL of a failure outside a chunk', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { store } = createStubStore();
    const client: VaultLogClient = {
      getBlockNumber: async () => {
        throw keyedFailure();
      },
      getLogs: async () => [],
    };

    await indexVaultOwners(client, store, TEST_CONFIG);

    const output = printed(consoleError.mock.calls);
    expect(output).toContain('Vault owner indexing failed');
    expect(output).toContain('https://eth-mainnet.example.org/<redacted>');
    expect(output).not.toContain(KEY);
    consoleError.mockRestore();
  });
});

// Viem maps every JSON-RPC -32005 to
// "Request exceeds defined limit.", and Infura answers a rate limit with that code. A throttle
// read as a range refusal halved the window down to 100 blocks and multiplied the requests
// against a provider that was already refusing them.
describe('isRangeError on a rate limit', () => {
  const rpcError = (code: number, message: string): RpcRequestError =>
    new RpcRequestError({ body: {}, error: { code, message }, url: 'https://rpc.example.org' });

  it.each([
    ['a -32005 whose provider says the request rate was exceeded', new LimitExceededRpcError(rpcError(-32005, 'project ID request rate exceeded'))],
    ['a -32005 that says it was rate limited', new LimitExceededRpcError(rpcError(-32005, 'daily request count exceeded, request rate limited'))],
    ['a bare -32005 that names a rate limit', Object.assign(new Error('rate limit exceeded'), { code: -32005 })],
    ['an HTTP 429 whose body says the limit was exceeded', new HttpRequestError({ url: 'https://rpc.example.org', status: 429, details: 'limit exceeded' })],
    ['an HTTP 429 with no wording at all', new HttpRequestError({ url: 'https://rpc.example.org', status: 429 })],
    ['a compute unit throttle', new Error('Your app has exceeded its compute units per second capacity')],
  ])('does not read %s as a window that was too wide', (_label, error) => {
    expect(isRangeError(error)).toBe(false);
  });

  it('still reads a -32005 that does not name a rate limit as a range refusal', () => {
    expect(isRangeError(new LimitExceededRpcError(rpcError(-32005, 'query returned more than 10000 results')))).toBe(true);
  });

  it('stops a throttled run at once instead of halving the window', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const widths: bigint[] = [];
    const client: VaultLogClient = {
      getBlockNumber: async () => TEST_CONFIG.deployBlock + MAX_BLOCK_RANGE - 1n,
      getLogs: async ({ fromBlock, toBlock }) => {
        widths.push(toBlock - fromBlock + 1n);
        throw new LimitExceededRpcError(rpcError(-32005, 'project ID request rate exceeded'));
      },
    };

    await indexVaultOwners(client, createStubStore().store, TEST_CONFIG);

    expect(widths).toEqual([MAX_BLOCK_RANGE]);
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });
});

// The API answered 'ok' from an index
// that had stopped advancing, or from a first sync or rebuild that had published only its
// first chunks. The indexer now stamps the time a run reached its target block, and wipes
// the stamp before a scan from the deploy block publishes anything.
describe('indexVaultOwners sync stamp', () => {
  const SYNCED_KEY = vaultOwnersSyncedAtKey(TEST_CONFIG.chainId);
  const NOW = 1_800_000_000_000;
  let clock: jest.SpyInstance;
  let consoleError: jest.SpyInstance;
  let consoleWarn: jest.SpyInstance;
  beforeEach(() => {
    clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    clock.mockRestore();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it('stamps a run that reached its target block, after the cursor', async () => {
    const { store, data, sets } = createStubStore();

    await indexVaultOwners(createStubClient(150n, [[{ args: { user: OWNER_A } }]]).client, store, TEST_CONFIG);

    expect(data.get(SYNCED_KEY)).toBe(String(NOW));
    const lastCursor = sets.map((entry) => entry.key).lastIndexOf(VAULT_OWNERS_CURSOR_KEY);
    expect(sets.findIndex((entry) => entry.key === SYNCED_KEY && entry.value === String(NOW))).toBeGreaterThan(lastCursor);
  });

  it('stamps a run with nothing new to scan', async () => {
    const { store, data } = createStubStore({
      [VAULT_OWNERS_SET_KEY]: JSON.stringify([OWNER_A]),
      [VAULT_OWNERS_CURSOR_KEY]: '200',
    });

    await indexVaultOwners(createStubClient(200n, []).client, store, TEST_CONFIG);

    expect(data.get(SYNCED_KEY)).toBe(String(NOW));
  });

  it('leaves an earlier stamp to age when a run stops part way', async () => {
    const earlier = String(NOW - 60_000);
    const { store, data } = createStubStore({
      [VAULT_OWNERS_SET_KEY]: JSON.stringify([OWNER_A]),
      [VAULT_OWNERS_CURSOR_KEY]: '150',
      [SYNCED_KEY]: earlier,
    });
    const head = 150n + MAX_BLOCK_RANGE * 2n;
    const client: VaultLogClient = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock }) => {
        if (fromBlock > 151n) throw new Error('rpc down');
        return [];
      },
    };

    await indexVaultOwners(client, store, TEST_CONFIG);

    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe((150n + MAX_BLOCK_RANGE).toString());
    expect(data.get(SYNCED_KEY)).toBe(earlier);
  });

  it('wipes the stamp before a rebuild from the deploy block publishes its first chunk', async () => {
    const head = TEST_CONFIG.deployBlock + MAX_BLOCK_RANGE * 2n - 1n;
    const { store, data, sets } = createStubStore({
      [VAULT_OWNERS_CURSOR_KEY]: head.toString(),
      [SYNCED_KEY]: String(NOW - 30_000),
    });
    const client: VaultLogClient = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock }) => {
        if (fromBlock > TEST_CONFIG.deployBlock) throw new Error('rpc down');
        return [{ args: { user: OWNER_A } }];
      },
    };

    await indexVaultOwners(client, store, TEST_CONFIG);

    const wipe = sets.findIndex((entry) => entry.key === SYNCED_KEY);
    const firstOwners = sets.findIndex((entry) => entry.key === VAULT_OWNERS_SET_KEY);
    expect(wipe).toBeGreaterThanOrEqual(0);
    expect(wipe).toBeLessThan(firstOwners);
    expect(isOwnerIndexFresh(data.get(SYNCED_KEY), NOW)).toBe(false);
  });

  it.each([
    [String(NOW), NOW, true],
    [String(NOW - VAULT_OWNERS_STALE_AFTER_MS + 1), NOW, true],
    [String(NOW - VAULT_OWNERS_STALE_AFTER_MS), NOW, false],
    [String(NOW + 120_000), NOW, false],
    ['syncing', NOW, false],
    ['', NOW, false],
    [null, NOW, false],
  ])('isOwnerIndexFresh(%p) is %p', (raw, now, expected) => {
    expect(isOwnerIndexFresh(raw, now)).toBe(expected);
  });
});

// Every run re-validated, re-sorted and
// rewrote the whole stored set although no owner was added, which blocks the API's event
// loop for hundreds of milliseconds a minute near the cap.
describe('indexVaultOwners set rewrites', () => {
  const NOW = 1_800_000_000_000;
  let clock: jest.SpyInstance;
  beforeEach(() => {
    clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    clock.mockRestore();
  });

  const ownerWrites = (sets: StubStore['sets']): number =>
    sets.filter((entry) => entry.key === VAULT_OWNERS_SET_KEY).length;

  it('rewrites the set only when an owner is added or the daily refresh is due', async () => {
    const { store, data, sets } = createStubStore({
      [VAULT_OWNERS_SET_KEY]: JSON.stringify([OWNER_A]),
      [VAULT_OWNERS_CURSOR_KEY]: '150',
    });

    // The first run of a process refreshes the set's TTL, since nothing says when it was written.
    await indexVaultOwners(createStubClient(200n, [[{ args: { user: OWNER_A } }]]).client, store, TEST_CONFIG);
    expect(ownerWrites(sets)).toBe(1);

    // Known owners only, and a quiet run: the cursor and the mark move, the set does not.
    await indexVaultOwners(createStubClient(250n, [[{ args: { user: OWNER_A } }]]).client, store, TEST_CONFIG);
    await indexVaultOwners(createStubClient(250n, []).client, store, TEST_CONFIG);
    expect(ownerWrites(sets)).toBe(1);
    expect(data.get(VAULT_OWNERS_CURSOR_KEY)).toBe('250');
    expect(sets.filter((entry) => entry.key === vaultOwnersTruncatedKey(TEST_CONFIG.chainId))).toHaveLength(3);

    // A new owner is written at once.
    await indexVaultOwners(createStubClient(300n, [[{ args: { user: OWNER_B } }]]).client, store, TEST_CONFIG);
    expect(ownerWrites(sets)).toBe(2);
    expect(JSON.parse(data.get(VAULT_OWNERS_SET_KEY) ?? 'null')).toEqual([OWNER_A, OWNER_B].sort());

    // A day on, a quiet run rewrites it so its seven-day TTL never lapses under a healthy indexer.
    clock.mockReturnValue(NOW + VAULT_OWNERS_SET_REFRESH_MS);
    await indexVaultOwners(createStubClient(300n, []).client, store, TEST_CONFIG);
    expect(ownerWrites(sets)).toBe(3);
  });

  it('does not rewrite a capped set for a depositor the cap leaves out again', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ownerAt = (index: number): Address => getAddress(`0x${(index + 1).toString(16).padStart(40, '0')}`);
    const atCap = Array.from({ length: MAX_STORED_OWNERS }, (_, index) => ownerAt(index));
    const { store, sets } = createStubStore({
      [VAULT_OWNERS_SET_KEY]: JSON.stringify(atCap),
      [VAULT_OWNERS_CURSOR_KEY]: '150',
      [vaultOwnersTruncatedKey(TEST_CONFIG.chainId)]: '1',
    });
    await indexVaultOwners(createStubClient(150n, []).client, store, TEST_CONFIG);
    const before = ownerWrites(sets);

    await indexVaultOwners(createStubClient(200n, [[{ args: { user: OWNER_A } }]]).client, store, TEST_CONFIG);

    expect(ownerWrites(sets)).toBe(before);
    consoleWarn.mockRestore();
  });
});
