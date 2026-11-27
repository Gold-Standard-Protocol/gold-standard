import { describe, expect, it } from 'vitest';
import { formatFeeBps, originationFeeSplit } from './originationFee';

const gsusd = (whole: bigint): bigint => whole * 10n ** 18n;

describe('originationFeeSplit', () => {
	it('takes 5 bps from what a 10,000 GSUSD mint delivers', () => {
		expect(originationFeeSplit(gsusd(10_000n), 5n, false)).toEqual({
			bps: 5n,
			fee: gsusd(5n),
			received: gsusd(9_995n),
		});
	});

	it('rounds the fee down, as the contract does', () => {
		expect(originationFeeSplit(19_999n, 5n, false)).toEqual({ bps: 5n, fee: 9n, received: 19_990n });
	});

	it('charges an exempt account nothing', () => {
		expect(originationFeeSplit(gsusd(100n), 5n, true)).toEqual({ bps: 0n, fee: 0n, received: gsusd(100n) });
	});

	it('charges nothing while the fee is off', () => {
		expect(originationFeeSplit(gsusd(100n), 0n, false)).toEqual({ bps: 0n, fee: 0n, received: gsusd(100n) });
	});
});

describe('formatFeeBps', () => {
	it('states basis points as a percentage', () => {
		expect(formatFeeBps(5n)).toBe('0.05%');
		expect(formatFeeBps(100n)).toBe('1%');
		expect(formatFeeBps(25n)).toBe('0.25%');
	});
});
