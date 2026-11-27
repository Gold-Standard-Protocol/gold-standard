import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { VaultPositionCard, healthBadge } from './VaultPositionCard';

const E18 = 10n ** 18n;

const vault = vi.hoisted(() => ({
	ratio: {} as Record<string, unknown>,
}));

vi.mock('@goldstandard/hooks', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@goldstandard/hooks')>();
	return {
		...actual,
		useVaultContext: () => ({
			chainId: 1,
			position: {
				isLoading: false,
				hasPosition: true,
				position: { collateralToken: '0x00000000000000000000000000000000000000a1', collateralAmount: E18, debtAmount: 2_000n * E18 },
			},
			ratio: vault.ratio,
			liquidationPrice: { priceFormatted: undefined },
			fees: { accruedFees: 0n },
			collateralDecimals: 18,
			collateralSymbol: 'PAXG',
		}),
		useRefreshWindow: () => ({ active: false, startedAt: null }),
		useActiveCollateralTokens: () => ({}),
	};
});

const governed = { minRatio: 130, liquidationRatio: 110 };

describe('position badge on governed ratios', () => {
	it('calls a vault below the 130% minimum at risk rather than caution', () => {
		expect(healthBadge(125, governed).label).toBe('At risk');
		expect(healthBadge(140, governed).label).toBe('Caution');
		expect(healthBadge(150, governed).label).toBe('Healthy');
		expect(healthBadge(108, governed).label).toBe('Liquidatable');
	});

	it('moves its bands with governance', () => {
		expect(healthBadge(160, { minRatio: 150, liquidationRatio: 120 }).label).toBe('Caution');
	});

	it('keeps unknown and no-debt apart', () => {
		expect(healthBadge(undefined, governed).label).toBe('Ratio unavailable');
		expect(healthBadge(Infinity, governed).label).toBe('No debt');
	});
});

describe('position card health', () => {
	it('shows the live ratio with no caveat', () => {
		vault.ratio = { ratioPercent: 100, source: 'live', minRatioPercent: 130, liquidationRatioPercent: 110 };
		render(<VaultPositionCard />);
		expect(screen.getByText('Liquidatable')).toBeTruthy();
		expect(screen.queryByText(/Live gold price unavailable/)).toBeNull();
	});

	it('says so when the ratio falls back to the stored price', () => {
		vault.ratio = { ratioPercent: 160, source: 'stored', minRatioPercent: 130, liquidationRatioPercent: 110 };
		render(<VaultPositionCard />);
		expect(screen.getByText('Healthy')).toBeTruthy();
		expect(screen.getByText(/Live gold price unavailable\. This ratio uses the last price the oracle recorded/)).toBeTruthy();
	});

	it('labels the gauge with the governed minimum and comfort line', () => {
		vault.ratio = { ratioPercent: 140, source: 'live', minRatioPercent: 150, liquidationRatioPercent: 120 };
		render(<VaultPositionCard />);
		expect(screen.getByText('150%')).toBeTruthy();
		expect(screen.getByText('180%')).toBeTruthy();
		expect(screen.getByText('At risk')).toBeTruthy();
	});
});
