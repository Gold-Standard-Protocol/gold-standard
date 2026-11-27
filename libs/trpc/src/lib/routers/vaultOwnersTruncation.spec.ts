// The indexer's owner-set cap keeps the lowest addresses, so served as complete it would let
// ground dust depositors hide every real borrower from the API and the Liquidations page.
// The real indexer, router and keeper Redis source run over an
// in-memory store and a fake chain that answers getLogs by block range.
const apiStore = new Map<string, string>();

jest.mock('../config/cacheManager', () => ({
  getCacheHandle: () => ({ keyv: { get: async (key: string) => apiStore.get(key) } }),
}));

// Importing the router bootstraps the indexer; keep the queue out of these tests.
jest.mock('../indexer/queue', () => ({
  initVaultIndexWorker: jest.fn(),
  scheduleVaultIndex: jest.fn(async () => undefined),
}));

import { getAddress } from 'viem';
import type { Address } from 'viem';
import type { IndexerConfig } from '../indexer/config';
import {
  indexVaultOwners,
  MAX_STORED_OWNERS,
  vaultOwnersSetKey,
  vaultOwnersTruncatedKey,
} from '../indexer/vaultOwnerIndexer';
import type { IndexerCacheStore, VaultLogClient } from '../indexer/vaultOwnerIndexer';
import { createRedisVaultOwnerSource } from '../keeper/ownerSource';
import type { KeeperLogger } from '../keeper/ports';
import { VAULT_OWNERS_MEMO_MS, vaultsRouter } from './vaults';

const CHAIN = 11155111;
const CONFIG: IndexerConfig = {
  rpcUrl: 'https://sepolia.example.org/rpc',
  goldVaultAddress: getAddress('0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0'),
  deployBlock: 1_000n,
  chainId: CHAIN,
  confirmations: 6,
};

const EARLY_BORROWERS = [
  getAddress('0x90f79bf6eb2c4f870365e785982e1f101e93b906'),
  getAddress('0x15d34aaf54267db7d7c367839aaf71a00a2c6a65'),
  getAddress('0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc'),
];
const LATE_BORROWER = getAddress('0x976ea74026e726554db657fa54763abd0c3a0aa9');
const BORROWERS = [...EARLY_BORROWERS, LATE_BORROWER];

// Depositors ground to a 0x0000 prefix, so they sort below every borrower above, followed
// by pseudo-random hex rather than a sequence.
let seed = 0x9e3779b9;
const nextHex = (): string => {
  seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
  return seed.toString(16).padStart(8, '0');
};
const groundDepositor = (): Address => {
  let tail = '';
  while (tail.length < 36) tail += nextHex();
  return getAddress(`0x0000${tail.slice(0, 36)}`);
};

const deposits: { block: bigint; user: Address }[] = [];
let head = 0n;
const client: VaultLogClient = {
  getBlockNumber: async () => head,
  getLogs: async ({ fromBlock, toBlock }) =>
    deposits
      .filter((log) => log.block >= fromBlock && log.block <= toBlock)
      .map((log) => ({ args: { user: log.user } })),
};

const data = new Map<string, string>();
const store: IndexerCacheStore = {
  get: async (key) => data.get(key) ?? null,
  set: async (key, value) => {
    data.set(key, value);
    return value;
  },
};

// The route shares an answer for VAULT_OWNERS_MEMO_MS, so each read is a little later.
let clock = 1_800_000_000_000;
const servedOwners = async () => {
  clock += VAULT_OWNERS_MEMO_MS;
  apiStore.clear();
  for (const [key, value] of data) apiStore.set(key, value);
  return vaultsRouter.createCaller({}).owners({ chainId: CHAIN });
};

const keeperRead = async (): Promise<{ owners: Address[]; levels: string[] }> => {
  const levels: string[] = [];
  const log: KeeperLogger = {
    info: () => undefined,
    warn: (event) => levels.push(`warn:${event}`),
    error: (event) => levels.push(`error:${event}`),
  };
  const owners = await createRedisVaultOwnerSource(CHAIN, log, {
    get: async (key) => data.get(key) ?? null,
  }).getOwners();
  return { owners, levels };
};

describe('vault owner index past its cap', () => {
  let warn: jest.SpyInstance;
  let now: jest.SpyInstance;
  beforeAll(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterAll(() => {
    warn.mockRestore();
    now.mockRestore();
  });

  it('never serves a set that ground depositors pushed past the cap as complete', async () => {
    EARLY_BORROWERS.forEach((user, index) => deposits.push({ block: 1_010n + BigInt(index), user }));
    head = 1_100n;
    await indexVaultOwners(client, store, CONFIG);
    const before = await servedOwners();
    expect(before.status).toBe('ok');
    expect(before.owners).toEqual(expect.arrayContaining(EARLY_BORROWERS));

    for (let index = 0; index < MAX_STORED_OWNERS; index += 1) {
      deposits.push({ block: 1_200n + BigInt(Math.floor(index / 200)), user: groundDepositor() });
    }
    deposits.push({ block: 1_500n, user: LATE_BORROWER });
    head = 1_600n;
    await indexVaultOwners(client, store, CONFIG);

    // The capped set holds none of the borrowers, so it must not be the answer.
    const stored = JSON.parse(data.get(vaultOwnersSetKey(CHAIN)) ?? '[]') as string[];
    expect(BORROWERS.filter((owner) => stored.includes(owner))).toEqual([]);
    expect(data.get(vaultOwnersTruncatedKey(CHAIN))).toBe('1');
    expect(await servedOwners()).toEqual({ status: 'unavailable', owners: [], lastIndexedBlock: null });

    const keeper = await keeperRead();
    expect(keeper.levels).toEqual(['error:keeper.job-error']);

    // A quiet run rewrites the mark, so it cannot expire while the set stays capped.
    head = 1_700n;
    await indexVaultOwners(client, store, CONFIG);
    expect(data.get(vaultOwnersTruncatedKey(CHAIN))).toBe('1');
    expect((await servedOwners()).status).toBe('unavailable');

    // Deleting the set rebuilds the same capped set from the logs and marks it again.
    data.delete(vaultOwnersSetKey(CHAIN));
    await indexVaultOwners(client, store, CONFIG);
    expect(data.get(vaultOwnersTruncatedKey(CHAIN))).toBe('1');
    expect((await servedOwners()).status).toBe('unavailable');
  });
});
