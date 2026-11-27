import { describe, expect, it } from 'vitest';
import { Token } from '@goldstandard/models';
import { filterReserveAssets } from './useReserveAssetTokens';

// The filter reads only identity and order; a minimal stand-in is enough here.
const paxg = { address: '0x45804880De22913dAFE09f4980848ECE6EcbAf78', symbol: 'PAXG' } as unknown as Token;
const xaut = { address: '0x68749665FF8D2d112Fa859AA293F07A622782F38', symbol: 'XAUT' } as unknown as Token;
// assets(token) => [supported, pausedUntil, decimals, minReserve, dailyCapPpm, listed]
const asset = (supported: boolean) => ({ status: 'success' as const, result: [supported, 0n, 18, 0n, 0n, supported] });

describe('filterReserveAssets', () => {
	it('keeps only the gold tokens the reserve supports: a dormant XAUT stays out of the reserve picker', () => {
		expect(filterReserveAssets([paxg, xaut], [asset(true), asset(false)])).toEqual([paxg]);
	});

	it('keeps a paused asset, which the panel explains, rather than hiding it', () => {
		// A pause holds until its pausedUntil timestamp.
		const paused = { status: 'success' as const, result: [true, 1_900_000_000n, 18, 0n, 0n, true] };
		expect(filterReserveAssets([paxg], [paused])).toEqual([paxg]);
	});

	it('treats a failed or malformed read as not supported', () => {
		expect(filterReserveAssets([paxg, xaut], [{ status: 'failure' }, asset(true)])).toEqual([xaut]);
		expect(filterReserveAssets([paxg], [{ status: 'success', result: undefined }])).toEqual([]);
	});

	it('answers undefined while the reads are loading', () => {
		expect(filterReserveAssets([paxg, xaut], undefined)).toBeUndefined();
	});
});
