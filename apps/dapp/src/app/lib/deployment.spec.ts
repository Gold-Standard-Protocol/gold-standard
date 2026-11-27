import { describe, expect, it } from 'vitest';
import { apiUrl, buildInfo, ledgerRecordUrl } from './deployment';

describe('apiUrl', () => {
	it('stays same-origin when VITE_API_URL is unset', () => {
		expect(apiUrl({})).toBe('/trpc');
		expect(apiUrl({ VITE_API_URL: '  ' })).toBe('/trpc');
	});

	it('accepts the endpoint with or without the /trpc suffix or a trailing slash', () => {
		expect(apiUrl({ VITE_API_URL: 'https://api.goldstandard.finance' })).toBe('https://api.goldstandard.finance/trpc');
		expect(apiUrl({ VITE_API_URL: 'https://api.goldstandard.finance/' })).toBe('https://api.goldstandard.finance/trpc');
		expect(apiUrl({ VITE_API_URL: 'https://api.goldstandard.finance/trpc/' })).toBe('https://api.goldstandard.finance/trpc');
	});

	it('refuses a relative or schemeless value', () => {
		expect(() => apiUrl({ VITE_API_URL: 'api.goldstandard.finance' })).toThrow('VITE_API_URL');
		expect(() => apiUrl({ VITE_API_URL: '/api' })).toThrow('VITE_API_URL');
	});
});

describe('buildInfo', () => {
	it('reports the commit and links it when the source repository is known', () => {
		expect(buildInfo({ VITE_BUILD_COMMIT: 'abc1234def', VITE_SOURCE_URL: 'https://github.com/org/repo/' })).toEqual({
			commit: 'abc1234def',
			sourceUrl: 'https://github.com/org/repo/commit/abc1234def',
		});
	});

	it('falls back to "unknown" without a link', () => {
		expect(buildInfo({})).toEqual({ commit: 'unknown' });
		expect(buildInfo({ VITE_SOURCE_URL: 'https://github.com/org/repo' })).toEqual({ commit: 'unknown' });
		expect(buildInfo({ VITE_BUILD_COMMIT: 'abc1234def' })).toEqual({ commit: 'abc1234def' });
	});
});

describe('ledgerRecordUrl', () => {
	it('is the same-origin path when the API is this origin', () => {
		expect(ledgerRecordUrl({})).toBe('/usage-ledger.csv');
		expect(ledgerRecordUrl({ VITE_API_URL: '  ' })).toBe('/usage-ledger.csv');
	});

	it('sits on the API origin, beside its tRPC endpoint, however the API URL was written', () => {
		for (const raw of ['https://api.example', 'https://api.example/', 'https://api.example/trpc', 'https://api.example/trpc/']) {
			expect(ledgerRecordUrl({ VITE_API_URL: raw })).toBe('https://api.example/usage-ledger.csv');
		}
		expect(ledgerRecordUrl({ VITE_API_URL: 'https://example.org/api/trpc' })).toBe('https://example.org/api/usage-ledger.csv');
	});
});
