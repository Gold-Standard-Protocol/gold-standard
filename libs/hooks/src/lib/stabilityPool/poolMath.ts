import { checkAmount } from '@goldstandard/utils';

const BPS_DENOMINATOR = 10_000n;
const GSUSD_DECIMALS = 18;

/**
 * Returns the depositor's share of the pool in basis points (0 to 10000).
 * Guards against division by zero so callers can render "0.00%" safely
 * before the pool has any deposits.
 */
export function poolShareBps(effectiveDeposit: bigint, totalDeposits: bigint): number {
	if (totalDeposits <= 0n || effectiveDeposit <= 0n) return 0;
	return Number((effectiveDeposit * BPS_DENOMINATOR) / totalDeposits);
}

/**
 * Mirrors the StabilityPool contract semantics: a withdrawal request above the
 * compounded effective deposit is capped rather than reverted. The UI uses this
 * to warn "You can withdraw at most X" instead of letting the user be surprised.
 */
export function clampWithdrawAmount(requested: bigint, effective: bigint): bigint {
	if (requested <= 0n || effective <= 0n) return 0n;
	return requested > effective ? effective : requested;
}

/**
 * Parses a typed GSUSD amount (18 decimals) without ever throwing into render, through
 * the shared parser in @goldstandard/utils: malformed text and excess decimals are refused,
 * never rounded. Zero parses as 0n so a caller can tell "nothing typed" from "zero".
 */
export function parseGsusdAmount(amount: string | undefined): bigint | undefined {
	if (!amount) return undefined;
	const { value, problem } = checkAmount(amount, GSUSD_DECIMALS);
	if (problem === 'empty') return 0n;
	return value;
}
