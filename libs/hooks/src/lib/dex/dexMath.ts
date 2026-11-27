import { parseAmount } from '@goldstandard/utils';

const BPS_DENOMINATOR = 10_000n;
/** GSUSD carries 18 decimals; the oracle quotes gold with 8, and implied prices match it. */
const GSUSD_DECIMALS = 18;
const PRICE_DECIMALS = 8;

/**
 * The amountOutMinimum argument for the router: the quoted output less a tolerance in
 * basis points, so a pool move between quote and execution beyond the tolerance
 * reverts "Too little received" rather than filling at a worse rate. Same shape as
 * computeMinGoldOut for the reserve, kept separate so the two legs cannot drift apart
 * silently if one of them ever changes.
 */
export function computeMinAmountOut(amountOut: bigint, slippageBps: bigint): bigint {
	return (amountOut * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
}

/**
 * The gold price a market quote implies, as GSUSD per one gold token with 8 decimals,
 * on the oracle's own scale so the two can sit side by side on screen. Direction does
 * not matter: pass whichever side is GSUSD and whichever is gold. Undefined when the
 * gold side is zero, because there is no price in a quote that pays nothing.
 */
export function impliedGoldPrice8(
	gsusdAmount: bigint,
	goldAmount: bigint,
	goldDecimals: number
): bigint | undefined {
	if (goldAmount <= 0n || gsusdAmount < 0n) return undefined;
	return (
		(gsusdAmount * 10n ** BigInt(goldDecimals) * 10n ** BigInt(PRICE_DECIMALS)) /
		(goldAmount * 10n ** BigInt(GSUSD_DECIMALS))
	);
}

/** A fill this far worse than the oracle gets a warning (200 = 2.00%). */
export const PRICE_IMPACT_WARN_BPS = 200n;
/** A fill this far worse than the oracle needs an explicit acknowledgement (500 = 5.00%). */
export const PRICE_IMPACT_CONFIRM_BPS = 500n;

export type PriceImpactLevel = 'ok' | 'warn' | 'severe';

/**
 * How much worse than the oracle a market fill is, in basis points, from the point of
 * view of the person trading: a seller of gold is hurt by an implied price below the
 * oracle, a buyer by one above it. A fill that beats the oracle reads as zero. The pool
 * fee alone accounts for 30 basis points at the standard tier; anything near the
 * warning line is the pool running out of depth, not a fee.
 */
export function adverseDeviationBps(
	impliedPrice8: bigint | undefined,
	oraclePrice8: bigint | undefined,
	sellingGold: boolean
): bigint | undefined {
	if (impliedPrice8 === undefined || oraclePrice8 === undefined || oraclePrice8 <= 0n) return undefined;
	const adverse = sellingGold ? oraclePrice8 - impliedPrice8 : impliedPrice8 - oraclePrice8;
	if (adverse <= 0n) return 0n;
	return (adverse * BPS_DENOMINATOR) / oraclePrice8;
}

export function priceImpactLevel(deviationBps: bigint | undefined): PriceImpactLevel {
	if (deviationBps === undefined) return 'ok';
	if (deviationBps >= PRICE_IMPACT_CONFIRM_BPS) return 'severe';
	if (deviationBps >= PRICE_IMPACT_WARN_BPS) return 'warn';
	return 'ok';
}

/** Basis points as a percentage with one decimal, rounded down: 5714 is "57.1%". */
export function formatDeviationBps(bps: bigint): string {
	const tenths = bps / 10n;
	return `${tenths / 10n}.${tenths % 10n}%`;
}

/**
 * Parses a typed token amount without ever throwing into render, through the shared
 * parser in @goldstandard/utils: malformed text and excess decimals are refused, never rounded.
 * The market leg accepts gold as the input side, so this is decimals-aware.
 */
export function parseTokenAmount(amount: string | undefined, decimals: number): bigint | undefined {
	return parseAmount(amount, decimals);
}

/**
 * A Uniswap v3 fee tier as a percentage label: 3000 is "0.30%". Fee tiers are in
 * hundredths of a basis point, so 1e6 is 100%.
 */
export function poolFeeLabel(fee: number): string {
	return `${(fee / 10_000).toFixed(2)}%`;
}

export type BetterVenue = 'market' | 'reserve' | 'equal';

/**
 * Which venue pays more gold for the same GSUSD. Undefined until both quotes exist,
 * so the comparison line never claims a winner on one side of the data.
 */
export function compareVenues(
	marketOut: bigint | undefined,
	reserveOut: bigint | undefined
): BetterVenue | undefined {
	if (marketOut === undefined || reserveOut === undefined) return undefined;
	if (marketOut > reserveOut) return 'market';
	if (reserveOut > marketOut) return 'reserve';
	return 'equal';
}
