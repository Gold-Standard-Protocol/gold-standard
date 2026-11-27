import { MAX_RATIO_RESERVE_PER_100K } from '@goldstandard/hooks';

/** GoldVault.PRECISION: ratios are 1e6 fixed point. */
const PRECISION = 1_000_000n;
/** GoldVault.PRICE_DECIMALS: oracle prices carry 8 decimals. */
const PRICE_DECIMALS = 100_000_000n;
/** The reserve is expressed in parts per 100,000. */
const RESERVE_DENOMINATOR = 100_000n;

/**
 * GoldVault.withdraw's own test, reproduced floor for floor: the remaining collateral is
 * normalised to 18 decimals, valued at the oracle price (one floor), and that value is
 * turned into a ratio against the fee-inclusive debt (a second floor).
 */
function contractAccepts(
	remaining: bigint,
	currentDebt: bigint,
	price8: bigint,
	minRatioPpm: bigint,
	decimals: number
): boolean {
	const normalised = remaining * 10n ** BigInt(18 - decimals);
	const collateralValue = (normalised * price8) / PRICE_DECIMALS;
	return (collateralValue * PRECISION) / currentDebt >= minRatioPpm;
}

/**
 * The most collateral a vault can release while staying at or above the minimum ratio,
 * in the collateral's own decimals.
 *
 * With debt outstanding the vault must keep `debt × minRatio / price` of collateral. The
 * previous Max offered the whole balance, which at 50,000 GSUSD against 100 PAXG quoted
 * 100 PAXG when only 83.75 could actually leave. Rounds the required collateral UP, then
 * checks the figure against the contract's exact integer arithmetic: the contract floors
 * twice on the way to its ratio, so the real-valued bound can still be a wei short for an
 * 18-decimal token, and a quoted Max must never fail the contract's own check.
 *
 * Fees accrue every second, so the debt the contract judges is a little larger than the
 * quote. With debt outstanding the ratio is therefore held against the debt grown by the
 * same reserve Mint Max leaves, or a Max sized to the last wei fails in the block that
 * includes it. A vault with no debt accrues nothing and releases everything.
 *
 * @param collateralAmount  Vault collateral, token decimals.
 * @param currentDebt       Fee-inclusive debt, 18 decimals.
 * @param price8            Oracle price, 8 decimals.
 * @param minRatioPpm       Minimum ratio, 1e6 fixed point (1_300_000 = 130%).
 * @param decimals          Collateral token decimals (PAXG 18, XAUT 6).
 * @param reservePer100k    Debt growth to allow for, parts per 100,000. The shared Mint Max reserve.
 */
export function maxWithdrawable(
	collateralAmount: bigint,
	currentDebt: bigint,
	price8: bigint,
	minRatioPpm: bigint,
	decimals: number,
	reservePer100k: bigint = MAX_RATIO_RESERVE_PER_100K
): bigint {
	if (currentDebt <= 0n) return collateralAmount;
	if (price8 <= 0n) return 0n;
	const debt = currentDebt + (currentDebt * reservePer100k + RESERVE_DENOMINATOR - 1n) / RESERVE_DENOMINATOR;
	// required = ceil(debt × minRatio × 10^decimals / (price × 1e10 × 1e6))
	const numerator = debt * minRatioPpm * 10n ** BigInt(decimals);
	const denominator = price8 * 10n ** 10n * PRECISION;
	let required = (numerator + denominator - 1n) / denominator;
	// The floors cost at most a wei or two; one extra wei of gold is worth far more than
	// either loss, so this settles almost immediately. The cap only guards a misuse.
	for (let bump = 0; bump < 16 && !contractAccepts(required, debt, price8, minRatioPpm, decimals); bump++) {
		required += 1n;
	}
	if (!contractAccepts(required, debt, price8, minRatioPpm, decimals)) return 0n;
	return collateralAmount > required ? collateralAmount - required : 0n;
}
