import { settle } from './account';
import type { LiquidityEvent, PositionReading } from './events';
import { activeValue, isInRange } from './liquidity';
import type { LiquidityLimits } from './liquidity';
import { openAccount } from './replayWorking';
import type { ReplayLimits, Working } from './replayWorking';

interface LiquidityContext {
  working: Working;
  limits: ReplayLimits;
  /** The time of the event's block; asked for only when an account changes. */
  time: () => number;
}

/**
 * Brings one owner's record in line with its positions: settles it to the event's time at
 * the liquidity it had, then sets the liquidity it has now. An owner with a position and no
 * record gets one, under the same cap as every other account.
 */
const refreshOwner = (context: LiquidityContext, owner: string): void => {
  const { working, limits } = context;
  const t = context.time();
  const active = activeValue(working.positions, owner, working.tick);
  let account = working.accounts.get(owner);
  if (account === undefined) {
    const holds = [...working.positions.values()].some((position) => position.owner === owner);
    if (!holds) return;
    account = openAccount(working, t, limits);
    if (account === undefined) return;
  }
  const settled = settle(account, t, working.pool, limits.start);
  working.accounts.set(owner, { ...settled, liquidity: active });
  working.dirty.add(owner);
};

/** A move of the pool's tick: only owners with a range the tick entered or left are touched. */
const applyTick = (context: LiquidityContext, tick: number): void => {
  const { working } = context;
  const before = working.tick;
  working.tick = tick;
  if (before === tick) return;
  const owners = new Set<string>();
  for (const position of working.positions.values()) {
    if (isInRange(before, position) !== isInRange(tick, position)) owners.add(position.owner);
  }
  for (const owner of owners) refreshOwner(context, owner);
};

const dropPosition = (working: Working, key: string): void => {
  working.positions.delete(key);
  working.positionsDirty.delete(key);
  working.positionsRemoved.add(key);
};

/**
 * A position as the chain holds it at the end of the event's block. It is tracked while it
 * is worth at least the minimum at the peg; below that, burned or gone it is dropped, so a
 * slot cannot be held without a balance. At the cap a new position is refused and the index
 * is marked incomplete. Both rules can only under-record.
 */
const applyPositionState = (
  context: LiquidityContext,
  liquidity: LiquidityLimits,
  tokenId: bigint,
  reading: PositionReading | undefined
): void => {
  const { working } = context;
  const key = tokenId.toString();
  const previous = working.positions.get(key);
  const owner = reading?.owner.toLowerCase();
  const value = reading === undefined ? 0n : liquidity.valueOf(reading.liquidity, reading.tickLower, reading.tickUpper);
  if (reading === undefined || owner === undefined || value < liquidity.minValue) {
    if (previous === undefined) return;
    dropPosition(working, key);
    refreshOwner(context, previous.owner);
    return;
  }
  if (previous === undefined && working.positions.size >= liquidity.maxPositions) {
    working.truncated = true;
    return;
  }
  working.positions.set(key, {
    owner,
    liquidity: reading.liquidity,
    tickLower: reading.tickLower,
    tickUpper: reading.tickUpper,
    value,
  });
  working.positionsRemoved.delete(key);
  working.positionsDirty.add(key);
  if (previous !== undefined && previous.owner !== owner) refreshOwner(context, previous.owner);
  refreshOwner(context, owner);
};

/**
 * Applies one liquidity event. The pool's logs about added and removed liquidity and the
 * position manager's own logs change nothing here: the indexer replaces them with `positionState`
 * events. With the dimension off every liquidity event is ignored.
 */
export const applyLiquidityEvent = (
  working: Working,
  event: LiquidityEvent,
  time: () => number,
  limits: ReplayLimits
): void => {
  if (limits.liquidity === undefined) return;
  const context: LiquidityContext = { working, limits, time };
  if (event.kind === 'poolTick') applyTick(context, event.tick);
  else if (event.kind === 'positionState') applyPositionState(context, limits.liquidity, event.tokenId, event.reading);
};
