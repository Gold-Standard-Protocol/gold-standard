import { describe, expect, it } from 'vitest';
import { keeperBounty, previewLiquidation } from './liquidationPlan';

const PRICE = 280_000_000_000n; // $2,800
const PENALTY = 50_000n; // 5%
const SHARE = 600_000n; // 60% to the liquidator
const DISCOUNT = 20_000n; // GoldVault.underwaterDiscountPpm default, 2%

describe('previewLiquidation mirrors GoldVault.liquidate', () => {
	it('pays the liquidator the debt in gold plus 60% of a 5% penalty: a 3% discount', () => {
		const p = previewLiquidation(2_800n * 10n ** 18n, 2_800n * 10n ** 18n, 10n * 10n ** 18n, PRICE, PENALTY, SHARE, 18, DISCOUNT);
		expect(p).toBeDefined();
		// 2,800 GSUSD at $2,800 = 1 PAXG debt-equivalent; seize 1.05; liquidator 1.03; protocol 0.02
		expect(p?.collateralSeized).toBe(1_050_000_000_000_000_000n);
		expect(p?.liquidatorPayout).toBe(1_030_000_000_000_000_000n);
		expect(p?.protocolPayout).toBe(20_000_000_000_000_000n);
		expect(p?.totalPenalty).toBe(50_000_000_000_000_000n);
		expect(p?.bonusPercent).toBe(3);
		expect(p?.clamped).toBe(false);
	});

	it('cuts the penalty, not the debt, when the vault is thin but still solvent', () => {
		// 5 PAXG worth $14,000 against 13,800 of debt: the full 5% penalty does not fit.
		const debt = 13_800n * 10n ** 18n;
		const p = previewLiquidation(debt, debt, 5n * 10n ** 18n, PRICE, PENALTY, SHARE, 18, DISCOUNT);
		expect(p?.collateralSeized).toBe(5n * 10n ** 18n);
		expect(p?.clamped).toBe(true);
		expect(p?.refused).toBe(false);
		expect(p?.debtRepaid).toBe(debt);
		// The whole vault is 5 PAXG; the debt is worth 4.9286; the penalty is the difference.
		const debtEquivalent = (debt * 100_000_000n) / PRICE;
		expect(p?.totalPenalty).toBe(5n * 10n ** 18n - debtEquivalent);
	});

	it('cuts the debt to what the gold is worth less the discount only when the vault is insolvent', () => {
		// 5 PAXG worth $14,000 against 28,000 of debt: 2% under $14,000 is 13,720.
		const debt = 28_000n * 10n ** 18n;
		const p = previewLiquidation(debt, debt, 5n * 10n ** 18n, PRICE, PENALTY, SHARE, 18, DISCOUNT);
		expect(p?.underwater).toBe(true);
		expect(p?.collateralSeized).toBe(5n * 10n ** 18n);
		expect(p?.debtRepaid).toBe(13_720n * 10n ** 18n);
		// 13,720 buys 4.9 PAXG; the 0.1 PAXG above it is split as a penalty.
		expect(p?.totalPenalty).toBe(100_000_000_000_000_000n);
		expect(p?.liquidatorPayout).toBe(4_960_000_000_000_000_000n);
	});

	it('caps the discount at the shortfall just under water', () => {
		// 5 PAXG worth $14,000 against 14,100 of debt: the flat 2% would repay 13,720, but
		// 2 × 14,000 − 14,100 = 13,900 is higher, so the buffer pays at most twice the hole.
		const debt = 14_100n * 10n ** 18n;
		const p = previewLiquidation(debt, debt, 5n * 10n ** 18n, PRICE, PENALTY, SHARE, 18, DISCOUNT);
		expect(p?.underwater).toBe(true);
		expect(p?.debtRepaid).toBe(13_900n * 10n ** 18n);
	});

	it('refuses a partial on an underwater vault: the shortfall is booked at once', () => {
		const debt = 28_000n * 10n ** 18n;
		const p = previewLiquidation(debt - 10n ** 18n, debt, 5n * 10n ** 18n, PRICE, PENALTY, SHARE, 18, DISCOUNT);
		expect(p?.refused).toBe(true);
	});

	it('takes a partial below 100% plus the penalty pro rata, keeping the ratio', () => {
		// 5 PAXG worth $14,000 against 13,461.54 of debt: 104%. At the full penalty multiple
		// the largest fitting partial would leave 1 wei of gold against thousands of GSUSD;
		// pro rata, half the debt takes half the gold and the vault stays at 104%.
		const debt = 13_461_538_461_538_461_538_461n;
		const half = debt / 2n;
		const p = previewLiquidation(half, debt, 5n * 10n ** 18n, PRICE, PENALTY, SHARE, 18, DISCOUNT);
		expect(p?.refused).toBe(false);
		expect(p?.clamped).toBe(true);
		expect(p?.underwater).toBe(false);
		expect(p?.debtRepaid).toBe(half);
		expect(p?.collateralSeized).toBe((5n * 10n ** 18n * half) / debt);
		const full = previewLiquidation(debt, debt, 5n * 10n ** 18n, PRICE, PENALTY, SHARE, 18, DISCOUNT);
		expect(full?.refused).toBe(false);
		expect(full?.collateralSeized).toBe(5n * 10n ** 18n);
		expect(full?.debtRepaid).toBe(debt);
	});

	it('still accepts a partial just above 100% plus the penalty', () => {
		// 5 PAXG worth $14,000 against 13,200 of debt: 106.06%.
		const debt = 13_200n * 10n ** 18n;
		const p = previewLiquidation(6_000n * 10n ** 18n, debt, 5n * 10n ** 18n, PRICE, PENALTY, SHARE, 18, DISCOUNT);
		expect(p?.refused).toBe(false);
		expect(p?.clamped).toBe(false);
		expect(p?.collateralSeized).toBe((6_000n * 10n ** 18n * 1_050_000n * 100_000_000n) / (PRICE * 1_000_000n));
	});

	it('works in XAUT decimals', () => {
		const p = previewLiquidation(2_800n * 10n ** 18n, 2_800n * 10n ** 18n, 10_000_000n, PRICE, PENALTY, SHARE, 6, DISCOUNT);
		expect(p?.collateralSeized).toBe(1_050_000n);
		expect(p?.liquidatorPayout).toBe(1_030_000n);
	});

	it('returns undefined without a price or an amount', () => {
		expect(previewLiquidation(0n, 1n, 1n, PRICE, PENALTY, SHARE, 18, DISCOUNT)).toBeUndefined();
		expect(previewLiquidation(1n, 1n, 1n, 0n, PENALTY, SHARE, 18, DISCOUNT)).toBeUndefined();
	});

	it('uses the governed underwater discount when gold cannot cover the debt', () => {
		const debt = 28_000n * 10n ** 18n;
		const p = previewLiquidation(debt, debt, 5n * 10n ** 18n, PRICE, PENALTY, SHARE, 18, 20_000n);
		// $14,000 of gold sells for $13,720 at a 2% discount. The liquidator receives
		// debt-equivalent gold plus 60% of the remaining gold; the protocol keeps 40%.
		expect(p?.debtRepaid).toBe(13_720n * 10n ** 18n);
		expect(p?.liquidatorPayout).toBe(4_960_000_000_000_000_000n);
		expect(p?.protocolPayout).toBe(40_000_000_000_000_000n);
	});

	it('caps the discount at the shortfall for a vault just below 100%', () => {
		const debt = 1_000n * 10n ** 18n;
		const p = previewLiquidation(debt, debt, 1_000_000n, 999n * 10n ** 8n, PENALTY, SHARE, 6, 20_000n);
		expect(p?.debtRepaid).toBe(998n * 10n ** 18n);
		const debtEquivalent = 998n * 1_000_000n / 999n;
		expect(p?.liquidatorPayout).toBe(debtEquivalent + (1_000_000n - debtEquivalent) * SHARE / 1_000_000n);
	});
});

/** Narrows a preview the test has already asserted to exist, without a non-null assertion. */
function present<T>(value: T | undefined): T {
	if (value === undefined) throw new Error('expected a liquidation preview');
	return value;
}

describe('keeperBounty', () => {
	it('is half the liquidator share of the penalty', () => {
		const p = previewLiquidation(2_800n * 10n ** 18n, 2_800n * 10n ** 18n, 10n * 10n ** 18n, PRICE, PENALTY, SHARE, 18, DISCOUNT);
		// penalty 0.05 PAXG × 30% = 0.015 PAXG
		expect(keeperBounty(present(p), SHARE)).toBe(15_000_000_000_000_000n);
	});

	it('survives a 100% liquidator share, which governance may set', () => {
		const p = previewLiquidation(2_800n * 10n ** 18n, 2_800n * 10n ** 18n, 10n * 10n ** 18n, PRICE, PENALTY, 1_000_000n, 18, DISCOUNT);
		expect(p?.protocolPayout).toBe(0n);
		expect(keeperBounty(present(p), 1_000_000n)).toBe(25_000_000_000_000_000n);
	});

	it('matches the contract to the wei for penalties that do not divide evenly', () => {
		// totalPenalty not a multiple of 5 in wei: the old reconstruction overshot here.
		const p = previewLiquidation(1_234_567n * 10n ** 12n, 1_234_567n * 10n ** 12n, 10n * 10n ** 18n, PRICE, PENALTY, SHARE, 18, DISCOUNT);
		expect(keeperBounty(present(p), SHARE)).toBe((present(p).totalPenalty * 300_000n) / 1_000_000n);
	});
});
