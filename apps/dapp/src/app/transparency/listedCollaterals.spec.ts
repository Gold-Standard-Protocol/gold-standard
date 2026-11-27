import { describe, expect, it } from 'vitest';
import type { CollateralStat } from '@goldstandard/hooks';
import { listedCollaterals } from './listedCollaterals';

const stat = (symbol: string, overrides: Partial<CollateralStat>): CollateralStat => ({
	symbol,
	name: symbol,
	image: '',
	address: '0x0000000000000000000000000000000000000001',
	decimals: 18,
	priceUsd: undefined,
	priceSource: undefined,
	balance: undefined,
	valueUsd: undefined,
	debt: undefined,
	minRatioPercent: undefined,
	liquidationRatioPercent: undefined,
	liquidationPenaltyPercent: undefined,
	debtCeiling: undefined,
	active: undefined,
	...overrides,
});

describe('listedCollaterals', () => {
	// A PAXG-first deployment registers XAUT in the oracle only: it is not a collateral.
	it('leaves out a dormant collateral that holds nothing and owes nothing', () => {
		const paxg = stat('PAXG', { active: true, balance: 10n, debt: 5n });
		const xaut = stat('XAUT', { active: false, balance: 0n, debt: 0n, minRatioPercent: 0 });
		expect(listedCollaterals([paxg, xaut])).toEqual([paxg]);
	});

	it('keeps an inactive collateral that still holds gold or debt, so nothing disappears from view', () => {
		const paused = stat('XAUT', { active: false, balance: 3n, debt: 0n });
		expect(listedCollaterals([paused])).toEqual([paused]);
	});

	it('keeps every asset before the vault has answered', () => {
		const unknown = stat('XAUT', {});
		expect(listedCollaterals([unknown])).toEqual([unknown]);
	});
});
