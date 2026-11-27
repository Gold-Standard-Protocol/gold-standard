import { describe, expect, it } from 'vitest';
import {
	adverseDeviationBps,
	formatDeviationBps,
	priceImpactLevel,
	compareVenues,
	computeMinAmountOut,
	impliedGoldPrice8,
	parseTokenAmount,
	poolFeeLabel,
} from './dexMath';

const ONE_PAXG = 10n ** 18n;
const ONE_XAUT = 10n ** 6n;
const GSUSD = (n: bigint) => n * 10n ** 18n;

describe('computeMinAmountOut', () => {
	it('applies the tolerance in basis points, rounding down', () => {
		expect(computeMinAmountOut(1_000_000n, 50n)).toBe(995_000n);
		expect(computeMinAmountOut(1_000_000n, 100n)).toBe(990_000n);
		expect(computeMinAmountOut(1_000_000n, 0n)).toBe(1_000_000n);
		expect(computeMinAmountOut(3n, 50n)).toBe(2n);
	});
});

describe('impliedGoldPrice8', () => {
	it('reads 2000 GSUSD for 1 PAXG as $2000.00000000', () => {
		expect(impliedGoldPrice8(GSUSD(2000n), ONE_PAXG, 18)).toBe(2000n * 10n ** 8n);
	});

	it('is decimals-aware: 2000 GSUSD for 1 XAUT at 6 decimals is the same price', () => {
		expect(impliedGoldPrice8(GSUSD(2000n), ONE_XAUT, 6)).toBe(2000n * 10n ** 8n);
	});

	it('keeps sub-dollar precision on a small fill', () => {
		// 0.25 PAXG for 512.5 GSUSD implies $2050 per oz.
		expect(impliedGoldPrice8(5125n * 10n ** 17n, ONE_PAXG / 4n, 18)).toBe(2050n * 10n ** 8n);
	});

	it('has no price when the gold side is zero', () => {
		expect(impliedGoldPrice8(GSUSD(1n), 0n, 18)).toBeUndefined();
	});
});

describe('parseTokenAmount', () => {
	it('returns undefined for unset input', () => {
		expect(parseTokenAmount(undefined, 18)).toBeUndefined();
		expect(parseTokenAmount('', 18)).toBeUndefined();
	});

	it('parses in the token decimals', () => {
		expect(parseTokenAmount('1.5', 18)).toBe(15n * 10n ** 17n);
		expect(parseTokenAmount('1.5', 6)).toBe(1_500_000n);
	});

	it('never throws on malformed input', () => {
		expect(parseTokenAmount('abc', 18)).toBeUndefined();
		expect(parseTokenAmount('1.2.3', 18)).toBeUndefined();
	});
});

describe('poolFeeLabel', () => {
	it('renders the standard tiers as percentages', () => {
		expect(poolFeeLabel(100)).toBe('0.01%');
		expect(poolFeeLabel(500)).toBe('0.05%');
		expect(poolFeeLabel(3000)).toBe('0.30%');
		expect(poolFeeLabel(10000)).toBe('1.00%');
	});
});

describe('compareVenues', () => {
	it('names the venue that pays more gold', () => {
		expect(compareVenues(2489n, 2485n)).toBe('market');
		expect(compareVenues(2480n, 2485n)).toBe('reserve');
		expect(compareVenues(2485n, 2485n)).toBe('equal');
	});

	it('declines to pick a winner until both quotes exist', () => {
		expect(compareVenues(undefined, 2485n)).toBeUndefined();
		expect(compareVenues(2489n, undefined)).toBeUndefined();
	});
});

describe('adverseDeviationBps', () => {
	const ORACLE = 4005n * 10n ** 8n;

	it('measures a seller against an implied price below the oracle', () => {
		// The thin Sepolia pool paid $1,717.43 an ounce for 7 PAXG against a $4,005 oracle.
		expect(adverseDeviationBps(171_743n * 10n ** 6n, ORACLE, true)).toBe(5711n);
	});

	it('measures a buyer against an implied price above the oracle', () => {
		expect(adverseDeviationBps(4_205n * 10n ** 8n, ORACLE, false)).toBe(499n);
	});

	it('reads a fill that beats the oracle as zero for either side', () => {
		expect(adverseDeviationBps(4_100n * 10n ** 8n, ORACLE, true)).toBe(0n);
		expect(adverseDeviationBps(3_900n * 10n ** 8n, ORACLE, false)).toBe(0n);
	});

	it('has no figure without both prices', () => {
		expect(adverseDeviationBps(undefined, ORACLE, true)).toBeUndefined();
		expect(adverseDeviationBps(ORACLE, undefined, true)).toBeUndefined();
		expect(adverseDeviationBps(ORACLE, 0n, true)).toBeUndefined();
	});
});

describe('priceImpactLevel', () => {
	it('warns from 2% and demands acknowledgement from 5%', () => {
		expect(priceImpactLevel(undefined)).toBe('ok');
		expect(priceImpactLevel(30n)).toBe('ok');
		expect(priceImpactLevel(199n)).toBe('ok');
		expect(priceImpactLevel(200n)).toBe('warn');
		expect(priceImpactLevel(499n)).toBe('warn');
		expect(priceImpactLevel(500n)).toBe('severe');
		expect(priceImpactLevel(5711n)).toBe('severe');
	});
});

describe('formatDeviationBps', () => {
	it('prints one decimal, rounding down', () => {
		expect(formatDeviationBps(5711n)).toBe('57.1%');
		expect(formatDeviationBps(200n)).toBe('2.0%');
		expect(formatDeviationBps(30n)).toBe('0.3%');
		expect(formatDeviationBps(0n)).toBe('0.0%');
	});
});
