import { LedgerIntegrityError } from './errors';

/**
 * A mirror of StabilityPool's product-sum arithmetic. Every value is fully determined by
 * the pool's events and every division is a floor, as Math.mulDiv is, so the mirror equals
 * the contract exactly; the indexer checks the four globals against the chain every run.
 */

export const POOL_PRECISION = 10n ** 18n;
export const POOL_SCALE_FACTOR = 10n ** 9n;

export interface PoolState {
  P: bigint;
  scale: bigint;
  epoch: bigint;
  total: bigint;
}

export interface DepositSnapshot {
  stored: bigint;
  snapP: bigint;
  snapScale: bigint;
  snapEpoch: bigint;
}

export const GENESIS_POOL: PoolState = { P: POOL_PRECISION, scale: 0n, epoch: 0n, total: 0n };
export const EMPTY_DEPOSIT: DepositSnapshot = { stored: 0n, snapP: 0n, snapScale: 0n, snapEpoch: 0n };

/** The depositor's balance after every absorption since its snapshot: _compoundedDeposit. */
export const compounded = (deposit: DepositSnapshot, pool: PoolState): bigint => {
  if (deposit.stored === 0n || deposit.snapP === 0n || deposit.snapEpoch < pool.epoch) return 0n;
  const scaleDiff = pool.scale - deposit.snapScale;
  const scaled = (deposit.stored * pool.P) / deposit.snapP;
  if (scaleDiff === 0n) return scaled;
  if (scaleDiff === 1n) return scaled / POOL_SCALE_FACTOR;
  return 0n;
};

/** The stored balance and its snapshot after a re-anchor: _updateSnapshot. */
export const anchor = (pool: PoolState, newStored: bigint): DepositSnapshot =>
  newStored === 0n
    ? EMPTY_DEPOSIT
    : { stored: newStored, snapP: pool.P, snapScale: pool.scale, snapEpoch: pool.epoch };

const floorZero = (value: bigint): bigint => (value > 0n ? value : 0n);

export const depositAfterDeposit = (deposit: DepositSnapshot, pool: PoolState, amount: bigint): DepositSnapshot =>
  anchor(pool, compounded(deposit, pool) + amount);

/** The clamp only bites for a depositor whose earlier dust deposit was never tracked. */
export const depositAfterWithdraw = (deposit: DepositSnapshot, pool: PoolState, amount: bigint): DepositSnapshot =>
  anchor(pool, floorZero(compounded(deposit, pool) - amount));

export const depositAfterClaim = (deposit: DepositSnapshot, pool: PoolState): DepositSnapshot =>
  anchor(pool, compounded(deposit, pool));

export const poolAfterDeposit = (pool: PoolState, amount: bigint): PoolState => ({
  ...pool,
  total: pool.total + amount,
});

export const poolAfterWithdraw = (pool: PoolState, amount: bigint): PoolState => {
  if (amount > pool.total) {
    throw new LedgerIntegrityError(
      `a withdrawal of ${amount} exceeds the mirrored pool total ${pool.total}`
    );
  }
  return { ...pool, total: pool.total - amount };
};

/** The globals after LiquidationAbsorbed(debt): _updateRewardSumAndProduct and _absorb. */
export const poolAfterAbsorption = (pool: PoolState, debt: bigint): PoolState => {
  const total = pool.total;
  if (debt < 0n || total <= 0n || debt >= total) {
    throw new LedgerIntegrityError(
      `an absorption of ${debt} is impossible against the mirrored pool total ${total}`
    );
  }
  const remaining = total - debt;
  const productFactor = (remaining * POOL_PRECISION) / total;
  if (productFactor < POOL_SCALE_FACTOR) {
    return { P: POOL_PRECISION, scale: 0n, epoch: pool.epoch + 1n, total: remaining };
  }
  const product = (pool.P * productFactor) / POOL_PRECISION;
  if (product < POOL_SCALE_FACTOR) {
    return {
      P: (pool.P * productFactor * POOL_SCALE_FACTOR) / POOL_PRECISION,
      scale: pool.scale + 1n,
      epoch: pool.epoch,
      total: remaining,
    };
  }
  return { ...pool, P: product, total: remaining };
};
