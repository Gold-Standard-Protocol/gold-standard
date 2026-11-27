import type { Address } from 'viem';
import { pegValue } from './liquidityMath';
import { MAX_TRACKED_LIQUIDITY_POSITIONS, MIN_TRACKED_LIQUIDITY_VALUE } from './limits';

/**
 * The liquidity dimension: positions of one configured Uniswap v3 pool, held through the
 * NonfungiblePositionManager. A position counts at its value at the peg (liquidityMath.ts)
 * and only while the pool's tick is inside its range. The record is the NFT owner's.
 */

/** The two addresses the operator configures. */
export interface LiquidityConfig {
  pool: Address;
  positionManager: Address;
}

/** The pool as the chain describes it, read once and checked against the deployment. */
export interface LiquiditySource extends LiquidityConfig {
  token0: Address;
  token1: Address;
  fee: number;
  decimals0: number;
  decimals1: number;
}

export interface LiquidityPosition {
  /** Lowercase address of the NFT's owner. */
  owner: string;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  /** The position's value at the peg, dollars with 18 decimals. */
  value: bigint;
}

export interface LiquidityState {
  /** The pool's current tick; null before the pool is initialized. */
  tick: number | null;
  /** Keyed by the token id in decimal. Every position here is worth at least the tracking minimum. */
  positions: ReadonlyMap<string, LiquidityPosition>;
}

export const GENESIS_LIQUIDITY: LiquidityState = { tick: null, positions: new Map() };

/** What the replay needs to know about the source; absent while the source is off. */
export interface LiquidityLimits {
  valueOf: (liquidity: bigint, tickLower: number, tickUpper: number) => bigint;
  minValue: bigint;
  maxPositions: number;
}

export const liquidityLimits = (source: Pick<LiquiditySource, 'decimals0' | 'decimals1'>): LiquidityLimits => ({
  valueOf: (liquidity, tickLower, tickUpper) => pegValue(source, liquidity, tickLower, tickUpper),
  minValue: MIN_TRACKED_LIQUIDITY_VALUE,
  maxPositions: MAX_TRACKED_LIQUIDITY_POSITIONS,
});

/** In range as the pool counts it: the lower tick is inside, the upper tick is not. */
export const isInRange = (tick: number | null, position: Pick<LiquidityPosition, 'tickLower' | 'tickUpper'>): boolean =>
  tick !== null && position.tickLower <= tick && tick < position.tickUpper;

/** The value of an owner's positions that are in range at `tick`: what the owner's record grows by. */
export const activeValue = (
  positions: ReadonlyMap<string, LiquidityPosition>,
  owner: string,
  tick: number | null
): bigint => {
  let total = 0n;
  for (const position of positions.values()) {
    if (position.owner === owner && isInRange(tick, position)) total += position.value;
  }
  return total;
};

/** True when a move of the tick takes it across `boundary`, so a range ending there changes state. */
export const crossesBoundary = (from: number | null, to: number, boundary: number): boolean =>
  from === null || (from < boundary) !== (to < boundary);
