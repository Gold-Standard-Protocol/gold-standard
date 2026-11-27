import { describe, expect, it } from 'vitest';
import {
	BaseError,
	ContractFunctionExecutionError,
	ContractFunctionRevertedError,
	ContractFunctionZeroDataError,
	HttpRequestError,
} from 'viem';
import { isQuoteRevert } from './useDexQuote';

const wrap = (cause: BaseError) =>
	new ContractFunctionExecutionError(cause, { abi: [], functionName: 'quoteExactInputSingle' });

describe('isQuoteRevert', () => {
	it('treats a reasoned revert from the quoter as "no route"', () => {
		const revert = new ContractFunctionRevertedError({
			abi: [],
			functionName: 'quoteExactInputSingle',
			message: 'swaps entirely within 0-liquidity regions are not supported',
		});
		expect(isQuoteRevert(wrap(revert))).toBe(true);
	});

	it('treats an empty return (no pool contract at the computed address) as "no route"', () => {
		expect(isQuoteRevert(wrap(new ContractFunctionZeroDataError({ functionName: 'quoteExactInputSingle' })))).toBe(
			true
		);
	});

	// The one case the UI must not misreport: the RPC did not answer, the pool may be fine.
	it('does not mistake an RPC failure for missing liquidity', () => {
		const http = new HttpRequestError({ url: 'https://rpc.example', details: 'timeout' });
		expect(isQuoteRevert(wrap(http))).toBe(false);
		expect(isQuoteRevert(new Error('offline'))).toBe(false);
		expect(isQuoteRevert(undefined)).toBe(false);
	});
});
