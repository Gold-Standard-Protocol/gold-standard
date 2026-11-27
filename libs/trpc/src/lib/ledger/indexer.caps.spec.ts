import { decodeMeta } from './codec';
import type { LedgerMeta } from './codec';
import { createIndexerMemory, indexLedger } from './indexer';
import type { IndexerMemory } from './indexer';
import { createMemoryLedgerStore } from './memoryStore';
import type { MemoryLedgerStore } from './memoryStore';
import { createFakeChain, testConfig } from './testSupport';
import type { FakeChain } from './testSupport';

const ONE = 10n ** 18n;
const addr = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, '0')}`;
const ALICE = addr(0xa1);
const BOB = addr(0xb2);
const CAROL = addr(0xc3);
const NOW = 1_900_000_000_000;
// The address cap is lowered for this file so that it can be reached with a handful of wallets.
const config = testConfig({ maxAddresses: 2 });

const metaOf = (store: MemoryLedgerStore): LedgerMeta => {
  const meta = decodeMeta(store.raw.meta);
  if (meta === undefined) throw new Error('the store holds no readable meta');
  return meta;
};

describe('indexLedger at its caps', () => {
  let chain: FakeChain;
  let store: MemoryLedgerStore;
  let memory: IndexerMemory;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let now: number;
  const run = (targetMemory: IndexerMemory = memory, targetStore: MemoryLedgerStore = store) =>
    indexLedger(chain, targetStore, config, targetMemory, () => now);

  beforeEach(() => {
    chain = createFakeChain(config);
    store = createMemoryLedgerStore();
    memory = createIndexerMemory();
    now = NOW;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  describe('the account cap', () => {
    /** One GSUSD passed through two addresses fills both slots with emptied records. */
    const fillWithEmptied = (): void => {
      chain.emit(400n, 'pool', 'Deposited', { user: ALICE, amount: ONE });
      chain.emit(410n, 'pool', 'Withdrawn', { user: ALICE, amount: ONE });
      chain.emit(420n, 'pool', 'Deposited', { user: BOB, amount: ONE });
      chain.emit(430n, 'pool', 'Withdrawn', { user: BOB, amount: ONE });
    };

    it('deletes nothing at the cap: emptied records stay, the new borrower is refused and one line tells the operator what to do', async () => {
      fillWithEmptied();
      chain.head = 450n;
      await run();
      const before = new Map(store.raw.accounts);
      expect([...before.keys()].sort()).toEqual([ALICE, BOB]);

      chain.emit(500n, 'vault', 'DebtMinted', { user: CAROL, amount: 5_000n * ONE });
      chain.head = 600n;
      now += 60_000;
      await run();
      const meta = metaOf(store);
      expect(meta.truncated).toBe(true);
      expect(meta.accounts).toBe(2);
      // Both records are byte for byte what they were.
      expect(new Map(store.raw.accounts)).toEqual(before);
      expect(meta.syncedAt).toBe(String(now));
      expect(error).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        'Usage ledger reached its cap of 2 addresses: no new record is opened, every existing record keeps counting and the ledger is marked incomplete. Raise LEDGER_MAX_ADDRESSES and restart the API; the ledger then recomputes from the deploy block and is complete again (docs/USAGE_LEDGER.md section 1.4).'
      );
    });

    it('says so again on every run while the ledger is incomplete', async () => {
      fillWithEmptied();
      chain.emit(440n, 'vault', 'DebtMinted', { user: CAROL, amount: 5_000n * ONE });
      chain.head = 450n;
      await run();
      warn.mockClear();
      chain.head = 460n;
      await run();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Usage ledger is incomplete: .*Raise LEDGER_MAX_ADDRESSES/));
    });

    it('is complete again, with every address, once the cap is raised: the changed cap recomputes the ledger', async () => {
      fillWithEmptied();
      chain.emit(500n, 'vault', 'DebtMinted', { user: CAROL, amount: 5_000n * ONE });
      chain.head = 600n;
      await run();
      expect(metaOf(store).truncated).toBe(true);
      await indexLedger(chain, store, testConfig({ maxAddresses: 3 }), createIndexerMemory(), () => now);
      expect(metaOf(store).truncated).toBe(false);
      expect([...store.raw.accounts.keys()].sort()).toEqual([ALICE, BOB, CAROL]);
    });

    it('arrives at the same state from a rebuild and from a restart', async () => {
      fillWithEmptied();
      chain.head = 450n;
      await run();
      chain.emit(500n, 'vault', 'DebtMinted', { user: CAROL, amount: 5_000n * ONE });
      chain.head = 600n;
      await run();

      const rebuilt = createMemoryLedgerStore();
      await run(createIndexerMemory(), rebuilt);
      expect(new Map([...rebuilt.raw.accounts].sort())).toEqual(new Map([...store.raw.accounts].sort()));

      // A restarted process loads exactly the records the meta counts.
      chain.head = 610n;
      await run(createIndexerMemory());
      expect(error).not.toHaveBeenCalled();
      expect(metaOf(store).cursor).toBe('610');
    });

    it('is marked incomplete as soon as an address is refused', async () => {
      chain.emit(400n, 'pool', 'Deposited', { user: ALICE, amount: ONE });
      chain.emit(420n, 'pool', 'Deposited', { user: BOB, amount: ONE });
      chain.emit(500n, 'vault', 'DebtMinted', { user: CAROL, amount: 5_000n * ONE });
      chain.head = 600n;
      await run();
      expect(metaOf(store).truncated).toBe(true);
      expect(store.raw.accounts.has(CAROL)).toBe(false);
    });
  });
});
