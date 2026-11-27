import { describe, expect, it } from 'vitest';
import { MAX_RATIO_RESERVE_PER_100K } from '@goldstandard/hooks';
import { maxWithdrawable } from './withdrawPlan';

const PRICE = 400_000_000_000n; // $4,000
const MIN = 1_300_000n; // 130%
const NO_RESERVE = 0n;
const E18 = 10n ** 18n;
const YEAR_SECONDS = 31_536_000n;

/** GoldVault.withdraw's own ratio test, floor for floor, against the debt it will see. */
function contractAccepts(remaining: bigint, debt: bigint, decimals: number): boolean {
	const collateralValue = (remaining * 10n ** BigInt(18 - decimals) * PRICE) / 100_000_000n;
	return (collateralValue * 1_000_000n) / debt >= MIN;
}

/** The debt after `seconds` of a 2% annual stability fee. */
const accrued = (debt: bigint, seconds: bigint): bigint => debt + (debt * 2n * seconds) / (100n * YEAR_SECONDS);

describe('maxWithdrawable', () => {
	it('keeps debt × 130% of gold behind: 100 PAXG against 50,000 GSUSD frees 83.75', () => {
		const out = maxWithdrawable(100n * 10n ** 18n, 50_000n * 10n ** 18n, PRICE, MIN, 18, NO_RESERVE);
		expect(out).toBe(83_750_000_000_000_000_000n);
	});

	it('releases everything when there is no debt', () => {
		expect(maxWithdrawable(5n * 10n ** 18n, 0n, PRICE, MIN, 18)).toBe(5n * 10n ** 18n);
	});

	it('frees nothing when the vault is already at or below the minimum', () => {
		// 16.25 PAXG is exactly what 50,000 GSUSD needs at 130%.
		expect(maxWithdrawable(16_250_000_000_000_000_000n, 50_000n * 10n ** 18n, PRICE, MIN, 18)).toBe(0n);
	});

	it('never quotes a figure the contract would refuse by a wei at 18 decimals', () => {
		// The real-valued bound leaves 324_999_999_999_187_504 wei, which the contract's two
		// floors turn into a ratio of 1_299_999; one more wei behind gives 1_300_000.
		const debt = 1_000_000_000_000_000_012_307n;
		const price = 400_000_000_001n;
		const out = maxWithdrawable(10n ** 18n, debt, price, MIN, 18, NO_RESERVE);
		const remaining = 10n ** 18n - out;
		expect(remaining).toBe(324_999_999_999_187_505n);
		const ratio = ((remaining * price) / 100_000_000n) * 1_000_000n / debt;
		expect(ratio).toBeGreaterThanOrEqual(MIN);
		// And one wei less behind would have reverted.
		const ratioBelow = (((remaining - 1n) * price) / 100_000_000n) * 1_000_000n / debt;
		expect(ratioBelow).toBeLessThan(MIN);
	});

	it('works in XAUT decimals', () => {
		// 100 XAUT (6 dec) against 50,000 GSUSD: required 16.25 XAUT = 16_250_000
		expect(maxWithdrawable(100_000_000n, 50_000n * 10n ** 18n, PRICE, MIN, 6, NO_RESERVE)).toBe(83_750_000n);
	});

	it('leaves the Mint Max reserve behind: 100 PAXG against 50,000 GSUSD frees 83.709375', () => {
		const out = maxWithdrawable(100n * E18, 50_000n * E18, PRICE, MIN, 18);
		expect(out).toBe(83_709_375_000_000_000_000n);
		const grownDebt = 50_000n * E18 + (50_000n * E18 * MAX_RATIO_RESERVE_PER_100K) / 100_000n;
		expect(out).toBe(maxWithdrawable(100n * E18, grownDebt, PRICE, MIN, 18, NO_RESERVE));
	});

	it('still satisfies the ratio after a minute of fee accrual on a vault left at the edge', () => {
		const debt = 50_000n * E18;
		const out = maxWithdrawable(100n * E18, debt, PRICE, MIN, 18);
		expect(contractAccepts(100n * E18 - out, debt, 18)).toBe(true);
		expect(contractAccepts(100n * E18 - out, accrued(debt, 60n), 18)).toBe(true);
	});

	it('does the same in XAUT decimals', () => {
		const debt = 50_000n * E18;
		const out = maxWithdrawable(100_000_000n, debt, PRICE, MIN, 6);
		expect(contractAccepts(100_000_000n - out, accrued(debt, 60n), 6)).toBe(true);
	});

	it('gives a vault with no debt every unit of its collateral, in either decimals', () => {
		expect(maxWithdrawable(5n * E18, 0n, PRICE, MIN, 18)).toBe(5n * E18);
		expect(maxWithdrawable(5_000_000n, 0n, PRICE, MIN, 6)).toBe(5_000_000n);
	});
});
