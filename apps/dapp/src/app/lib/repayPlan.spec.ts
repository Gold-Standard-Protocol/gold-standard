import { describe, expect, it } from 'vitest';
import { MIN_DEBT, closeMargin, closesWithMargin, planRepayment } from './repayPlan';

const gsusd = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;

describe('planRepayment', () => {
	it('closes the position when the balance covers the fee-inclusive debt', () => {
		const plan = planRepayment(gsusd('1000'), gsusd('1005'), gsusd('2000'));
		expect(plan.closes).toBe(true);
		expect(plan.blocked).toBe(false);
		// Quotes above the true debt so a few seconds of accrual cannot undershoot.
		expect(plan.amount).toBeGreaterThan(gsusd('1005'));
	});

	// The exact case observed on Sepolia: 40,003 principal, 40,004.91 owed, 40,003 held.
	// The naive ceiling (currentDebt - MIN_DEBT) reverts on-chain; this must not.
	it('respects the pro-rata allocation, not currentDebt - MIN_DEBT', () => {
		const principal = gsusd('40003');
		const currentDebt = 40004910548423508608085n;
		const balance = gsusd('40003');

		const plan = planRepayment(principal, currentDebt, balance);
		expect(plan.closes).toBe(false);

		const naive = currentDebt - MIN_DEBT;
		expect(plan.amount).toBeLessThan(naive);

		// Reproduce the contract's own check against the quoted amount.
		const principalPortion = (principal * plan.amount) / currentDebt;
		expect(principal - principalPortion).toBeGreaterThanOrEqual(MIN_DEBT);
	});

	// Observed on Sepolia: 40,008 held against 40,005.11 owed was quoted a PARTIAL
	// repayment, because the old gate demanded the padded figure (~40,045) rather than
	// the actual debt. That refused a close to exactly the borrower who had just
	// acquired the shortfall in order to close.
	it('offers a full close whenever the balance covers the debt and the accrual margin, pad or no pad', () => {
		const currentDebt = 40005110000000000000000n;
		const balance = gsusd('40008');

		const plan = planRepayment(gsusd('40003'), currentDebt, balance);
		expect(plan.closes).toBe(true);
		// Never quotes more than the caller actually holds...
		expect(plan.amount).toBeLessThanOrEqual(balance);
		// ...and always at least the debt, so the close is not left a wei short.
		expect(plan.amount).toBeGreaterThanOrEqual(currentDebt);
	});

	it('caps the full-close quote at the balance rather than the 0.1% pad', () => {
		const currentDebt = gsusd('1000');
		const balance = currentDebt + closeMargin(currentDebt) + 1n; // barely covers the margin
		const plan = planRepayment(gsusd('999'), currentDebt, balance);
		expect(plan.closes).toBe(true);
		expect(plan.amount).toBe(balance);
	});

	// A balance exactly covering the debt used to be offered Close, and
	// the repayment fell a few seconds of fees short at inclusion and reverted.
	it('does not offer Close when the balance covers the debt but not the accrual margin', () => {
		const currentDebt = gsusd('1000');
		for (const balance of [currentDebt, currentDebt + 1n, currentDebt + closeMargin(currentDebt) - 1n]) {
			const plan = planRepayment(gsusd('999'), currentDebt, balance);
			expect(plan.closes).toBe(false);
			expect(plan.shortToClose).toBe(currentDebt + closeMargin(currentDebt) - balance);
		}
	});

	it('sizes the margin at an hour of the highest stability fee plus the six-decimal step', () => {
		// 50% a year for an hour on 40,000 GSUSD is about 2.28 GSUSD.
		const margin = closeMargin(gsusd('40000'));
		expect(margin > gsusd('2.28')).toBe(true);
		expect(margin < gsusd('2.29')).toBe(true);
	});

	it('always quotes a close that survives the six-decimal truncation with the margin intact', () => {
		const currentDebt = 40005110000000000000000n;
		const plan = planRepayment(gsusd('40003'), currentDebt, gsusd('50000'));
		const typed = (plan.amount / 10n ** 12n) * 10n ** 12n;
		expect(typed >= currentDebt + closeMargin(currentDebt) - 10n ** 12n).toBe(true);
	});

	it('reports nothing short once the balance can close', () => {
		expect(planRepayment(gsusd('1000'), gsusd('1005'), gsusd('2000')).shortToClose).toBe(0n);
	});

	it('never exceeds the caller balance', () => {
		const plan = planRepayment(gsusd('40000'), gsusd('40010'), gsusd('500'));
		expect(plan.amount).toBe(gsusd('500'));
		expect(plan.closes).toBe(false);
	});

	it('blocks when the position is too small to repay in part', () => {
		// Debt at the floor: any partial would drop it below MIN_DEBT.
		const plan = planRepayment(MIN_DEBT, gsusd('101'), gsusd('50'));
		expect(plan.blocked).toBe(true);
		expect(plan.amount).toBe(0n);
	});

	it('leaves at least MIN_DEBT across a range of fee levels', () => {
		const principal = gsusd('5000');
		for (const feePct of [0, 0.01, 0.5, 2, 10]) {
			const currentDebt = principal + (principal * BigInt(Math.round(feePct * 100))) / 10000n;
			// Balance deliberately just short of a full close.
			const plan = planRepayment(principal, currentDebt, currentDebt - 1n);
			const principalPortion = (principal * plan.amount) / currentDebt;
			expect(principal - principalPortion).toBeGreaterThanOrEqual(MIN_DEBT);
		}
	});

	it('treats an empty position as blocked rather than quoting zero silently', () => {
		expect(planRepayment(0n, 0n, gsusd('100')).blocked).toBe(true);
	});
});

describe('closesWithMargin', () => {
	const debt = 1_000n * 10n ** 18n;

	it('does not call an amount that only matches the debt this second a close', () => {
		// The debt accrues between the read and the confirming block, so an exact repayment
		// would fall a few seconds of fees short and revert below the minimum.
		expect(closesWithMargin(debt, debt)).toBe(false);
	});

	it('calls an amount a close once it carries the accrual margin', () => {
		expect(closesWithMargin(debt + closeMargin(debt), debt)).toBe(true);
		expect(closesWithMargin(debt + closeMargin(debt) - 1n, debt)).toBe(false);
	});
});
