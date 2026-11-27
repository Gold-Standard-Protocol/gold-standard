import { getAddress } from 'viem';
import type { ChainPosition } from './chainClient';
import { encodeMeta } from './codec';
import { ledgerToCsv, readLedger } from './export';
import { createIndexerMemory, indexLedger } from './indexer';
import { pegValue } from './liquidityMath';
import { createMemoryLedgerStore } from './memoryStore';
import type { MemoryLedgerStore } from './memoryStore';
import { genesisMeta } from './meta';
import { readAccount } from './reader';
import {
  createFakeChain,
  TEST_DOLLAR,
  TEST_GSUSD,
  TEST_LIQUIDITY,
  TEST_PARITY_TICK,
  TEST_POSITION_MANAGER,
  testBlockTime,
  testConfig,
} from './testSupport';

const ONE = 10n ** 18n;
const ALICE = '0x00000000000000000000000000000000000000A1';
const BOB = '0x00000000000000000000000000000000000000B2';
const CAROL = '0x00000000000000000000000000000000000000C3';
const ZERO = '0x0000000000000000000000000000000000000000';
const config = testConfig({ liquidity: TEST_LIQUIDITY });
const NOW = 1_900_000_000_000;
const LOWER = TEST_PARITY_TICK - 10;
const UPPER = TEST_PARITY_TICK + 10;
const LIQUIDITY = 10n ** 21n;
const VALUE = pegValue({ decimals0: 18, decimals1: 6 }, LIQUIDITY, LOWER, UPPER);

/** Unit-days with six fraction digits, rounded down: the export's own form, computed here by hand. */
const unitDays = (amount: bigint, blocks: bigint): string => {
  const scaled = (amount * blocks * 12n * 1_000_000n) / (ONE * 86_400n);
  return `${scaled / 1_000_000n}.${(scaled % 1_000_000n).toString().padStart(6, '0')}`;
};

describe('readLedger', () => {
  let store: MemoryLedgerStore;
  let warn: jest.SpyInstance;

  /** The ledger starts at block 400. Alice borrows, Bob deposits, Carol provides liquidity in range from 500. */
  const indexTo = async (head: bigint, using = config): Promise<void> => {
    const chain = createFakeChain(using);
    chain.emit(400n, 'vault', 'DebtMinted', { user: ALICE, amount: 1_000n * ONE });
    chain.emit(420n, 'pool', 'Deposited', { user: BOB, amount: 600n * ONE });
    chain.emit(700n, 'vault', 'DebtRepaid', { user: ALICE, amount: 400n * ONE });
    if (using.liquidity !== undefined) {
      const position: ChainPosition = { token0: TEST_GSUSD, token1: TEST_DOLLAR, fee: 500, tickLower: LOWER, tickUpper: UPPER, liquidity: LIQUIDITY, owner: CAROL };
      chain.emit(450n, 'liquidityPool', 'Initialize', { sqrtPriceX96: 1n, tick: TEST_PARITY_TICK });
      chain.emit(500n, 'liquidityPool', 'Mint', { sender: TEST_POSITION_MANAGER, owner: TEST_POSITION_MANAGER, tickLower: LOWER, tickUpper: UPPER, amount: 1n, amount0: 1n, amount1: 1n }, 'mint');
      chain.emit(500n, 'positionManager', 'Transfer', { from: ZERO, to: CAROL, tokenId: 7n }, 'mint');
      chain.emit(500n, 'positionManager', 'IncreaseLiquidity', { tokenId: 7n, liquidity: 1n, amount0: 1n, amount1: 1n }, 'mint');
      chain.setPosition(500n, 7n, position);
    }
    chain.head = head;
    await indexLedger(chain, store, using, createIndexerMemory(), () => NOW);
  };

  beforeEach(() => {
    store = createMemoryLedgerStore();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('lists every address with its three figures and its three balances as of one block', async () => {
    await indexTo(1_000n);
    const ledger = await readLedger({ config, store });
    expect(ledger).toMatchObject({
      chainId: config.chainId,
      vault: config.vault,
      startTimestamp: config.startTimestamp,
      liquidity: true,
      asOfBlock: '1000',
      asOfTimestamp: testBlockTime(1_000n),
      incomplete: false,
      addresses: 3,
    });
    const [alice, bob, carol] = ledger.rows;
    // Alice owed 1,000 GSUSD for 300 blocks and 600 for the next 300.
    expect(alice).toEqual({
      address: getAddress(ALICE.toLowerCase()),
      debtGsusdDays: unitDays(1_000n * ONE * 300n + 600n * ONE * 300n, 1n),
      poolGsusdDays: '0.000000',
      liquidityDollarDays: '0.000000',
      debtGsusd: '600.000000',
      poolGsusd: '0.000000',
      liquidityDollars: '0.000000',
    });
    expect(bob).toMatchObject({ debtGsusdDays: '0.000000', poolGsusdDays: unitDays(600n * ONE, 580n), poolGsusd: '600.000000' });
    expect(carol).toMatchObject({ debtGsusdDays: '0.000000', poolGsusdDays: '0.000000', liquidityDollarDays: unitDays(VALUE, 500n) });
    expect(BigInt(carol.liquidityDollars.replace('.', ''))).toBe(VALUE / 10n ** 12n);
  });

  it('orders the rows by address and carries no rank and no combined figure', async () => {
    await indexTo(1_000n);
    const ledger = await readLedger({ config, store });
    const addresses = ledger.rows.map((row) => row.address.toLowerCase());
    expect(addresses).toEqual([...addresses].sort());
    // Carol holds by far the largest figure and is still last: the order says nothing about size.
    expect(addresses).toEqual([ALICE, BOB, CAROL].map((address) => address.toLowerCase()));
    for (const row of ledger.rows) {
      expect(Object.keys(row)).toEqual(['address', 'debtGsusdDays', 'poolGsusdDays', 'liquidityDollarDays', 'debtGsusd', 'poolGsusd', 'liquidityDollars']);
    }
    expect(JSON.stringify(ledger)).not.toMatch(/rank|total|score/i);
  });

  it('states the same figures as the API answers for each address, to more digits', async () => {
    await indexTo(1_000n);
    const ledger = await readLedger({ config, store });
    for (const row of ledger.rows) {
      const answer = await readAccount({ config, store }, config.chainId, row.address, NOW);
      if (answer.status !== 'ok') throw new Error('expected ok');
      expect(row.debtGsusdDays.slice(0, -4)).toBe(answer.usage.debt);
      expect(row.poolGsusdDays.slice(0, -4)).toBe(answer.usage.pool);
      expect(row.liquidityDollarDays.slice(0, -4)).toBe(answer.usage.liquidity);
      expect(answer.asOfBlock).toBe(ledger.asOfBlock);
    }
  });

  it('keeps an address whose balances are all zero now but that has recorded usage', async () => {
    const off = testConfig();
    const chain = createFakeChain(off);
    chain.emit(400n, 'vault', 'DebtMinted', { user: ALICE, amount: 1_000n * ONE });
    chain.emit(500n, 'vault', 'DebtRepaid', { user: ALICE, amount: 1_000n * ONE });
    chain.head = 900n;
    await indexLedger(chain, store, off, createIndexerMemory(), () => NOW);
    const ledger = await readLedger({ config: off, store });
    expect(ledger.liquidity).toBe(false);
    expect(ledger.rows).toEqual([
      expect.objectContaining({ debtGsusdDays: unitDays(1_000n * ONE, 100n), debtGsusd: '0.000000', liquidityDollarDays: '0.000000' }),
    ]);
  });

  it('writes CSV with a header and one line per address, each closed by the block and time it is as of', async () => {
    await indexTo(1_000n);
    const ledger = await readLedger({ config, store });
    const lines = ledgerToCsv(ledger).split('\n');
    expect(lines[0]).toBe('address,debtGsusdDays,poolGsusdDays,liquidityDollarDays,debtGsusd,poolGsusd,liquidityDollars,asOfBlock,asOfTimestamp');
    expect(lines).toHaveLength(ledger.rows.length + 2);
    expect(lines[lines.length - 1]).toBe('');
    const first = ledger.rows[0];
    expect(lines[1]).toBe(
      `${first.address},${first.debtGsusdDays},${first.poolGsusdDays},${first.liquidityDollarDays},${first.debtGsusd},${first.poolGsusd},${first.liquidityDollars},1000,${testBlockTime(1_000n)}`
    );
    for (const line of lines.slice(1, -1)) expect(line).toMatch(/^0x[0-9a-fA-F]{40}(,\d+\.\d{6}){6},\d+,\d+$/);
  });

  it('gives the same export from a rebuild as from incremental runs', async () => {
    await indexTo(1_000n);
    const once = await readLedger({ config, store });
    store = createMemoryLedgerStore();
    await indexTo(600n);
    await indexTo(1_000n);
    expect(await readLedger({ config, store })).toEqual(once);
  });

  it('refuses to export while the index holds no finished state for this configuration', async () => {
    await expect(readLedger({ config, store })).rejects.toThrow(/holds no finished state/);
    store.raw.meta = encodeMeta(genesisMeta(config, []));
    await expect(readLedger({ config, store })).rejects.toThrow(/holds no finished state/);
    await indexTo(1_000n);
    await expect(readLedger({ config: testConfig({ liquidity: TEST_LIQUIDITY, startTimestamp: config.startTimestamp + 1 }), store })).rejects.toThrow(
      /holds no finished state/
    );
  });

  it('refuses a read during which the state moved, or whose records do not number what the meta counts', async () => {
    await indexTo(1_000n);
    const readMeta = store.readMeta;
    let reads = 0;
    const moving = {
      ...store,
      readMeta: async () => {
        const meta = await readMeta();
        reads += 1;
        return reads > 1 && meta !== undefined ? { ...meta, stateId: 'ffffffffffffffff' } : meta;
      },
    };
    await expect(readLedger({ config, store: moving })).rejects.toThrow(/changed while it was read/);
    store.raw.accounts.delete(ALICE.toLowerCase());
    await expect(readLedger({ config, store })).rejects.toThrow(/changed while it was read/);
  });
});
