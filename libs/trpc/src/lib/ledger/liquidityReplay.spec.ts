import { settle } from './account';
import type { LedgerAccount } from './account';
import { LedgerIntegrityError } from './errors';
import type { LedgerEvent } from './events';
import { liquidityLimits } from './liquidity';
import type { LiquidityLimits } from './liquidity';
import { pegValue } from './liquidityMath';
import { GENESIS_POOL } from './poolMirror';
import { applyEvents } from './replay';
import type { ReplayLimits, ReplayState } from './replay';
import { RAW_PER_UNIT_DAY } from './units';

const START = 1_800_000_000;
const DAY = 86_400;
const ONE = 10n ** 18n;
const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b2';
const CAROL = '0x00000000000000000000000000000000000000c3';

/** Block n is n hundred seconds after the ledger start. */
const blockTime = (block: bigint): number => START + Number(block) * 100;
const timestampsFor = (events: readonly LedgerEvent[]): Map<bigint, number> =>
  new Map(events.map((event) => [event.block, blockTime(event.block)] as const));

/** For readable figures a position is worth its liquidity: one unit of liquidity is one dollar wei. */
const worthItsLiquidity: LiquidityLimits = { valueOf: (liquidity) => liquidity, minValue: ONE, maxPositions: 100 };
const limits: ReplayLimits = { start: START, maxAccounts: 100, minTrackedDeposit: ONE, liquidity: worthItsLiquidity };
const genesis: ReplayState = { pool: GENESIS_POOL, accounts: new Map(), truncated: false };

let nextLogIndex = 0;
const at = (block: number) => ({ block: BigInt(block), logIndex: nextLogIndex++ });
const tick = (value: number, block: number): LedgerEvent => ({ kind: 'poolTick', tick: value, ...at(block) });
const position = (
  tokenId: number,
  owner: string,
  liquidity: bigint,
  block: number,
  range: readonly [number, number] = [-10, 10]
): LedgerEvent => ({
  kind: 'positionState',
  tokenId: BigInt(tokenId),
  reading: { owner: owner as `0x${string}`, liquidity, tickLower: range[0], tickUpper: range[1] },
  ...at(block),
});
const gone = (tokenId: number, block: number): LedgerEvent => ({
  kind: 'positionState',
  tokenId: BigInt(tokenId),
  reading: undefined,
  ...at(block),
});

const replay = (events: readonly LedgerEvent[], state = genesis, using = limits) =>
  applyEvents(state, events, timestampsFor(events), using);

/** The account's liquidity figure once settled to `block`, as the reader would show it. */
const liquidityRawAt = (state: ReplayState, owner: string, block: number, using = limits): bigint => {
  const account = state.accounts.get(owner);
  if (account === undefined) return 0n;
  return settle(account, blockTime(BigInt(block)), state.pool, using.start).liquidityRaw;
};

/** Dollars in range for a number of seconds: dollar wei times seconds, with no weight on either. */
const recorded = (dollars: bigint, seconds: number): bigint => dollars * BigInt(seconds);

describe('liquidity replay', () => {
  it('records one dollar-day per dollar per day while the tick is inside the range', () => {
    const { state } = replay([tick(0, 1), position(7, ALICE, 1_000n * ONE, 2)]);
    expect(state.accounts.get(ALICE)?.liquidity).toBe(1_000n * ONE);
    expect(liquidityRawAt(state, ALICE, 12)).toBe(recorded(1_000n * ONE, 1_000));
    // A full day: 1,000 dollars for 86,400 seconds is 1,000 dollar-days, on the first day as on any other.
    const fullDay = settle(state.accounts.get(ALICE) as LedgerAccount, blockTime(2n) + DAY, state.pool, START);
    expect(fullDay.liquidityRaw).toBe(1_000n * ONE * BigInt(DAY));
    expect(fullDay.liquidityRaw).toBe(1_000n * RAW_PER_UNIT_DAY);
  });

  it('records nothing while the tick is outside the range', () => {
    const { state } = replay([tick(50, 1), position(7, ALICE, 1_000n * ONE, 2)]);
    expect(state.accounts.get(ALICE)?.liquidity).toBe(0n);
    expect(liquidityRawAt(state, ALICE, 500)).toBe(0n);
    expect(state.liquidity?.positions.get('7')?.value).toBe(1_000n * ONE);
  });

  it('counts the lower tick as inside and the upper tick as outside, as the pool does', () => {
    const lower = replay([tick(-10, 1), position(7, ALICE, 5n * ONE, 2)]).state;
    expect(lower.accounts.get(ALICE)?.liquidity).toBe(5n * ONE);
    const upper = replay([tick(10, 1), position(7, ALICE, 5n * ONE, 2)]).state;
    expect(upper.accounts.get(ALICE)?.liquidity).toBe(0n);
    const justInside = replay([tick(9, 1), position(7, ALICE, 5n * ONE, 2)]).state;
    expect(justInside.accounts.get(ALICE)?.liquidity).toBe(5n * ONE);
  });

  it('records nothing before the pool has a tick', () => {
    const { state } = replay([position(7, ALICE, 1_000n * ONE, 1), tick(0, 4)]);
    expect(liquidityRawAt(state, ALICE, 4)).toBe(0n);
    expect(liquidityRawAt(state, ALICE, 6)).toBe(recorded(1_000n * ONE, 200));
  });

  it('stops when the tick leaves the range and resumes when it returns', () => {
    const events = [tick(0, 1), position(7, ALICE, 1_000n * ONE, 1), tick(40, 5), tick(45, 6), tick(-3, 8)];
    const { state } = replay(events);
    // In range from block 1 to 5 and from block 8 on.
    expect(liquidityRawAt(state, ALICE, 10)).toBe(recorded(1_000n * ONE, 400) + recorded(1_000n * ONE, 200));
    const outside = replay(events.slice(0, 4)).state;
    expect(outside.accounts.get(ALICE)?.liquidity).toBe(0n);
    expect(liquidityRawAt(outside, ALICE, 7)).toBe(recorded(1_000n * ONE, 400));
  });

  it('asks for a block time only when a tick move changes an account', () => {
    const setup = [tick(0, 1), position(7, ALICE, 1_000n * ONE, 1)];
    const quiet = [tick(3, 5), tick(-9, 6), tick(9, 7)];
    const crossing = tick(10, 8);
    const timestamps = timestampsFor(setup);
    const { state } = applyEvents(genesis, [...setup, ...quiet], timestamps, limits);
    expect(state.liquidity?.tick).toBe(9);
    expect(() => applyEvents(genesis, [...setup, ...quiet, crossing], timestamps, limits)).toThrow(
      LedgerIntegrityError
    );
  });

  it('adds up the positions of one owner that are in range', () => {
    const { state } = replay([
      tick(0, 1),
      position(7, ALICE, 1_000n * ONE, 1),
      position(8, ALICE, 300n * ONE, 1, [100, 200]),
      position(9, ALICE, 50n * ONE, 1, [-200, 1]),
    ]);
    expect(state.accounts.get(ALICE)?.liquidity).toBe(1_050n * ONE);
    const moved = replay([tick(150, 3)], state).state;
    expect(moved.accounts.get(ALICE)?.liquidity).toBe(300n * ONE);
    expect(liquidityRawAt(moved, ALICE, 5)).toBe(recorded(1_050n * ONE, 200) + recorded(300n * ONE, 200));
  });

  it('moves the record to the new owner from the transfer on when the position is transferred', () => {
    const { state, dirty } = replay([tick(0, 1), position(7, ALICE, 1_000n * ONE, 1), position(7, BOB, 1_000n * ONE, 5)]);
    expect(state.liquidity?.positions.get('7')?.owner).toBe(BOB);
    expect(state.accounts.get(ALICE)?.liquidity).toBe(0n);
    expect(state.accounts.get(BOB)?.liquidity).toBe(1_000n * ONE);
    expect(liquidityRawAt(state, ALICE, 9)).toBe(recorded(1_000n * ONE, 400));
    expect(liquidityRawAt(state, BOB, 9)).toBe(recorded(1_000n * ONE, 400));
    expect([...dirty].sort()).toEqual([ALICE, BOB]);
  });

  it('follows an increase and a decrease of the liquidity', () => {
    const { state } = replay([
      tick(0, 1),
      position(7, ALICE, 1_000n * ONE, 1),
      position(7, ALICE, 2_500n * ONE, 4),
      position(7, ALICE, 400n * ONE, 7),
    ]);
    expect(state.accounts.get(ALICE)?.liquidity).toBe(400n * ONE);
    expect(liquidityRawAt(state, ALICE, 10)).toBe(
      recorded(1_000n * ONE, 300) + recorded(2_500n * ONE, 300) + recorded(400n * ONE, 300)
    );
  });

  it('records nothing for liquidity added and removed inside one block', () => {
    // The indexer reads the position at the end of the block, so both changes arrive as one state.
    const { state } = replay([tick(0, 1), position(7, ALICE, 1_000n * ONE, 3), gone(7, 3)]);
    expect(state.liquidity?.positions.size).toBe(0);
    expect(liquidityRawAt(state, ALICE, 50)).toBe(0n);
    const flash = replay([tick(0, 1), position(7, ALICE, 10n * ONE, 2), position(7, ALICE, 9_000n * ONE, 5), position(7, ALICE, 10n * ONE, 5)]).state;
    expect(liquidityRawAt(flash, ALICE, 8)).toBe(recorded(10n * ONE, 600));
  });

  it('records nothing before the ledger start', () => {
    const early: ReplayLimits = { ...limits, start: blockTime(5n) };
    const { state } = replay([tick(0, 1), position(7, ALICE, 1_000n * ONE, 2)], genesis, early);
    expect(liquidityRawAt(state, ALICE, 5, early)).toBe(0n);
    expect(liquidityRawAt(state, ALICE, 7, early)).toBe(recorded(1_000n * ONE, 200));
  });

  it('does not track a position worth less than the minimum, and drops one that falls below it', () => {
    const dust = replay([tick(0, 1), position(7, ALICE, ONE - 1n, 2)]);
    expect(dust.state.liquidity?.positions.size).toBe(0);
    expect(dust.state.accounts.has(ALICE)).toBe(false);
    const { state, positionsRemoved, positionsDirty } = replay([
      tick(0, 1),
      position(7, ALICE, 1_000n * ONE, 2),
      position(7, ALICE, ONE - 1n, 6),
    ]);
    expect(state.liquidity?.positions.size).toBe(0);
    expect([...positionsRemoved]).toEqual(['7']);
    expect(positionsDirty.size).toBe(0);
    expect(state.accounts.get(ALICE)?.liquidity).toBe(0n);
    expect(liquidityRawAt(state, ALICE, 40)).toBe(recorded(1_000n * ONE, 400));
    // Worth exactly the minimum is tracked.
    expect(replay([tick(0, 1), position(7, ALICE, ONE, 2)]).state.liquidity?.positions.size).toBe(1);
  });

  it('drops a burned position and ignores the state of a position it never tracked', () => {
    const { state } = replay([tick(0, 1), position(7, ALICE, 1_000n * ONE, 2), gone(7, 5), gone(99, 6)]);
    expect(state.liquidity?.positions.size).toBe(0);
    expect(liquidityRawAt(state, ALICE, 30)).toBe(recorded(1_000n * ONE, 300));
  });

  it('refuses a new position at the cap and marks the ledger incomplete', () => {
    const capped: ReplayLimits = { ...limits, liquidity: { ...worthItsLiquidity, maxPositions: 2 } };
    const { state } = replay(
      [tick(0, 1), position(1, ALICE, 5n * ONE, 2), position(2, BOB, 5n * ONE, 2), position(3, CAROL, 5n * ONE, 3), position(1, ALICE, 9n * ONE, 4)],
      genesis,
      capped
    );
    expect(state.truncated).toBe(true);
    expect([...(state.liquidity?.positions.keys() ?? [])]).toEqual(['1', '2']);
    expect(state.accounts.has(CAROL)).toBe(false);
    // A tracked position is still updated at the cap.
    expect(state.liquidity?.positions.get('1')?.liquidity).toBe(9n * ONE);
  });

  it('opens no record for an owner at the address cap, keeps the position and marks the ledger incomplete', () => {
    const capped: ReplayLimits = { ...limits, maxAccounts: 1 };
    const debtor: LedgerEvent = { kind: 'mint', account: BOB as `0x${string}`, amount: ONE, ...at(1) };
    const repaid: LedgerEvent = { kind: 'repay', account: BOB as `0x${string}`, amount: ONE, ...at(5) };
    const { state } = replay([debtor, tick(0, 1), position(7, ALICE, 5n * ONE, 2), repaid, position(7, ALICE, 6n * ONE, 8)], genesis, capped);
    // Bob repaid everything and still keeps his record: no slot is ever freed.
    expect([...state.accounts.keys()]).toEqual([BOB]);
    expect(state.accounts.get(BOB)?.debtRaw).toBe(ONE * 400n);
    expect(state.accounts.has(ALICE)).toBe(false);
    expect(state.liquidity?.positions.get('7')?.liquidity).toBe(6n * ONE);
    expect(state.truncated).toBe(true);
  });

  it('keeps the record of an owner whose position is gone', () => {
    const { state } = replay([tick(0, 1), position(7, ALICE, 5n * ONE, 2), gone(7, 6)]);
    expect(state.liquidity?.positions.size).toBe(0);
    expect(state.accounts.get(ALICE)?.liquidity).toBe(0n);
    expect(liquidityRawAt(state, ALICE, 50)).toBe(recorded(5n * ONE, 400));
  });

  it('gives the same state however the events are split into windows', () => {
    const events = [
      tick(0, 1),
      position(7, ALICE, 1_000n * ONE, 1),
      position(8, BOB, 20n * ONE, 2, [5, 60]),
      tick(7, 3),
      position(7, CAROL, 1_000n * ONE, 4),
      tick(70, 5),
      position(8, BOB, 90n * ONE, 6, [5, 60]),
      tick(-4, 7),
      gone(7, 8),
      tick(30, 9),
    ];
    const timestamps = timestampsFor(events);
    const whole = applyEvents(genesis, events, timestamps, limits).state;
    for (let split = 1; split < events.length; split += 1) {
      const first = applyEvents(genesis, events.slice(0, split), timestamps, limits).state;
      const second = applyEvents(first, events.slice(split), timestamps, limits).state;
      expect(second).toEqual(whole);
    }
  });

  it('ignores every liquidity event and keeps no liquidity state while the dimension is off', () => {
    const off: ReplayLimits = { start: START, maxAccounts: 100, minTrackedDeposit: ONE };
    const result = replay([tick(0, 1), position(7, ALICE, 1_000n * ONE, 2)], genesis, off);
    expect(result.state).toEqual(genesis);
    expect(result.dirty.size).toBe(0);
    expect(result.positionsDirty.size).toBe(0);
  });

  it('ignores the raw pool and position manager logs, which the indexer replaces', () => {
    const { state } = replay([
      tick(0, 1),
      { kind: 'poolLiquidity', owner: ALICE as `0x${string}`, added: true, transactionHash: `0x${'ab'.repeat(32)}`, ...at(2) },
      { kind: 'positionChange', tokenId: 7n, increase: true, ...at(2) },
    ]);
    expect(state.liquidity).toEqual({ tick: 0, positions: new Map() });
    expect(state.accounts.size).toBe(0);
  });

  it('values a position at the peg with the real arithmetic', () => {
    const pair = { decimals0: 18, decimals1: 6 };
    const real: ReplayLimits = { ...limits, liquidity: liquidityLimits(pair) };
    const liquidity = 10n ** 21n;
    const range = [-276_330, -276_320] as const;
    const { state } = replay([tick(-276_325, 1), position(7, ALICE, liquidity, 2, range)], genesis, real);
    const value = pegValue(pair, liquidity, range[0], range[1]);
    expect(value > ONE).toBe(true);
    expect(state.accounts.get(ALICE)?.liquidity).toBe(value);
    expect(liquidityRawAt(state, ALICE, 12, real)).toBe(recorded(value, 1_000));
  });
});
