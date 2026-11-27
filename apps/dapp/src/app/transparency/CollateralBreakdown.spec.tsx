import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CollateralStat } from '@goldstandard/hooks';
import { CollateralBreakdown } from './CollateralBreakdown';

/**
 * A missing price, holding or value used to render a bare
 * hyphen, and a failed holding read on a deployed chain read "Pre-launch". Every missing
 * cell now names its cause.
 */
const PAXG: CollateralStat = {
	symbol: 'PAXG',
	name: 'Paxos Gold',
	image: '/tokens/paxg.png',
	address: '0x00000000000000000000000000000000000000a1',
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
};

const textOf = (row: CollateralStat, status: Parameters<typeof CollateralBreakdown>[0]['status']): string => {
	const { container } = render(<CollateralBreakdown collaterals={[row]} tvlUsd={undefined} status={status} />);
	return container.textContent ?? '';
};

afterEach(cleanup);

describe('CollateralBreakdown missing values', () => {
	it('says the chain read failed, never a dash or "Pre-launch", once the contracts are deployed', () => {
		const text = textOf(PAXG, 'error');
		expect(text).toContain('Chain read failed, retrying');
		expect(text).not.toContain('Pre-launch');
		expect(text).not.toMatch(/(^|\s)-(\s|$)/);
	});

	it('names a missing price separately from a holding it did read', () => {
		const text = textOf({ ...PAXG, balance: 5n * 10n ** 18n }, 'live');
		expect(text).toMatch(/5(\.0+)? PAXG/);
		expect(text).toContain('Price unavailable, retrying');
	});

	it('says Loading while the first read is in flight', () => {
		expect(textOf(PAXG, 'loading')).toContain('Loading');
	});

	it('keeps "Pre-launch" for a holding only before the contracts exist', () => {
		const text = textOf(PAXG, 'pre-launch');
		expect(text).toContain('Pre-launch');
		expect(text).toContain('Price feed unavailable, retrying');
	});
});
