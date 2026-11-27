import type { Address } from 'viem';
import { goldOracleKeeperAbi, goldVaultKeeperAbi } from './abis';
import { KEEPER_EVENTS } from './alerts';
import type { KeeperConfig } from './config';
import { describeError, expectBigInt, expectBoolean, expectTuple } from './decode';
import { attemptDirectLiquidation } from './directLiquidation';
import type { DirectPartialTerms } from './directLiquidation';
import { LIQUIDATION_JOB as JOB, PRECISION, PRICE_DECIMALS } from './liquidationConstants';
import { requiresFullLiquidation } from './liquidationSizing';
import type { KeeperJobDeps, KeeperTxSender } from './ports';

/**
 * Liquidation while paused or frozen.
 *
 * What still works depends on which stop is on (GoldVault and GoldOracle):
 *   - the VAULT paused: liquidateViaPool still runs and prices through getEmergencyPrice
 *     exactly as emergencyLiquidate does, so the keeper tries the pool first, at no
 *     cost to its own wallet, and only then emergencyLiquidate from its own GSUSD;
 *   - the ORACLE paused: liquidateViaPool also uses getEmergencyPrice, so the
 *     funded pool remains the first path and emergencyLiquidate is the fallback;
 *   - the token FROZEN by the guardian or governance, paused or not: every seizure stops,
 *     getEmergencyPrice included ("Token frozen"), so the keeper
 *     reports the vault blocked. A freeze lapses after 14 days unless the guardian extends it.
 * emergencyLiquidate pays from the keeper's own GSUSD, so it runs only when the direct
 * path is armed and funded, in full or, for a wallet short of the debt, with the largest
 * partial the vault accepts (see attemptDirectLiquidation); in every other case the keeper
 * says plainly that liquidation is blocked and why.
 */

export interface PauseState {
  oraclePaused: boolean;
  vaultPaused: boolean;
  /** GoldOracle.tokenFrozen for this vault's collateral token. */
  tokenFrozen: boolean;
}

export const isPaused = (pause: PauseState): boolean =>
  pause.oraclePaused || pause.vaultPaused || pause.tokenFrozen;

const readFlag = async (
  deps: KeeperJobDeps,
  address: Address,
  abi: typeof goldOracleKeeperAbi | typeof goldVaultKeeperAbi,
  functionName: string,
  label: string,
  args?: readonly unknown[]
): Promise<boolean> =>
  expectBoolean(await deps.read.readContract({ address, abi, functionName, args }), label);

export const readPauseState = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  collateralToken: Address
): Promise<PauseState> => ({
  oraclePaused: await readFlag(deps, config.goldOracleAddress, goldOracleKeeperAbi, 'paused', 'oracle.paused'),
  vaultPaused: await readFlag(deps, config.goldVaultAddress, goldVaultKeeperAbi, 'paused', 'vault.paused'),
  tokenFrozen: await readFlag(
    deps,
    config.goldOracleAddress,
    goldOracleKeeperAbi,
    'tokenFrozen',
    'oracle.tokenFrozen',
    [collateralToken]
  ),
});

export interface EmergencyCandidate {
  owner: Address;
  /** Fee-inclusive debt, getVaultCurrentDebt. */
  debt: bigint;
  collateralToken: Address;
  /** Collateral in the token's native decimals. */
  collateralAmount: bigint;
  decimals: number;
  liquidationRatio: bigint;
  /**
   * vaults().debtAmount and collateralTypes().liquidationPenalty. With both, a wallet short
   * of the whole debt sends the largest partial emergencyLiquidate accepts; without either
   * the direct path is the full liquidation or nothing.
   */
  principal?: bigint;
  penaltyPpm?: bigint;
  /** GoldVault.minDebt as read from the chain; undefined sizes no partial. */
  minDebt?: bigint;
}

/** The partial terms for emergencyLiquidate at the emergency price, when the candidate carries them. */
const partialTermsAt = (candidate: EmergencyCandidate, price: bigint): DirectPartialTerms | undefined => {
  const { principal, penaltyPpm } = candidate;
  if (principal === undefined || penaltyPpm === undefined) return undefined;
  return {
    principal,
    fullOnly: requiresFullLiquidation({
      collateralAmount: candidate.collateralAmount,
      decimals: candidate.decimals,
      price,
      debt: candidate.debt,
      penaltyPpm,
    }),
    minDebt: candidate.minDebt,
  };
};

type EmergencyPricing =
  | { ok: true; price: bigint; ratio: bigint }
  | { ok: false; reason: string };

/**
 * GoldVault.emergencyLiquidate parity. The oracle's getEmergencyPrice is exactly the
 * price the vault uses, so the keeper reads it rather than re-deriving it, then applies
 * the vault's own gate, ratio < liquidationRatio, with the same integer arithmetic. A
 * revert ("Token frozen" for a frozen token, pause or not, "Not in emergency", "No
 * price") means the vault would revert too. getEmergencyPrice is the liquidation rule
 * itself, min(max(C, G), G x (1 + m)), and answers "No price" whenever C or G is
 * unhealthy: lastKnownPrice never prices a seizure, so the keeper attempts nothing then.
 */
/**
 * The pool path while the vault or oracle is paused, sized at the emergency price. `done` is
 * true when the pool took the vault, or may have (an unreadable receipt), so nothing may
 * compete; `residualLeft` says a confirmed partial fill left debt behind.
 */
export type EmergencyPoolAttempt = (emergencyPrice: bigint) => Promise<{ done: boolean; residualLeft?: boolean }>;

type ResidualRead = { ok: true; candidate: EmergencyCandidate } | { ok: false; reason: string };

/** The vault as the chain shows it after a partial fill: the debt and the collateral both shrink. */
const readAfterPartial = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  candidate: EmergencyCandidate
): Promise<ResidualRead> => {
  try {
    const debt = expectBigInt(
      await deps.read.readContract({
        address: config.goldVaultAddress,
        abi: goldVaultKeeperAbi,
        functionName: 'getVaultCurrentDebt',
        args: [candidate.owner],
      }),
      'getVaultCurrentDebt'
    );
    const vault = expectTuple(
      await deps.read.readContract({
        address: config.goldVaultAddress,
        abi: goldVaultKeeperAbi,
        functionName: 'vaults',
        args: [candidate.owner],
      }),
      3,
      'vaults'
    );
    return {
      ok: true,
      candidate: {
        ...candidate,
        debt,
        collateralAmount: expectBigInt(vault[1], 'vaults.collateralAmount'),
        // A candidate without the principal sizes no partial, before a fill or after one.
        ...(candidate.principal === undefined ? {} : { principal: expectBigInt(vault[2], 'vaults.debtAmount') }),
      },
    };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
};

const priceEmergency = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  candidate: EmergencyCandidate,
  vaultPaused: boolean
): Promise<EmergencyPricing> => {
  let price: bigint;
  try {
    price = expectBigInt(
      await deps.read.readContract({
        address: config.goldOracleAddress,
        abi: goldOracleKeeperAbi,
        functionName: 'getEmergencyPrice',
        args: [candidate.collateralToken, vaultPaused],
      }),
      'getEmergencyPrice'
    );
  } catch (error) {
    return { ok: false, reason: `getEmergencyPrice reverted: ${describeError(error)}` };
  }
  if (price === 0n) {
    return { ok: false, reason: 'getEmergencyPrice returned 0' };
  }
  const normalised = candidate.collateralAmount * 10n ** BigInt(18 - candidate.decimals);
  const value = (normalised * price) / PRICE_DECIMALS;
  return { ok: true, price, ratio: (value * PRECISION) / candidate.debt };
};

const blockedReason = (outcome: 'disabled' | 'unfunded', poolTried: boolean): string => {
  const why = poolTried
    ? 'liquidateViaPool could not take the vault while the vault or oracle is paused'
    : 'no pool attempt was available while the vault or oracle is paused';
  return outcome === 'disabled'
    ? `${why} and the direct path is disabled; set KEEPER_ENABLE_DIRECT=true and fund the keeper wallet to use emergencyLiquidate`
    : `${why} and the keeper wallet cannot cover the debt for emergencyLiquidate, nor a partial the vault would accept`;
};

export const attemptEmergencyLiquidation = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  tx: KeeperTxSender,
  candidate: EmergencyCandidate,
  pause: PauseState,
  tryPool?: EmergencyPoolAttempt
): Promise<void> => {
  // GoldVault prices the pool path through getEmergencyPrice for either pause.
  const pool = pause.vaultPaused || pause.oraclePaused ? tryPool : undefined;
  const reportBlocked = (
    reason: string,
    priced: { price?: bigint; ratio?: bigint; poolTried?: boolean } = {}
  ): void => {
    deps.log.error(KEEPER_EVENTS.vaultLiquidationBlocked, {
      job: JOB,
      owner: candidate.owner,
      debt: candidate.debt,
      collateralToken: candidate.collateralToken,
      oraclePaused: pause.oraclePaused,
      vaultPaused: pause.vaultPaused,
      tokenFrozen: pause.tokenFrozen,
      enableDirect: config.enableDirect,
      poolTried: priced.poolTried ?? false,
      emergencyPrice: priced.price,
      ratio: priced.ratio,
      reason,
    });
  };
  const pricing = await priceEmergency(deps, config, candidate, pause.vaultPaused);
  if (!pricing.ok) {
    reportBlocked(pricing.reason);
    return;
  }
  const { price, ratio } = pricing;
  if (ratio >= candidate.liquidationRatio) {
    reportBlocked('the vault is not undercollateralised at getEmergencyPrice, the price the paused paths use', {
      price,
      ratio,
    });
    return;
  }
  const poolOutcome = pool !== undefined ? await pool(price) : undefined;
  let target = { candidate, price, ratio };
  if (poolOutcome?.done) {
    if (poolOutcome.residualLeft !== true) return;
    // The pool took what it could and left
    // debt behind. Settle it through emergencyLiquidate in this tick rather than the next,
    // from fresh reads: the partial shrank the debt and the collateral, and a partial above
    // the penalty band can restore the vault, so the vault's own gate runs again first.
    const fresh = await readAfterPartial(deps, config, candidate);
    if (!fresh.ok) {
      reportBlocked(`the residual after a partial pool fill could not be read: ${fresh.reason}`, { price, ratio, poolTried: true });
      return;
    }
    if (fresh.candidate.debt === 0n) return;
    const repriced = await priceEmergency(deps, config, fresh.candidate, pause.vaultPaused);
    if (!repriced.ok) {
      reportBlocked(repriced.reason, { poolTried: true });
      return;
    }
    if (repriced.ratio >= candidate.liquidationRatio) return;
    target = { candidate: fresh.candidate, price: repriced.price, ratio: repriced.ratio };
  }
  const outcome = await attemptDirectLiquidation(
    deps,
    config,
    tx,
    candidate.owner,
    target.candidate.debt,
    'emergencyLiquidate',
    partialTermsAt(target.candidate, target.price)
  );
  if (outcome === 'disabled' || outcome === 'unfunded') {
    reportBlocked(blockedReason(outcome, pool !== undefined), {
      price: target.price,
      ratio: target.ratio,
      poolTried: pool !== undefined,
    });
  }
};
