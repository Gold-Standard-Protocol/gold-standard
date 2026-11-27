/** GoldStabilityReserve.PPM: spreads and coverage use 1e6 fixed point. */
export const PPM = 1_000_000n;
/** Oracle prices carry 8 decimals; GSUSD carries 18, hence the 1e10 scale. */
const ORACLE_PRICE_SCALE = 10n ** 10n;
/** GoldStabilityReserve.MIN_SPREAD_PPM / MAX_SPREAD_PPM. */
export const MIN_SPREAD_PPM = 5_000n;
export const MAX_SPREAD_PPM = 50_000n;

export interface SwapPreview {
	/** The spread rate the preview used, ppm. */
	spreadPpm: bigint;
	/** The spread, in GSUSD. This is what goes to insurance as revenue. */
	spreadAmount: bigint;
	/** What the reserve values the gold against. Held as inventory, never burned. */
	net: bigint;
	/** Gold out, in the token's decimals. */
	goldOut: bigint;
	/** True when the contract would revert with "Swap too small". */
	tooSmall: boolean;
}

/**
 * Previews a swap exactly as GoldStabilityReserve.swapGsusdForGold computes it:
 *   fee     = mulDiv(gsusdIn, spread, PPM)
 *   goldOut = mulDiv(gsusdIn - fee, 10^decimals, price × 1e10)
 * The preview uses the UI oracle read; the executed price is the live validated read.
 */
export function previewSwap(
	gsusdIn: bigint,
	spreadPpm: bigint,
	tokenPrice8: bigint,
	tokenDecimals: number
): SwapPreview {
	const spreadAmount = (gsusdIn * spreadPpm) / PPM;
	const net = gsusdIn - spreadAmount;
	const goldOut =
		tokenPrice8 > 0n ? (net * 10n ** BigInt(tokenDecimals)) / (tokenPrice8 * ORACLE_PRICE_SCALE) : 0n;
	return { spreadPpm, spreadAmount, net, goldOut, tooSmall: gsusdIn > 0n && goldOut === 0n };
}

/**
 * The minGoldOut argument: the previewed gold less a tolerance in basis points, so a
 * price move between preview and execution beyond the tolerance reverts "Slippage"
 * rather than filling at a worse rate.
 */
export function computeMinGoldOut(goldOut: bigint, slippageBps: bigint): bigint {
	return (goldOut * (10_000n - slippageBps)) / 10_000n;
}
