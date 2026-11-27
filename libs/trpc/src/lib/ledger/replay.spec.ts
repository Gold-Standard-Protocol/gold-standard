import { settle } from './account';
import type { LedgerAccount } from './account';
import { LedgerIntegrityError } from './errors';
import type { LedgerEvent } from './events';
import { compounded, GENESIS_POOL } from './poolMirror';
import { applyEvents } from './replay';
import type { ReplayLimits, ReplayState } from './replay';

const START = 1_800_000_000;
const DAY = 86_400;
const ONE = 10n ** 18n;
const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b2';
const CAROL = '0x00000000000000000000000000000000000000c3';
const limits: ReplayLimits = { start: START, maxAccounts: 50_000, minTrackedDeposit: ONE };
const genesis: ReplayState = { pool: GENESIS_POOL, accounts: new Map(), truncated: false };
/** Recorded seconds up to `t`: every second after the start counts once. */
const M = (t: number): bigint => BigInt(Math.max(0, t - START));

/** Block n is at START + n * 1,000 seconds unless a spec says otherwise. */
const blockTime = (block: bigint): number => START + Number(block) * 1_000;
const timestampsFor = (events: readonly LedgerEvent[], extra: ReadonlyMap<bigint, number> = new Map()): Map<bigint, number> =>
  new Map([...events.map((event) => [event.block, blockTime(event.block)] as const), ...extra]);

let nextIndex = 0;
const at = (block: number): { block: bigint; logIndex: number } => ({ block: BigInt(block), logIndex: nextIndex++ });
const mint = (account: string, amount: bigint, block: number): LedgerEvent => ({ kind: 'mint', account: account as `0x${string}`, amount, ...at(block) });
const repay = (account: string, amount: bigint, block: number): LedgerEvent => ({ kind: 'repay', account: account as `0x${string}`, amount, ...at(block) });
const liquidated = (account: string, amount: bigint, block: number): LedgerEvent => ({ kind: 'liquidated', account: account as `0x${string}`, amount, ...at(block) });
const badDebt = (account: string, block: number): LedgerEvent => ({ kind: 'badDebt', account: account as `0x${string}`, ...at(block) });
const deposit = (account: string, amount: bigint, block: number): LedgerEvent => ({ kind: 'deposit', account: account as `0x${string}`, amount, ...at(block) });
const withdraw = (account: string, amount: bigint, block: number): LedgerEvent => ({ kind: 'withdraw', account: account as `0x${string}`, amount, ...at(block) });
const claim = (account: string, block: number): LedgerEvent => ({ kind: 'claim', account: account as `0x${string}`, ...at(block) });
const absorb = (debt: bigint, block: number): LedgerEvent => ({ kind: 'absorb', debt, ...at(block) });

const replay = (events: readonly LedgerEvent[], state: ReplayState = genesis) =>
  applyEvents(state, events, timestampsFor(events), limits);

const must = (state: ReplayState, address: string): LedgerAccount => {
  const account = state.accounts.get(address);
  if (account === undefined) throw new Error(`no account for ${address}`);
  return account;
};

describe('applyEvents: vault debt', () => {
  it('adds the full minted amount and records from the mint', () => {
    const { state, dirty } = replay([mint(ALICE, 1_000n * ONE, 1), mint(ALICE, 500n * ONE, 2)]);
    const alice = must(state, ALICE);
    expect(alice.debt).toBe(1_500n * ONE);
    expect(alice.debtRaw).toBe(1_000n * ONE * (M(blockTime(2n)) - M(blockTime(1n))));
    expect(alice.ts).toBe(blockTime(2n));
    expect([...dirty]).toEqual([ALICE]);
  });

  it('counts every second the same, however long after the start it falls', () => {
    const events = [mint(ALICE, 1_000n * ONE, 1), repay(ALICE, 1_000n * ONE, 2)];
    const timestamps = new Map([
      [1n, START + 13 * DAY],
      [2n, START + 15 * DAY],
    ]);
    const { state } = applyEvents(genesis, events, timestamps, limits);
    // Two days are two days: 2,000 GSUSD-days, with no period weighted above another.
    expect(must(state, ALICE).debtRaw).toBe(1_000n * ONE * BigInt(2 * DAY));
    const late = new Map([
      [1n, START + 400 * DAY],
      [2n, START + 402 * DAY],
    ]);
    expect(must(applyEvents(genesis, events, late, limits).state, ALICE).debtRaw).toBe(1_000n * ONE * BigInt(2 * DAY));
    expect(must(state, ALICE).debt).toBe(0n);
  });

  it('subtracts a repayment and clamps at zero, since the amount includes the fee', () => {
    const { state } = replay([mint(ALICE, 1_000n * ONE, 1), repay(ALICE, 400n * ONE, 2), repay(ALICE, 700n * ONE, 3)]);
    expect(must(state, ALICE).debt).toBe(0n);
  });

  it('never raises the debt on a repayment', () => {
    const { state } = replay([mint(ALICE, 1_000n * ONE, 1), repay(ALICE, 0n, 2), repay(ALICE, 1n, 3)]);
    expect(must(state, ALICE).debt).toBe(1_000n * ONE - 1n);
  });

  it('reduces the debt on a liquidation, direct or through the pool, clamped at zero', () => {
    const { state } = replay([mint(ALICE, 1_000n * ONE, 1), liquidated(ALICE, 300n * ONE, 2), liquidated(ALICE, 900n * ONE, 3)]);
    expect(must(state, ALICE).debt).toBe(0n);
  });

  it('stops recording once a vault is liquidated in full', () => {
    const events = [mint(ALICE, 1_000n * ONE, 1), liquidated(ALICE, 1_020n * ONE, 2), mint(BOB, 1n, 9)];
    const { state } = replay(events);
    const settled = settle(must(state, ALICE), blockTime(9n), state.pool, START);
    expect(settled.debtRaw).toBe(1_000n * ONE * (M(blockTime(2n)) - M(blockTime(1n))));
  });

  it('zeroes the debt on bad debt, emitted before the liquidation event of the same transaction', () => {
    const { state } = replay([mint(ALICE, 1_000n * ONE, 1), badDebt(ALICE, 2), liquidated(ALICE, 250n * ONE, 2)]);
    expect(must(state, ALICE).debt).toBe(0n);
  });

  it('creates no account for a repayment, a liquidation or bad debt of an untracked address', () => {
    const { state, dirty } = replay([repay(ALICE, 5n, 1), liquidated(BOB, 5n, 1), badDebt(CAROL, 1)]);
    expect(state.accounts.size).toBe(0);
    expect(dirty.size).toBe(0);
  });
});

describe('applyEvents: principal read from the vault', () => {
  const withPrincipal = (event: LedgerEvent, principal: bigint): LedgerEvent => ({ ...event, principal }) as LedgerEvent;

  it('tracks the principal the vault holds, not the fee-inclusive event amount', () => {
    // Principal 1,000 with 50 of accrued fee: repaying 525 retires 500 of principal.
    const events = [
      withPrincipal(mint(ALICE, 1_000n * ONE, 1), 1_000n * ONE),
      withPrincipal(repay(ALICE, 525n * ONE, 2), 500n * ONE),
    ];
    expect(must(replay(events).state, ALICE).debt).toBe(500n * ONE);
  });

  it('does the same for a partial liquidation and for bad debt', () => {
    const events = [
      withPrincipal(mint(ALICE, 1_000n * ONE, 1), 1_000n * ONE),
      withPrincipal(liquidated(ALICE, 210n * ONE, 2), 800n * ONE),
      withPrincipal(badDebt(ALICE, 3), 0n),
    ];
    const afterLiquidation = replay(events.slice(0, 2)).state;
    expect(must(afterLiquidation, ALICE).debt).toBe(800n * ONE);
    expect(must(replay(events).state, ALICE).debt).toBe(0n);
  });

  it('records at the principal from the event onward', () => {
    const events = [
      withPrincipal(mint(ALICE, 1_000n * ONE, 1), 1_000n * ONE),
      withPrincipal(repay(ALICE, 525n * ONE, 2), 500n * ONE),
      withPrincipal(mint(ALICE, 0n, 3), 500n * ONE),
    ];
    const account = must(replay(events).state, ALICE);
    expect(account.debtRaw).toBe(1_000n * ONE * (M(blockTime(2n)) - M(blockTime(1n))) + 500n * ONE * (M(blockTime(3n)) - M(blockTime(2n))));
  });
});

describe('applyEvents: stability pool', () => {
  it('tracks a deposit at or above the minimum and records it by the second', () => {
    const { state } = replay([deposit(ALICE, 100n * ONE, 1), withdraw(ALICE, 40n * ONE, 2)]);
    const alice = must(state, ALICE);
    expect(compounded(alice, state.pool)).toBe(60n * ONE);
    expect(alice.poolRaw).toBe(100n * ONE * (M(blockTime(2n)) - M(blockTime(1n))));
    expect(state.pool.total).toBe(60n * ONE);
  });

  it('leaves a dust depositor untracked but still moves the pool total', () => {
    const { state } = replay([deposit(ALICE, ONE - 1n, 1), claim(ALICE, 2), withdraw(ALICE, ONE - 1n, 3)]);
    expect(state.accounts.size).toBe(0);
    expect(state.pool.total).toBe(0n);
  });

  it('clamps the withdrawal of a depositor whose first dust deposit was not tracked', () => {
    const { state } = replay([deposit(ALICE, ONE / 2n, 1), deposit(ALICE, 5n * ONE, 2), withdraw(ALICE, 5n * ONE + ONE / 2n, 3)]);
    expect(compounded(must(state, ALICE), state.pool)).toBe(0n);
    expect(state.pool.total).toBe(0n);
  });

  it('applies a dust deposit to an account that already exists', () => {
    const { state } = replay([mint(ALICE, ONE, 1), deposit(ALICE, 7n, 2)]);
    expect(compounded(must(state, ALICE), state.pool)).toBe(7n);
  });

  it('settles every depositor at its balance before an absorption, then scales them', () => {
    const events = [deposit(ALICE, 600n * ONE, 1), deposit(BOB, 400n * ONE, 1), mint(CAROL, ONE, 1), absorb(500n * ONE, 3)];
    const { state, dirty } = replay(events);
    const alice = must(state, ALICE);
    const bob = must(state, BOB);
    expect(alice.ts).toBe(blockTime(3n));
    expect(alice.poolRaw).toBe(600n * ONE * (M(blockTime(3n)) - M(blockTime(1n))));
    expect(bob.poolRaw).toBe(400n * ONE * (M(blockTime(3n)) - M(blockTime(1n))));
    expect(compounded(alice, state.pool)).toBe(300n * ONE);
    expect(compounded(bob, state.pool)).toBe(200n * ONE);
    expect(state.pool.total).toBe(500n * ONE);
    // The borrower holds nothing in the pool and is not touched by the absorption.
    expect(must(state, CAROL).ts).toBe(blockTime(1n));
    expect(dirty).toEqual(new Set([ALICE, BOB, CAROL]));
  });

  it('records at the reduced balance after an absorption', () => {
    const events = [deposit(ALICE, 1_000n * ONE, 1), absorb(250n * ONE, 2), withdraw(ALICE, 1n, 4)];
    const { state } = replay(events);
    const before = 1_000n * ONE * (M(blockTime(2n)) - M(blockTime(1n)));
    const after = 750n * ONE * (M(blockTime(4n)) - M(blockTime(2n)));
    expect(must(state, ALICE).poolRaw).toBe(before + after);
  });

  it('wipes every earlier depositor on an epoch reset and keeps the dust in the total', () => {
    const total = 1_000n * ONE;
    const debt = total - 5n;
    const { state } = replay([deposit(ALICE, total, 1), absorb(debt, 2), deposit(BOB, 10n * ONE, 3), claim(ALICE, 4)]);
    expect(state.pool.epoch).toBe(1n);
    expect(state.pool.P).toBe(GENESIS_POOL.P);
    expect(state.pool.scale).toBe(0n);
    expect(state.pool.total).toBe(5n + 10n * ONE);
    expect(compounded(must(state, ALICE), state.pool)).toBe(0n);
    expect(must(state, ALICE).stored).toBe(0n);
    expect(compounded(must(state, BOB), state.pool)).toBe(10n * ONE);
    // Nothing more is recorded for the wiped depositor after the reset.
    const settled = settle(must(state, ALICE), blockTime(50n), state.pool, START);
    expect(settled.poolRaw).toBe(total * (M(blockTime(2n)) - M(blockTime(1n))));
  });

  it('re-anchors on a claim without changing the balance', () => {
    const { state } = replay([deposit(ALICE, 900n * ONE, 1), deposit(BOB, 100n * ONE, 1), absorb(100n * ONE, 2), claim(ALICE, 3)]);
    const alice = must(state, ALICE);
    expect(alice.stored).toBe(810n * ONE);
    expect(alice.snapP).toBe(state.pool.P);
  });

  it('fails on an absorption the pool could not have made, leaving the caller state untouched', () => {
    const start = replay([deposit(ALICE, 10n * ONE, 1)]).state;
    expect(() => replay([absorb(10n * ONE, 2)], start)).toThrow(LedgerIntegrityError);
    expect(() => replay([absorb(1n, 2)], genesis)).toThrow(LedgerIntegrityError);
    expect(must(start, ALICE).ts).toBe(blockTime(1n));
    expect(start.pool.total).toBe(10n * ONE);
  });

  it('fails on a withdrawal above the mirrored total', () => {
    expect(() => replay([withdraw(ALICE, 1n, 1)])).toThrow(LedgerIntegrityError);
  });
});

describe('applyEvents: limits and time', () => {
  it('opens no record past the cap and marks the ledger incomplete, for good', () => {
    const capped: ReplayLimits = { ...limits, maxAccounts: 2 };
    const events = [mint(ALICE, ONE, 1), deposit(BOB, ONE, 1), mint(CAROL, ONE, 2), deposit(CAROL, 5n * ONE, 2), mint(ALICE, ONE, 3)];
    const first = applyEvents(genesis, events, timestampsFor(events), capped);
    expect([...first.state.accounts.keys()]).toEqual([ALICE, BOB]);
    expect(first.state.truncated).toBe(true);
    expect(must(first.state, ALICE).debt).toBe(2n * ONE);
    // The refused depositor still moves the pool total, so the mirror stays exact.
    expect(first.state.pool.total).toBe(6n * ONE);
    const later = [mint(ALICE, ONE, 4)];
    expect(applyEvents(first.state, later, timestampsFor(later), capped).state.truncated).toBe(true);
  });

  it('never deletes a record: an emptied record keeps its slot and its figures at the cap', () => {
    const capped: ReplayLimits = { ...limits, maxAccounts: 2 };
    // One GSUSD passed from address to address fills both slots with emptied records.
    const events = [
      deposit(ALICE, ONE, 1),
      withdraw(ALICE, ONE, 2),
      deposit(BOB, ONE, 3),
      withdraw(BOB, ONE, 4),
      mint(CAROL, 5_000n * ONE, 5),
    ];
    const { state } = applyEvents(genesis, events, timestampsFor(events), capped);
    expect([...state.accounts.keys()].sort()).toEqual([ALICE, BOB]);
    // What Alice held for one block is still on her record, although she holds nothing now.
    expect(must(state, ALICE).poolRaw).toBe(ONE * (M(blockTime(2n)) - M(blockTime(1n))));
    expect(must(state, BOB).poolRaw).toBe(ONE * (M(blockTime(4n)) - M(blockTime(3n))));
    expect(state.accounts.has(CAROL)).toBe(false);
    expect(state.truncated).toBe(true);
  });

  it('keeps every existing record growing correctly at the cap', () => {
    const capped: ReplayLimits = { ...limits, maxAccounts: 2 };
    const events = [mint(ALICE, 1_000n * ONE, 1), deposit(BOB, 10n * ONE, 1), mint(CAROL, ONE, 2), repay(ALICE, 400n * ONE, 5), deposit(BOB, 5n * ONE, 6), withdraw(BOB, 1n, 9)];
    const { state } = applyEvents(genesis, events, timestampsFor(events), capped);
    expect(state.truncated).toBe(true);
    expect(must(state, ALICE).debtRaw).toBe(1_000n * ONE * (M(blockTime(5n)) - M(blockTime(1n))));
    expect(must(state, ALICE).debt).toBe(600n * ONE);
    expect(must(state, BOB).poolRaw).toBe(10n * ONE * (M(blockTime(6n)) - M(blockTime(1n))) + 15n * ONE * (M(blockTime(9n)) - M(blockTime(6n))));
  });

  it('reports no record as removed, whatever happens', () => {
    const capped: ReplayLimits = { ...limits, maxAccounts: 1 };
    const events = [deposit(ALICE, ONE, 1), withdraw(ALICE, ONE, 2), mint(BOB, ONE, 3), repay(BOB, ONE, 4), mint(ALICE, ONE, 5)];
    const result = applyEvents(genesis, events, timestampsFor(events), capped);
    expect(result).not.toHaveProperty('removed');
    expect([...result.state.accounts.keys()]).toEqual([ALICE]);
    expect(must(result.state, ALICE).debt).toBe(ONE);
  });

  it('refuses the same addresses however the events are split into windows', () => {
    const capped: ReplayLimits = { ...limits, maxAccounts: 2 };
    const events = [
      deposit(ALICE, 3n * ONE, 1),
      withdraw(ALICE, 3n * ONE, 2),
      deposit(BOB, ONE, 2),
      withdraw(BOB, ONE, 4),
      mint(CAROL, 10n * ONE, 5),
      deposit('0x00000000000000000000000000000000000000d4', 2n * ONE, 6),
    ];
    const timestamps = timestampsFor(events);
    const whole = applyEvents(genesis, events, timestamps, capped).state;
    expect([...whole.accounts.keys()].sort()).toEqual([ALICE, BOB]);
    for (let split = 0; split <= events.length; split += 1) {
      const first = applyEvents(genesis, events.slice(0, split), timestamps, capped).state;
      const second = applyEvents(first, events.slice(split), timestamps, capped).state;
      expect(new Map([...second.accounts].sort())).toEqual(new Map([...whole.accounts].sort()));
      expect(second.truncated).toBe(whole.truncated);
    }
  });

  it('opens no record for a first pool deposit under the minimum, and keeps counting whatever an existing record holds', () => {
    const { state } = replay([deposit(ALICE, ONE - 1n, 1), deposit(BOB, ONE, 1), withdraw(BOB, ONE - 5n, 2), deposit(BOB, 3n, 3), withdraw(BOB, 1n, 6)]);
    expect(state.accounts.has(ALICE)).toBe(false);
    // Bob keeps a record with five wei, then eight: dust on an open record is still recorded.
    expect(must(state, BOB).poolRaw).toBe(ONE * (M(blockTime(2n)) - M(blockTime(1n))) + 5n * (M(blockTime(3n)) - M(blockTime(2n))) + 8n * (M(blockTime(6n)) - M(blockTime(3n))));
  });

  it('replays events before the ledger start for balances and records nothing there', () => {
    const events = [mint(ALICE, 1_000n * ONE, 1), deposit(ALICE, 100n * ONE, 2), mint(ALICE, 1n, 3)];
    const timestamps = new Map([
      [1n, START - 9_000],
      [2n, START - 500],
      [3n, START + 10],
    ]);
    const { state } = applyEvents(genesis, events, timestamps, limits);
    const alice = must(state, ALICE);
    expect(alice.debt).toBe(1_000n * ONE + 1n);
    expect(alice.debtRaw).toBe(1_000n * ONE * 10n);
    expect(alice.poolRaw).toBe(100n * ONE * 10n);
  });

  it('fails when a block has no timestamp', () => {
    const events = [mint(ALICE, ONE, 1)];
    expect(() => applyEvents(genesis, events, new Map(), limits)).toThrow(LedgerIntegrityError);
  });

  it('does not mutate the state it is given', () => {
    const first = replay([mint(ALICE, ONE, 1), deposit(ALICE, 10n * ONE, 1)]).state;
    const snapshot = new Map(first.accounts);
    const frozenAccount = must(first, ALICE);
    replay([mint(ALICE, ONE, 2), absorb(ONE, 3), mint(BOB, ONE, 4)], first);
    expect(first.accounts).toEqual(snapshot);
    expect(first.accounts.get(ALICE)).toBe(frozenAccount);
    expect(first.pool.total).toBe(10n * ONE);
  });
});

describe('applyEvents: chunk independence', () => {
  const events: LedgerEvent[] = [
    mint(ALICE, 2_000n * ONE, 1),
    deposit(BOB, 900n * ONE + 7n, 1),
    deposit(CAROL, 300n * ONE, 2),
    mint(BOB, 1_500n * ONE, 3),
    absorb(450n * ONE + 3n, 4),
    repay(ALICE, 700n * ONE, 5),
    claim(BOB, 6),
    withdraw(CAROL, 50n * ONE, 7),
    absorb(300n * ONE, 8),
    deposit(ALICE, 2n * ONE, 9),
    liquidated(BOB, 800n * ONE, 10),
    badDebt(BOB, 11),
    liquidated(BOB, 100n * ONE, 11),
    withdraw(BOB, 100n * ONE, 12),
    mint(CAROL, 123n * ONE, 13),
  ];
  const end = blockTime(20n);
  const timestamps = new Map<bigint, number>(Array.from({ length: 21 }, (_, block) => [BigInt(block), blockTime(BigInt(block))]));

  /** Every account settled to the same end time, so runs can be compared field by field. */
  const finalView = (state: ReplayState): Map<string, LedgerAccount> =>
    new Map([...state.accounts].map(([address, account]) => [address, settle(account, end, state.pool, START)]));

  const onePass = applyEvents(genesis, events, timestamps, limits).state;

  it('gives the same raw values when the events arrive in two windows, split at every index', () => {
    for (let split = 0; split <= events.length; split += 1) {
      const first = applyEvents(genesis, events.slice(0, split), timestamps, limits).state;
      const second = applyEvents(first, events.slice(split), timestamps, limits).state;
      expect(second.pool).toEqual(onePass.pool);
      expect(finalView(second)).toEqual(finalView(onePass));
    }
  });

  it('gives the same raw values when the events arrive one per window', () => {
    let state = genesis;
    for (const event of events) {
      state = applyEvents(state, [event], timestamps, limits).state;
    }
    expect(finalView(state)).toEqual(finalView(onePass));
  });

  it('gives the same raw values when every account is also settled at arbitrary extra times', () => {
    let state = genesis;
    events.forEach((event, index) => {
      state = applyEvents(state, [event], timestamps, limits).state;
      const extra = blockTime(event.block) + 1 + ((index * 137) % 900);
      const nextEvent = events[index + 1];
      // Only between events: an extra settle may not run past the next change of a balance.
      if (nextEvent !== undefined && extra >= blockTime(nextEvent.block)) return;
      const pool = state.pool;
      state = {
        ...state,
        accounts: new Map([...state.accounts].map(([address, account]) => [address, settle(account, extra, pool, START)])),
      };
    });
    expect(finalView(state)).toEqual(finalView(onePass));
  });
});
