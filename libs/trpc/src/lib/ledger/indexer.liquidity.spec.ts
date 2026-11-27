import type { ChainPosition } from './chainClient';
import { decodeAccount, decodeMeta, decodePosition } from './codec';
import type { LedgerMeta } from './codec';
import { createIndexerMemory, indexLedger } from './indexer';
import type { IndexerMemory } from './indexer';
import { pegValue } from './liquidityMath';
import { createMemoryLedgerStore } from './memoryStore';
import type { MemoryLedgerStore } from './memoryStore';
import { ledgerFingerprint } from './meta';
import { readAccount, readStatus } from './reader';
import {
  createFakeChain,
  TEST_DOLLAR,
  TEST_GSUSD,
  TEST_LIQUIDITY,
  TEST_LIQUIDITY_FACTS,
  TEST_PARITY_TICK,
  TEST_POSITION_MANAGER,
  testConfig,
} from './testSupport';
import type { FakeChain } from './testSupport';
import { RAW_PER_UNIT_DAY } from './units';

const ALICE = '0x00000000000000000000000000000000000000A1';
const BOB = '0x00000000000000000000000000000000000000B2';
const ZERO = '0x0000000000000000000000000000000000000000';
const alice = ALICE.toLowerCase();
const bob = BOB.toLowerCase();
const NOW = 1_900_000_000_000;
const ONE = 10n ** 18n;
const PAIR = { decimals0: 18, decimals1: 6 };
const LOWER = TEST_PARITY_TICK - 10;
const UPPER = TEST_PARITY_TICK + 10;
const LIQUIDITY = 10n ** 21n;
const VALUE = pegValue(PAIR, LIQUIDITY, LOWER, UPPER);

const config = testConfig({ liquidity: TEST_LIQUIDITY });

const chainPosition = (overrides: Partial<ChainPosition> = {}): ChainPosition => ({
  token0: TEST_GSUSD,
  token1: TEST_DOLLAR,
  fee: 500,
  tickLower: LOWER,
  tickUpper: UPPER,
  liquidity: LIQUIDITY,
  owner: ALICE,
  ...overrides,
});

const metaOf = (store: MemoryLedgerStore): LedgerMeta => {
  const meta = decodeMeta(store.raw.meta);
  if (meta === undefined) throw new Error('the store holds no readable meta');
  return meta;
};

const swapArgs = (tick: number) => ({ sender: BOB, recipient: BOB, amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, liquidity: 1n, tick });
const amounts = { liquidity: 1n, amount0: 1n, amount1: 1n };

/** What the chain emits and holds when a position is minted through the position manager. */
const mintPosition = (chain: FakeChain, block: bigint, tokenId: bigint, position: ChainPosition): void => {
  const transaction = `mint ${tokenId} at ${block}`;
  chain.emit(block, 'liquidityPool', 'Mint', { sender: TEST_POSITION_MANAGER, owner: TEST_POSITION_MANAGER, tickLower: position.tickLower, tickUpper: position.tickUpper, amount: 1n, amount0: 1n, amount1: 1n }, transaction);
  chain.emit(block, 'positionManager', 'Transfer', { from: ZERO, to: position.owner, tokenId }, transaction);
  chain.emit(block, 'positionManager', 'IncreaseLiquidity', { tokenId, ...amounts }, transaction);
  chain.setPosition(block, tokenId, position);
};

/** A decrease through the position manager: the pool's Burn, then the manager's own log. */
const decreasePosition = (chain: FakeChain, block: bigint, tokenId: bigint, position: ChainPosition | undefined): void => {
  const transaction = `decrease ${tokenId} at ${block}`;
  chain.emit(block, 'liquidityPool', 'Burn', { owner: TEST_POSITION_MANAGER, tickLower: LOWER, tickUpper: UPPER, amount: 1n, amount0: 1n, amount1: 1n }, transaction);
  chain.emit(block, 'positionManager', 'DecreaseLiquidity', { tokenId, ...amounts }, transaction);
  chain.setPosition(block, tokenId, position);
};

/** What the position manager emits for a position of some other pool: our pool logs nothing. */
const foreignActivity = (chain: FakeChain, block: bigint, tokenId: bigint): void => {
  const transaction = `foreign ${tokenId} at ${block}`;
  chain.emit(block, 'positionManager', 'Transfer', { from: ZERO, to: BOB, tokenId }, transaction);
  chain.emit(block, 'positionManager', 'IncreaseLiquidity', { tokenId, ...amounts }, transaction);
  chain.emit(block, 'positionManager', 'DecreaseLiquidity', { tokenId, ...amounts }, transaction);
};

/** Dollars in range over `blocks` blocks of twelve seconds: dollar wei times seconds. */
const recorded = (dollars: bigint, blocks: bigint): bigint => dollars * blocks * 12n;

describe('indexLedger with the liquidity dimension', () => {
  let chain: FakeChain;
  let store: MemoryLedgerStore;
  let memory: IndexerMemory;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  const run = (targetMemory: IndexerMemory = memory, using = config) => indexLedger(chain, store, using, targetMemory, () => NOW);
  const liquidityRaw = (address: string): bigint => decodeAccount(store.raw.accounts.get(address))?.liquidityRaw ?? -1n;

  beforeEach(() => {
    chain = createFakeChain(config);
    store = createMemoryLedgerStore();
    memory = createIndexerMemory();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  /** The ledger starts at block 400. A position in range from 500, out from 600 to 700, transferred at 800. */
  const seed = (): void => {
    chain.emit(450n, 'liquidityPool', 'Initialize', { sqrtPriceX96: 1n, tick: TEST_PARITY_TICK });
    mintPosition(chain, 500n, 7n, chainPosition());
    mintPosition(chain, 520n, 8n, chainPosition({ owner: BOB, tickLower: UPPER + 100, tickUpper: UPPER + 200 }));
    chain.emit(600n, 'liquidityPool', 'Swap', swapArgs(UPPER + 5));
    chain.emit(650n, 'liquidityPool', 'Swap', swapArgs(UPPER + 20));
    chain.emit(700n, 'liquidityPool', 'Swap', swapArgs(TEST_PARITY_TICK + 1));
    chain.emit(800n, 'positionManager', 'Transfer', { from: ALICE, to: BOB, tokenId: 7n }, 'transfer 7');
    chain.setPosition(800n, 7n, chainPosition({ owner: BOB }));
    chain.head = 900n;
  };

  it('records positions from the logs and the position manager', async () => {
    seed();
    await run();
    expect(error).not.toHaveBeenCalled();
    const meta = metaOf(store);
    expect(meta.cursor).toBe('900');
    expect(meta.lp).toEqual({ tick: TEST_PARITY_TICK + 1, positions: 2 });
    expect(meta.syncedAt).toBe(String(NOW));
    // Alice: in range for blocks 500 to 600 and 700 to 800, then the position is Bob's.
    expect(liquidityRaw(alice)).toBe(recorded(VALUE, 200n));
    expect(decodeAccount(store.raw.accounts.get(alice))?.liquidity).toBe(0n);
    // Bob's own position never came into range; he holds Alice's from block 800.
    expect(decodeAccount(store.raw.accounts.get(bob))?.liquidity).toBe(VALUE);
    expect(decodePosition(store.raw.positions.get('7'))?.owner).toBe(bob);
    expect(store.raw.positions.size).toBe(2);

    const reader = { config, store };
    const aliceAnswer = await readAccount(reader, config.chainId, ALICE, NOW);
    const bobAnswer = await readAccount(reader, config.chainId, BOB, NOW);
    if (aliceAnswer.status !== 'ok' || bobAnswer.status !== 'ok') throw new Error('expected ok');
    const dollarDays = (raw: bigint): string => {
      const hundredths = (raw * 100n) / RAW_PER_UNIT_DAY;
      return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
    };
    expect(aliceAnswer.usage).toEqual({ debt: '0.00', pool: '0.00', liquidity: dollarDays(recorded(VALUE, 200n)) });
    expect(aliceAnswer.balances.liquidity).toBe('0');
    expect(bobAnswer.usage.liquidity).toBe(dollarDays(recorded(VALUE, 100n)));
    expect(bobAnswer.balances.liquidity).toBe(VALUE.toString());

    const status = await readStatus(reader, config.chainId, NOW);
    expect(status).toMatchObject({ status: 'ok', terms: { liquidity: true }, asOfBlock: '900', addresses: 2, incomplete: false });
  });

  it('reads the position manager only for our positions, and block times only where an account changes', async () => {
    seed();
    // Positions of other pools: thousands of these pass by on a real chain.
    foreignActivity(chain, 510n, 900n);
    foreignActivity(chain, 660n, 900n);
    const timed: bigint[] = [];
    const getBlockTimestamp = chain.getBlockTimestamp;
    chain.getBlockTimestamp = async (block) => {
      timed.push(block);
      return getBlockTimestamp(block);
    };
    await run();
    // The run ends with the audit of both tracked positions at the cursor.
    expect(chain.positionReads).toEqual([
      { block: 500n, tokenIds: [7n] },
      { block: 520n, tokenIds: [8n] },
      { block: 800n, tokenIds: [7n] },
      { block: 900n, tokenIds: [7n, 8n] },
    ]);
    // The position manager handed over the logs of our two positions and nothing else.
    const served = chain.positionLogsServed.map((log) => [log.eventName, log.args?.['tokenId']]);
    expect(served).toEqual([
      ['IncreaseLiquidity', 7n],
      ['IncreaseLiquidity', 8n],
      // The filter for the two new ids starts after the first was found, so it also returns the mint transfer of the second.
      ['Transfer', 8n],
      ['Transfer', 7n],
    ]);
    // One window: one receipt per mint, and one id filter for the two positions found in it.
    expect(chain.windows).toEqual([[100n, 900n]]);
    expect(chain.receiptReads).toHaveLength(2);
    expect(chain.transferReads).toEqual([{ fromBlock: 501n, toBlock: 900n, tokenIds: [7n, 8n] }]);
    // 650 moves the tick without crossing a range end, and block 510 holds nothing of ours.
    // 450 is the pool's first tick, which is always timed once a range is known.
    expect([...new Set(timed)].sort()).toEqual([450n, 500n, 520n, 600n, 700n, 800n, 900n]);
  });

  it('arrives at the same state in one window and in many', async () => {
    seed();
    await run();
    const whole = { accounts: new Map(store.raw.accounts), positions: new Map(store.raw.positions), lp: metaOf(store).lp };
    store = createMemoryLedgerStore();
    memory = createIndexerMemory();
    await run(memory, { ...config, maxBlockRange: 37n });
    expect(chain.windows.length).toBeGreaterThan(20);
    expect({ accounts: new Map(store.raw.accounts), positions: new Map(store.raw.positions), lp: metaOf(store).lp }).toEqual(whole);
  });

  it('resumes from the store in a new process and keeps following the pool', async () => {
    seed();
    chain.head = 620n;
    await run();
    expect(metaOf(store).lp).toEqual({ tick: UPPER + 5, positions: 2 });
    chain.head = 900n;
    await run(createIndexerMemory());
    expect(liquidityRaw(alice)).toBe(recorded(VALUE, 200n));
    expect(error).not.toHaveBeenCalled();
  });

  it('drops a position that was burned and stops recording it', async () => {
    seed();
    decreasePosition(chain, 850n, 7n, undefined);
    chain.emit(850n, 'positionManager', 'Transfer', { from: BOB, to: ZERO, tokenId: 7n }, 'burn 7');
    await run();
    expect(store.raw.positions.has('7')).toBe(false);
    expect(metaOf(store).lp?.positions).toBe(1);
    expect(liquidityRaw(bob)).toBe(recorded(VALUE, 50n));
    expect(decodeAccount(store.raw.accounts.get(bob))?.liquidity).toBe(0n);
  });

  it('does not record a position of another pool that the position manager minted in the same block', async () => {
    chain.emit(450n, 'liquidityPool', 'Initialize', { sqrtPriceX96: 1n, tick: TEST_PARITY_TICK });
    mintPosition(chain, 500n, 7n, chainPosition());
    foreignActivity(chain, 500n, 900n);
    chain.setPosition(500n, 900n, chainPosition({ owner: BOB, token1: ZERO }));
    chain.head = 600n;
    await run();
    expect([...store.raw.positions.keys()]).toEqual(['7']);
    expect(store.raw.accounts.has(bob)).toBe(false);
    // It was never even read: its logs were not asked for.
    expect(chain.positionReads.flatMap((read) => read.tokenIds)).not.toContain(900n);
  });

  it('rebuilds when the tracked tick is not the pool tick, as after a swap log the endpoint lost', async () => {
    seed();
    chain.poolTickOverride = () => TEST_PARITY_TICK + 3;
    await run();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^Usage ledger index integrity failure: at block 900 the index tracks tick/));
  });

  it('says plainly what is wrong and what to change when the pool was initialized before the deploy block', async () => {
    // No Initialize log inside the blocks the index reads, yet the pool has a tick.
    chain.head = 300n;
    chain.poolTickOverride = () => TEST_PARITY_TICK;
    await run();
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Usage ledger index integrity failure: at block 300 the liquidity pool is initialized \(tick -276324\) but the index never saw its Initialize log\. The index reads from GOLD_VAULT_DEPLOY_BLOCK on, so a pool initialized before that block cannot be followed: name a pool created after the deployment in LEDGER_LIQUIDITY_POOL_ADDRESS, or remove both liquidity variables to turn the source off\./
      )
    );
    expect(metaOf(store).cursor).toBeNull();
    expect(metaOf(store).rebuilds).toEqual([NOW]);
    expect(store.raw.positions.size).toBe(0);
  });

  it('rebuilds when an audited position is tracked with more liquidity than the position manager holds', async () => {
    seed();
    chain.positionOverride = (block, tokenId, truth) =>
      block === 900n && tokenId === 8n && truth !== undefined ? { ...truth, liquidity: truth.liquidity - 1n } : truth;
    await run();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/Usage ledger index integrity failure: at block 900 the index tracks liquidity position 8/));
    expect(metaOf(store).cursor).toBeNull();
  });

  it('writes no fresh stamp when the liquidity pool cannot be read for the check', async () => {
    seed();
    const readPoolTick = chain.readPoolTick;
    chain.readPoolTick = async () => {
      throw new Error('the endpoint is away');
    };
    await run();
    expect(metaOf(store).cursor).toBe('900');
    expect(metaOf(store).syncedAt).toBe('syncing');
    chain.readPoolTick = readPoolTick;
    await run();
    expect(metaOf(store).syncedAt).toBe(String(NOW));
  });

  it('keeps the committed state and retries when a position read fails mid scan', async () => {
    seed();
    const readPositions = chain.readPositions;
    chain.readPositions = async () => {
      throw new Error('the endpoint is away');
    };
    await run();
    expect(metaOf(store).cursor).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^Usage ledger indexing stopped at block 100/), expect.anything());
    chain.readPositions = readPositions;
    await run();
    expect(liquidityRaw(alice)).toBe(recorded(VALUE, 200n));
  });

  it('follows a decrease in a block with no pool Mint, and a transfer in a later run', async () => {
    seed();
    decreasePosition(chain, 820n, 7n, chainPosition({ owner: BOB, liquidity: LIQUIDITY / 2n }));
    chain.head = 830n;
    await run();
    expect(decodePosition(store.raw.positions.get('7'))?.liquidity).toBe(LIQUIDITY / 2n);
    // A later run knows both positions, so their transfers are asked for by id over its own window.
    chain.emit(850n, 'positionManager', 'Transfer', { from: BOB, to: ALICE, tokenId: 7n }, 'back to alice');
    chain.setPosition(850n, 7n, chainPosition({ owner: ALICE, liquidity: LIQUIDITY / 2n }));
    foreignActivity(chain, 850n, 901n);
    chain.head = 900n;
    chain.transferReads.length = 0;
    await run();
    expect(chain.transferReads).toEqual([{ fromBlock: 831n, toBlock: 900n, tokenIds: [7n, 8n] }]);
    expect(decodePosition(store.raw.positions.get('7'))?.owner).toBe(alice);
    expect(chain.positionLogsServed.every((log) => log.args?.['tokenId'] === 7n || log.args?.['tokenId'] === 8n)).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it('narrows the window when the endpoint refuses the transfer filter as too wide', async () => {
    seed();
    chain.head = 700n;
    await run();
    chain.head = 5_000n;
    chain.beforeGetLogs = (fromBlock, toBlock) => {
      if (toBlock - fromBlock + 1n > 1_000n) throw new Error('query returned more than 10000 results');
    };
    chain.windows.length = 0;
    await run();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/eth_getLogs refused 4300 blocks from block 701 as too wide/));
    expect(chain.windows.every(([from, to]) => to - from + 1n <= 1_000n)).toBe(true);
    expect(metaOf(store).cursor).toBe('5000');
    expect(decodePosition(store.raw.positions.get('7'))?.owner).toBe(bob);
  });

  it('refuses a pool that is not a GSUSD pool, indexing nothing, and says which variables to correct', async () => {
    seed();
    chain.liquidityFacts = { ...TEST_LIQUIDITY_FACTS, stablecoin: ZERO };
    await run();
    expect(store.raw.meta).toBeNull();
    expect(chain.windows).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/^Usage ledger liquidity pool refused: .*neither is the GSUSD token of this deployment.*LEDGER_LIQUIDITY_POOL_ADDRESS and LEDGER_LIQUIDITY_POSITION_MANAGER/)
    );
    // Corrected, the same process indexes on its next run.
    chain.liquidityFacts = TEST_LIQUIDITY_FACTS;
    await run();
    expect(metaOf(store).cursor).toBe('900');
  });

  it('reads the pool description once per process', async () => {
    seed();
    let reads = 0;
    const readLiquidityFacts = chain.readLiquidityFacts;
    chain.readLiquidityFacts = async (liquidity) => {
      reads += 1;
      return readLiquidityFacts(liquidity);
    };
    await run();
    await run();
    expect(reads).toBe(1);
  });

  it('recomputes the whole ledger when the dimension is turned on, turned off or pointed at another pool', async () => {
    const off = testConfig();
    seed();
    chain.emit(460n, 'vault', 'DebtMinted', { user: ALICE, amount: 1_000n * ONE });
    // Off: the liquidity logs are not even asked for, so the fake chain must not hand them over.
    const everything = chain.logs;
    chain.logs = everything.filter((log) => log.address === off.vault || log.address === off.pool);
    await run(memory, off);
    const offMeta = metaOf(store);
    expect(offMeta.fingerprint).toBe(ledgerFingerprint(off));
    expect(offMeta).not.toHaveProperty('lp');
    expect(liquidityRaw(alice)).toBe(0n);
    expect(store.raw.accounts.get(alice)).not.toContain('"lr"');

    chain.logs = everything;
    await run();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/computed under another configuration/));
    expect(metaOf(store).fingerprint).toBe(ledgerFingerprint(config));
    expect(liquidityRaw(alice)).toBe(recorded(VALUE, 200n));
    expect(decodeAccount(store.raw.accounts.get(alice))?.debt).toBe(1_000n * ONE);

    chain.logs = everything.filter((log) => log.address === off.vault || log.address === off.pool);
    await run(memory, off);
    expect(metaOf(store)).not.toHaveProperty('lp');
    expect(store.raw.positions.size).toBe(0);
    expect(liquidityRaw(alice)).toBe(0n);
  });
});
