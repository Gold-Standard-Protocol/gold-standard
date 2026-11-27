import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { TOKEN_LIST } from '@goldstandard/constants';
import { ChainId } from '@goldstandard/models';
import { useAllGoldTokens, useAllTokens } from './token';

/**
 * The token list is built from the bundle, so it exists with no
 * API and no tRPC provider at all. These render without any provider; the old hook threw.
 */
describe('token list without the API', () => {
	it('lists mainnet PAXG and XAUT at their pinned addresses and decimals', () => {
		const { result } = renderHook(() => useAllGoldTokens(ChainId.MAINNET));
		const bySymbol = Object.fromEntries(Object.values(result.current.data).map((token) => [token.symbol, token]));
		expect(bySymbol['PAXG']?.address).toBe('0x45804880De22913dAFE09f4980848ECE6EcbAf78');
		expect(bySymbol['PAXG']?.decimals).toBe(18);
		expect(bySymbol['XAUT']?.address).toBe('0x68749665FF8D2d112Fa859AA293F07A622782F38');
		expect(bySymbol['XAUT']?.decimals).toBe(6);
		expect(Object.values(result.current.data).every((token) => token.gold)).toBe(true);
	});

	it('keys every token by its address and matches the bundled list', () => {
		const { result } = renderHook(() => useAllTokens(ChainId.SEPOLIA));
		// Sepolia PAXG is listed only when VITE_PAXG_ADDRESS is set, so compare with
		// whichever bundled tokens carry a Sepolia address in this environment.
		const bundled = TOKEN_LIST.filter((token) => token.addresses[ChainId.SEPOLIA]);
		const listed = Object.entries(result.current.data);
		expect(listed.length).toBeGreaterThan(0);
		for (const [address, token] of listed) expect(token.address).toBe(address);
		expect(listed.map(([, token]) => token.symbol).sort()).toEqual(bundled.map((token) => token.symbol).sort());
		for (const info of bundled) {
			expect(listed.some(([, token]) => token.symbol === info.symbol && token.decimals === info.decimals)).toBe(true);
		}
	});

	it('returns the same record on every render so effects keyed on it settle', () => {
		const { result, rerender } = renderHook(() => useAllGoldTokens(ChainId.SEPOLIA));
		const first = result.current.data;
		rerender();
		expect(result.current.data).toBe(first);
	});
});
