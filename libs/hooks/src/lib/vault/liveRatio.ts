/** GoldVault.PRECISION: ratios are 1e6 fixed point (1_300_000 = 130%). */
export const RATIO_PRECISION = 1_000_000n;

/**
 * GoldVault.getCollateralisationRatio returns type(uint256).max for a vault with no debt.
 * Divided naively that renders as "1.1579208923731619e+73%", which is what the position
 * card showed after a full repayment.
 */
export const NO_DEBT_RATIO = 2n ** 256n - 1n;

/**
 * Where a collateral ratio was priced:
 *   - 'live': quoteTokenPrice, the view twin of the price GoldVault.liquidate settles at;
 *   - 'stored': getCollateralisationRatio, which prices at the oracle's lastKnownPrice and
 *     can lag a quiet market move by as much as the keeper lets it drift.
 */
export type RatioSource = 'live' | 'stored';

/**
 * The ratio at the live liquidation quote, as the keeper computes it: liquidationRatio x
 * quoteTokenPrice / getLiquidationPrice. getLiquidationPrice
 * is oracle free (the 8 decimal price at which this vault crosses its liquidation ratio),
 * so the ratio follows linearly from any price in the same units. Undefined when the vault
 * has no liquidation price (no debt or no collateral). Pure.
 */
export function liveCollateralRatio(
	liquidationRatio: bigint,
	quote8: bigint,
	liquidationPrice8: bigint
): bigint | undefined {
	if (liquidationPrice8 <= 0n || liquidationRatio <= 0n || quote8 <= 0n) return undefined;
	return (liquidationRatio * quote8) / liquidationPrice8;
}

/** What is known about the live quote for a collateral: its price, a refusal, or nothing yet. */
export type LiveQuote = { price8: bigint } | { refused: true } | undefined;

export interface ResolvedRatio {
	ratio: bigint | undefined;
	/** Undefined for a ratio no price decides (no debt, no collateral) and while loading. */
	source: RatioSource | undefined;
}

/**
 * The ratio to show and how it was priced. The live quote decides whenever it answers; the
 * stored view is used only when the quote was refused (the caller says so visibly), and for
 * the two states no price changes: no debt, and debt against no collateral. Pure and
 * exported for tests.
 */
export function resolveCollateralRatio(input: {
	storedRatio: bigint | undefined;
	liquidationPrice: bigint | undefined;
	liquidationRatio: bigint | undefined;
	quote: LiveQuote;
}): ResolvedRatio {
	const { storedRatio, liquidationPrice, liquidationRatio, quote } = input;
	if (storedRatio === NO_DEBT_RATIO) return { ratio: NO_DEBT_RATIO, source: undefined };
	// Debt against no collateral has no liquidation price and a stored ratio of zero at any price.
	if (liquidationPrice === 0n && storedRatio !== undefined) return { ratio: storedRatio, source: undefined };
	if (quote && 'refused' in quote) {
		return storedRatio === undefined ? { ratio: undefined, source: undefined } : { ratio: storedRatio, source: 'stored' };
	}
	if (quote && liquidationPrice !== undefined && liquidationRatio !== undefined) {
		const live = liveCollateralRatio(liquidationRatio, quote.price8, liquidationPrice);
		if (live !== undefined) return { ratio: live, source: 'live' };
	}
	return { ratio: undefined, source: undefined };
}

/** A 1e6 fixed-point ratio as a percentage; Infinity for the no-debt sentinel. Pure. */
export function ratioToPercent(ratio: bigint): number {
	if (ratio === NO_DEBT_RATIO) return Infinity;
	return (Number(ratio) / Number(RATIO_PRECISION)) * 100;
}
