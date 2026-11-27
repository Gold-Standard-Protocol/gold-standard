import { GOLD_VAULT_MIN_DEBT } from '@goldstandard/constants';

/**
 * The smallest debt a vault may carry, as the target chain launched with it. Callers pass
 * GoldVault.minDebt as read from the chain; this is the figure assumed without one.
 */
export const MIN_DEBT = GOLD_VAULT_MIN_DEBT;

/** StabilityModule.MAX_ANNUAL_RATE_BPS: governance cannot set a stability fee above 50% a year. */
const MAX_ANNUAL_RATE_BPS = 5_000n;
const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
/** How long a close is given to confirm before its margin could run out. */
export const CLOSE_ACCRUAL_SECONDS = 60n * 60n;
/** The Close amount is typed at six decimals, rounded down: up to 0.000001 GSUSD is lost. */
const SIX_DECIMAL_STEP = 10n ** 12n;

/**
 * What the debt can grow by between the read and the block that confirms a close:
 * an hour of stability fee at the highest rate governance may set, plus
 * what the six-decimal Close amount drops. Close was offered with no margin at all, so a
 * balance exactly covering the debt sent a repayment that fell a few seconds of fees short
 * and reverted "Remaining debt below minimum". Pure.
 */
export function closeMargin(currentDebt: bigint): bigint {
	return (currentDebt * MAX_ANNUAL_RATE_BPS * CLOSE_ACCRUAL_SECONDS) / (10_000n * SECONDS_PER_YEAR) + SIX_DECIMAL_STEP;
}

/**
 * True when `amount` closes the position with the accrual margin, not merely at this
 * second. A hand-typed repayment equal to the debt read a moment ago is not a close: by the
 * confirming block the debt has grown and the transaction reverts below the minimum. The
 * form's hint and the review screen both decide by this, as Close itself does. Pure.
 */
export function closesWithMargin(amount: bigint, currentDebt: bigint): boolean {
	return amount >= currentDebt + closeMargin(currentDebt);
}

export interface RepayPlan {
	/** The largest amount that will actually succeed. */
	amount: bigint;
	/** True when this amount closes the position outright. */
	closes: boolean;
	/** True when no legal repayment exists at all. */
	blocked: boolean;
	/** GSUSD the caller would need on top of their balance to close; zero when they can. */
	shortToClose: bigint;
}

/**
 * The largest repayment GoldVault will accept.
 *
 * `repay` allocates principal pro rata, `principalPortion = principal * amount /
 * currentDebt`, and then requires the REMAINING PRINCIPAL to be either zero or at
 * least MIN_DEBT. That leaves a dead band just below the full debt where every
 * repayment reverts with "Remaining debt below minimum".
 *
 * The ceiling on a partial repayment is therefore NOT `currentDebt - MIN_DEBT`: that
 * ignores the pro-rata allocation and overshoots, because accrued fees mean
 * `currentDebt > principal`. Solving `principal - principal * A / currentDebt >=
 * MIN_DEBT` for A gives the bound used below. Getting this wrong by ~0.005 GSUSD was
 * enough to make the quoted Max revert on-chain.
 *
 * @param principal   Vault principal debt, excluding accrued fees.
 * @param currentDebt Fee-inclusive debt, which is what the contract charges.
 * @param balance     The caller's GSUSD balance.
 */
export function planRepayment(
	principal: bigint,
	currentDebt: bigint,
	balance: bigint,
	minDebt: bigint = MIN_DEBT
): RepayPlan {
	if (currentDebt <= 0n || principal <= 0n) {
		return { amount: 0n, closes: false, blocked: true, shortToClose: 0n };
	}

	// Overshoot the full-close quote: debt accrues every second, so an exact quote is
	// stale on arrival. The contract caps the pull at the true debt, so overshooting is
	// free, but ONLY up to what the caller actually holds.
	//
	// The gate is the debt plus the accrual margin, NOT the 0.1% pad. Requiring the padded
	// figure refused a full close to anyone holding between the debt and the debt plus
	// 0.1%, which is exactly the borrower who has just acquired the shortfall and is
	// trying to close: 40,008 held against 40,005.11 owed was quoted a partial repayment
	// because it fell short of the 40,045 pad. The margin there is about 2.3 GSUSD.
	const margin = closeMargin(currentDebt);
	const closeNeeds = currentDebt + margin;
	if (balance >= closeNeeds) {
		const padded = (currentDebt * 1001n) / 1000n;
		const fullClose = padded > closeNeeds ? padded : closeNeeds;
		const amount = balance < fullClose ? balance : fullClose;
		return { amount, closes: true, blocked: false, shortToClose: 0n };
	}

	// Largest partial that still leaves minDebt of principal behind.
	const maxPartial =
		principal > minDebt ? (currentDebt * (principal - minDebt)) / principal : 0n;

	const amount = balance < maxPartial ? balance : maxPartial;
	return { amount, closes: false, blocked: amount <= 0n, shortToClose: closeNeeds - balance };
}
