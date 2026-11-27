import type { ChainPosition } from './chainClient';
import { LedgerIntegrityError } from './errors';
import type { LedgerEvent, RawLedgerLog } from './events';
import type { LiquidityPosition, LiquiditySource, LiquidityState } from './liquidity';
import { checkLiquidityAgainstChain, prepareLiquidityEvents } from './liquidityIndex';
import { pegValue } from './liquidityMath';
import { LIQUIDITY_AUDIT_POSITIONS_PER_RUN, LIQUIDITY_IDS_PER_FILTER } from './limits';
import { TEST_DOLLAR, TEST_GSUSD, TEST_LIQUIDITY, TEST_PARITY_TICK, TEST_POSITION_MANAGER, testTransactionHash } from './testSupport';

const ALICE = '0x00000000000000000000000000000000000000A1';
const BOB = '0x00000000000000000000000000000000000000b2';
const OTHER_TOKEN = '0x00000000000000000000000000000000000000dD';
const source: LiquiditySource = { ...TEST_LIQUIDITY, token0: TEST_GSUSD, token1: TEST_DOLLAR, fee: 500, decimals0: 18, decimals1: 6 };
const LOWER = TEST_PARITY_TICK - 10;
const UPPER = TEST_PARITY_TICK + 10;
/** About 1,000 dollars at the peg in a twenty tick range. */
const LIQUIDITY = 10n ** 21n;
const empty: LiquidityState = { tick: null, positions: new Map() };

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

const tracked = (overrides: Partial<LiquidityPosition> = {}): LiquidityPosition => ({
  owner: ALICE.toLowerCase(),
  liquidity: LIQUIDITY,
  tickLower: LOWER,
  tickUpper: UPPER,
  value: pegValue(source, LIQUIDITY, LOWER, UPPER),
  ...overrides,
});

interface ManagerLog {
  eventName: 'IncreaseLiquidity' | 'DecreaseLiquidity' | 'Transfer';
  tokenId: bigint;
  block: bigint;
  logIndex: number;
  transaction: string;
}

interface FakeClient {
  reads: { block: bigint; tokenIds: bigint[] }[];
  positions: Map<string, ChainPosition | undefined>;
  /** Everything the position manager emitted, for every pool: only receipts and id filters hand any of it over. */
  managerLogs: ManagerLog[];
  receiptReads: string[];
  transferReads: { fromBlock: bigint; toBlock: bigint; tokenIds: bigint[] }[];
  served: ManagerLog[];
  tick: number | null;
  fail: boolean;
  readPositions(block: bigint, tokenIds: readonly bigint[]): Promise<(ChainPosition | undefined)[]>;
  readPoolTick(block: bigint): Promise<number | null>;
  getPositionLiquidityLogs(transactionHash: string): Promise<RawLedgerLog[]>;
  getPositionTransferLogs(fromBlock: bigint, toBlock: bigint, tokenIds: readonly bigint[]): Promise<RawLedgerLog[]>;
}

const hashOf = (transaction: string): `0x${string}` => testTransactionHash(transaction);

const raw = (log: ManagerLog): RawLedgerLog => ({
  address: TEST_POSITION_MANAGER,
  eventName: log.eventName,
  args: log.eventName === 'Transfer' ? { from: ALICE, to: BOB, tokenId: log.tokenId } : { tokenId: log.tokenId, liquidity: 1n },
  blockNumber: log.block,
  logIndex: log.logIndex,
  transactionHash: hashOf(log.transaction),
});

const fakeClient = (positions: Record<string, ChainPosition | undefined> = {}): FakeClient => {
  const client: FakeClient = {
    reads: [],
    positions: new Map(Object.entries(positions)),
    managerLogs: [],
    receiptReads: [],
    transferReads: [],
    served: [],
    tick: null,
    fail: false,
    readPositions: async (block, tokenIds) => {
      if (client.fail) throw new Error('the endpoint is away');
      client.reads.push({ block, tokenIds: [...tokenIds] });
      return tokenIds.map((tokenId) => client.positions.get(tokenId.toString()));
    },
    readPoolTick: async () => {
      if (client.fail) throw new Error('the endpoint is away');
      return client.tick;
    },
    getPositionLiquidityLogs: async (transactionHash) => {
      client.receiptReads.push(transactionHash);
      const logs = client.managerLogs.filter((log) => hashOf(log.transaction) === transactionHash && log.eventName !== 'Transfer');
      client.served.push(...logs);
      return logs.map(raw);
    },
    getPositionTransferLogs: async (fromBlock, toBlock, tokenIds) => {
      client.transferReads.push({ fromBlock, toBlock, tokenIds: [...tokenIds] });
      const logs = client.managerLogs.filter(
        (log) => log.eventName === 'Transfer' && log.block >= fromBlock && log.block <= toBlock && tokenIds.includes(log.tokenId)
      );
      client.served.push(...logs);
      return logs.map(raw);
    },
  };
  return client;
};

let nextLogIndex = 0;
const at = (block: number) => ({ block: BigInt(block), logIndex: nextLogIndex++ });
const WINDOW = { from: 1n, to: 100n };

/** A chain under construction: the pool's logs go to the window, the position manager's stay on the fake chain. */
const scene = (positions: Record<string, ChainPosition | undefined> = {}) => {
  const client = fakeClient(positions);
  const decoded: LedgerEvent[] = [];
  const manager = (eventName: ManagerLog['eventName'], tokenId: number, block: number, transaction: string): ManagerLog => {
    const log = { eventName, tokenId: BigInt(tokenId), transaction, ...at(block) };
    client.managerLogs.push(log);
    return log;
  };
  const pool = (added: boolean, block: number, transaction: string, owner: string = TEST_POSITION_MANAGER): void => {
    decoded.push({ kind: 'poolLiquidity', owner: owner as `0x${string}`, added, transactionHash: hashOf(transaction), ...at(block) });
  };
  return {
    client,
    decoded,
    /** A mint through the position manager: the pool's Mint, the NFT transfer, then the increase. */
    mint: (tokenId: number, block: number, transaction = `mint ${tokenId} ${block}`) => {
      pool(true, block, transaction);
      manager('Transfer', tokenId, block, transaction);
      return manager('IncreaseLiquidity', tokenId, block, transaction);
    },
    increase: (tokenId: number, block: number, transaction = `increase ${tokenId} ${block}`) => {
      pool(true, block, transaction);
      return manager('IncreaseLiquidity', tokenId, block, transaction);
    },
    decrease: (tokenId: number, block: number, transaction = `decrease ${tokenId} ${block}`) => {
      pool(false, block, transaction);
      return manager('DecreaseLiquidity', tokenId, block, transaction);
    },
    transfer: (tokenId: number, block: number, transaction = `transfer ${tokenId} ${block}`) =>
      manager('Transfer', tokenId, block, transaction),
    /** Activity of a position of another pool: the position manager logs it, our pool does not. */
    foreign: (eventName: ManagerLog['eventName'], tokenId: number, block: number, transaction = `foreign ${tokenId} ${block}`) =>
      manager(eventName, tokenId, block, transaction),
    directMint: (block: number) => pool(true, block, `direct ${block}`, ALICE),
    tick: (value: number, block: number) => decoded.push({ kind: 'poolTick', tick: value, ...at(block) }),
    prepare: (state: LiquidityState = empty) => prepareLiquidityEvents(client, source, state, decoded, WINDOW),
  };
};

const mint: LedgerEvent = { kind: 'mint', account: ALICE, amount: 5n, block: 3n, logIndex: 1_000_000 };
const startingWith = (...ids: string[]): LiquidityState => ({
  tick: TEST_PARITY_TICK,
  positions: new Map(ids.map((id) => [id, tracked()])),
});
const stateIds = (events: readonly LedgerEvent[]): (bigint | undefined)[] =>
  events.map((event) => (event.kind === 'positionState' ? event.tokenId : undefined));

describe('prepareLiquidityEvents', () => {
  it('passes every event through, with every block timed, and asks nothing while the source is off', async () => {
    const client = fakeClient();
    const events: LedgerEvent[] = [mint, { kind: 'poolTick', tick: 5, ...at(4) }];
    const prepared = await prepareLiquidityEvents(client, undefined, empty, events, WINDOW);
    expect(prepared.events).toEqual(events);
    expect(prepared.timedBlocks).toEqual([3n, 4n]);
    expect([client.reads, client.receiptReads, client.transferReads]).toEqual([[], [], []]);
  });

  it('finds a new position from the pool log and the receipt of its transaction', async () => {
    const chain = scene({ '7': chainPosition() });
    const increase = chain.mint(7, 5, 'the mint');
    const prepared = await chain.prepare();
    expect(chain.client.receiptReads).toEqual([hashOf('the mint')]);
    expect(chain.client.reads).toEqual([{ block: 5n, tokenIds: [7n] }]);
    expect(prepared.events).toEqual([
      {
        kind: 'positionState',
        tokenId: 7n,
        reading: { owner: ALICE, liquidity: LIQUIDITY, tickLower: LOWER, tickUpper: UPPER },
        block: 5n,
        logIndex: increase.logIndex,
      },
    ]);
    expect(prepared.timedBlocks).toEqual([5n]);
  });

  it('never asks for, and never decodes, a position manager event of another pool', async () => {
    const chain = scene({ '7': chainPosition() });
    // Other pools: in other blocks, in the same block as our mint, and in a block where a direct provider used our pool.
    chain.foreign('Transfer', 900, 4);
    chain.foreign('IncreaseLiquidity', 900, 4);
    chain.foreign('IncreaseLiquidity', 901, 5);
    chain.mint(7, 5);
    chain.foreign('DecreaseLiquidity', 902, 5);
    chain.foreign('Transfer', 902, 5);
    chain.directMint(6);
    chain.foreign('IncreaseLiquidity', 903, 6);
    chain.foreign('Transfer', 904, 60);
    chain.transfer(7, 70);
    const prepared = await chain.prepare();
    expect(chain.client.served.map((log) => log.tokenId)).toEqual([7n, 7n]);
    expect(chain.client.served.every((log) => log.tokenId === 7n)).toBe(true);
    // One receipt, for the one transaction in which our pool logged for the position manager.
    expect(chain.client.receiptReads).toHaveLength(1);
    // The only id filter is the follow-up for the position found in this window.
    expect(chain.client.transferReads).toEqual([{ fromBlock: 6n, toBlock: 100n, tokenIds: [7n] }]);
    expect(chain.client.reads.flatMap((read) => read.tokenIds)).toEqual([7n, 7n]);
    expect(stateIds(prepared.events)).toEqual([7n, 7n]);
  });

  it('takes only the position manager log that follows the pool log, in a transaction that also touches another pool', async () => {
    const chain = scene({ '7': chainPosition(), '900': chainPosition({ token1: OTHER_TOKEN }) });
    // One multicall: a position of another pool first, then ours, then another again.
    chain.foreign('IncreaseLiquidity', 900, 5, 'multicall');
    chain.increase(7, 5, 'multicall');
    chain.foreign('IncreaseLiquidity', 901, 5, 'multicall');
    const prepared = await chain.prepare();
    expect(chain.client.reads).toEqual([{ block: 5n, tokenIds: [7n] }]);
    expect(stateIds(prepared.events)).toEqual([7n]);
  });

  it('matches two changes of our pool in one transaction each to its own position', async () => {
    const chain = scene({ '7': chainPosition(), '8': chainPosition({ owner: BOB }) });
    chain.increase(7, 5, 'both');
    chain.increase(8, 5, 'both');
    const prepared = await chain.prepare();
    expect(chain.client.receiptReads).toEqual([hashOf('both')]);
    expect(stateIds(prepared.events)).toEqual([7n, 8n]);
  });

  it('treats a pool log with no position manager log behind it as an integrity failure', async () => {
    const chain = scene();
    chain.decoded.push({ kind: 'poolLiquidity', owner: TEST_POSITION_MANAGER, added: true, transactionHash: hashOf('orphan'), ...at(5) });
    await expect(chain.prepare()).rejects.toThrow(LedgerIntegrityError);
    // A decrease does not stand in for the increase the pool log calls for.
    const wrong = scene();
    wrong.decoded.push({ kind: 'poolLiquidity', owner: TEST_POSITION_MANAGER, added: true, transactionHash: hashOf('wrong'), ...at(6) });
    wrong.foreign('DecreaseLiquidity', 7, 6, 'wrong');
    await expect(wrong.prepare()).rejects.toThrow(/holds no matching position manager log/);
  });

  it('ignores liquidity the pool recorded for a direct provider', async () => {
    const chain = scene();
    chain.directMint(6);
    const prepared = await chain.prepare();
    expect(prepared.events).toEqual([]);
    expect([chain.client.reads, chain.client.receiptReads, chain.client.transferReads]).toEqual([[], [], []]);
  });

  it('catches an increase, a decrease in a block with no pool Mint and a decrease to zero of a tracked position', async () => {
    const chain = scene({ '7': chainPosition() });
    chain.increase(7, 10);
    chain.decrease(7, 20);
    const last = chain.decrease(7, 30);
    chain.client.readPositions = async (block, tokenIds) => {
      chain.client.reads.push({ block, tokenIds: [...tokenIds] });
      return tokenIds.map(() => (block === 10n ? chainPosition({ liquidity: 2n * LIQUIDITY }) : block === 20n ? chainPosition() : chainPosition({ liquidity: 0n })));
    };
    const prepared = await chain.prepare(startingWith('7'));
    expect(chain.client.reads.map((read) => read.block)).toEqual([10n, 20n, 30n]);
    expect(prepared.events.map((event) => (event.kind === 'positionState' ? event.reading?.liquidity : undefined))).toEqual([
      2n * LIQUIDITY,
      LIQUIDITY,
      0n,
    ]);
    expect(prepared.events[2]).toMatchObject({ block: 30n, logIndex: last.logIndex });
  });

  it('catches a transfer of a tracked position through the token id filter', async () => {
    const chain = scene({ '7': chainPosition({ owner: BOB }) });
    chain.transfer(7, 8);
    chain.foreign('Transfer', 900, 8);
    const prepared = await chain.prepare(startingWith('7'));
    expect(chain.client.transferReads).toEqual([{ fromBlock: 1n, toBlock: 100n, tokenIds: [7n] }]);
    expect(chain.client.receiptReads).toEqual([]);
    expect(prepared.events).toEqual([expect.objectContaining({ kind: 'positionState', tokenId: 7n, block: 8n, reading: expect.objectContaining({ owner: BOB }) })]);
  });

  it('asks for the transfers of a position found in this window from the block after it was found', async () => {
    const chain = scene({ '7': chainPosition() });
    chain.mint(7, 40);
    const moved = chain.transfer(7, 55);
    const prepared = await chain.prepare(startingWith('3'));
    expect(chain.client.transferReads).toEqual([
      { fromBlock: 1n, toBlock: 100n, tokenIds: [3n] },
      { fromBlock: 41n, toBlock: 100n, tokenIds: [7n] },
    ]);
    expect(prepared.events.map((event) => [event.block, event.logIndex])).toContainEqual([55n, moved.logIndex]);
    // The position was read at its mint and at its transfer, each once, though the pass ran twice.
    expect(chain.client.reads).toEqual([
      { block: 40n, tokenIds: [7n] },
      { block: 55n, tokenIds: [7n] },
    ]);
  });

  it('asks for no transfers at all while no position is tracked', async () => {
    const chain = scene();
    chain.tick(5, 4);
    await chain.prepare();
    expect(chain.client.transferReads).toEqual([]);
  });

  it('asks for the transfers of many tracked positions a filter of ids at a time', async () => {
    const ids = Array.from({ length: 2 * LIQUIDITY_IDS_PER_FILTER + 3 }, (_, index) => String(index + 1));
    const chain = scene(Object.fromEntries(ids.map((id) => [id, chainPosition({ owner: BOB })])));
    chain.transfer(2, 9);
    chain.transfer(LIQUIDITY_IDS_PER_FILTER + 1, 9);
    chain.transfer(2 * LIQUIDITY_IDS_PER_FILTER + 3, 12);
    const prepared = await chain.prepare(startingWith(...ids));
    expect(LIQUIDITY_IDS_PER_FILTER).toBe(500);
    expect(chain.client.transferReads.map((read) => read.tokenIds.length)).toEqual([500, 500, 3]);
    expect(chain.client.transferReads.map((read) => [read.fromBlock, read.toBlock])).toEqual([
      [1n, 100n],
      [1n, 100n],
      [1n, 100n],
    ]);
    // Every id is asked for exactly once.
    expect(chain.client.transferReads.flatMap((read) => read.tokenIds).map(String)).toEqual(ids);
    expect(stateIds(prepared.events)).toEqual([2n, 501n, 1_003n]);
  });

  it('writes one state per position and block, at the place of its last log', async () => {
    const chain = scene({ '7': chainPosition() });
    chain.mint(7, 5, 'first');
    const last = chain.increase(7, 5, 'second');
    const prepared = await chain.prepare();
    expect(prepared.events).toHaveLength(1);
    expect(prepared.events[0]).toMatchObject({ kind: 'positionState', logIndex: last.logIndex });
    expect(chain.client.reads).toEqual([{ block: 5n, tokenIds: [7n] }]);
  });

  it('reports a tracked position that no longer exists as gone, and stops reading it', async () => {
    const chain = scene({});
    chain.transfer(7, 8);
    chain.transfer(7, 9);
    const prepared = await chain.prepare(startingWith('7'));
    expect(prepared.events).toEqual([expect.objectContaining({ kind: 'positionState', tokenId: 7n, reading: undefined, block: 8n })]);
    expect(chain.client.reads).toEqual([{ block: 8n, tokenIds: [7n] }]);
  });

  it('leaves out a new position worth less than the minimum, and reads it again when it next gains liquidity', async () => {
    const chain = scene({ '7': chainPosition({ liquidity: 1_000n }) });
    chain.mint(7, 5);
    chain.decrease(7, 6);
    chain.increase(7, 7);
    const prepared = await chain.prepare();
    expect(prepared.events).toEqual([]);
    expect(chain.client.reads.map((read) => read.block)).toEqual([5n, 7n]);
  });

  it('reports a tracked position that fell below the minimum, so the replay drops it', async () => {
    const chain = scene({ '7': chainPosition({ liquidity: 1_000n }) });
    chain.decrease(7, 8);
    const prepared = await chain.prepare(startingWith('7'));
    expect(prepared.events).toEqual([expect.objectContaining({ kind: 'positionState', reading: expect.objectContaining({ liquidity: 1_000n }) })]);
  });

  it('times only the tick moves that cross the end of a tracked or newly read range', async () => {
    const chain = scene({ '8': chainPosition({ tickLower: UPPER + 100, tickUpper: UPPER + 200 }) });
    chain.tick(TEST_PARITY_TICK + 3, 10);
    chain.tick(TEST_PARITY_TICK - 9, 11);
    chain.tick(UPPER, 12);
    chain.tick(UPPER + 50, 13);
    chain.mint(8, 14);
    chain.tick(UPPER + 150, 15);
    chain.tick(UPPER + 160, 16);
    chain.tick(LOWER - 1, 17);
    const prepared = await chain.prepare(startingWith('7'));
    expect(prepared.events.map((event) => event.kind)).toEqual([
      'poolTick',
      'poolTick',
      'poolTick',
      'poolTick',
      'positionState',
      'poolTick',
      'poolTick',
      'poolTick',
    ]);
    // 12 leaves the first range, 15 enters the second, 17 leaves it; 14 holds the new position.
    expect([...prepared.timedBlocks].sort()).toEqual([12n, 14n, 15n, 17n]);
  });

  it('keeps the other events and their order', async () => {
    const chain = scene({ '7': chainPosition() });
    chain.tick(TEST_PARITY_TICK, 2);
    chain.decoded.push(mint);
    chain.mint(7, 5);
    const prepared = await chain.prepare();
    expect(prepared.events.map((event) => event.kind)).toEqual(['poolTick', 'mint', 'positionState']);
    expect(prepared.timedBlocks).toContain(3n);
  });

  it('lets a failed read stop the window', async () => {
    const chain = scene({ '7': chainPosition() });
    chain.mint(7, 5);
    chain.client.fail = true;
    await expect(chain.prepare()).rejects.toThrow('the endpoint is away');
  });
});

describe('checkLiquidityAgainstChain', () => {
  const state = (positions: [string, LiquidityPosition][] = [['7', tracked()]], tickValue: number | null = 5): LiquidityState => ({
    tick: tickValue,
    positions: new Map(positions),
  });

  it('passes when the tick and the audited positions agree with the chain', async () => {
    const client = fakeClient({ '7': chainPosition() });
    client.tick = 5;
    expect(await checkLiquidityAgainstChain(client, state(), 40n, 0)).toEqual({ outcome: 'passed', nextOffset: 0 });
    expect(client.reads).toEqual([{ block: 40n, tokenIds: [7n] }]);
  });

  it('passes with no position and a pool that is not initialized', async () => {
    const client = fakeClient();
    expect(await checkLiquidityAgainstChain(client, state([], null), 40n, 0)).toEqual({ outcome: 'passed', nextOffset: 0 });
    expect(client.reads).toEqual([]);
  });

  it('fails when the tracked tick is not the pool tick', async () => {
    const client = fakeClient({ '7': chainPosition() });
    client.tick = 6;
    await expect(checkLiquidityAgainstChain(client, state(), 40n, 0)).rejects.toThrow(LedgerIntegrityError);
    client.tick = 5;
    // A pool initialized before the deploy block: the message says what is wrong and what to change.
    const early = checkLiquidityAgainstChain(client, state([], null), 40n, 0);
    await expect(early).rejects.toThrow(LedgerIntegrityError);
    await expect(early).rejects.toThrow(/the liquidity pool is initialized \(tick 5\) but the index never saw its Initialize log/);
    await expect(early).rejects.toThrow(/a pool initialized before that block cannot be followed/);
    await expect(early).rejects.toThrow(/LEDGER_LIQUIDITY_POOL_ADDRESS, or remove both liquidity variables/);
  });

  it('fails when a position is tracked with more liquidity than the chain holds, for another owner or not at all', async () => {
    const less = fakeClient({ '7': chainPosition({ liquidity: LIQUIDITY - 1n }) });
    less.tick = 5;
    await expect(checkLiquidityAgainstChain(less, state(), 40n, 0)).rejects.toThrow(LedgerIntegrityError);
    const moved = fakeClient({ '7': chainPosition({ owner: BOB }) });
    moved.tick = 5;
    await expect(checkLiquidityAgainstChain(moved, state(), 40n, 0)).rejects.toThrow(LedgerIntegrityError);
    const burned = fakeClient({});
    burned.tick = 5;
    await expect(checkLiquidityAgainstChain(burned, state(), 40n, 0)).rejects.toThrow(/no such position/);
  });

  it('leaves a position tracked with less liquidity than the chain holds alone', async () => {
    const client = fakeClient({ '7': chainPosition({ liquidity: LIQUIDITY + 1n }) });
    client.tick = 5;
    expect((await checkLiquidityAgainstChain(client, state(), 40n, 0)).outcome).toBe('passed');
  });

  it('audits the positions in rotation', async () => {
    const count = LIQUIDITY_AUDIT_POSITIONS_PER_RUN + 5;
    const ids = Array.from({ length: count }, (_, index) => String(index + 1));
    const client = fakeClient(Object.fromEntries(ids.map((id) => [id, chainPosition()])));
    client.tick = 5;
    const all = state(ids.map((id) => [id, tracked()]));
    const first = await checkLiquidityAgainstChain(client, all, 40n, 0);
    expect(first).toEqual({ outcome: 'passed', nextOffset: LIQUIDITY_AUDIT_POSITIONS_PER_RUN });
    const second = await checkLiquidityAgainstChain(client, all, 41n, LIQUIDITY_AUDIT_POSITIONS_PER_RUN);
    expect(second).toEqual({ outcome: 'passed', nextOffset: LIQUIDITY_AUDIT_POSITIONS_PER_RUN - 5 });
    expect(client.reads[1].tokenIds.slice(0, 6)).toEqual([21n, 22n, 23n, 24n, 25n, 1n]);
  });

  it('answers unknown, without failing, when the endpoint cannot be asked', async () => {
    const client = fakeClient({ '7': chainPosition() });
    client.fail = true;
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await checkLiquidityAgainstChain(client, state(), 40n, 0)).toEqual({ outcome: 'unknown' });
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
