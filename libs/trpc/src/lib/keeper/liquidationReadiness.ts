import { erc20KeeperAbi, goldVaultKeeperAbi, stabilityPoolKeeperAbi } from './abis';
import { KEEPER_EVENTS } from './alerts';
import { collateralIdForToken } from './collateral';
import type { KeeperConfig } from './config';
import { describeError, expectBigInt, expectTuple } from './decode';
import { directLiquidationFloat } from './directLiquidation';
import { LIQUIDATION_JOB } from './liquidationConstants';
import type { KeeperJobDeps } from './ports';

// The liquidation watch's launch-day readiness preflight, run once a
// tick after the debt sweep so the pool can be measured against the largest vault. Moved
// out of liquidationWatch.ts with the open profile yardstick.

const JOB = LIQUIDATION_JOB;

/** Debt ceiling for the primary collateral, the yardstick LAUNCH.md uses. */
const readDebtCeiling = async (
  deps: KeeperJobDeps,
  config: KeeperConfig
): Promise<bigint | undefined> => {
  try {
    const raw = await deps.read.readContract({
      address: config.goldVaultAddress,
      abi: goldVaultKeeperAbi,
      functionName: 'collateralTypes',
      args: [collateralIdForToken(config.paxgToken)],
    });
    const tuple = expectTuple(raw, 7, 'collateralTypes');
    return expectBigInt(tuple[4], 'collateralTypes.debtCeiling');
  } catch {
    return undefined;
  }
};

/**
 * What the pool is measured against: the debt ceiling of a capped deployment; under an
 * unlimited ceiling (LAUNCH_CAPS=open, MaxUint256) the largest vault debt of the tick's
 * sweep, or minDebt, the smallest debt a vault can carry, when the sweep has no larger one.
 */
type PoolYardstick =
  | { kind: 'debt-ceiling'; amount: bigint }
  | { kind: 'largest-vault-debt'; amount: bigint }
  | { kind: 'min-debt'; amount: bigint };

const UNLIMITED_CEILING = 2n ** 256n - 1n;

const POOL_SHORT_OF: Readonly<Record<PoolYardstick['kind'] | 'unknown', string>> = {
  'debt-ceiling': 'StabilityPool deposits are below the debt ceiling',
  'largest-vault-debt':
    'StabilityPool deposits do not exceed the largest vault debt (the debt ceiling is unlimited, as under LAUNCH_CAPS=open)',
  'min-debt':
    'StabilityPool deposits do not exceed GoldVault.minDebt, the smallest debt a vault can carry (the debt ceiling is unlimited, as under LAUNCH_CAPS=open)',
  unknown: 'The StabilityPool is empty',
};

/**
 * What the keeper cannot do. Measured against the largest vault, a pool that holds something
 * still takes every vault smaller than its deposits, so "cannot liquidate" would be false
 * (in a mainnet fork rehearsal the line fired in the tick that liquidated through
 * the pool).
 */
const cannotLiquidate = (yardstick: PoolYardstick | undefined): string =>
  yardstick?.kind === 'largest-vault-debt'
    ? 'this keeper cannot liquidate the largest vault; a vault whose debt is below the pool deposits still goes through the pool'
    : 'this keeper can alert but cannot liquidate';

const noPathDetail = (yardstick: PoolYardstick | undefined, minDebtUnknown: boolean): string => {
  const pool = POOL_SHORT_OF[yardstick?.kind ?? 'unknown'];
  return minDebtUnknown
    ? `${pool} and GoldVault.minDebt has not been readable since this keeper started, so the keeper wallet cannot be measured against the smallest vault and the direct path is not counted as armed. Restore the minDebt read (keeper.min-debt-unreadable carries the reason), or seed the pool.`
    : `${pool} and the direct path is disabled or cannot cover even a minDebt vault: ${cannotLiquidate(yardstick)}. Seed the pool past that figure, or set KEEPER_ENABLE_DIRECT=true and fund the keeper wallet with GSUSD${
        yardstick?.kind === 'debt-ceiling' ? ', before raising any debt ceiling above zero' : ''
      }.`;
};

/**
 * The figure the pool must reach, or undefined when none can be read. A ceiling is the
 * yardstick only while it caps something: MaxUint256 can never be reached, so a pool
 * measured against it paged every tick however deep it was. The largest debt of the sweep is the
 * vault the pool must be able
 * to take; a tick without a sweep, or without a debt above minDebt, uses minDebt.
 */
const poolYardstick = (
  ceiling: bigint | undefined,
  largestDebt: bigint | undefined,
  minDebt: bigint | undefined
): PoolYardstick | undefined => {
  if (ceiling === undefined) return undefined;
  if (ceiling !== UNLIMITED_CEILING) return { kind: 'debt-ceiling', amount: ceiling };
  if (largestDebt !== undefined && (minDebt === undefined || largestDebt > minDebt)) {
    return { kind: 'largest-vault-debt', amount: largestDebt };
  }
  return minDebt === undefined ? undefined : { kind: 'min-debt', amount: minDebt };
};

/** StabilityPool.absorbLiquidationPrefunded needs debt < totalDeposits; a ceiling needs only to be met. */
const poolClears = (totalDeposits: bigint, yardstick: PoolYardstick): boolean =>
  yardstick.kind === 'debt-ceiling' ? totalDeposits >= yardstick.amount : totalDeposits > yardstick.amount;

/**
 * Launch-day readiness preflight.
 *
 * A live keeper has exactly two execution paths and BOTH can be silently
 * unarmed: `liquidateViaPool` needs `totalDeposits > debt`, and the pool is
 * empty at launch; the direct path needs `KEEPER_ENABLE_DIRECT=true` (default
 * false) AND a GSUSD-funded wallet, and no runbook step funds it. The keeper
 * would therefore watch and alert while being unable to act, yet LAUNCH.md
 * makes keeper responsiveness a hard gate for every ceiling doubling.
 *
 * Rather than discover that during a crash, emit a pageable error every tick
 * while no path is armed. Dry run is exempt: watch-only is its whole purpose.
 * `largestDebt` is the largest debt of the tick's sweep, undefined without one.
 */
const reportLiquidationReadiness = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  minDebt: bigint | undefined,
  largestDebt: bigint | undefined
): Promise<void> => {
  const { read, tx, log } = deps;
  if (config.dryRun || tx === undefined) {
    return;
  }
  const totalDeposits = expectBigInt(
    await read.readContract({
      address: config.stabilityPoolAddress,
      abi: stabilityPoolKeeperAbi,
      functionName: 'totalDeposits',
    }),
    'totalDeposits'
  );
  // A pool with ANY balance used to satisfy this check, so a dust deposit
  // silenced the alarm: the unarmed keeper this check exists to report went
  // unreported. LAUNCH.md requires the pool to be seeded ABOVE the week's ceiling, so
  // measure against the exposure the protocol actually carries: the ceiling while
  // one caps it, the largest vault otherwise (see poolYardstick).
  const ceiling = await readDebtCeiling(deps, config);
  const yardstick = poolYardstick(ceiling, largestDebt, minDebt);
  if (yardstick !== undefined && poolClears(totalDeposits, yardstick)) {
    return;
  }
  if (yardstick === undefined && totalDeposits > 0n) {
    // Nothing to measure against: fall back to the weaker check rather than page noisily.
    return;
  }
  let gsusdBalance = 0n;
  let minimumDirectFloat: bigint | undefined;
  if (config.enableDirect) {
    gsusdBalance = expectBigInt(
      await read.readContract({
        address: config.gsusdAddress,
        abi: erc20KeeperAbi,
        functionName: 'balanceOf',
        args: [tx.account],
      }),
      'balanceOf'
    );
    // Any balance above zero used to count as armed, so one wei sent to the keeper by any
    // holder silenced this page, the dust bypass the pool side above was already closed
    // against. The smallest vault the contract allows owes
    // minDebt, and the direct path demands that plus its headroom. A wallet that cannot be
    // measured, because minDebt has never been read, is not counted as armed.
    minimumDirectFloat = minDebt === undefined ? undefined : directLiquidationFloat(minDebt);
    if (minimumDirectFloat !== undefined && gsusdBalance >= minimumDirectFloat) {
      return;
    }
  }
  log.error(KEEPER_EVENTS.noLiquidationPath, {
    job: JOB,
    stabilityPoolDeposits: totalDeposits,
    debtCeiling: ceiling,
    poolYardstick: yardstick?.kind,
    poolYardstickAmount: yardstick?.amount,
    enableDirect: config.enableDirect,
    keeperGsusdBalance: gsusdBalance,
    minimumDirectFloat,
    account: tx.account,
    detail: noPathDetail(yardstick, config.enableDirect && minDebt === undefined),
  });
};

/**
 * The preflight only reports, so a read it cannot make must not cost the tick its owner
 * walk: a vault past its line would wait a whole interval for a pool or wallet read that has
 * nothing to do with it. The failure is logged
 * with `step: 'readiness'` and the walk goes on.
 */
export const reportReadinessOrLog = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  minDebt: bigint | undefined,
  largestDebt: bigint | undefined
): Promise<void> => {
  try {
    await reportLiquidationReadiness(deps, config, minDebt, largestDebt);
  } catch (error) {
    deps.log.error(KEEPER_EVENTS.jobError, {
      job: JOB,
      step: 'readiness',
      reason: describeError(error),
    });
  }
};
