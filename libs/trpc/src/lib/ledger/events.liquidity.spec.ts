import { LedgerIntegrityError } from './errors';
import { decodeLedgerLogs, isLiquidityEvent, LIQUIDITY_POOL_EVENTS, POSITION_LIQUIDITY_EVENTS, POSITION_TRANSFER_EVENT } from './events';
import type { RawLedgerLog } from './events';

const VAULT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const POOL = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const LIQUIDITY_POOL = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const MANAGER = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const ZERO = '0x0000000000000000000000000000000000000000';
const off = { vault: VAULT, pool: POOL } as const;
const on = { ...off, liquidity: { pool: LIQUIDITY_POOL, positionManager: MANAGER } } as const;

const swapArgs = { sender: USER, recipient: OTHER, amount0: -5n, amount1: 6n, sqrtPriceX96: 2n ** 96n, liquidity: 9n, tick: -276_325 };
const log = (overrides: Partial<RawLedgerLog>): RawLedgerLog => ({
  address: LIQUIDITY_POOL,
  eventName: 'Swap',
  args: swapArgs,
  blockNumber: 10n,
  logIndex: 0,
  removed: false,
  ...overrides,
});

describe('decodeLedgerLogs with the liquidity dimension', () => {
  it('consumes four pool events, and three position manager events that are never asked for by block range', () => {
    expect(LIQUIDITY_POOL_EVENTS.map((event) => event.name)).toEqual(['Initialize', 'Swap', 'Mint', 'Burn']);
    expect(POSITION_LIQUIDITY_EVENTS.map((event) => event.name)).toEqual(['IncreaseLiquidity', 'DecreaseLiquidity']);
    expect(POSITION_TRANSFER_EVENT.name).toBe('Transfer');
    // The token id is a topic of all three, so a filter can name it.
    for (const event of [...POSITION_LIQUIDITY_EVENTS, POSITION_TRANSFER_EVENT]) {
      expect(event.inputs.find((input) => input.name === 'tokenId')?.indexed).toBe(true);
    }
  });

  it('takes the tick from Initialize and from Swap', () => {
    const events = decodeLedgerLogs(
      [log({ eventName: 'Initialize', args: { sqrtPriceX96: 2n ** 96n, tick: 0 }, logIndex: 0 }), log({ logIndex: 1 })],
      on
    );
    expect(events).toEqual([
      { kind: 'poolTick', tick: 0, block: 10n, logIndex: 0 },
      { kind: 'poolTick', tick: -276_325, block: 10n, logIndex: 1 },
    ]);
    expect(events.every(isLiquidityEvent)).toBe(true);
  });

  it('notes for whom the pool added or removed liquidity, and in which transaction', () => {
    const args = { sender: MANAGER, owner: MANAGER, tickLower: -10, tickUpper: 10, amount: 5n, amount0: 1n, amount1: 2n };
    const transactionHash = `0x${'AB'.repeat(32)}`;
    const events = decodeLedgerLogs(
      [log({ eventName: 'Mint', args, transactionHash }), log({ eventName: 'Burn', args, transactionHash, logIndex: 1 })],
      on
    );
    const lowercase = transactionHash.toLowerCase();
    expect(events).toEqual([
      { kind: 'poolLiquidity', owner: MANAGER.toLowerCase(), added: true, transactionHash: lowercase, block: 10n, logIndex: 0 },
      { kind: 'poolLiquidity', owner: MANAGER.toLowerCase(), added: false, transactionHash: lowercase, block: 10n, logIndex: 1 },
    ]);
  });

  it('reduces every position manager log to its token id and whether liquidity was added', () => {
    const amounts = { liquidity: 5n, amount0: 1n, amount1: 2n };
    const events = decodeLedgerLogs(
      [
        log({ address: MANAGER, eventName: 'Transfer', args: { from: ZERO, to: USER, tokenId: 7n }, logIndex: 0 }),
        log({ address: MANAGER, eventName: 'IncreaseLiquidity', args: { tokenId: 7n, ...amounts }, logIndex: 1 }),
        log({ address: MANAGER, eventName: 'DecreaseLiquidity', args: { tokenId: 7n, ...amounts }, logIndex: 2 }),
      ],
      on
    );
    expect(events).toEqual([
      { kind: 'positionChange', tokenId: 7n, increase: false, block: 10n, logIndex: 0 },
      { kind: 'positionChange', tokenId: 7n, increase: true, block: 10n, logIndex: 1 },
      { kind: 'positionChange', tokenId: 7n, increase: false, block: 10n, logIndex: 2 },
    ]);
  });

  it('sorts liquidity events among the others by block and log index', () => {
    const events = decodeLedgerLogs(
      [
        log({ blockNumber: 12n, logIndex: 4 }),
        { address: VAULT, eventName: 'DebtMinted', args: { user: USER, amount: 5n }, blockNumber: 12n, logIndex: 2, removed: false },
        log({ blockNumber: 11n, logIndex: 9 }),
      ],
      on
    );
    expect(events.map((event) => [event.kind, event.block, event.logIndex])).toEqual([
      ['poolTick', 11n, 9],
      ['mint', 12n, 2],
      ['poolTick', 12n, 4],
    ]);
  });

  it.each<[string, Partial<RawLedgerLog>]>([
    ['a swap emitted by another pool', { address: OTHER }],
    ['a swap emitted by the position manager', { address: MANAGER }],
    ['a transfer emitted by the liquidity pool', { eventName: 'Transfer', args: { from: ZERO, to: USER, tokenId: 7n } }],
    ['a transfer emitted by a token', { address: OTHER, eventName: 'Transfer', args: { from: ZERO, to: USER, tokenId: 7n } }],
    ['a tick that is not a number', { args: { ...swapArgs, tick: -276_325n } }],
    ['a tick outside the range', { args: { ...swapArgs, tick: 887_273 } }],
    ['a fractional tick', { args: { ...swapArgs, tick: 1.5 } }],
    ['a missing tick', { args: { sender: USER } }],
    ['a removed log', { removed: true }],
    ['a token id that is not a bigint', { address: MANAGER, eventName: 'IncreaseLiquidity', args: { tokenId: 7 } }],
    ['a missing token id', { address: MANAGER, eventName: 'DecreaseLiquidity', args: {} }],
    ['a pool log with no owner', { eventName: 'Mint', args: { sender: MANAGER }, transactionHash: `0x${'ab'.repeat(32)}` }],
    ['a pool liquidity log with no transaction hash', { eventName: 'Mint', args: { owner: MANAGER } }],
    ['a pool liquidity log with a malformed transaction hash', { eventName: 'Burn', args: { owner: MANAGER }, transactionHash: '0x1234' }],
  ])('treats %s as an integrity failure, never skipping it', (_name, overrides) => {
    expect(() => decodeLedgerLogs([log({}), log(overrides)], on)).toThrow(LedgerIntegrityError);
  });

  it('refuses every liquidity log while the source is off', () => {
    expect(() => decodeLedgerLogs([log({})], off)).toThrow(/not by the configured liquidity pool/);
    expect(() =>
      decodeLedgerLogs([log({ address: MANAGER, eventName: 'Transfer', args: { from: ZERO, to: USER, tokenId: 7n } })], off)
    ).toThrow(/not by the configured position manager/);
  });
});
