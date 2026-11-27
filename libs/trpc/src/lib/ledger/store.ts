import type { Redis } from 'ioredis';
import type { LedgerAccount } from './account';
import { decodeAccount, decodeMeta, decodePosition, encodeAccount, encodeMeta, encodePosition } from './codec';
import type { LedgerMeta } from './codec';
import { LedgerIntegrityError } from './errors';
import type { LedgerKeys } from './keys';
import { LEDGER_STATE_TTL_MS } from './limits';
import type { LiquidityPosition } from './liquidity';

export interface CommitWrite {
  meta: LedgerMeta;
  /** The records that changed or were opened, keyed by lowercase address. A record is never deleted. */
  accounts: ReadonlyMap<string, LedgerAccount>;
  /** The liquidity positions that changed, keyed by token id. */
  positions?: ReadonlyMap<string, LiquidityPosition>;
  /** Token ids of the liquidity positions that are deleted. */
  positionsRemoved?: readonly string[];
}

/** The two raw values one account answer is built from, read in one round trip. */
export interface AccountViewRaw {
  meta: string | null;
  account: string | null;
}

export interface LedgerStore {
  /** Undefined when the meta is absent or fails its schema. */
  readMeta(): Promise<LedgerMeta | undefined>;
  /** The meta as stored, for the readers, which judge it themselves. */
  readMetaRaw(): Promise<string | null>;
  /** Throws LedgerIntegrityError when a stored record fails its schema. */
  loadAccounts(): Promise<Map<string, LedgerAccount>>;
  /** The liquidity positions, keyed by token id. Throws LedgerIntegrityError on an unreadable record. */
  loadPositions(): Promise<Map<string, LiquidityPosition>>;
  /** Atomic. False when another writer moved the state since `expectedStateId` was read. */
  commit(expectedStateId: string | null, write: CommitWrite): Promise<boolean>;
  /** Drops every key and installs `meta`. */
  reset(meta: LedgerMeta): Promise<void>;
  readAccountView(address: string): Promise<AccountViewRaw>;
  /** Every address that has a record, lowercase, in no particular order. */
  listAddresses(): Promise<string[]>;
  /** The stored records of these addresses as stored, in the order asked; null for one that has none. */
  readAccountsRaw(addresses: readonly string[]): Promise<(string | null)[]>;
}

const SCAN_COUNT = 1_000;
const HSET_FIELDS_PER_COMMAND = 500;
const HDEL_FIELDS_PER_COMMAND = 500;

type ExecResult = [error: Error | null, result: unknown][] | null;

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The replies of a transaction that ran; a failed command inside it is a store failure. */
const repliesOf = (results: ExecResult): unknown[] => {
  if (results === null) throw new Error('the Redis transaction was discarded');
  return results.map(([error, reply]) => {
    if (error !== null) throw error;
    return reply;
  });
};

const scanHash = async (redis: Redis, key: string): Promise<Map<string, string>> => {
  const entries = new Map<string, string>();
  let cursor = '0';
  do {
    const [next, flat] = await redis.hscan(key, cursor, 'COUNT', SCAN_COUNT);
    for (let index = 0; index + 1 < flat.length; index += 2) {
      entries.set(flat[index], flat[index + 1]);
    }
    cursor = next;
  } while (cursor !== '0');
  return entries;
};

const chunked = <Item>(items: readonly Item[], size: number): Item[][] => {
  const chunks: Item[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
};

const storedStateId = (raw: string | null): string | null => decodeMeta(raw)?.stateId ?? null;

/** Loads one hash of records, failing loudly on a record that does not decode. */
const loadRecords = async <Value>(
  redis: Redis,
  key: string,
  decode: (raw: string) => Value | undefined,
  describe: (field: string) => string
): Promise<Map<string, Value>> => {
  const records = new Map<string, Value>();
  for (const [field, raw] of await scanHash(redis, key)) {
    const value = decode(raw);
    if (value === undefined) throw new LedgerIntegrityError(`${describe(field)} is unreadable`);
    records.set(field, value);
  }
  return records;
};

export const createLedgerStore = (redis: Redis, keys: LedgerKeys): LedgerStore => {
  const hsetAll = (
    multi: ReturnType<Redis['multi']>,
    key: string,
    entries: readonly (readonly [string, string])[]
  ): void => {
    for (const chunk of chunked(entries, HSET_FIELDS_PER_COMMAND)) {
      multi.hset(key, Object.fromEntries(chunk));
    }
  };
  const hdelAll = (multi: ReturnType<Redis['multi']>, key: string, fields: readonly string[]): void => {
    for (const chunk of chunked(fields, HDEL_FIELDS_PER_COMMAND)) {
      multi.hdel(key, ...chunk);
    }
  };

  return {
    readMeta: async () => decodeMeta(await redis.get(keys.meta)),

    readMetaRaw: () => redis.get(keys.meta),

    loadAccounts: () => loadRecords(redis, keys.accounts, decodeAccount, (address) => `the stored record of ${address}`),

    loadPositions: () =>
      loadRecords(redis, keys.positions, decodePosition, (tokenId) => `the stored liquidity position ${tokenId}`),

    commit: async (expectedStateId, write) => {
      await redis.watch(keys.meta);
      let queued = false;
      try {
        if (storedStateId(await redis.get(keys.meta)) !== expectedStateId) return false;
        const multi = redis.multi();
        hsetAll(multi, keys.accounts, [...write.accounts].map(([address, account]) => [address, encodeAccount(account)] as const));
        hsetAll(multi, keys.positions, [...(write.positions ?? [])].map(([tokenId, position]) => [tokenId, encodePosition(position)] as const));
        hdelAll(multi, keys.positions, write.positionsRemoved ?? []);
        multi.set(keys.meta, encodeMeta(write.meta));
        for (const key of [keys.meta, keys.accounts, keys.positions]) {
          multi.pexpire(key, LEDGER_STATE_TTL_MS);
        }
        queued = true;
        const results = (await multi.exec()) as ExecResult;
        if (results === null) return false;
        repliesOf(results);
        return true;
      } finally {
        // EXEC clears the watch itself; every other way out must.
        if (!queued) await redis.unwatch();
      }
    },

    reset: async (meta) => {
      repliesOf(
        (await redis
          .multi()
          .del(keys.accounts, keys.positions)
          .set(keys.meta, encodeMeta(meta), 'PX', LEDGER_STATE_TTL_MS)
          .exec()) as ExecResult
      );
    },

    listAddresses: () => redis.hkeys(keys.accounts),

    readAccountsRaw: async (addresses) => (addresses.length === 0 ? [] : redis.hmget(keys.accounts, ...addresses)),

    readAccountView: async (address) => {
      const [meta, account] = repliesOf(
        (await redis.multi().get(keys.meta).hget(keys.accounts, address).exec()) as ExecResult
      );
      return { meta: stringOrNull(meta), account: stringOrNull(account) };
    },
  };
};
