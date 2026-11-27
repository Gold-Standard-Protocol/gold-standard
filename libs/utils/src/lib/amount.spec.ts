import { describe, expect, it } from 'vitest';
import { canonicalAmount, checkAmount, describeAmountProblem, fractionDigits, parseAmount, withinDecimals } from './amount';

const E18 = 10n ** 18n;

describe('checkAmount', () => {
	it('parses a plain decimal in the token decimals', () => {
		expect(checkAmount('1.5', 18)).toEqual({ value: 15n * 10n ** 17n, problem: undefined });
		expect(checkAmount('1.5', 6)).toEqual({ value: 1_500_000n, problem: undefined });
		expect(checkAmount('1.', 18).value).toBe(E18);
		expect(checkAmount('.5', 18).value).toBe(5n * 10n ** 17n);
		expect(checkAmount('00001', 18).value).toBe(E18);
	});

	it('reports an empty field and a zero amount as nothing to act on', () => {
		expect(checkAmount('', 18).problem).toBe('empty');
		expect(checkAmount(undefined, 18).problem).toBe('empty');
		expect(checkAmount('0', 18).problem).toBe('empty');
		expect(checkAmount('0.0', 18).problem).toBe('empty');
		expect(checkAmount('0.000', 6).problem).toBe('empty');
	});

	it.each([
		'-1', '+1', '1e3', '1e18', '0x10', '1,000', '1 000', ' 1 ', 'abc', '١٢٣', '１２３', '1_000', '0.1.2', '1..2', '-0', 'Infinity', 'NaN', '​1', '.',
	])('rejects %j as malformed rather than sanitising it', (raw) => {
		expect(checkAmount(raw, 18)).toEqual({ value: undefined, problem: 'malformed' });
	});

	it('rejects more decimals than the token carries instead of rounding', () => {
		expect(checkAmount('0.0000005', 6).problem).toBe('too-many-decimals');
		expect(checkAmount('0.123456789', 6).problem).toBe('too-many-decimals');
		expect(checkAmount('0.0000000000000000001', 18).problem).toBe('too-many-decimals');
		expect(checkAmount('0.000001', 6).value).toBe(1n);
	});

	it('rejects a value beyond uint256', () => {
		expect(checkAmount('1'.repeat(78), 18).problem).toBe('too-large');
	});

	it('rejects more than the balance when one is given', () => {
		expect(checkAmount('2', 18, E18).problem).toBe('over-balance');
		expect(checkAmount('1', 18, E18).value).toBe(E18);
	});
});

describe('parseAmount', () => {
	it('is the value alone', () => {
		expect(parseAmount('2', 18)).toBe(2n * E18);
		expect(parseAmount('abc', 18)).toBeUndefined();
	});
});

describe('withinDecimals', () => {
	it('allows typing up to the token decimals and no further', () => {
		expect(fractionDigits('1')).toBe(0);
		expect(fractionDigits('1.')).toBe(0);
		expect(fractionDigits('1.25')).toBe(2);
		expect(withinDecimals('0.000000', 6)).toBe(true);
		expect(withinDecimals('0.0000005', 6)).toBe(false);
		expect(withinDecimals('100.', 0)).toBe(true);
		expect(withinDecimals('100.5', 0)).toBe(false);
	});
});

describe('describeAmountProblem', () => {
	it('names the token in the decimals reason', () => {
		expect(describeAmountProblem('too-many-decimals', 'XAUT')).toBe('More decimals than XAUT supports');
		expect(describeAmountProblem('empty', 'XAUT')).toBe('Enter an amount');
		expect(describeAmountProblem('malformed', 'XAUT')).toBe('Only digits and one decimal point');
		expect(describeAmountProblem('over-balance', 'XAUT')).toBe('More than your balance');
	});
});

describe('canonicalAmount', () => {
	it('prints exactly the signed value without grouping or trailing zeros', () => {
		expect(canonicalAmount(3n * E18, 18)).toBe('3');
		expect(canonicalAmount(5000n * E18, 18)).toBe('5000');
		expect(canonicalAmount(1n, 6)).toBe('0.000001');
		expect(canonicalAmount(15n * 10n ** 17n, 18)).toBe('1.5');
	});
});

describe('checkAmount on adversarial input', () => {
	it('rejects a very long run of digits ending in a letter without stalling', () => {
		const started = Date.now();
		const result = checkAmount(`${'1'.repeat(200_000)}x`, 18);
		expect(result.problem).toBe('malformed');
		expect(Date.now() - started).toBeLessThan(500);
	});
});
