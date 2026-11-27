import { settle } from './account';
import type { LedgerAccount } from './account';
import { LedgerIntegrityError } from './errors';
import { isLiquidityEvent } from './events';
import type { LiquidityEvent, LedgerEvent } from './events';
import { GENESIS_LIQUIDITY } from './liquidity';
import type { LiquidityState } from './liquidity';
import { applyLiquidityEvent } from './liquidityReplay';
import {
  depositAfterClaim,
  depositAfterDeposit,
  depositAfterWithdraw,
  poolAfterAbsorption,
  poolAfterDeposit,
  poolAfterWithdraw,
} from './poolMirror';
import type { PoolState } from './poolMirror';
import { openAccount } from './replayWorking';
import type { ReplayLimits, Working } from './replayWorking';

export interface ReplayState {
  pool: PoolState;
  /** Keyed by lowercase address. */
  accounts: ReadonlyMap<string, LedgerAccount>;
  /**
   * Sticky: an account or a liquidity position was refused at its cap, so some activity is
   * not recorded.
   */
  truncated: boolean;
  /** The liquidity dimension's state; absent means the genesis state, as while the dimension is off. */
  liquidity?: LiquidityState;
}

export type { ReplayLimits };

export interface ReplayResult {
  state: ReplayState;
  /** Lowercase addresses whose record changed. */
  dirty: Set<string>;
  /** Token ids, in decimal, of the liquidity positions that changed. */
  positionsDirty: Set<string>;
  /** Token ids, in decimal, of the liquidity positions that were dropped. */
  positionsRemoved: Set<string>;
}

type AccountEvent = Exclude<LedgerEvent, { kind: 'absorb' } | LiquidityEvent>;

const floorZero = (value: bigint): bigint => (value > 0n ? value : 0n);

const timestampOf = (timestamps: ReadonlyMap<bigint, number>, block: bigint): number => {
  const timestamp = timestamps.get(block);
  if (timestamp === undefined) {
    throw new LedgerIntegrityError(`no timestamp was fetched for block ${block}`);
  }
  return timestamp;
};

const createsAccount = (event: AccountEvent, limits: ReplayLimits): boolean =>
  event.kind === 'mint' || (event.kind === 'deposit' && event.amount >= limits.minTrackedDeposit);

const withPoolTotal = (pool: PoolState, event: AccountEvent): PoolState => {
  if (event.kind === 'deposit') return poolAfterDeposit(pool, event.amount);
  if (event.kind === 'withdraw') return poolAfterWithdraw(pool, event.amount);
  return pool;
};

/** The account after one of its own events, already settled to the event's time. */
const applyToAccount = (
  account: LedgerAccount,
  event: AccountEvent,
  pool: PoolState
): LedgerAccount => {
  switch (event.kind) {
    // The principal read from the vault at the event's block is the tracked debt. Without
    // one (specs of this arithmetic) the event amount stands in: for a repayment or a
    // liquidation it includes the stability fee, so it can only leave the debt too low.
    case 'mint':
      return { ...account, debt: event.principal ?? account.debt + event.amount };
    case 'repay':
    case 'liquidated':
      return { ...account, debt: event.principal ?? floorZero(account.debt - event.amount) };
    case 'badDebt':
      return { ...account, debt: event.principal ?? 0n };
    case 'deposit':
      return { ...account, ...depositAfterDeposit(account, pool, event.amount) };
    case 'withdraw':
      return { ...account, ...depositAfterWithdraw(account, pool, event.amount) };
    case 'claim':
      return { ...account, ...depositAfterClaim(account, pool) };
  }
};

const applyAbsorption = (
  working: Working,
  debt: bigint,
  t: number,
  limits: ReplayLimits
): void => {
  // Every depositor is settled at its balance before the absorption, then the mirror moves.
  for (const [address, account] of working.accounts) {
    if (account.stored === 0n) continue;
    const settled = settle(account, t, working.pool, limits.start);
    if (settled !== account) {
      working.accounts.set(address, settled);
      working.dirty.add(address);
    }
  }
  working.pool = poolAfterAbsorption(working.pool, debt);
};

const applyAccountEvent = (
  working: Working,
  event: AccountEvent,
  t: number,
  limits: ReplayLimits
): void => {
  const address = event.account.toLowerCase();
  let account = working.accounts.get(address);
  if (account === undefined && createsAccount(event, limits)) {
    account = openAccount(working, t, limits);
  }
  if (account !== undefined) {
    const settled = settle(account, t, working.pool, limits.start);
    working.accounts.set(address, applyToAccount(settled, event, working.pool));
    working.dirty.add(address);
  }
  // The pool total moves whether or not the depositor is tracked.
  working.pool = withPoolTotal(working.pool, event);
};

/**
 * Applies decoded events, in order, to a copy of the state. `timestamps` maps each event's
 * block to its unix time. An account is created by a mint or by a pool deposit of at least
 * `minTrackedDeposit`; an event for an untracked account changes no account. At the cap a
 * new account takes the slot of one that holds nothing, and is refused only when every
 * tracked account holds a balance. Both rules can only under-record. Throws
 * LedgerIntegrityError when the pool mirror cannot follow an event; the caller's state is
 * untouched in that case. Liquidity events are applied by liquidityReplay.ts and change
 * nothing while the liquidity dimension is off.
 */
export const applyEvents = (
  state: ReplayState,
  events: readonly LedgerEvent[],
  timestamps: ReadonlyMap<bigint, number>,
  limits: ReplayLimits
): ReplayResult => {
  const liquidity = state.liquidity ?? GENESIS_LIQUIDITY;
  const working: Working = {
    pool: state.pool,
    accounts: new Map(state.accounts),
    truncated: state.truncated,
    dirty: new Set<string>(),
    tick: liquidity.tick,
    positions: new Map(liquidity.positions),
    positionsDirty: new Set<string>(),
    positionsRemoved: new Set<string>(),
  };
  for (const event of events) {
    // A liquidity event asks for its block's time only when it changes an account: most swaps do not.
    if (isLiquidityEvent(event)) {
      applyLiquidityEvent(working, event, () => timestampOf(timestamps, event.block), limits);
      continue;
    }
    const t = timestampOf(timestamps, event.block);
    if (event.kind === 'absorb') {
      applyAbsorption(working, event.debt, t, limits);
    } else {
      applyAccountEvent(working, event, t, limits);
    }
  }
  return {
    state: {
      pool: working.pool,
      accounts: working.accounts,
      truncated: working.truncated,
      ...(state.liquidity === undefined && limits.liquidity === undefined
        ? {}
        : { liquidity: { tick: working.tick, positions: working.positions } }),
    },
    dirty: working.dirty,
    positionsDirty: working.positionsDirty,
    positionsRemoved: working.positionsRemoved,
  };
};
