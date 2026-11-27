import { describe, expect, it } from 'vitest';
import { computeMinGoldOut, previewSwap } from './stabilityMath';

const GOLD = 200_000_000_000n; // $2000, 8 dec

describe('previewSwap mirrors GoldStabilityReserve.swapGsusdForGold', () => {
	it('2000 GSUSD at $2000 and 0.5% spread pays 0.995 PAXG', () => {
		// The exact figure asserted on-chain in contracts/test/GoldStabilityReserve.test.ts
		const p = previewSwap(2000n * 10n ** 18n, 5_000n, GOLD, 18);
		expect(p.spreadAmount).toBe(10n * 10n ** 18n);
		expect(p.net).toBe(1990n * 10n ** 18n);
		expect(p.goldOut).toBe(995_000_000_000_000_000n);
		expect(p.tooSmall).toBe(false);
	});

	it('handles XAUT at 6 decimals: 995000', () => {
		expect(previewSwap(2000n * 10n ** 18n, 5_000n, GOLD, 6).goldOut).toBe(995_000n);
	});

	it('flags a swap too small to yield any gold', () => {
		expect(previewSwap(1n, 5_000n, GOLD, 6).tooSmall).toBe(true);
	});

	it('returns zero gold on a zero price rather than dividing by zero', () => {
		expect(previewSwap(10n ** 18n, 5_000n, 0n, 18).goldOut).toBe(0n);
	});
});

describe('computeMinGoldOut', () => {
	it('applies the tolerance in basis points', () => {
		expect(computeMinGoldOut(1_000_000n, 50n)).toBe(995_000n);
		expect(computeMinGoldOut(1_000_000n, 0n)).toBe(1_000_000n);
	});
});
