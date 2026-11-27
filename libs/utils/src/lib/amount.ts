import { formatUnits, maxUint256, parseUnits } from 'viem';

/**
 * Why an amount field cannot be acted on. One code per cause, so every form can show
 * the same short reason under the field and disable its action on the same rule.
 */
export type AmountProblem = 'empty' | 'malformed' | 'too-many-decimals' | 'too-large' | 'over-balance';

export interface AmountCheck {
	/** The amount in native units, or undefined whenever there is a problem. */
	value: bigint | undefined;
	problem: AmountProblem | undefined;
}

/** Digits with at most one decimal point; a bare "1." or ".5" is a legitimate typing state. */
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Number of digits after the decimal point in a typed string. */
export function fractionDigits(raw: string): number {
	const dot = raw.indexOf('.');
	return dot === -1 ? 0 : raw.length - dot - 1;
}

/**
 * True when `next` may replace the field's value: it has no more fraction digits than the
 * token carries. Rejecting the extra digit at the keystroke is the only honest option,
 * because parseUnits would otherwise round 0.0000005 XAUT up to 0.000001 and the review
 * would show a figure the wallet never signs.
 */
export function withinDecimals(next: string, decimals: number): boolean {
	return fractionDigits(next) <= decimals;
}

/**
 * The one parser behind every amount field. `parseUnits` alone accepted 1e3, 0x10 and
 * Arabic-Indic digits on some paths and rounded excess decimals on others, so each form
 * enabled its action on text the contract would never see as typed.
 */
export function checkAmount(raw: string | undefined, decimals: number, balance?: bigint): AmountCheck {
	const text = raw ?? '';
	if (text === '') return { value: undefined, problem: 'empty' };
	if (!DECIMAL.test(text)) return { value: undefined, problem: 'malformed' };
	if (!withinDecimals(text, decimals)) return { value: undefined, problem: 'too-many-decimals' };
	const value = parseUnits(text, decimals);
	if (value > maxUint256) return { value: undefined, problem: 'too-large' };
	if (value === 0n) return { value: undefined, problem: 'empty' };
	if (balance !== undefined && value > balance) return { value: undefined, problem: 'over-balance' };
	return { value, problem: undefined };
}

/** The native-unit value alone, for callers that only need a number or nothing. */
export function parseAmount(raw: string | undefined, decimals: number): bigint | undefined {
	return checkAmount(raw, decimals).value;
}

/** The short line shown under an amount field. */
export function describeAmountProblem(problem: AmountProblem, symbol: string): string {
	switch (problem) {
		case 'empty':
			return 'Enter an amount';
		case 'malformed':
			return 'Only digits and one decimal point';
		case 'too-many-decimals':
			return `More decimals than ${symbol} supports`;
		case 'too-large':
			return 'This amount is too large';
		case 'over-balance':
			return 'More than your balance';
	}
}

/**
 * The exact decimal the wallet is asked to sign, as text: no grouping, no rounding and
 * no trailing zeros. Reviews print this rather than the typed string, so what is shown is
 * precisely what the parsed argument encodes.
 */
export function canonicalAmount(value: bigint, decimals: number): string {
	return formatUnits(value, decimals);
}
