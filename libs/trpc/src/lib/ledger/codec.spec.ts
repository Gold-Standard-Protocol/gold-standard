import { newAccount } from './account';
import type { LedgerAccount } from './account';
import { decodeAccount, decodeMeta, decodePosition, encodeAccount, encodeMeta, encodePosition } from './codec';
import type { LedgerMeta } from './codec';

const ADDRESS = '0x00000000000000000000000000000000000000aa';
const HUGE = 2n ** 200n + 12_345n;

const account: LedgerAccount = {
  debt: HUGE,
  stored: 5n,
  snapP: 10n ** 18n,
  snapScale: 2n,
  snapEpoch: 1n,
  liquidity: 0n,
  debtRaw: HUGE * 3n,
  poolRaw: 0n,
  liquidityRaw: 0n,
  ts: 1_800_000_000,
};

const meta: LedgerMeta = {
  v: 1,
  fingerprint: 'a'.repeat(64),
  stateId: '0123456789abcdef',
  cursor: '12345',
  asOfTimestamp: 1_800_000_000,
  pool: { P: '1000000000000000000', scale: '0', epoch: '0', total: '42' },
  accounts: 3,
  truncated: false,
  syncedAt: '1800000000000',
  rebuilds: [1_800_000_000_000],
};

describe('ledger codec round trips', () => {
  it('account', () => {
    expect(decodeAccount(encodeAccount(account))).toEqual(account);
    expect(decodeAccount(encodeAccount(newAccount(0)))).toEqual(newAccount(0));
  });

  it('account with liquidity, and no liquidity keys for an account without it', () => {
    const provider: LedgerAccount = { ...account, liquidity: HUGE + 1n, liquidityRaw: HUGE * 5n };
    expect(decodeAccount(encodeAccount(provider))).toEqual(provider);
    expect(Object.keys(JSON.parse(encodeAccount(account)) as object)).toEqual(['d', 's', 'sp', 'ss', 'se', 'b', 'p', 't']);
    expect(decodeAccount('{"d":"1","s":"0","sp":"0","ss":"0","se":"0","b":"2","p":"3","t":5}')).toEqual({
      ...newAccount(5),
      debt: 1n,
      debtRaw: 2n,
      poolRaw: 3n,
    });
  });

  it('stores three figures and no combined one', () => {
    const stored = JSON.parse(encodeAccount({ ...account, liquidity: 1n, liquidityRaw: 2n })) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['b', 'd', 'l', 'lr', 'p', 's', 'se', 'sp', 'ss', 't']);
  });

  it('liquidity position, with negative ticks', () => {
    const position = { owner: ADDRESS, liquidity: HUGE, tickLower: -276_330, tickUpper: -276_320, value: 2n * HUGE };
    expect(decodePosition(encodePosition(position))).toEqual(position);
    expect(decodePosition(encodePosition({ ...position, tickLower: -887_273 }))).toBeUndefined();
    expect(decodePosition(encodePosition({ ...position, owner: ADDRESS.toUpperCase() }))).toBeUndefined();
    expect(decodePosition('{"o":"0x00000000000000000000000000000000000000aa","l":"1","a":1.5,"b":2,"v":"1"}')).toBeUndefined();
    expect(decodePosition(null)).toBeUndefined();
  });

  it('meta, including a null cursor and the syncing stamp', () => {
    expect(decodeMeta(encodeMeta(meta))).toEqual(meta);
    const syncing: LedgerMeta = { ...meta, cursor: null, syncedAt: 'syncing', rebuilds: [] };
    expect(decodeMeta(encodeMeta(syncing))).toEqual(syncing);
  });

  it('meta with the liquidity record, before and after the pool is initialized', () => {
    const fresh: LedgerMeta = { ...meta, lp: { tick: null, positions: 0 } };
    expect(decodeMeta(encodeMeta(fresh))).toEqual(fresh);
    const running: LedgerMeta = { ...meta, lp: { tick: -276_325, positions: 12 } };
    expect(decodeMeta(encodeMeta(running))).toEqual(running);
    expect(decodeMeta(JSON.stringify({ ...meta, lp: { tick: 900_000, positions: 1 } }))).toBeUndefined();
  });
});

describe('ledger codec refusals', () => {
  it.each<[string, string | null | undefined]>([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['text that is not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['a record with a missing field', '{"d":"1"}'],
    ['a negative amount', '{"d":"-1","s":"0","sp":"0","ss":"0","se":"0","b":"0","p":"0","t":5}'],
    ['a number where a decimal string belongs', '{"d":1,"s":"0","sp":"0","ss":"0","se":"0","b":"0","p":"0","t":5}'],
    ['an unknown field', '{"d":"1","s":"0","sp":"0","ss":"0","se":"0","b":"0","p":"0","t":5,"x":1}'],
    ['a fractional time', '{"d":"1","s":"0","sp":"0","ss":"0","se":"0","b":"0","p":"0","t":5.5}'],
    ['an amount of absurd length', `{"d":"${'9'.repeat(121)}","s":"0","sp":"0","ss":"0","se":"0","b":"0","p":"0","t":5}`],
  ])('answers undefined for an account that is %s', (_name, raw) => {
    expect(decodeAccount(raw)).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>]>([
    ['another version', { v: 2 }],
    ['a fingerprint that is not 64 hex', { fingerprint: 'abc' }],
    ['a state id that is not 16 hex', { stateId: 'xyz' }],
    ['a cursor that is not a decimal', { cursor: '0x10' }],
    ['a stamp that is neither a time nor syncing', { syncedAt: 'yesterday' }],
    ['a pool with a missing field', { pool: { P: '1', scale: '0', epoch: '0' } }],
    ['too many rebuild times', { rebuilds: Array.from({ length: 65 }, () => 1) }],
    ['an unknown field', { final: true }],
  ])('answers undefined for a meta with %s', (_name, overrides) => {
    expect(decodeMeta(JSON.stringify({ ...meta, ...overrides }))).toBeUndefined();
  });
});
