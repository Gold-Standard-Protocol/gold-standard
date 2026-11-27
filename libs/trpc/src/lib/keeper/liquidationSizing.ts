import { PRECISION, PRICE_DECIMALS } from './liquidationConstants';

export interface FullLiquidationInput {
  /** Collateral in the token's native decimals (vaults().collateralAmount). */
  collateralAmount: bigint;
  decimals: number;
  /** 8-decimal gold price the vault will price the seizure at. */
  price: bigint;
  /** Current debt including accrued fees. */
  debt: bigint;
  /** collateralTypes().liquidationPenalty in parts per million. */
  penaltyPpm: bigint;
}

const priceScaleOf = (input: FullLiquidationInput): bigint => input.price * 10n ** BigInt(18 - input.decimals);

/** The gold's value in GSUSD (18 decimals) at the price, as _sizeSeizure's `coverable`. */
const coverableOf = (input: FullLiquidationInput): bigint =>
  (input.collateralAmount * priceScaleOf(input)) / PRICE_DECIMALS;

/**
 * GoldVault._sizeSeizure's thin branch: a full seizure at the (1 + penalty) multiple
 * no longer fits in the vault's collateral, so a liquidation takes the gold pro rata
 * (a partial keeps the vault's ratio, a full one takes all of it). Same inputs, same
 * integer arithmetic, in the token's native units:
 *   fullSeize = debt * (PRECISION + penalty) * PRICE_DECIMALS / (price * scale * PRECISION)
 */
export const isThinVault = (input: FullLiquidationInput): boolean => {
  const fullSeize =
    (input.debt * (PRECISION + input.penaltyPpm) * PRICE_DECIMALS) / (priceScaleOf(input) * PRECISION);
  return fullSeize > input.collateralAmount;
};

/**
 * Parity with GoldVault._sizeSeizure: only an
 * UNDERWATER vault, one whose gold is worth less than its debt, refuses a partial
 * ("Thin vault: liquidate in full"). A thin but solvent vault, between 100% and 100%
 * plus the penalty, takes a pro-rata partial, so a pool smaller than it can work it
 * down; above that band a partial is sized at the full multiple as before.
 */
export const requiresFullLiquidation = (input: FullLiquidationInput): boolean =>
  isThinVault(input) && coverableOf(input) < input.debt;

/** The same underwater line read off a collateralisation ratio in ppm, for the degraded path. */
export const requiresFullLiquidationByRatio = (ratioPpm: bigint): boolean => ratioPpm < PRECISION;

/**
 * How much of `debt` the pool path should absorb: 0 for the whole position when the
 * pool covers it, a partial that leaves at least minDebt of principal and is at least
 * minDebt itself (worth the gas) or undefined when the pool path is not worth taking.
 * The caller never asks this of an underwater vault, which takes only a full liquidation.
 * `minDebt` is GoldVault.minDebt as read from the chain, undefined when the keeper has
 * never read it: a partial is then not sized at all, since any guess at the minimum either
 * reverts or leaves a vault the contract refuses.
 */
export const sizePoolAbsorb = (
  debt: bigint,
  principal: bigint,
  absorbable: bigint,
  minDebt: bigint | undefined
): bigint | undefined => {
  if (absorbable >= debt) return 0n;
  if (minDebt === undefined) return undefined;
  // GoldVault allocates principal pro rata: residual = principal * (1 - x / debt).
  const maxPartial =
    principal > minDebt ? (debt * (principal - minDebt)) / principal : 0n;
  const partial = absorbable < maxPartial ? absorbable : maxPartial;
  return partial >= minDebt ? partial : undefined;
};

/**
 * How much of `debt` the keeper wallet should repay directly when its GSUSD `balance` cannot
 * fund a full liquidation (the debt plus the direct headroom): the largest partial
 * GoldVault._applySeizure accepts, or undefined when there is none worth sending. The rules
 * are sizePoolAbsorb's, on purpose, so the two paths never disagree: the partial leaves at
 * least minDebt of principal behind, is at least minDebt itself and is never sized while
 * minDebt is unknown. It is always strictly below the debt, since liquidate pulls exactly the
 * amount asked and a figure equal to the debt read now is a partial one block later that
 * strands the fee accrued meanwhile ("Residual debt below minimum"). The caller never asks
 * this of an underwater vault, which takes only a full liquidation.
 */
export const sizeDirectPartial = (
  debt: bigint,
  principal: bigint,
  balance: bigint,
  minDebt: bigint | undefined
): bigint | undefined => {
  if (debt <= 1n || balance <= 0n) return undefined;
  const spendable = balance < debt ? balance : debt - 1n;
  const partial = sizePoolAbsorb(debt, principal, spendable, minDebt);
  return partial === undefined || partial === 0n ? undefined : partial;
};

export interface FullRepayInput extends FullLiquidationInput {
  /** GoldVault.underwaterDiscountPpm. */
  discountPpm: bigint;
}

/**
 * Parity with GoldVault.liquidateViaPool. What a full liquidation actually repays, which is what the pool
 * must strictly exceed: GoldVault.liquidateViaPool checks getTotalDeposits() > repay
 * after _sizeSeizure, not against the nominal debt. While the gold still covers the
 * debt, thin or not, the repayment is the debt. Underwater it is the gold's
 * value less the discount, and the discount never exceeds the shortfall itself:
 *   coverable = collateral * price * scale / PRICE_DECIMALS
 *   repay = coverable * (PRECISION - discount) / PRECISION
 *   if 2 * coverable > debt and 2 * coverable - debt > repay: repay = 2 * coverable - debt
 */
export const fullLiquidationRepay = (input: FullRepayInput): bigint => {
  if (!isThinVault(input)) return input.debt;
  const coverable = coverableOf(input);
  if (coverable >= input.debt) return input.debt;
  const discounted = (coverable * (PRECISION - input.discountPpm)) / PRECISION;
  const capped = 2n * coverable - input.debt;
  return 2n * coverable > input.debt && capped > discounted ? capped : discounted;
};
