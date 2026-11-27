import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { newAccount } from './account';
import { decodeMeta, encodeAccount, encodeMeta } from './codec';
import { ledgerToCsv, readLedger } from './export';
import { createIndexerMemory, indexLedger } from './indexer';
import { createMemoryLedgerStore } from './memoryStore';
import type { MemoryLedgerStore } from './memoryStore';
import { genesisMeta } from './meta';
import { buildRecord, createRecordCache, summaryOf } from './record';
import { createFakeChain, TEST_VAULT, testBlockTime, testConfig } from './testSupport';
import { RAW_PER_UNIT_DAY } from './units';

const ONE = 10n ** 18n;
const ALICE = '0x00000000000000000000000000000000000000A1';
const BOB = '0x00000000000000000000000000000000000000B2';
const CAROL = '0x00000000000000000000000000000000000000C3';
const TOKEN = '0x00000000000000000000000000000000000000F0';
const config = testConfig();
const NOW = 1_900_000_000_000;
const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

describe('the whole record as a file', () => {
  let store: MemoryLedgerStore;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  /** Borrowing, deposits, an absorption that scales every deposit and a claim: every kind of figure. */
  const indexTo = async (head: bigint): Promise<void> => {
    const chain = createFakeChain(config);
    chain.emit(400n, 'vault', 'DebtMinted', { user: ALICE, amount: 1_000n * ONE });
    chain.emit(420n, 'pool', 'Deposited', { user: BOB, amount: 600n * ONE });
    chain.emit(450n, 'pool', 'Deposited', { user: CAROL, amount: 400n * ONE });
    chain.emit(500n, 'pool', 'LiquidationAbsorbed', { token: TOKEN, debtAbsorbed: 250n * ONE, collateralGained: 1n });
    chain.emit(500n, 'vault', 'LiquidatedViaPool', { vaultOwner: ALICE, liquidator: BOB, debtRepaid: 250n * ONE, collateralSeized: 1n });
    chain.emit(700n, 'vault', 'DebtRepaid', { user: ALICE, amount: 100n * ONE });
    chain.head = head;
    await indexLedger(chain, store, config, createIndexerMemory(), () => NOW);
  };

  beforeEach(() => {
    store = createMemoryLedgerStore();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it('is byte for byte what the export tool writes for the same index', async () => {
    await indexTo(1_000n);
    const record = await buildRecord({ config, store }, NOW);
    if (record === undefined) throw new Error('expected a record');
    const fromTool = ledgerToCsv(await readLedger({ config, store }));
    const body = gunzipSync(Buffer.concat(record.gzip));
    expect(body.equals(Buffer.from(fromTool, 'utf8'))).toBe(true);
    expect(record.sha256).toBe(sha256(fromTool));
    expect(record.bytes).toBe(Buffer.byteLength(fromTool));
    expect(fromTool.split('\n')).toHaveLength(3 + 2);
  });

  it('describes itself: the block and time it is as of, how many records and whether the ledger is complete', async () => {
    await indexTo(1_000n);
    const record = await buildRecord({ config, store }, NOW);
    expect(record && summaryOf(record)).toEqual({
      chainId: config.chainId,
      vault: TEST_VAULT,
      startTimestamp: config.startTimestamp,
      liquidity: false,
      asOfBlock: '1000',
      asOfTimestamp: testBlockTime(1_000n),
      records: 3,
      complete: true,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      bytes: expect.any(Number),
    });
    expect(record?.stateId).toBe(decodeMeta(store.raw.meta)?.stateId);
  });

  it('says so when the ledger is incomplete', async () => {
    await indexTo(1_000n);
    const meta = decodeMeta(store.raw.meta);
    if (meta === undefined) throw new Error('no meta');
    store.raw.meta = encodeMeta({ ...meta, truncated: true });
    expect((await buildRecord({ config, store }, NOW))?.complete).toBe(false);
  });

  it('is the same bytes for the same index whenever it is built, and other bytes once the index moves', async () => {
    await indexTo(1_000n);
    const first = await buildRecord({ config, store }, NOW);
    const again = await buildRecord({ config, store }, NOW + 30_000);
    expect(again?.sha256).toBe(first?.sha256);
    await indexTo(1_100n);
    const later = await buildRecord({ config, store }, NOW);
    expect(later?.asOfBlock).toBe('1100');
    expect(later?.sha256).not.toBe(first?.sha256);
  });

  it('keeps the rows in address order across the steps it is built in', async () => {
    // 2,500 records: three steps, written in an order that is not the address order.
    const meta = { ...genesisMeta(config, []), cursor: '777', asOfTimestamp: testBlockTime(777n), accounts: 2_500, syncedAt: String(NOW) };
    store.raw.meta = encodeMeta(meta);
    for (let n = 2_500; n >= 1; n -= 1) {
      store.raw.accounts.set(addr(n * 7_919), encodeAccount({ ...newAccount(meta.asOfTimestamp), debtRaw: RAW_PER_UNIT_DAY * BigInt(n) }));
    }
    const record = await buildRecord({ config, store }, NOW);
    if (record === undefined) throw new Error('expected a record');
    const lines = gunzipSync(Buffer.concat(record.gzip)).toString('utf8').trim().split('\n').slice(1);
    expect(lines).toHaveLength(2_500);
    const addresses = lines.map((line) => line.split(',')[0].toLowerCase());
    expect(addresses).toEqual([...addresses].sort());
    expect(gunzipSync(Buffer.concat(record.gzip)).toString('utf8')).toBe(ledgerToCsv(await readLedger({ config, store })));
  });

  it('is a header alone for a ledger that holds no record yet', async () => {
    store.raw.meta = encodeMeta({ ...genesisMeta(config, []), cursor: '120', asOfTimestamp: testBlockTime(120n), syncedAt: String(NOW) });
    const record = await buildRecord({ config, store }, NOW);
    expect(record?.records).toBe(0);
    expect(gunzipSync(Buffer.concat(record?.gzip ?? [])).toString('utf8')).toBe(
      'address,debtGsusdDays,poolGsusdDays,liquidityDollarDays,debtGsusd,poolGsusd,liquidityDollars,asOfBlock,asOfTimestamp\n'
    );
  });

  it.each<[string, (store: MemoryLedgerStore) => void]>([
    ['there is no state', (target) => { target.raw.meta = null; }],
    ['the state is being recomputed', (target) => { target.raw.meta = encodeMeta({ ...genesisMeta(config, []), cursor: '9', syncedAt: 'syncing' }); }],
    ['the stamp is stale', (target) => { target.raw.meta = encodeMeta({ ...genesisMeta(config, []), cursor: '9', syncedAt: String(NOW - 10 * 60_000) }); }],
    ['the state belongs to another configuration', (target) => { target.raw.meta = encodeMeta({ ...genesisMeta(config, []), cursor: '9', syncedAt: String(NOW), fingerprint: 'f'.repeat(64) }); }],
  ])('builds nothing while %s', async (_name, arrange) => {
    await indexTo(1_000n);
    arrange(store);
    expect(await buildRecord({ config, store }, NOW)).toBeUndefined();
  });

  it('starts over when the index commits during the build, and gives a file of one block', async () => {
    await indexTo(1_000n);
    const readAccountsRaw = store.readAccountsRaw;
    let moved = false;
    store.readAccountsRaw = async (addresses) => {
      if (!moved) {
        moved = true;
        await indexTo(1_050n);
      }
      return readAccountsRaw(addresses);
    };
    const record = await buildRecord({ config, store }, NOW);
    expect(record?.asOfBlock).toBe('1050');
    expect(gunzipSync(Buffer.concat(record?.gzip ?? [])).toString('utf8')).toBe(ledgerToCsv(await readLedger({ config, store })));
  });

  it('builds nothing from a store whose records do not number what the meta counts, or that holds an unreadable one', async () => {
    await indexTo(1_000n);
    store.raw.accounts.set(ALICE.toLowerCase(), '{"d":"oops"}');
    expect(await buildRecord({ config, store }, NOW)).toBeUndefined();
    store.raw.accounts.delete(ALICE.toLowerCase());
    expect(await buildRecord({ config, store }, NOW)).toBeUndefined();
  });

  describe('kept per process', () => {
    it('builds once per indexed state however many ask, and again only after the index has moved', async () => {
      await indexTo(1_000n);
      const list = jest.spyOn(store, 'listAddresses');
      const cache = createRecordCache({ config, store });
      const [first, second] = await Promise.all([cache.current(NOW), cache.current(NOW)]);
      expect(second).toBe(first);
      expect(await cache.current(NOW + 20_000)).toBe(first);
      expect(list).toHaveBeenCalledTimes(1);
      await indexTo(1_010n);
      const next = await cache.current(NOW);
      expect(next?.asOfBlock).toBe('1010');
      expect(list).toHaveBeenCalledTimes(2);
      expect((await cache.summary(NOW))?.sha256).toBe(next?.sha256);
    });

    it('costs one read of the meta, and nothing else, while the file is current', async () => {
      await indexTo(1_000n);
      const cache = createRecordCache({ config, store });
      await cache.current(NOW);
      const meta = jest.spyOn(store, 'readMetaRaw');
      const accounts = jest.spyOn(store, 'readAccountsRaw');
      await cache.current(NOW);
      expect(meta).toHaveBeenCalledTimes(1);
      expect(accounts).not.toHaveBeenCalled();
    });

    it('serves nothing once the ledger can no longer be answered from, and does not throw when the store fails', async () => {
      await indexTo(1_000n);
      const cache = createRecordCache({ config, store });
      expect(await cache.current(NOW)).toBeDefined();
      expect(await cache.current(NOW + 10 * 60_000)).toBeUndefined();
      store.readMetaRaw = async () => {
        throw new Error('ECONNREFUSED');
      };
      expect(await cache.current(NOW)).toBeUndefined();
      expect(await cache.summary(NOW)).toBeUndefined();
      expect(error).toHaveBeenCalled();
    });
  });
});
