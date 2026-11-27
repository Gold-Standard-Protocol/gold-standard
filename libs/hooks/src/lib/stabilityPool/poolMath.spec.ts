import { describe, expect, it } from 'vitest';
import { clampWithdrawAmount, parseGsusdAmount, poolShareBps } from './poolMath';

describe('poolShareBps', () => {
	it('returns the share in basis points', () => {
		expect(poolShareBps(25n, 100n)).toBe(2500);
	});

	it('returns 10000 when the depositor is the whole pool', () => {
		expect(poolShareBps(100n, 100n)).toBe(10000);
	});

	it('floors fractional basis points', () => {
		expect(poolShareBps(1n, 3n)).toBe(3333);
	});

	it('guards against a zero total pool', () => {
		expect(poolShareBps(25n, 0n)).toBe(0);
	});

	it('returns 0 for a zero deposit', () => {
		expect(poolShareBps(0n, 100n)).toBe(0);
	});
});

describe('clampWithdrawAmount', () => {
	it('caps a request above the effective deposit', () => {
		expect(clampWithdrawAmount(150n, 100n)).toBe(100n);
	});

	it('passes through a request at or below the effective deposit', () => {
		expect(clampWithdrawAmount(50n, 100n)).toBe(50n);
		expect(clampWithdrawAmount(100n, 100n)).toBe(100n);
	});

	it('returns 0n when the effective deposit is zero', () => {
		expect(clampWithdrawAmount(50n, 0n)).toBe(0n);
	});

	it('returns 0n for a zero or negative request', () => {
		expect(clampWithdrawAmount(0n, 100n)).toBe(0n);
		expect(clampWithdrawAmount(-5n, 100n)).toBe(0n);
	});
});

describe('parseGsusdAmount', () => {
	it('returns undefined for undefined input', () => {
		expect(parseGsusdAmount(undefined)).toBeUndefined();
	});

	it('returns undefined for an empty string', () => {
		expect(parseGsusdAmount('')).toBeUndefined();
	});

	it('parses zero', () => {
		expect(parseGsusdAmount('0')).toBe(0n);
	});

	it('parses a decimal amount at 18 decimals', () => {
		expect(parseGsusdAmount('1.5')).toBe(1_500_000_000_000_000_000n);
	});

	it('returns undefined instead of throwing for invalid input', () => {
		expect(parseGsusdAmount('not-a-number')).toBeUndefined();
	});
});
