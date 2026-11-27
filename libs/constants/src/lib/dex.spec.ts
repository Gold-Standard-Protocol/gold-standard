import { DEFAULT_DEX_POOL_FEE, parseDexPoolFee } from './dex';

describe('parseDexPoolFee', () => {
	it('defaults to the 0.30% tier when unset or blank', () => {
		expect(parseDexPoolFee(undefined)).toBe(DEFAULT_DEX_POOL_FEE);
		expect(parseDexPoolFee('')).toBe(DEFAULT_DEX_POOL_FEE);
		expect(parseDexPoolFee('   ')).toBe(DEFAULT_DEX_POOL_FEE);
	});

	it('accepts every standard Uniswap v3 fee tier', () => {
		expect(parseDexPoolFee('100')).toBe(100);
		expect(parseDexPoolFee('500')).toBe(500);
		expect(parseDexPoolFee('3000')).toBe(3000);
		expect(parseDexPoolFee(' 10000 ')).toBe(10000);
	});

	// A pool at a non-standard tier cannot exist on a stock factory; quoting against it
	// would read as "no liquidity" for a reason nobody could diagnose from the UI.
	it('falls back to the default on a tier the factory does not enable', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		expect(parseDexPoolFee('2500')).toBe(DEFAULT_DEX_POOL_FEE);
		expect(parseDexPoolFee('abc')).toBe(DEFAULT_DEX_POOL_FEE);
		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});
});
