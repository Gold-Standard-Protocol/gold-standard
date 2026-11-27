import { describe, expect, it } from 'vitest';
import { parseRpcUrls } from './rpcUrls';

describe('parseRpcUrls', () => {
	it('reads one URL as a list of one', () => {
		expect(parseRpcUrls('https://rpc.example/v1')).toEqual(['https://rpc.example/v1']);
	});

	it('keeps several comma-separated URLs in the order given, trimmed', () => {
		expect(parseRpcUrls(' https://a.example , https://b.example,https://c.example ')).toEqual([
			'https://a.example',
			'https://b.example',
			'https://c.example',
		]);
	});

	it('drops blank entries, so an unset or empty value names no endpoint', () => {
		expect(parseRpcUrls(undefined)).toEqual([]);
		expect(parseRpcUrls('  ')).toEqual([]);
		expect(parseRpcUrls('https://a.example,, ,')).toEqual(['https://a.example']);
	});
});
