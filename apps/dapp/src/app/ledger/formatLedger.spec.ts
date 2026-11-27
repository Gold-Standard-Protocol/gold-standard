import { describe, expect, it } from 'vitest';
import { formatFigure, formatUtc, isZeroFigure, parseWei } from './formatLedger';

describe('formatFigure', () => {
	it('groups thousands and keeps the two fraction digits the API sent', () => {
		expect(formatFigure('3000.00')).toBe('3,000.00');
		expect(formatFigure('1234567.80')).toBe('1,234,567.80');
		expect(formatFigure('0.00')).toBe('0.00');
		expect(formatFigure('999.99')).toBe('999.99');
	});

	it('does no arithmetic, so a figure beyond double precision is unchanged', () => {
		expect(formatFigure('123456789012345678901234567890.12')).toBe('123,456,789,012,345,678,901,234,567,890.12');
	});

	it('returns anything that is not a plain decimal as it came', () => {
		expect(formatFigure('1e9')).toBe('1e9');
		expect(formatFigure('-5.00')).toBe('-5.00');
		expect(formatFigure('')).toBe('');
	});
});

describe('isZeroFigure', () => {
	it('recognises zero and nothing else', () => {
		expect(isZeroFigure('0.00')).toBe(true);
		expect(isZeroFigure('0')).toBe(true);
		expect(isZeroFigure('0.01')).toBe(false);
		expect(isZeroFigure('10.00')).toBe(false);
		expect(isZeroFigure('')).toBe(false);
	});
});

describe('parseWei', () => {
	it('reads a decimal string and refuses the rest', () => {
		expect(parseWei('1500000000000000000')).toBe(1_500_000_000_000_000_000n);
		expect(parseWei('0')).toBe(0n);
		expect(parseWei('-1')).toBeUndefined();
		expect(parseWei('0x10')).toBeUndefined();
		expect(parseWei('1.5')).toBeUndefined();
		expect(parseWei('')).toBeUndefined();
	});
});

describe('formatUtc', () => {
	it('writes the instant in UTC, the same for every visitor', () => {
		expect(formatUtc(1_794_657_600)).toBe('14 Nov 2026, 12:00 UTC');
		expect(formatUtc(0)).toBe('1 Jan 1970, 00:00 UTC');
	});
});
