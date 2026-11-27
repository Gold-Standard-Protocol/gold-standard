import { LedgerIntegrityError } from './errors';
import { decodeLedgerLogs, LEDGER_EVENTS } from './events';
import type { RawLedgerLog } from './events';

const VAULT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const POOL = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const sources = { vault: VAULT, pool: POOL } as const;

const log = (overrides: Partial<RawLedgerLog>): RawLedgerLog => ({
  address: VAULT,
  eventName: 'DebtMinted',
  args: { user: USER, amount: 5n },
  blockNumber: 10n,
  logIndex: 0,
  removed: false,
  ...overrides,
});

describe('decodeLedgerLogs', () => {
  it('consumes nine events', () => {
    expect(LEDGER_EVENTS.map((event) => event.name)).toEqual([
      'DebtMinted',
      'DebtRepaid',
      'Liquidated',
      'LiquidatedViaPool',
      'BadDebt',
      'Deposited',
      'Withdrawn',
      'LiquidationAbsorbed',
      'CollateralClaimed',
    ]);
  });

  it('decodes each vault event', () => {
    const events = decodeLedgerLogs(
      [
        log({ logIndex: 0 }),
        log({ eventName: 'DebtRepaid', args: { user: USER, amount: 2n }, logIndex: 1 }),
        log({ eventName: 'Liquidated', args: { vaultOwner: USER, liquidator: OTHER, debtRepaid: 3n, collateralSeized: 9n }, logIndex: 2 }),
        log({ eventName: 'LiquidatedViaPool', args: { vaultOwner: USER, liquidator: OTHER, debtRepaid: 4n, collateralSeized: 9n }, logIndex: 3 }),
        log({ eventName: 'BadDebt', args: { vaultOwner: USER, amount: 1n }, logIndex: 4 }),
      ],
      sources
    );
    const account = USER.toLowerCase();
    expect(events).toEqual([
      { kind: 'mint', account, amount: 5n, block: 10n, logIndex: 0 },
      { kind: 'repay', account, amount: 2n, block: 10n, logIndex: 1 },
      { kind: 'liquidated', account, amount: 3n, block: 10n, logIndex: 2 },
      { kind: 'liquidated', account, amount: 4n, block: 10n, logIndex: 3 },
      { kind: 'badDebt', account, block: 10n, logIndex: 4 },
    ]);
  });

  it('decodes each pool event', () => {
    const events = decodeLedgerLogs(
      [
        log({ address: POOL, eventName: 'Deposited', args: { user: USER, amount: 7n }, logIndex: 0 }),
        log({ address: POOL, eventName: 'Withdrawn', args: { user: USER, amount: 0n }, logIndex: 1 }),
        log({ address: POOL, eventName: 'LiquidationAbsorbed', args: { token: OTHER, debtAbsorbed: 6n, collateralGained: 1n }, logIndex: 2 }),
        log({ address: POOL, eventName: 'CollateralClaimed', args: { user: USER, token: OTHER, amount: 1n }, logIndex: 3 }),
      ],
      sources
    );
    const account = USER.toLowerCase();
    expect(events).toEqual([
      { kind: 'deposit', account, amount: 7n, block: 10n, logIndex: 0 },
      { kind: 'withdraw', account, amount: 0n, block: 10n, logIndex: 1 },
      { kind: 'absorb', debt: 6n, block: 10n, logIndex: 2 },
      { kind: 'claim', account, block: 10n, logIndex: 3 },
    ]);
  });

  it('sorts by block, then by log index', () => {
    const events = decodeLedgerLogs(
      [
        log({ blockNumber: 12n, logIndex: 1 }),
        log({ blockNumber: 11n, logIndex: 30 }),
        log({ blockNumber: 12n, logIndex: 0 }),
        log({ blockNumber: 9n, logIndex: 99 }),
      ],
      sources
    );
    expect(events.map((event) => [event.block, event.logIndex])).toEqual([
      [9n, 99],
      [11n, 30],
      [12n, 0],
      [12n, 1],
    ]);
  });

  it('accepts emitter addresses in any case', () => {
    expect(decodeLedgerLogs([log({ address: VAULT.toLowerCase() })], sources)).toHaveLength(1);
  });

  it.each<[string, Partial<RawLedgerLog>]>([
    ['a removed log', { removed: true }],
    ['a missing block number', { blockNumber: null }],
    ['a missing log index', { logIndex: null }],
    ['an unknown event', { eventName: 'Transfer' }],
    ['a prototype name as the event', { eventName: 'constructor' }],
    ['no event name', { eventName: undefined }],
    ['a vault event emitted by the pool', { address: POOL }],
    ['a vault event emitted by a stranger', { address: OTHER }],
    ['a pool event emitted by the vault', { eventName: 'Deposited' }],
    ['a missing address argument', { args: { amount: 5n } }],
    ['an invalid address argument', { args: { user: '0x1234', amount: 5n } }],
    ['a missing amount', { args: { user: USER } }],
    ['an amount that is not a bigint', { args: { user: USER, amount: 5 } }],
    ['a negative amount', { args: { user: USER, amount: -1n } }],
    ['no arguments at all', { args: undefined }],
  ])('treats %s as an integrity failure, never skipping it', (_name, overrides) => {
    expect(() => decodeLedgerLogs([log({}), log(overrides)], sources)).toThrow(LedgerIntegrityError);
  });
});
