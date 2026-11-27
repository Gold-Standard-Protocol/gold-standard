import { createHash, randomBytes } from 'node:crypto';
import { SYNCING } from './codec';
import type { LedgerMeta } from './codec';
import type { LedgerConfig } from './env';
import {
  MAX_TRACKED_LIQUIDITY_POSITIONS,
  MIN_TRACKED_LIQUIDITY_VALUE,
  MIN_TRACKED_POOL_DEPOSIT,
  REBUILD_WINDOW_MS,
} from './limits';
import { GENESIS_POOL } from './poolMirror';
import type { PoolState } from './poolMirror';

const STATE_ID_BYTES = 8;

/** A new id for every commit, so a second writer notices that the state moved. */
export const newStateId = (): string => randomBytes(STATE_ID_BYTES).toString('hex');

/** The liquidity dimension's part of the fingerprint; undefined, and so absent, while it is off. */
const liquidityFingerprint = (config: LedgerConfig): Record<string, string | number> | undefined =>
  config.liquidity === undefined
    ? undefined
    : {
        pool: config.liquidity.pool.toLowerCase(),
        positionManager: config.liquidity.positionManager.toLowerCase(),
        minTrackedValue: MIN_TRACKED_LIQUIDITY_VALUE.toString(),
        maxTrackedPositions: MAX_TRACKED_LIQUIDITY_POSITIONS,
      };

/**
 * Identifies everything a stored figure depends on. A change to the deployment, the start
 * time, a tracking limit or the liquidity pool changes it, and the indexer then rebuilds
 * from the deploy block. Off, the liquidity dimension adds no key (JSON drops an undefined
 * value); turning it on, or naming another pool or position manager, changes the result.
 */
export const ledgerFingerprint = (config: LedgerConfig): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        chainId: config.chainId,
        vault: config.vault.toLowerCase(),
        pool: config.pool.toLowerCase(),
        deployBlock: config.deployBlock.toString(),
        startTimestamp: config.startTimestamp,
        minTrackedPoolDeposit: MIN_TRACKED_POOL_DEPOSIT.toString(),
        maxAddresses: config.maxAddresses,
        liquidity: liquidityFingerprint(config),
      })
    )
    .digest('hex');

export const encodePool = (pool: PoolState): LedgerMeta['pool'] => ({
  P: pool.P.toString(),
  scale: pool.scale.toString(),
  epoch: pool.epoch.toString(),
  total: pool.total.toString(),
});

export const decodePool = (pool: LedgerMeta['pool']): PoolState => ({
  P: BigInt(pool.P),
  scale: BigInt(pool.scale),
  epoch: BigInt(pool.epoch),
  total: BigInt(pool.total),
});

/** The rebuild times still inside the 24 hour window. */
export const recentRebuilds = (rebuilds: readonly number[], now: number): number[] =>
  rebuilds.filter((at) => now - at < REBUILD_WINDOW_MS && at <= now);

/** The meta of an index that has applied nothing yet. */
export const genesisMeta = (config: LedgerConfig, rebuilds: readonly number[]): LedgerMeta => ({
  v: 1,
  fingerprint: ledgerFingerprint(config),
  stateId: newStateId(),
  cursor: null,
  asOfTimestamp: 0,
  pool: encodePool(GENESIS_POOL),
  accounts: 0,
  truncated: false,
  syncedAt: SYNCING,
  rebuilds: [...rebuilds],
  ...(config.liquidity === undefined ? {} : { lp: { tick: null, positions: 0 } }),
});
