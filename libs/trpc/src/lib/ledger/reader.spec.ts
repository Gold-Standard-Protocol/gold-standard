import { newAccount } from './account';
import type { LedgerAccount } from './account';
import { encodeAccount, encodeMeta } from './codec';
import type { LedgerMeta } from './codec';
import { LEDGER_STALE_AFTER_MS, LEDGER_SYNC_STAMP_SKEW_MS } from './limits';
import { createMemoryLedgerStore } from './memoryStore';
import type { MemoryLedgerStore } from './memoryStore';
import { genesisMeta } from './meta';
import { describeTerms, isLedgerIndexFresh, readAccount, readStatus } from './reader';
import { TEST_LIQUIDITY, TEST_START, testConfig } from './testSupport';
import { RAW_PER_UNIT_DAY } from './units';

const config = testConfig();
const CHAIN = config.chainId;
const NOW = (TEST_START + 5 * 86_400) * 1000;
const AS_OF = TEST_START + 5 * 86_400 - 30;
const WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const wallet = WALLET.toLowerCase();
const ONE = 10n ** 18n;

describe('describeTerms', () => {
  it('says from when usage is recorded and whether liquidity is a dimension, and nothing else', () => {
    expect(describeTerms(config)).toEqual({ startTimestamp: TEST_START, liquidity: false });
    expect(describeTerms(testConfig({ liquidity: TEST_LIQUIDITY }))).toEqual({ startTimestamp: TEST_START, liquidity: true });
  });
});

describe('isLedgerIndexFresh', () => {
  it('accepts a stamp younger than the threshold and a little clock skew ahead', () => {
    expect(isLedgerIndexFresh(String(NOW), NOW)).toBe(true);
    expect(isLedgerIndexFresh(String(NOW - LEDGER_STALE_AFTER_MS + 1), NOW)).toBe(true);
    expect(isLedgerIndexFresh(String(NOW + LEDGER_SYNC_STAMP_SKEW_MS), NOW)).toBe(true);
  });

  it('refuses a stale stamp, one far in the future and anything that is not a time', () => {
    expect(isLedgerIndexFresh(String(NOW - LEDGER_STALE_AFTER_MS), NOW)).toBe(false);
    expect(isLedgerIndexFresh(String(NOW + LEDGER_SYNC_STAMP_SKEW_MS + 1), NOW)).toBe(false);
    expect(isLedgerIndexFresh('syncing', NOW)).toBe(false);
    expect(isLedgerIndexFresh('', NOW)).toBe(false);
  });
});

describe('ledger readers', () => {
  let store: MemoryLedgerStore;
  let error: jest.SpyInstance;

  const meta = (overrides: Partial<LedgerMeta> = {}): LedgerMeta => ({
    ...genesisMeta(config, []),
    cursor: '9000',
    asOfTimestamp: AS_OF,
    accounts: 240,
    syncedAt: String(NOW - 1_000),
    ...overrides,
  });
  const install = (overrides: Partial<LedgerMeta> = {}): void => {
    store.raw.meta = encodeMeta(meta(overrides));
  };
  const deps = () => ({ config, store });

  beforeEach(() => {
    store = createMemoryLedgerStore();
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    error.mockRestore();
  });

  describe('readStatus', () => {
    const read = (chainId = CHAIN, now = NOW) => readStatus(deps(), chainId, now);

    it('answers ok with the block and time the ledger is as of and the number of addresses', async () => {
      install();
      expect(await read()).toEqual({
        status: 'ok',
        terms: { startTimestamp: TEST_START, liquidity: false },
        asOfBlock: '9000',
        asOfTimestamp: AS_OF,
        addresses: 240,
        incomplete: false,
        record: null,
      });
    });

    it('carries what describes the download when the caller serves one, and null while it is being prepared', async () => {
      install();
      const summary = {
        chainId: CHAIN,
        vault: config.vault,
        startTimestamp: TEST_START,
        liquidity: false,
        asOfBlock: '9000',
        asOfTimestamp: AS_OF,
        records: 240,
        complete: true,
        sha256: 'ab'.repeat(32),
        bytes: 31_337,
      };
      const served = await readStatus({ ...deps(), record: { summary: async () => summary } }, CHAIN, NOW);
      expect(served).toMatchObject({ status: 'ok', record: summary });
      const preparing = await readStatus({ ...deps(), record: { summary: async () => undefined } }, CHAIN, NOW);
      expect(preparing).toMatchObject({ status: 'ok', record: null });
    });

    it('carries no rank, no list of addresses and no combined figure', async () => {
      install();
      expect(JSON.stringify(await read())).not.toMatch(/rank|entries|total|score|0x[0-9a-f]{40}/i);
    });

    it('marks the ledger incomplete once a tracking cap was reached', async () => {
      install({ truncated: true });
      expect(await read()).toMatchObject({ status: 'ok', incomplete: true });
    });

    it('answers unavailable for another chain than the configured one', async () => {
      install();
      expect(await read(1)).toEqual({ status: 'unavailable', terms: { startTimestamp: TEST_START, liquidity: false } });
    });

    it.each<[string, Partial<LedgerMeta> | null]>([
      ['no meta at all', null],
      ['an index that has applied nothing', { cursor: null }],
      ['a rebuild in progress', { syncedAt: 'syncing' }],
      ['a stale stamp', { syncedAt: String(NOW - LEDGER_STALE_AFTER_MS) }],
      ['a state computed under another configuration', { fingerprint: 'f'.repeat(64) }],
    ])('answers unavailable for %s', async (_name, overrides) => {
      if (overrides !== null) install(overrides);
      expect((await read()).status).toBe('unavailable');
    });

    it('answers unavailable for a meta that does not parse', async () => {
      store.raw.meta = '{"v":1}';
      expect((await read()).status).toBe('unavailable');
    });

    it('answers unavailable, without throwing, when Redis fails', async () => {
      install();
      store.readMetaRaw = async () => {
        throw new Error('ECONNREFUSED');
      };
      expect((await read()).status).toBe('unavailable');
      expect(error).toHaveBeenCalledTimes(1);
    });
  });

  describe('readAccount', () => {
    const stored: LedgerAccount = {
      ...newAccount(AS_OF - 100),
      debt: 1_000n * ONE,
      stored: 200n * ONE,
      snapP: ONE,
      snapScale: 0n,
      snapEpoch: 0n,
      liquidity: 2_000n * ONE,
      debtRaw: RAW_PER_UNIT_DAY * 10n,
      poolRaw: RAW_PER_UNIT_DAY * 20n,
      liquidityRaw: RAW_PER_UNIT_DAY * 7n,
    };
    const read = (address = WALLET, chainId = CHAIN) => readAccount(deps(), chainId, address, NOW);

    it('settles the stored record to the index time and answers three separate figures', async () => {
      install();
      store.raw.accounts.set(wallet, encodeAccount(stored));
      // 100 seconds more: 1,000 GSUSD of debt, 200 GSUSD in the pool and 2,000 dollars in range.
      // 1,000 * 100 / 86,400 = 1.157 GSUSD-days, 200 * 100 / 86,400 = 0.231, 2,000 * 100 / 86,400 = 2.314.
      expect(await read()).toEqual({
        status: 'ok',
        address: WALLET,
        asOfBlock: '9000',
        asOfTimestamp: AS_OF,
        usage: { debt: '11.15', pool: '20.23', liquidity: '9.31' },
        balances: { debt: (1_000n * ONE).toString(), poolDeposit: (200n * ONE).toString(), liquidity: (2_000n * ONE).toString() },
      });
    });

    it('answers no sum of the three figures and nothing that orders the wallet among others', async () => {
      install();
      store.raw.accounts.set(wallet, encodeAccount(stored));
      const answer = await read();
      if (answer.status !== 'ok') throw new Error('expected ok');
      expect(Object.keys(answer.usage)).toEqual(['debt', 'pool', 'liquidity']);
      expect(JSON.stringify(answer)).not.toMatch(/total|rank|score|bonus/i);
    });

    it('rounds each figure down on its own', async () => {
      install();
      const sliver = (RAW_PER_UNIT_DAY * 9n) / 1_000n;
      store.raw.accounts.set(wallet, encodeAccount({ ...newAccount(AS_OF), debtRaw: sliver, poolRaw: sliver, liquidityRaw: sliver + RAW_PER_UNIT_DAY / 1_000n }));
      const answer = await read();
      if (answer.status !== 'ok') throw new Error('expected ok');
      expect(answer.usage).toEqual({ debt: '0.00', pool: '0.00', liquidity: '0.01' });
    });

    it('answers zeros for a wallet with no record', async () => {
      install();
      expect(await read()).toEqual({
        status: 'ok',
        address: WALLET,
        asOfBlock: '9000',
        asOfTimestamp: AS_OF,
        usage: { debt: '0.00', pool: '0.00', liquidity: '0.00' },
        balances: { debt: '0', poolDeposit: '0', liquidity: '0' },
      });
    });

    it('accepts the address in any case and looks it up lowercase', async () => {
      install();
      store.raw.accounts.set(wallet, encodeAccount(stored));
      expect(await read(wallet)).toMatchObject({ status: 'ok', address: WALLET });
    });

    it('answers unavailable for a missing record when the ledger is incomplete', async () => {
      install({ truncated: true });
      expect(await read()).toEqual({ status: 'unavailable' });
    });

    it('still answers a tracked account when the ledger is incomplete', async () => {
      install({ truncated: true });
      store.raw.accounts.set(wallet, encodeAccount(stored));
      expect(await read()).toMatchObject({ status: 'ok' });
    });

    it('answers unavailable for an unreadable record, a stale stamp and a rebuild in progress', async () => {
      install();
      store.raw.accounts.set(wallet, '{"d":"oops"}');
      expect(await read()).toEqual({ status: 'unavailable' });
      store.raw.accounts.set(wallet, encodeAccount(stored));
      install({ syncedAt: String(NOW - LEDGER_STALE_AFTER_MS) });
      expect(await read()).toEqual({ status: 'unavailable' });
      install({ syncedAt: 'syncing' });
      expect(await read()).toEqual({ status: 'unavailable' });
    });

    it('answers unavailable for another chain and when Redis fails', async () => {
      install();
      expect(await read(WALLET, 1)).toEqual({ status: 'unavailable' });
      store.readAccountView = async () => {
        throw new Error('ECONNREFUSED');
      };
      expect(await read()).toEqual({ status: 'unavailable' });
      expect(error).toHaveBeenCalledTimes(1);
    });
  });
});
