import { decodeAccount, decodeMeta } from './codec';
import type { LedgerMeta } from './codec';
import { createIndexerMemory, indexLedger } from './indexer';
import type { IndexerMemory } from './indexer';
import { DEBT_AUDIT_ACCOUNTS_PER_RUN, MAX_RUN_MS, MAX_WINDOWS_PER_RUN } from './limits';
import { createMemoryLedgerStore } from './memoryStore';
import type { MemoryLedgerStore } from './memoryStore';
import { ledgerFingerprint } from './meta';
import { createFakeChain, TEST_DEPLOY_BLOCK, testBlockTime, testConfig } from './testSupport';
import type { FakeChain } from './testSupport';

const ONE = 10n ** 18n;
const ALICE = '0x00000000000000000000000000000000000000A1';
const BOB = '0x00000000000000000000000000000000000000B2';
const CAROL = '0x00000000000000000000000000000000000000C3';
const TOKEN = '0x00000000000000000000000000000000000000F0';
const alice = ALICE.toLowerCase();
const bob = BOB.toLowerCase();
const NOW = 1_900_000_000_000;

const config = testConfig();

/** Activity across blocks 400 to 800 (the ledger starts at block 400). */
const seedActivity = (chain: FakeChain): void => {
  chain.emit(400n, 'vault', 'DebtMinted', { user: ALICE, amount: 1_000n * ONE });
  chain.emit(420n, 'pool', 'Deposited', { user: BOB, amount: 600n * ONE });
  chain.emit(450n, 'pool', 'Deposited', { user: CAROL, amount: 400n * ONE });
  chain.emit(500n, 'pool', 'LiquidationAbsorbed', { token: TOKEN, debtAbsorbed: 250n * ONE, collateralGained: 1n });
  chain.emit(500n, 'vault', 'LiquidatedViaPool', { vaultOwner: ALICE, liquidator: BOB, debtRepaid: 250n * ONE, collateralSeized: 1n });
  chain.emit(600n, 'pool', 'CollateralClaimed', { user: BOB, token: TOKEN, amount: 1n });
  chain.emit(700n, 'vault', 'DebtRepaid', { user: ALICE, amount: 100n * ONE });
  chain.emit(800n, 'pool', 'Withdrawn', { user: CAROL, amount: 50n * ONE });
};

const metaOf = (store: MemoryLedgerStore): LedgerMeta => {
  const meta = decodeMeta(store.raw.meta);
  if (meta === undefined) throw new Error('the store holds no readable meta');
  return meta;
};

/** Everything a rebuild must reproduce: the records and the settled meta. */
const comparable = (store: MemoryLedgerStore) => {
  const { stateId: _stateId, syncedAt: _syncedAt, rebuilds: _rebuilds, ...meta } = metaOf(store);
  return {
    meta,
    accounts: new Map([...store.raw.accounts].sort()),
  };
};

describe('indexLedger', () => {
  let chain: FakeChain;
  let store: MemoryLedgerStore;
  let memory: IndexerMemory;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let now: number;
  const clock = (): number => now;
  const run = (targetMemory: IndexerMemory = memory, targetStore: MemoryLedgerStore = store) =>
    indexLedger(chain, targetStore, config, targetMemory, clock);

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

  describe('scanning', () => {
    it('syncs from the deploy block, records each dimension by the second and stamps the run', async () => {
      seedActivity(chain);
      chain.head = 1_000n;
      await run();

      const meta = metaOf(store);
      expect(chain.windows).toEqual([[TEST_DEPLOY_BLOCK, 1_000n]]);
      expect(meta.cursor).toBe('1000');
      expect(meta.asOfTimestamp).toBe(testBlockTime(1_000n));
      expect(meta.syncedAt).toBe(String(NOW));
      expect(meta.accounts).toBe(3);
      expect(meta.fingerprint).toBe(ledgerFingerprint(config));
      expect(meta.pool.total).toBe((700n * ONE).toString());
      expect(store.raw.accounts.size).toBe(3);
      // Alice owed 1,000 GSUSD from block 400 to 500 and 750 from there to 700: twelve seconds a block.
      const aliceRecord = decodeAccount(store.raw.accounts.get(alice));
      expect(aliceRecord?.debtRaw).toBe((1_000n * 100n + 750n * 200n) * ONE * 12n);
      expect(aliceRecord?.poolRaw).toBe(0n);
      // Bob held 600 GSUSD in the pool from block 420 to the absorption at 500, as of his last event.
      expect(decodeAccount(store.raw.accounts.get(bob))?.debtRaw).toBe(0n);
      expect((decodeAccount(store.raw.accounts.get(bob))?.poolRaw ?? 0n) >= 600n * 80n * ONE * 12n).toBe(true);
      expect(error).not.toHaveBeenCalled();
    });

    it('stops the confirmation depth short of the head', async () => {
      const deep = testConfig({ confirmations: 12 });
      chain.head = 1_000n;
      await indexLedger(chain, store, deep, memory, clock);
      expect(chain.windows).toEqual([[TEST_DEPLOY_BLOCK, 988n]]);
      expect(metaOf(store).cursor).toBe('988');
    });

    it('resumes from the cursor and never reads a block twice', async () => {
      seedActivity(chain);
      chain.head = 450n;
      await run();
      chain.head = 700n;
      await run();
      chain.head = 1_000n;
      await run();
      expect(chain.windows).toEqual([
        [100n, 450n],
        [451n, 700n],
        [701n, 1_000n],
      ]);
    });

    it('refreshes the stamp when no new block has arrived, reading no logs', async () => {
      seedActivity(chain);
      chain.head = 1_000n;
      await run();
      now += 60_000;
      await run();
      expect(chain.windows).toHaveLength(1);
      expect(metaOf(store).syncedAt).toBe(String(NOW + 60_000));
      expect(metaOf(store).cursor).toBe('1000');
    });

    it('reads in windows of 10,000 blocks', async () => {
      chain.head = TEST_DEPLOY_BLOCK + 24_999n;
      await run();
      expect(chain.windows).toEqual([
        [100n, 10_099n],
        [10_100n, 20_099n],
        [20_100n, 25_099n],
      ]);
    });

    it('halves a window the provider refuses as too wide and keeps the narrower width', async () => {
      chain.head = TEST_DEPLOY_BLOCK + 9_999n;
      chain.beforeGetLogs = (from, to) => {
        if (to - from + 1n > 2_500n) throw new Error('query exceeds max block range 2500');
      };
      await run();
      expect(chain.windows.map(([from, to]) => to - from + 1n)).toEqual([2_500n, 2_500n, 2_500n, 2_500n]);
      expect(metaOf(store).cursor).toBe('10099');
      expect(warn.mock.calls.filter(([line]) => String(line).includes('too wide'))).toHaveLength(2);
      expect(error).not.toHaveBeenCalled();
    });

    it('never asks for more than INDEXER_MAX_BLOCK_RANGE, so a ten-block provider refuses nothing', async () => {
      chain.head = TEST_DEPLOY_BLOCK + 34n + BigInt(config.confirmations);
      chain.beforeGetLogs = (from, to) => {
        if (to - from + 1n > 10n) throw new Error('You can make eth_getLogs requests with up to a 10 block range');
      };
      const narrow = { ...config, maxBlockRange: 10n };
      await indexLedger(chain, store, narrow, memory, clock);
      const widths = chain.windows.map(([from, to]) => to - from + 1n);
      expect(widths.every((width) => width <= 10n)).toBe(true);
      expect(widths.slice(0, -1).every((width) => width === 10n)).toBe(true);
      chain.windows.slice(1).forEach(([from], index) => expect(from).toBe((chain.windows[index]?.[1] ?? 0n) + 1n));
      expect(chain.windows[0]?.[0]).toBe(TEST_DEPLOY_BLOCK);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('too wide'));
      expect(error).not.toHaveBeenCalled();
    });

    it('ends the run on a throttle without narrowing, keeping the committed windows', async () => {
      chain.head = TEST_DEPLOY_BLOCK + 29_999n;
      chain.beforeGetLogs = (from) => {
        if (from > 10_099n) throw new Error('Request exceeds defined limit. Details: rate limit reached at https://rpc.example.org/v1/secret-key');
      };
      await run();
      expect(chain.windows).toEqual([[100n, 10_099n]]);
      expect(metaOf(store).cursor).toBe('10099');
      expect(metaOf(store).syncedAt).toBe('syncing');
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('too wide'));
      // The provider key in the error never reaches the log.
      expect(JSON.stringify(error.mock.calls)).not.toContain('secret-key');
      expect(JSON.stringify(error.mock.calls)).toContain('<redacted>');
    });

    it('stops after the window limit and resumes on the next run', async () => {
      chain.head = TEST_DEPLOY_BLOCK + BigInt(MAX_WINDOWS_PER_RUN) * 10_000n + 4_999n;
      await run();
      expect(chain.windows).toHaveLength(MAX_WINDOWS_PER_RUN);
      expect(metaOf(store).syncedAt).toBe('syncing');
      await run();
      expect(chain.windows).toHaveLength(MAX_WINDOWS_PER_RUN + 1);
      expect(metaOf(store).cursor).toBe(chain.head.toString());
      expect(metaOf(store).syncedAt).toBe(String(NOW));
    });

    it('stops after the time limit and resumes on the next run', async () => {
      chain.head = TEST_DEPLOY_BLOCK + 39_999n;
      chain.beforeGetLogs = () => {
        now += MAX_RUN_MS / 2;
      };
      await run();
      expect(chain.windows).toHaveLength(2);
      expect(metaOf(store).syncedAt).toBe('syncing');
      await run();
      expect(metaOf(store).cursor).toBe(chain.head.toString());
    });

    it('refuses a deploy block above the head', async () => {
      chain.head = 50n;
      await run();
      expect(chain.windows).toEqual([]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('deploy block 100 is above the chain head 50'));
      expect(metaOf(store).cursor).toBeNull();
    });

    it('keeps an existing stamp while it catches up and does not publish until it reaches the target', async () => {
      seedActivity(chain);
      chain.head = 450n;
      await run();
      chain.head = 1_000n;
      chain.beforeGetLogs = () => {
        throw new Error('socket hang up');
      };
      now += 60_000;
      await run();
      expect(metaOf(store).syncedAt).toBe(String(NOW));
      expect(metaOf(store).cursor).toBe('450');
    });
  });

  describe('recovery', () => {
    it('recomputes the same state from a wiped store as the incremental runs produced', async () => {
      seedActivity(chain);
      for (const head of [410n, 455n, 500n, 640n, 799n, 1_000n]) {
        chain.head = head;
        await run();
      }
      const incremental = comparable(store);

      const wiped = createMemoryLedgerStore();
      await run(createIndexerMemory(), wiped);
      expect(comparable(wiped)).toEqual(incremental);
      expect(incremental.accounts.size).toBe(3);
    });

    it('rebuilds when the meta is missing', async () => {
      seedActivity(chain);
      chain.head = 1_000n;
      await run();
      const before = comparable(store);

      store.raw.meta = null;
      await run();
      expect(chain.windows).toEqual([
        [100n, 1_000n],
        [100n, 1_000n],
      ]);
      expect(comparable(store)).toEqual(before);
    });

    it('rebuilds when the meta is unreadable', async () => {
      seedActivity(chain);
      chain.head = 1_000n;
      await run();
      const before = comparable(store);
      store.raw.meta = '{"v":1,"cursor":"9999999"}';
      await run();
      expect(comparable(store)).toEqual(before);
    });

    it('rebuilds when the configuration fingerprint changes, discarding the old records', async () => {
      seedActivity(chain);
      chain.head = 1_000n;
      await run();
      const laterStart = testConfig({ startTimestamp: testBlockTime(650n) });
      const laterChain = createFakeChain(laterStart);
      seedActivity(laterChain);
      laterChain.head = 1_000n;
      await indexLedger(laterChain, store, laterStart, memory, clock);

      const fresh = createMemoryLedgerStore();
      await indexLedger(laterChain, fresh, laterStart, createIndexerMemory(), clock);
      expect(metaOf(store).fingerprint).toBe(ledgerFingerprint(laterStart));
      expect(comparable(store)).toEqual(comparable(fresh));
      expect(metaOf(store).syncedAt).toBe(String(now));
    });

    it('resumes after a crash between windows without counting anything twice', async () => {
      chain.emit(400n, 'vault', 'DebtMinted', { user: ALICE, amount: 1_000n * ONE });
      chain.emit(15_000n, 'vault', 'DebtMinted', { user: ALICE, amount: 500n * ONE });
      chain.emit(15_000n, 'pool', 'Deposited', { user: BOB, amount: 10n * ONE });
      chain.head = 25_000n;
      chain.beforeGetLogs = (from) => {
        if (from > 10_099n) throw new Error('connection reset');
      };
      await run();
      expect(metaOf(store).cursor).toBe('10099');

      // A new process: nothing in memory, the store as the first window left it.
      chain.beforeGetLogs = () => undefined;
      await run(createIndexerMemory());

      const onePass = createMemoryLedgerStore();
      await run(createIndexerMemory(), onePass);
      expect(comparable(store)).toEqual(comparable(onePass));
      expect(JSON.parse(store.raw.accounts.get(alice) ?? '{}').d).toBe((1_500n * ONE).toString());
    });

    it('never throws when the store fails', async () => {
      store.readMeta = async () => {
        throw new Error('Connection is closed. redis://user:hunter2@cache.example.org:6379');
      };
      await expect(run()).resolves.toBeUndefined();
      expect(JSON.stringify(error.mock.calls)).not.toContain('hunter2');
    });
  });

  describe('two writers on one store', () => {
    it('reloads when another process moved the state, applying nothing twice', async () => {
      seedActivity(chain);
      const other = createIndexerMemory();
      chain.head = 450n;
      await run(memory);
      chain.head = 700n;
      await run(other);
      chain.head = 1_000n;
      await run(memory);

      const single = createMemoryLedgerStore();
      await run(createIndexerMemory(), single);
      expect(comparable(store)).toEqual(comparable(single));
    });

    it('drops its memory when a commit loses the race, and the next run recovers', async () => {
      seedActivity(chain);
      chain.head = 450n;
      await run(memory);
      chain.head = 1_000n;

      // The other process finishes the same blocks between this run's read and its commit.
      const other = createIndexerMemory();
      const commit = store.commit;
      let raced = false;
      store.commit = async (expected, write) => {
        if (!raced) {
          raced = true;
          await indexLedger(chain, { ...store, commit }, config, other, clock);
        }
        return commit(expected, write);
      };
      const commitsBefore = store.commits();
      await run(memory);

      expect(memory.stateId).toBeNull();
      expect(memory.accounts.size).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('another writer'));
      // Only the other process's two commits (its window and its snapshot) were accepted.
      expect(store.commits() - commitsBefore).toBe(2);

      const single = createMemoryLedgerStore();
      await run(createIndexerMemory(), single);
      expect(comparable(store)).toEqual(comparable(single));

      now += 60_000;
      await run(memory);
      expect(metaOf(store).syncedAt).toBe(String(NOW + 60_000));
      expect(comparable(store)).toEqual(comparable(single));
    });
  });

  describe('integrity', () => {
    const corruptTotal = (): void => {
      chain.poolStateOverride = (_block, truth) => ({ ...truth, total: truth.total + 1n });
    };

    it('writes no fresh stamp on a pool mismatch, rebuilds once, then holds', async () => {
      seedActivity(chain);
      chain.head = 1_000n;
      await run();
      expect(metaOf(store).syncedAt).toBe(String(NOW));

      corruptTotal();
      chain.head = 1_010n;
      now += 60_000;
      await run();
      // One error line with both sets of values, and the state reset for a rebuild.
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toContain('the pool mirror (P 750000000000000000, scale 0, epoch 0, total 700000000000000000000) differs from the contract (P 750000000000000000, scale 0, epoch 0, total 700000000000000000001)');
      expect(error.mock.calls[0][0]).toContain('Recomputing the whole ledger');
      expect(metaOf(store)).toMatchObject({ cursor: null, syncedAt: 'syncing', rebuilds: [NOW + 60_000] });
      expect(store.raw.accounts.size).toBe(0);

      // The rebuild meets the same mismatch: no second rebuild, no stamp, the error repeats.
      now += 60_000;
      await run();
      expect(metaOf(store)).toMatchObject({ cursor: '1010', syncedAt: 'syncing', rebuilds: [NOW + 60_000] });
      expect(error.mock.calls[1][0]).toContain('An automatic rebuild was already made in the last 24 hours');
      now += 60_000;
      await run();
      expect(error).toHaveBeenCalledTimes(3);
      expect(metaOf(store).syncedAt).toBe('syncing');

      // Once the chain agrees again the held index stamps itself.
      chain.poolStateOverride = undefined;
      now += 60_000;
      await run();
      expect(metaOf(store).syncedAt).toBe(String(now));
    });

    it('allows another automatic rebuild after 24 hours', async () => {
      seedActivity(chain);
      chain.head = 1_000n;
      corruptTotal();
      await run();
      await run();
      expect(metaOf(store).rebuilds).toEqual([NOW]);
      now += 24 * 60 * 60_000 + 1;
      await run();
      expect(metaOf(store)).toMatchObject({ cursor: null, rebuilds: [now] });
    });

    it('treats a vault that liquidates through another pool the same way', async () => {
      seedActivity(chain);
      chain.head = 1_000n;
      await run();
      chain.poolStateOverride = (_block, truth) => ({ ...truth, vaultPool: '0x00000000000000000000000000000000000000dD' });
      now += 60_000;
      await run();
      expect(error.mock.calls[0][0]).toContain('not the configured pool');
      expect(metaOf(store)).toMatchObject({ cursor: null, syncedAt: 'syncing' });
      now += 60_000;
      await run();
      expect(metaOf(store).syncedAt).toBe('syncing');
    });

    it('writes no stamp and makes no rebuild when the check cannot be made', async () => {
      seedActivity(chain);
      chain.head = 1_000n;
      await run();
      chain.head = 1_005n;
      chain.poolStateOverride = () => {
        throw new Error('HTTP request failed. URL: https://rpc.example.org/v1/secret-key');
      };
      now += 60_000;
      await run();
      expect(metaOf(store)).toMatchObject({ cursor: '1005', syncedAt: String(NOW), rebuilds: [] });
      expect(JSON.stringify(error.mock.calls)).not.toContain('secret-key');
    });

    it('commits nothing from a window that holds an undecodable log', async () => {
      seedActivity(chain);
      chain.head = 450n;
      await run();
      const before = store.raw.meta;
      chain.emit(460n, 'pool', 'Deposited', { user: 'nobody', amount: 5n });
      chain.head = 1_000n;
      now += 25 * 60 * 60_000;
      // A rebuild was not made recently, so this one resets; the reset is the only write.
      await run();
      expect(error.mock.calls[0][0]).toContain('argument user is not an address');
      expect(metaOf(store).cursor).toBeNull();
      expect(store.raw.meta).not.toBe(before);
      await run();
      expect(metaOf(store).cursor).toBeNull();
      expect(error.mock.calls[1][0]).toContain('already made');
    });

    it('treats an impossible absorption as an integrity failure', async () => {
      chain.emit(400n, 'pool', 'Deposited', { user: BOB, amount: 10n * ONE });
      chain.emit(410n, 'pool', 'LiquidationAbsorbed', { token: TOKEN, debtAbsorbed: 10n * ONE, collateralGained: 1n });
      chain.head = 500n;
      // The window fails in the reducer, before any commit and before the chain check.
      await run();
      expect(error.mock.calls[0][0]).toContain('impossible against the mirrored pool total');
      expect(metaOf(store).cursor).toBeNull();
      expect(store.raw.accounts.size).toBe(0);
    });

    it('rebuilds when a stored account record is unreadable', async () => {
      seedActivity(chain);
      chain.head = 1_000n;
      await run();
      const before = comparable(store);
      store.raw.accounts.set(alice, '{"d":"oops"}');
      await run(createIndexerMemory());
      expect(error.mock.calls[0][0]).toContain(`the stored record of ${alice} is unreadable`);
      await run(createIndexerMemory());
      expect(comparable(store)).toEqual(before);
    });

    it('rebuilds when the store lost account records the meta counts', async () => {
      seedActivity(chain);
      chain.head = 1_000n;
      await run();
      store.raw.accounts.delete(alice);
      await run(createIndexerMemory());
      expect(error.mock.calls[0][0]).toContain('holds 2 account records but its meta counts 3');
      expect(metaOf(store).cursor).toBeNull();
    });
  });

  describe('vault debt against the chain', () => {
    it('tracks the principal the vault holds after a partial repayment, not the fee-inclusive event amount', async () => {
      // Principal 1,000 with 50 of accrued fee: repaying 525 retires 500, where the event amounts leave 475.
      chain.emit(400n, 'vault', 'DebtMinted', { user: ALICE, amount: 1_000n * ONE });
      chain.emit(500n, 'vault', 'DebtRepaid', { user: ALICE, amount: 525n * ONE });
      chain.vaultDebtOverride = (block, _owner, truth) => (block >= 500n ? 500n * ONE : truth);
      chain.head = 1_000n;
      await run();
      expect(JSON.parse(store.raw.accounts.get(alice) ?? '{}').d).toBe((500n * ONE).toString());
      expect(metaOf(store).syncedAt).toBe(String(NOW));
      expect(error).not.toHaveBeenCalled();
      // One read per block that holds a vault event, then the audit at the cursor.
      expect(chain.debtReads).toEqual([
        { block: 400n, owners: [alice] },
        { block: 500n, owners: [alice] },
        { block: 1_000n, owners: [alice] },
      ]);
    });

    it('gives the same records whether the events arrive in one window or in several', async () => {
      seedActivity(chain);
      chain.vaultDebtOverride = (block, _owner, truth) => (block >= 700n && truth > 0n ? truth + 3n * ONE : truth);
      chain.head = 450n;
      await run();
      chain.head = 720n;
      await run();
      chain.head = 1_000n;
      await run();
      const whole = createMemoryLedgerStore();
      await run(createIndexerMemory(), whole);
      expect(comparable(store)).toEqual(comparable(whole));
    });

    it('does not publish a borrower whose repayment log the endpoint failed to return', async () => {
      chain.emit(400n, 'vault', 'DebtMinted', { user: ALICE, amount: 1_000n * ONE });
      chain.emit(420n, 'pool', 'Deposited', { user: BOB, amount: 600n * ONE });
      chain.emit(500n, 'vault', 'DebtRepaid', { user: ALICE, amount: 1_000n * ONE });
      const getLogs = chain.getLogs;
      chain.getLogs = async (from, to) => (await getLogs(from, to)).filter((log) => log.eventName !== 'DebtRepaid');
      chain.head = 8_000n;
      await run();
      // Before the audit this run ended with a fresh stamp, 1,000 GSUSD of debt still on Alice's record.
      expect(error.mock.calls[0][0]).toContain('Usage ledger index integrity failure');
      expect(error.mock.calls[0][0]).toContain(`tracks ${1_000n * ONE} of debt principal for ${alice} but the vault holds 0`);
      expect(metaOf(store)).toMatchObject({ cursor: null, syncedAt: 'syncing', rebuilds: [NOW] });
      // The endpoint answers in full again: the rebuild ends with the true figures.
      chain.getLogs = getLogs;
      now += 60_000;
      await run();
      expect(JSON.parse(store.raw.accounts.get(alice) ?? '{}').d).toBe('0');
      expect(metaOf(store).syncedAt).toBe(String(now));
    });

    it('leaves a tracked debt below the vault alone: it can only under-record', async () => {
      chain.emit(400n, 'vault', 'DebtMinted', { user: ALICE, amount: 1_000n * ONE });
      chain.head = 500n;
      await run();
      chain.vaultDebtOverride = (block, _owner, truth) => (block > 500n ? truth + ONE : truth);
      chain.head = 600n;
      now += 60_000;
      await run();
      expect(error).not.toHaveBeenCalled();
      expect(metaOf(store).syncedAt).toBe(String(now));
    });

    it('audits the accounts that owe in rotation, a bounded number per run', async () => {
      const owner = (n: number): string => `0x${(0x1000 + n).toString(16).padStart(40, '0')}`;
      for (let n = 0; n < DEBT_AUDIT_ACCOUNTS_PER_RUN + 10; n += 1) {
        chain.emit(400n, 'vault', 'DebtMinted', { user: owner(n), amount: ONE });
      }
      chain.emit(410n, 'pool', 'Deposited', { user: BOB, amount: 5n * ONE });
      chain.head = 500n;
      await run();
      const firstAudit = chain.debtReads[chain.debtReads.length - 1];
      expect(firstAudit.block).toBe(500n);
      expect(firstAudit.owners).toEqual(Array.from({ length: DEBT_AUDIT_ACCOUNTS_PER_RUN }, (_, n) => owner(n)));
      now += 60_000;
      await run();
      const secondAudit = chain.debtReads[chain.debtReads.length - 1];
      expect(secondAudit.owners).toHaveLength(DEBT_AUDIT_ACCOUNTS_PER_RUN);
      expect(secondAudit.owners.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, n) => owner(DEBT_AUDIT_ACCOUNTS_PER_RUN + n)));
      expect(secondAudit.owners[10]).toBe(owner(0));
    });

    it('writes no stamp and makes no rebuild when the vault cannot be read for the audit', async () => {
      chain.emit(400n, 'vault', 'DebtMinted', { user: ALICE, amount: 1_000n * ONE });
      chain.head = 500n;
      await run();
      const readVaultDebts = chain.readVaultDebts;
      chain.readVaultDebts = async () => {
        throw new Error('HTTP request failed. URL: https://rpc.example.org/v1/secret-key');
      };
      now += 60_000;
      await run();
      expect(metaOf(store)).toMatchObject({ cursor: '500', syncedAt: String(NOW), rebuilds: [] });
      expect(JSON.stringify(error.mock.calls)).not.toContain('secret-key');
      chain.readVaultDebts = readVaultDebts;
      now += 60_000;
      await run();
      expect(metaOf(store).syncedAt).toBe(String(now));
    });

    it('commits nothing from a window whose principal read fails, and resumes there', async () => {
      chain.emit(400n, 'vault', 'DebtMinted', { user: ALICE, amount: 1_000n * ONE });
      chain.head = 500n;
      const readVaultDebts = chain.readVaultDebts;
      chain.readVaultDebts = async () => {
        throw new Error('missing trie node');
      };
      await run();
      expect(store.raw.accounts.size).toBe(0);
      expect(metaOf(store).cursor).toBeNull();
      chain.readVaultDebts = readVaultDebts;
      await run();
      expect(metaOf(store).cursor).toBe('500');
    });
  });
});
