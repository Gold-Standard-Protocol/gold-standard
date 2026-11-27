/**
 * Contract maths, reproduced exactly.
 *
 * Every function here mirrors a formula in contracts/src/core. Amounts are bigint in
 * the contracts' own units so the accounting identity can be asserted to the wei, not
 * to floating-point tolerance. Prices carry 8 decimals (the oracle), GSUSD and PAXG
 * carry 18, ratios and spreads use GoldVault's 1e6 fixed point.
 */

/** GoldVault.PRECISION: ratios, penalties and spreads. 1_000_000 = 100%. */
export const PPM = 1_000_000n;
/** GoldVault.PRICE_DECIMALS: oracle prices carry 8 decimals. */
export const PRICE_DECIMALS = 100_000_000n;
/** 18-decimal token unit. */
export const WAD = 10n ** 18n;
/** StabilityModule.PRECISION: per-second rate accumulator. */
export const RAY = 10n ** 18n;
export const SECONDS_PER_YEAR = 365n * 86_400n;
export const SECONDS_PER_DAY = 86_400n;
/** GoldVault.MIN_DEBT. */
export const MIN_DEBT = 100n * WAD;
/** GoldVault.underwaterDiscountPpm at deploy: underwater gold sells 2% below its value. */
export const DEFAULT_UNDERWATER_DISCOUNT_PPM = 20_000n;

/** OpenZeppelin Math.mulDiv, floor. */
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
	if (denominator === 0n) throw new Error('mulDiv: division by zero');
	return (a * b) / denominator;
}

/** Collateral value in 18-decimal USD: collateral (18) × price (8) / 1e8. */
export function collateralValueUsd(collateral18: bigint, price8: bigint): bigint {
	return mulDiv(collateral18, price8, PRICE_DECIMALS);
}

/**
 * GoldVault.getCollateralisationRatio: (value × PPM) / debt. Returns 2^256−1 for a
 * vault with no debt, exactly as the contract does.
 */
export function collateralRatio(collateral18: bigint, price8: bigint, debt18: bigint): bigint {
	if (debt18 === 0n) return 2n ** 256n - 1n;
	return mulDiv(collateralValueUsd(collateral18, price8), PPM, debt18);
}

/** StabilityModule._annualToPerSecond: RAY + bps × RAY / (10000 × seconds per year). */
export function perSecondRate(annualBps: bigint): bigint {
	return RAY + (annualBps * RAY) / (10_000n * SECONDS_PER_YEAR);
}

/**
 * MakerDAO-style rpow: x^n in `base` fixed point by exponentiation-by-squaring,
 * rounding half-up at each multiply exactly as StabilityModule._rpow does.
 */
export function rpow(x: bigint, n: bigint, base: bigint = RAY): bigint {
	if (n === 0n) return base;
	if (x === 0n) return 0n;
	const half = base / 2n;
	let z = n % 2n === 0n ? base : x;
	let b = x;
	let e = n / 2n;
	while (e > 0n) {
		b = (b * b + half) / base;
		if (e % 2n === 1n) z = (z * b + half) / base;
		e /= 2n;
	}
	return z;
}

/** Accumulator after `elapsed` seconds at `perSec`: acc × perSec^elapsed / RAY. */
export function accrueAccumulator(accumulator: bigint, perSec: bigint, elapsedSeconds: bigint): bigint {
	return mulDiv(accumulator, rpow(perSec, elapsedSeconds), RAY);
}

/** StabilityModule.getCurrentDebt: normalised × accumulator / RAY. */
export function currentDebt(normalised18: bigint, accumulator: bigint): bigint {
	return mulDiv(normalised18, accumulator, RAY);
}

/** StabilityModule.recordDebt rounds UP (protocol-favouring). */
export function normaliseDebtCeil(debt18: bigint, accumulator: bigint): bigint {
	const n = debt18 * RAY;
	return (n + accumulator - 1n) / accumulator;
}

/** StabilityModule.reduceDebt rounds down. */
export function normaliseDebtFloor(debt18: bigint, accumulator: bigint): bigint {
	return mulDiv(debt18, RAY, accumulator);
}

/** Why GoldVault._sizeSeizure refuses a liquidation, in its own revert strings. */
export type SeizureRefusal = 'Thin vault: liquidate in full' | 'Liquidation too small';

export type SeizureSizing =
	| {
			ok: true;
			/** GSUSD the liquidator actually pays. */
			repay: bigint;
			/** Collateral leaving the vault, native decimals. */
			seize: bigint;
			/** Collateral worth exactly `repay` at the price, never above `seize`. */
			debtEquivalent: bigint;
	  }
	| { ok: false; reason: SeizureRefusal };

const refuse = (reason: SeizureRefusal): SeizureSizing => ({ ok: false, reason });

const settleSeizure = (repay: bigint, seize: bigint, priceScale: bigint): SeizureSizing =>
	// A repayment too small to move any collateral is refused, as on chain.
	seize > 0n ? { ok: true, repay, seize, debtEquivalent: mulDiv(repay, PRICE_DECIMALS, priceScale) } : refuse('Liquidation too small');

/**
 * What an underwater vault repays: its gold's value less the discount, but never a
 * discount larger than the shortfall itself (the 2c minus d cap).
 */
const underwaterRepay = (coverable: bigint, currentDebt18: bigint, underwaterDiscountPpm: bigint): bigint => {
	const discounted = mulDiv(coverable, PPM - underwaterDiscountPpm, PPM);
	const shortfallCapped = 2n * coverable > currentDebt18 ? 2n * coverable - currentDebt18 : 0n;
	return shortfallCapped > discounted ? shortfallCapped : discounted;
};

/**
 * GoldVault._sizeSeizure, every liquidation path's sizing, ported verbatim. The model used to
 * scale the debt down whenever the full seizure did not fit
 * the collateral, which booked a vault between 100% and 105% as bad debt and priced every
 * underwater seizure at the penalty rather than the discount. Now, as on chain:
 *   - with room for the whole penalty, the seizure is the repayment times (1 + penalty);
 *   - below 100% plus the penalty, a partial is pro rata (the same share of the gold as of
 *     the debt) and a full liquidation takes all the gold for all the debt;
 *   - underwater (the gold worth less than the debt) only a full liquidation is accepted,
 *     and it repays the gold's value less underwaterDiscountPpm, capped at 2c minus d; the
 *     rest is bad debt.
 * Parity with the Solidity tests is pinned in mechanics.spec.ts.
 */
export function sizeSeizure(
	debtToRepay18: bigint,
	currentDebt18: bigint,
	collateralAmount: bigint,
	tokenPrice8: bigint,
	penaltyPpm: bigint,
	decimalScale: bigint,
	underwaterDiscountPpm: bigint
): SeizureSizing {
	const priceScale = tokenPrice8 * decimalScale;
	const fullSeize = mulDiv(currentDebt18 * (PPM + penaltyPpm), PRICE_DECIMALS, priceScale * PPM);
	if (fullSeize > collateralAmount) {
		// Pro rata; the whole of the gold on a full liquidation.
		const seize = mulDiv(collateralAmount, debtToRepay18, currentDebt18);
		const coverable = mulDiv(collateralAmount, priceScale, PRICE_DECIMALS);
		if (coverable >= currentDebt18) return settleSeizure(debtToRepay18, seize, priceScale);
		if (debtToRepay18 !== currentDebt18) return refuse('Thin vault: liquidate in full');
		return settleSeizure(underwaterRepay(coverable, currentDebt18, underwaterDiscountPpm), seize, priceScale);
	}
	const seize =
		debtToRepay18 === currentDebt18 ? fullSeize : mulDiv(debtToRepay18 * (PPM + penaltyPpm), PRICE_DECIMALS, priceScale * PPM);
	return settleSeizure(debtToRepay18, seize, priceScale);
}

export interface LiquidationOutcome {
	/** GSUSD the liquidator pays: what it asked to repay, or less once the vault is underwater. */
	debtRepaid18: bigint;
	collateralSeized18: bigint;
	toLiquidator18: bigint;
	toProtocol18: bigint;
}

export type LiquidationResult = ({ ok: true } & LiquidationOutcome) | { ok: false; reason: SeizureRefusal };

/**
 * GoldVault._liquidateDirect for the model's 18-decimal collateral: sizeSeizure, then the
 * penalty split. Whatever the seizure holds above the repayment's worth is the penalty
 * (possibly reduced, or the discount once underwater); the liquidator gets the repayment's
 * worth plus its share of that, the protocol the rest.
 */
export function liquidationSeizure(
	debtToRepay18: bigint,
	currentDebt18: bigint,
	price8: bigint,
	collateral18: bigint,
	penaltyPpm: bigint,
	liquidatorSharePpm: bigint,
	underwaterDiscountPpm: bigint = DEFAULT_UNDERWATER_DISCOUNT_PPM
): LiquidationResult {
	const sized = sizeSeizure(debtToRepay18, currentDebt18, collateral18, price8, penaltyPpm, 1n, underwaterDiscountPpm);
	if (!sized.ok) return sized;
	const bonus = mulDiv(sized.seize - sized.debtEquivalent, liquidatorSharePpm, PPM);
	const toLiquidator = sized.debtEquivalent + bonus;
	return {
		ok: true,
		debtRepaid18: sized.repay,
		collateralSeized18: sized.seize,
		toLiquidator18: toLiquidator,
		toProtocol18: sized.seize - toLiquidator,
	};
}

/**
 * GSR below-peg leg: gold out for GSUSD in at oracle price minus spread.
 *   goldOut = gsusdIn × (PPM − spread) / PPM × 1e8 / price
 * Same shape as RedemptionModule.redeem's collateralOut with the fee netted first.
 */
export function gsrGoldOut(gsusdIn18: bigint, price8: bigint, spreadPpm: bigint): bigint {
	const afterSpread = mulDiv(gsusdIn18, PPM - spreadPpm, PPM);
	return mulDiv(afterSpread, PRICE_DECIMALS, price8);
}

/** The spread portion of a below-peg swap, in GSUSD: what routes to insurance as fee. */
export function gsrSpreadTaken(gsusdIn18: bigint, spreadPpm: bigint): bigint {
	return mulDiv(gsusdIn18, spreadPpm, PPM);
}

/**
 * GSR above-peg leg (Phase 2): GSUSD out for gold in, valued at oracle minus a
 * haircut, minus spread. The haircut is the protocol refusing to pay full oracle for
 * incoming gold; the spread is its margin.
 */
export function gsrGsusdOut(goldIn18: bigint, price8: bigint, spreadPpm: bigint, haircutPpm: bigint): bigint {
	const valued = mulDiv(collateralValueUsd(goldIn18, price8), PPM - haircutPpm, PPM);
	return mulDiv(valued, PPM - spreadPpm, PPM);
}

/**
 * A utilisation spread curve: steps of [coverage at least (ppm), spread (ppm)] sorted
 * by coverage descending. The first step whose threshold the current coverage meets
 * applies; below every threshold, `restrictedSpreadPpm` applies.
 */
export interface SpreadCurve {
	steps: ReadonlyArray<readonly [coverageAtLeastPpm: bigint, spreadPpm: bigint]>;
	restrictedSpreadPpm: bigint;
}

export function utilisationSpread(coveragePpm: bigint, curve: SpreadCurve): bigint {
	for (const [threshold, spread] of curve.steps) {
		if (coveragePpm >= threshold) return spread;
	}
	return curve.restrictedSpreadPpm;
}

/** Coverage: redeemable reserve value ÷ circulating supply, in ppm. */
export function coveragePpm(reserveValueUsd18: bigint, circulating18: bigint): bigint {
	if (circulating18 === 0n) return PPM * 1000n;
	return mulDiv(reserveValueUsd18, PPM, circulating18);
}

/** GoldStabilityReserve.MIN_SPREAD_PPM and MAX_SPREAD_PPM: setSpreadCurve's bounds. */
export const MIN_SPREAD_PPM = 5_000n;
export const MAX_SPREAD_PPM = 50_000n;
/** GoldStabilityReserve.MAX_SPREAD_STEPS. */
export const MAX_SPREAD_STEPS = 8;

/**
 * The reason GoldStabilityReserve.setSpreadCurve would refuse `curve`, in its own words,
 * or undefined when the curve could be set on chain. A run on a curve the contract
 * refuses says nothing about the deployed reserve.
 */
export function spreadCurveRefusal(curve: SpreadCurve): string | undefined {
	if (curve.steps.length > MAX_SPREAD_STEPS) return 'Too many steps';
	const restricted = curve.restrictedSpreadPpm;
	if (restricted < MIN_SPREAD_PPM || restricted > MAX_SPREAD_PPM) return 'Restricted spread out of range';
	let lastCoverage: bigint | undefined;
	let lastSpread = 0n;
	for (const [coverage, spread] of curve.steps) {
		if (lastCoverage !== undefined && coverage >= lastCoverage) return 'Steps must descend in coverage';
		if (spread < MIN_SPREAD_PPM || spread > MAX_SPREAD_PPM) return 'Spread out of range';
		if (spread < lastSpread) return 'Spreads must ascend';
		if (spread > restricted) return 'Step exceeds restricted spread';
		lastCoverage = coverage;
		lastSpread = spread;
	}
	return undefined;
}

/**
 * GoldStabilityReserve.dampedCirculatingSupply: the higher of the live and the smoothed
 * supply, each less the reserve's own inventory, so a burn is credited only as it ages.
 */
export function dampedCirculatingSupply(liveSupply18: bigint, smoothedSupply18: bigint, inventory18: bigint): bigint {
	const live = liveSupply18 > inventory18 ? liveSupply18 - inventory18 : 0n;
	const smoothed = smoothedSupply18 > inventory18 ? smoothedSupply18 - inventory18 : 0n;
	return live > smoothed ? live : smoothed;
}

/**
 * GoldStabilityReserve._swapSpreadPpm: the tier of the coverage a swap of `gsusdIn18`
 * leaves behind, with the gold leaving valued at the whole input and the supply left
 * where it stands. A swap of zero is currentSpreadPpm().
 */
export function swapSpreadPpm(
	reserveValueUsd18: bigint,
	gsusdIn18: bigint,
	dampedCirculating18: bigint,
	curve: SpreadCurve
): bigint {
	if (dampedCirculating18 === 0n) return utilisationSpread(PPM * 1000n, curve);
	const remaining = reserveValueUsd18 > gsusdIn18 ? reserveValueUsd18 - gsusdIn18 : 0n;
	return utilisationSpread(mulDiv(remaining, PPM, dampedCirculating18), curve);
}

/** Convert a float USD price to the oracle's 8-decimal bigint. */
export function toPrice8(usd: number): bigint {
	return BigInt(Math.round(usd * 1e8));
}

/** Convert an 18-decimal bigint to a float for agent decisions and reporting. */
export function toNumber18(x: bigint): number {
	return Number(x / 10n ** 12n) / 1e6;
}

/** Convert a float to an 18-decimal bigint (floor). */
export function fromNumber18(x: number): bigint {
	if (!Number.isFinite(x) || x <= 0) return 0n;
	return BigInt(Math.floor(x * 1e6)) * 10n ** 12n;
}
