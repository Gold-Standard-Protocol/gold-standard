import { describe, expect, it } from 'vitest';
import { liveRequest, sameArgs } from './liveRequest';

const E18 = 10n ** 18n;
const TOKEN = '0x0000000000000000000000000000000000000001';

describe('sameArgs', () => {
	it('compares bigints, strings, tuples and structs by value', () => {
		expect(sameArgs([TOKEN, 5n * E18], [TOKEN, 5n * E18])).toBe(true);
		expect(sameArgs([TOKEN, 5n * E18], [TOKEN, 50n * E18])).toBe(false);
		expect(sameArgs([{ tokenIn: TOKEN, amountIn: 1n }], [{ tokenIn: TOKEN, amountIn: 1n }])).toBe(true);
		expect(sameArgs([{ tokenIn: TOKEN, amountIn: 1n }], [{ tokenIn: TOKEN, amountIn: 2n }])).toBe(false);
		expect(sameArgs([1n], [1n, 2n])).toBe(false);
		expect(sameArgs(undefined, [])).toBe(false);
	});
});

describe('liveRequest', () => {
	const request = { args: [TOKEN, 5n * E18] as const, value: undefined };

	it('returns the request when it is settled data for the current arguments', () => {
		expect(liveRequest({ data: { request }, isPlaceholderData: false }, [TOKEN, 5n * E18])).toBe(request);
	});

	it('refuses placeholder data: the previous simulation is a request for the previous inputs', () => {
		expect(liveRequest({ data: { request }, isPlaceholderData: true }, [TOKEN, 5n * E18])).toBeUndefined();
	});

	it('refuses settled data whose arguments differ from what is parsed now', () => {
		expect(liveRequest({ data: { request }, isPlaceholderData: false }, [TOKEN, 50n * E18])).toBeUndefined();
	});

	it('refuses a request from a previous account even when the amounts agree', () => {
		const other = { args: [TOKEN, 5n * E18] as const, value: undefined };
		// The simulation key changes with the account, so wagmi serves the old request as a placeholder.
		expect(liveRequest({ data: { request: other }, isPlaceholderData: true }, [TOKEN, 5n * E18])).toBeUndefined();
	});

	it('refuses a request whose value differs from the expected value', () => {
		const payable = { args: [TOKEN, 5n * E18] as const, value: 1n };
		expect(liveRequest({ data: { request: payable }, isPlaceholderData: false }, [TOKEN, 5n * E18])).toBeUndefined();
		expect(liveRequest({ data: { request: payable }, isPlaceholderData: false }, [TOKEN, 5n * E18], 1n)).toBe(payable);
	});

	it('returns nothing without data or without parsed inputs', () => {
		expect(liveRequest({ data: undefined, isPlaceholderData: false }, [TOKEN, 5n * E18])).toBeUndefined();
		expect(liveRequest({ data: { request }, isPlaceholderData: false }, undefined)).toBeUndefined();
	});
});
