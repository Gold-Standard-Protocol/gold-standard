import { encodeAccount, encodeMeta } from '../ledger/codec';
import { newAccount } from '../ledger/account';
import { LEDGER_MEMO_MS } from '../ledger/limits';
import { createMemoryLedgerStore } from '../ledger/memoryStore';
import { genesisMeta } from '../ledger/meta';
import { createRecordCache } from '../ledger/record';
import type { LedgerRuntime } from '../ledger/runtime';
import { testConfig } from '../ledger/testSupport';
import { RAW_PER_UNIT_DAY } from '../ledger/units';

let runtime: LedgerRuntime | undefined;
const getLedgerRuntime = jest.fn(() => runtime);
jest.mock('../ledger/runtime', () => ({ getLedgerRuntime: () => getLedgerRuntime() }));

// Importing the router bootstraps the indexer; keep the queue out of these tests.
const scheduleLedgerIndex = jest.fn(async () => undefined);
const initLedgerIndexWorker = jest.fn();
jest.mock('../ledger/queue', () => ({
  scheduleLedgerIndex: () => scheduleLedgerIndex(),
  initLedgerIndexWorker: () => initLedgerIndexWorker(),
}));

import { ledgerRouter } from './ledger';

const config = testConfig();
const CHAIN = config.chainId as 11155111;
const WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const AS_OF = 1_899_999_900;
const caller = ledgerRouter.createCaller({});

describe('ledgerRouter', () => {
  let now = 1_900_000_000_000;
  let clock: jest.SpyInstance;
  let store: ReturnType<typeof createMemoryLedgerStore>;

  const install = (): void => {
    store.raw.meta = encodeMeta({ ...genesisMeta(config, []), cursor: '500', asOfTimestamp: AS_OF, accounts: 1, syncedAt: String(now) });
    store.raw.accounts.set(WALLET.toLowerCase(), encodeAccount({ ...newAccount(AS_OF), debtRaw: RAW_PER_UNIT_DAY * 3n }));
  };

  beforeEach(() => {
    // Each case starts past the previous one's memo.
    now += LEDGER_MEMO_MS * 10;
    clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    store = createMemoryLedgerStore();
    runtime = { config, store, record: createRecordCache({ config, store }) };
  });

  afterEach(() => {
    clock.mockRestore();
  });

  it('bootstraps the schedule first and the worker after it', () => {
    expect(scheduleLedgerIndex).toHaveBeenCalledTimes(1);
    expect(initLedgerIndexWorker).toHaveBeenCalledTimes(1);
    expect(scheduleLedgerIndex.mock.invocationCallOrder[0]).toBeLessThan(initLedgerIndexWorker.mock.invocationCallOrder[0]);
  });

  it('offers two queries and nothing that writes', () => {
    expect(Object.keys(ledgerRouter._def.procedures).sort()).toEqual(['account', 'status']);
    for (const procedure of Object.values(ledgerRouter._def.procedures)) {
      expect((procedure as { _def: { type: string } })._def.type).toBe('query');
    }
  });

  describe('while the ledger is off', () => {
    beforeEach(() => {
      runtime = undefined;
    });

    it('answers disabled from both procedures without a store', async () => {
      expect(await caller.status({ chainId: CHAIN })).toEqual({ status: 'disabled' });
      expect(await caller.account({ chainId: CHAIN, address: WALLET })).toEqual({ status: 'disabled' });
    });
  });

  describe('while the ledger is on', () => {
    it('answers the status of the ledger', async () => {
      install();
      expect(await caller.status({ chainId: CHAIN })).toEqual({
        status: 'ok',
        terms: { startTimestamp: config.startTimestamp, liquidity: false },
        asOfBlock: '500',
        asOfTimestamp: AS_OF,
        addresses: 1,
        incomplete: false,
        record: {
          chainId: CHAIN,
          vault: config.vault,
          startTimestamp: config.startTimestamp,
          liquidity: false,
          asOfBlock: '500',
          asOfTimestamp: AS_OF,
          records: 1,
          complete: true,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          bytes: expect.any(Number),
        },
      });
    });

    it('answers one wallet with three separate figures', async () => {
      install();
      const answer = await caller.account({ chainId: CHAIN, address: WALLET.toLowerCase() });
      expect(answer).toMatchObject({ status: 'ok', address: WALLET, usage: { debt: '3.00', pool: '0.00', liquidity: '0.00' } });
    });

    it('shares one status read between callers for a few seconds, then reads again', async () => {
      install();
      const read = jest.spyOn(store, 'readMetaRaw');
      await Promise.all([caller.status({ chainId: CHAIN }), caller.status({ chainId: CHAIN })]);
      const afterFirst = read.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);
      await caller.status({ chainId: CHAIN });
      // The memoised answer reads nothing, neither for the status nor for the download it describes.
      expect(read.mock.calls.length).toBe(afterFirst);
      now += LEDGER_MEMO_MS + 1;
      store.raw.meta = encodeMeta({ ...genesisMeta(config, []), cursor: '600', asOfTimestamp: AS_OF + 100, accounts: 1, syncedAt: String(now) });
      const later = await caller.status({ chainId: CHAIN });
      expect(later).toMatchObject({ status: 'ok', asOfBlock: '600', record: { asOfBlock: '600' } });
      expect(read.mock.calls.length).toBeGreaterThan(afterFirst);
    });

    it('answers unavailable, with what the ledger records, while nothing is indexed yet', async () => {
      expect(await caller.status({ chainId: CHAIN })).toEqual({
        status: 'unavailable',
        terms: { startTimestamp: config.startTimestamp, liquidity: false },
      });
      expect(await caller.account({ chainId: CHAIN, address: WALLET })).toEqual({ status: 'unavailable' });
    });

    it('refuses an input that is not a supported chain or an address', async () => {
      await expect(caller.status({ chainId: 5 as never })).rejects.toThrow();
      await expect(caller.account({ chainId: CHAIN, address: 'not-an-address' })).rejects.toThrow();
    });
  });
});
