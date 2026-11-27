import type { LedgerAccount } from './account';
import { decodeAccount, decodeMeta, decodePosition, encodeAccount, encodeMeta, encodePosition } from './codec';
import { LedgerIntegrityError } from './errors';
import type { LiquidityPosition } from './liquidity';
import type { LedgerStore } from './store';

/** The raw strings an in-memory store holds, open to specs that need to corrupt or inspect them. */
export interface MemoryLedgerStore extends LedgerStore {
  raw: {
    meta: string | null;
    accounts: Map<string, string>;
    positions: Map<string, string>;
  };
  /** How many commits were accepted. */
  commits: () => number;
}

const decodeAll = <Value>(
  entries: ReadonlyMap<string, string>,
  decode: (raw: string) => Value | undefined,
  describe: (field: string) => string
): Map<string, Value> => {
  const records = new Map<string, Value>();
  for (const [field, raw] of entries) {
    const value = decode(raw);
    if (value === undefined) throw new LedgerIntegrityError(`${describe(field)} is unreadable`);
    records.set(field, value);
  }
  return records;
};

/**
 * The store contract over plain maps, holding the same encoded strings Redis would. For
 * specs and local experiments; it has the atomicity of a single thread.
 */
export const createMemoryLedgerStore = (): MemoryLedgerStore => {
  const raw: MemoryLedgerStore['raw'] = { meta: null, accounts: new Map(), positions: new Map() };
  let commits = 0;
  return {
    raw,
    commits: () => commits,
    readMeta: async () => decodeMeta(raw.meta),
    readMetaRaw: async () => raw.meta,
    loadAccounts: async () => decodeAll(raw.accounts, decodeAccount, (address) => `the stored record of ${address}`),
    loadPositions: async () => decodeAll(raw.positions, decodePosition, (tokenId) => `the stored liquidity position ${tokenId}`),
    commit: async (expectedStateId, write) => {
      if ((decodeMeta(raw.meta)?.stateId ?? null) !== expectedStateId) return false;
      for (const [address, account] of write.accounts) raw.accounts.set(address, encodeAccount(account));
      for (const [tokenId, position] of write.positions ?? []) raw.positions.set(tokenId, encodePosition(position));
      for (const tokenId of write.positionsRemoved ?? []) raw.positions.delete(tokenId);
      raw.meta = encodeMeta(write.meta);
      commits += 1;
      return true;
    },
    reset: async (meta) => {
      raw.accounts.clear();
      raw.positions.clear();
      raw.meta = encodeMeta(meta);
    },
    readAccountView: async (address) => ({ meta: raw.meta, account: raw.accounts.get(address) ?? null }),
    listAddresses: async () => [...raw.accounts.keys()],
    readAccountsRaw: async (addresses) => addresses.map((address) => raw.accounts.get(address) ?? null),
  };
};
