import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { walkRegistryOwners } from './useRegistryVaultOwners';

const owner = (i: number) => `0x${i.toString(16).padStart(40, '0')}` as Address;

/** A registry holding `count` owners, recording every page it is asked for. */
function registry(count: number) {
	const owners = Array.from({ length: count }, (_, i) => owner(i + 1));
	const pages: Array<[bigint, bigint]> = [];
	const readPage = async (offset: bigint, limit: bigint) => {
		pages.push([offset, limit]);
		return owners.slice(Number(offset), Number(offset + limit));
	};
	return { owners, pages, readPage };
}

describe('walkRegistryOwners', () => {
	it('walks the registry in bounded pages until a short page ends it', async () => {
		const r = registry(1_050);
		expect(await walkRegistryOwners(r.readPage, 500n)).toEqual(r.owners);
		expect(r.pages).toEqual([[0n, 500n], [500n, 500n], [1_000n, 500n]]);
	});

	it('reads one empty page for an empty registry', async () => {
		const r = registry(0);
		expect(await walkRegistryOwners(r.readPage, 500n)).toEqual([]);
		expect(r.pages).toHaveLength(1);
	});

	it('reads one more page when the last full page ends exactly at the end', async () => {
		const r = registry(1_000);
		expect(await walkRegistryOwners(r.readPage, 500n)).toHaveLength(1_000);
		expect(r.pages).toHaveLength(3);
	});

	it('drops an owner seen twice when a removal moves the last owner forward mid-walk', async () => {
		const pages = [[owner(1), owner(2)], [owner(2)]];
		const readPage = async (offset: bigint) => pages[Number(offset / 2n)] ?? [];
		expect(await walkRegistryOwners(readPage, 2n)).toEqual([owner(1), owner(2)]);
	});

	it('refuses to walk forever', async () => {
		const readPage = async (_offset: bigint, limit: bigint) => Array.from({ length: Number(limit) }, (_, i) => owner(i + 1));
		await expect(walkRegistryOwners(readPage, 2n, 3)).rejects.toThrow(/more than 3 pages/);
	});

	// A list cut at a cap must never be served as complete,
	// since dust owners listed first would then hide every vault after them. Past the page
	// limit the walk fails, and the page says eligible positions cannot be shown.
	it('fails rather than returning the first pages of a registry longer than the page limit', async () => {
		await expect(walkRegistryOwners(registry(7).readPage, 2n, 3)).rejects.toThrow(/more than 3 pages/);
		await expect(walkRegistryOwners(registry(5).readPage, 2n, 3)).resolves.toHaveLength(5);
	});
});
