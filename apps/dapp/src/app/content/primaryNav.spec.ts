import { describe, expect, it } from 'vitest';
import { PRIMARY_NAV, primaryNav } from './site';

describe('primaryNav', () => {
	it('is the navigation of every build before the ledger page existed when the page is off', () => {
		expect(primaryNav(false)).toBe(PRIMARY_NAV);
		expect(primaryNav(false)).toEqual([
			{ to: '/', label: 'Home', end: true },
			{ to: '/vault', label: 'Vault' },
			{ to: '/pool', label: 'Pool' },
			{ to: '/swap', label: 'Swap' },
			{ to: '/transparency', label: 'Reserves' },
			{ to: '/docs', label: 'Docs' },
		]);
	});

	it('adds one entry, Ledger after Swap, when the page is on', () => {
		const on = primaryNav(true);
		expect(on.map((link) => link.label)).toEqual(['Home', 'Vault', 'Pool', 'Swap', 'Ledger', 'Reserves', 'Docs']);
		expect(on.find((link) => link.label === 'Ledger')).toEqual({ to: '/ledger', label: 'Ledger' });
		expect(PRIMARY_NAV).toHaveLength(6);
	});
});
