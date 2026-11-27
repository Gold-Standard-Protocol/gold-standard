import { describe, expect, it } from 'vitest';
import { pickOraclePrice, pickQuotedPrice, quoteFunctionFor } from './useOraclePrice';

const PRICE = 2_000n * 10n ** 8n;
const STALE_PRICE = 1_900n * 10n ** 8n;

describe('pickOraclePrice', () => {
	it('prefers the validated price when the oracle reports it fresh', () => {
		expect(pickOraclePrice(PRICE, true, STALE_PRICE)).toEqual({
			price8: PRICE,
			isLive: true,
		});
	});

	it('falls back to the last known price when validation fails', () => {
		expect(pickOraclePrice(PRICE, false, STALE_PRICE)).toEqual({
			price8: STALE_PRICE,
			isLive: false,
		});
	});

	it('falls back when the validated price is zero despite ok being true', () => {
		expect(pickOraclePrice(0n, true, STALE_PRICE)).toEqual({
			price8: STALE_PRICE,
			isLive: false,
		});
	});

	it('returns no price when neither source has one', () => {
		expect(pickOraclePrice(undefined, undefined, undefined)).toEqual({
			price8: undefined,
			isLive: false,
		});
		expect(pickOraclePrice(0n, false, 0n)).toEqual({
			price8: undefined,
			isLive: false,
		});
	});
});

describe('pickQuotedPrice', () => {
	const plain = { price8: STALE_PRICE, isLive: true };

	it('uses the purpose quote when the contract answered it', () => {
		expect(pickQuotedPrice(PRICE, undefined, plain)).toEqual({ price8: PRICE, isLive: true, refusal: undefined });
	});

	it('marks the plain price not live and carries the reason when the quote was refused', () => {
		expect(pickQuotedPrice(undefined, 'Off gold band', plain)).toEqual({
			price8: STALE_PRICE,
			isLive: false,
			refusal: 'Off gold band',
		});
	});

	it('keeps the plain pick while the quote is still loading', () => {
		expect(pickQuotedPrice(undefined, undefined, plain)).toEqual({ ...plain, refusal: undefined });
	});
});

describe('quoteFunctionFor (variant C)', () => {
	it('mirrors each action with the oracle view the contract prices it at', () => {
		expect(quoteFunctionFor('borrow')).toBe('quoteBorrowPrice');
		expect(quoteFunctionFor('liquidation')).toBe('quoteTokenPrice');
		expect(quoteFunctionFor('reserve')).toBe('quoteReservePrice');
	});

	it('reads no quote for a plain reference comparison', () => {
		expect(quoteFunctionFor('reference')).toBeUndefined();
	});
});
