import { newAccount, settle } from './account';
import type { LedgerAccount } from './account';
import { anchor, GENESIS_POOL } from './poolMirror';
import type { PoolState } from './poolMirror';
import { RAW_PER_UNIT_DAY } from './units';

const START = 1_800_000_000;
const DAY = 86_400;
const ONE = 10n ** 18n;

const pool: PoolState = { ...GENESIS_POOL, total: 500n * ONE };
const account = (overrides: Partial<LedgerAccount> = {}): LedgerAccount => ({
  ...newAccount(START),
  debt: 1_000n * ONE,
  ...anchor(pool, 200n * ONE),
  liquidity: 2_000n * ONE,
  ...overrides,
});

describe('settle', () => {
  it('returns the same record when the time is not after its own', () => {
    const record = account({ ts: START + 100 });
    expect(settle(record, START + 100, pool, START)).toBe(record);
    expect(settle(record, START + 50, pool, START)).toBe(record);
  });

  it('adds each balance times the seconds it was held, one figure per dimension', () => {
    const settled = settle(account(), START + 3_600, pool, START);
    expect(settled.debtRaw).toBe(1_000n * ONE * 3_600n);
    expect(settled.poolRaw).toBe(200n * ONE * 3_600n);
    expect(settled.liquidityRaw).toBe(2_000n * ONE * 3_600n);
    expect(settled.ts).toBe(START + 3_600);
  });

  it('records one unit-day for one unit held for one day', () => {
    const settled = settle(account({ debt: ONE, liquidity: ONE }), START + DAY, pool, START);
    expect(settled.debtRaw).toBe(RAW_PER_UNIT_DAY);
    expect(settled.liquidityRaw).toBe(RAW_PER_UNIT_DAY);
    expect(settled.poolRaw).toBe(200n * RAW_PER_UNIT_DAY);
  });

  it('weights no dimension against another and no period against another', () => {
    // The same balance over the same length of time gives the same figure in every dimension, early or late.
    const even = account({ debt: 7n * ONE, ...anchor(pool, 7n * ONE), liquidity: 7n * ONE });
    const early = settle(even, START + 1_000, pool, START);
    expect(new Set([early.debtRaw, early.poolRaw, early.liquidityRaw]).size).toBe(1);
    const late = settle({ ...even, ts: START + 500 * DAY }, START + 500 * DAY + 1_000, pool, START);
    expect(late.debtRaw).toBe(early.debtRaw);
    expect(late.poolRaw).toBe(early.poolRaw);
    expect(late.liquidityRaw).toBe(early.liquidityRaw);
  });

  it('settles in steps to the same figures as in one go', () => {
    const once = settle(account(), START + 10_000, pool, START);
    const stepped = [1, 77, 5_000, 9_999, 10_000].reduce((record, at) => settle(record, START + at, pool, START), account());
    expect(stepped).toEqual(once);
  });

  it('records nothing before the ledger starts, and from the start on for a period that spans it', () => {
    const before = settle(account({ ts: START - 5_000 }), START, pool, START);
    expect([before.debtRaw, before.poolRaw, before.liquidityRaw]).toEqual([0n, 0n, 0n]);
    expect(before.ts).toBe(START);
    const spanning = settle(account({ ts: START - 5_000 }), START + 30, pool, START);
    expect(spanning.debtRaw).toBe(1_000n * ONE * 30n);
  });

  it('uses the compounded pool balance, not the stored one', () => {
    const halved: PoolState = { ...pool, P: GENESIS_POOL.P / 2n };
    const settled = settle(account({ debt: 0n, liquidity: 0n }), START + 10, halved, START);
    expect(settled.poolRaw).toBe(100n * ONE * 10n);
  });

  it('adds nothing for a dimension with no balance and keeps what was recorded', () => {
    const record = account({ debt: 0n, liquidity: 0n, debtRaw: 7n, liquidityRaw: 9n });
    const settled = settle(record, START + DAY, pool, START);
    expect(settled.debtRaw).toBe(7n);
    expect(settled.liquidityRaw).toBe(9n);
  });

  it('does not change the record it is given', () => {
    const record = account();
    const copy = { ...record };
    settle(record, START + 99, pool, START);
    expect(record).toEqual(copy);
  });

  it('has no field for a combined figure', () => {
    expect(Object.keys(newAccount(0)).sort()).toEqual(
      ['debt', 'debtRaw', 'liquidity', 'liquidityRaw', 'poolRaw', 'snapEpoch', 'snapP', 'snapScale', 'stored', 'ts'].sort()
    );
  });
});
