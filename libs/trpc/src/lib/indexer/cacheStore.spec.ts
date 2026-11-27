import { EventEmitter } from 'node:events';
import { createCache } from 'cache-manager';
import Keyv from 'keyv';
import { getAddress } from 'viem';
import type { IndexerConfig } from './config';
import { createIndexerCacheStore } from './cacheStore';
import { indexVaultOwners } from './vaultOwnerIndexer';
import type { VaultLogClient } from './vaultOwnerIndexer';

/** A Keyv store whose reads fail the way a Redis blip does, and which records writes. */
const createFailingReadStore = () => {
  const writes: string[] = [];
  const store = Object.assign(new EventEmitter(), {
    get: async (): Promise<never> => {
      throw new Error('Connection is closed.');
    },
    set: async (key: string): Promise<boolean> => {
      writes.push(key);
      return true;
    },
    delete: async (): Promise<boolean> => true,
    clear: async (): Promise<void> => undefined,
  });
  return { store, writes };
};

const createHandle = () => {
  const { store, writes } = createFailingReadStore();
  const keyv = new Keyv({ store });
  keyv.on('error', () => undefined);
  return { handle: { cache: createCache({ stores: [keyv] }), keyv }, writes };
};

const CONFIG: IndexerConfig = {
  rpcUrl: 'https://sepolia.example.org/rpc',
  goldVaultAddress: getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3'),
  deployBlock: 100n,
  chainId: 11155111,
  confirmations: 0,
};

describe('indexer cache store', () => {
  it('rejects a read that Redis fails, where cache-manager would answer null', async () => {
    const { handle } = createHandle();
    // The old wiring: the failure is swallowed and looks like an empty store.
    await expect(handle.cache.get('vault:owners')).resolves.toBeNull();

    const store = createIndexerCacheStore(() => handle);
    await expect(store.get('vault:owners')).rejects.toThrow('Connection is closed.');
  });

  it('answers null for a key that is simply absent', async () => {
    const keyv = new Keyv();
    const store = createIndexerCacheStore(() => ({ cache: createCache({ stores: [keyv] }), keyv }));
    await expect(store.get('missing')).resolves.toBeNull();
    await store.set('present', 'value');
    await expect(store.get('present')).resolves.toBe('value');
  });

  it('aborts the run on a failed read instead of rebuilding the owner set from the deploy block', async () => {
    const { handle, writes } = createHandle();
    const getLogs = jest.fn(async () => []);
    const client: VaultLogClient = { getBlockNumber: async () => 1_000n, getLogs };
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await indexVaultOwners(client, createIndexerCacheStore(() => handle), CONFIG);

    expect(writes).toEqual([]);
    expect(getLogs).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
