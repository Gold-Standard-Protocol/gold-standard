import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { NO_DEBT_RATIO, liveCollateralRatio, resolveCollateralRatio } from './liveRatio';
import { ratioBands, ratioStatus, useCollateralRatio } from './useCollateralRatio';

const E8 = 10n ** 8n;
const OWNER = '0x0000000000000000000000000000000000000a11' as const;
const PAXG = '0x00000000000000000000000000000000000000a1' as const;

const chain = vi.hoisted(() => ({
	storedRatio: undefined as bigint | undefined,
	liquidationPrice: undefined as bigint | undefined,
	params: { minRatioPercent: 130, liquidationRatioPercent: 110, isLoading: false } as Record<string, unknown>,
	oracle: {
		price8: undefined as bigint | undefined,
		quoted: false,
		refusal: undefined as string | undefined,
		isLoading: false,
		isDeployed: true,
	},
}));

vi.mock('@goldstandard/constants', () => ({
	getGoldVaultContractConfig: () => ({ address: '0x00000000000000000000000000000000000000ff', abi: [] }),
}));
vi.mock('wagmi', () => ({
	useReadContract: () => ({ data: chain.storedRatio, isLoading: false, isError: false }),
}));
vi.mock('./useLiquidationPrice', () => ({
	useLiquidationPrice: () => ({ priceRaw: chain.liquidationPrice, isLoading: false, isError: false }),
}));
vi.mock('./useCollateralParams', () => ({ useCollateralParams: () => chain.params }));
vi.mock('../stability/useOraclePrice', () => ({ useOraclePrice: () => chain.oracle }));

describe('liveCollateralRatio', () => {
	it('is liquidationRatio x quote / liquidation price, as the keeper computes it', () => {
		// Liquidatable below $3,300 at 110%: at $3,000 the vault stands at 100%.
		expect(liveCollateralRatio(1_100_000n, 3_000n * E8, 3_300n * E8)).toBe(1_000_000n);
		expect(liveCollateralRatio(1_100_000n, 4_500n * E8, 3_300n * E8)).toBe(1_500_000n);
	});

	it('has nothing to say without a liquidation price', () => {
		expect(liveCollateralRatio(1_100_000n, 3_000n * E8, 0n)).toBeUndefined();
	});
});

describe('resolveCollateralRatio', () => {
	const base = { storedRatio: 1_600_000n, liquidationPrice: 3_300n * E8, liquidationRatio: 1_100_000n };

	it('prices at the live quote when it answers, whatever the stored ratio says', () => {
		expect(resolveCollateralRatio({ ...base, quote: { price8: 3_000n * E8 } })).toEqual({ ratio: 1_000_000n, source: 'live' });
	});

	it('falls back to the stored ratio, marked as such, only when the quote is refused', () => {
		expect(resolveCollateralRatio({ ...base, quote: { refused: true } })).toEqual({ ratio: 1_600_000n, source: 'stored' });
	});

	it('reports nothing while the quote is still loading', () => {
		expect(resolveCollateralRatio({ ...base, quote: undefined })).toEqual({ ratio: undefined, source: undefined });
	});

	it('keeps the no-debt sentinel and zero collateral, which no price changes', () => {
		expect(resolveCollateralRatio({ ...base, storedRatio: NO_DEBT_RATIO, liquidationPrice: 0n, quote: { price8: E8 } }).ratio).toBe(NO_DEBT_RATIO);
		expect(resolveCollateralRatio({ ...base, storedRatio: 0n, liquidationPrice: 0n, quote: { price8: E8 } })).toEqual({ ratio: 0n, source: undefined });
	});
});

describe('ratioStatus: governed bands', () => {
	it('derives the comfort line from the governed ratios', () => {
		expect(ratioBands(130, 110)).toEqual({ liquidation: 110, minimum: 130, comfort: 150 });
		expect(ratioBands(150, 120)).toEqual({ liquidation: 120, minimum: 150, comfort: 180 });
	});

	it('marks a vault below its minimum ratio as at risk, not as caution', () => {
		const governed = { minRatioPercent: 130, liquidationRatioPercent: 110 };
		expect(ratioStatus(125, governed)).toBe('danger');
		expect(ratioStatus(135, governed)).toBe('warning');
		expect(ratioStatus(150, governed)).toBe('healthy');
		expect(ratioStatus(105, governed)).toBe('liquidatable');
		expect(ratioStatus(Infinity, governed)).toBe('none');
	});

	it('follows governance when the ratios move', () => {
		expect(ratioStatus(155, { minRatioPercent: 150, liquidationRatioPercent: 120 })).toBe('warning');
		expect(ratioStatus(118, { minRatioPercent: 150, liquidationRatioPercent: 120 })).toBe('liquidatable');
	});
});

describe('useCollateralRatio', () => {
	beforeEach(() => {
		chain.storedRatio = 1_600_000n;
		chain.liquidationPrice = 3_300n * E8;
		chain.params = { minRatioPercent: 130, liquidationRatioPercent: 110, isLoading: false };
		chain.oracle = { price8: 3_000n * E8, quoted: true, refusal: undefined, isLoading: false, isDeployed: true };
	});

	it('shows a quiet fall the stored view has not seen: liquidatable at the live quote', () => {
		const { result } = renderHook(() => useCollateralRatio(11155111, OWNER, PAXG));
		expect(result.current.ratioPercent).toBe(100);
		expect(result.current.source).toBe('live');
		expect(result.current.status).toBe('liquidatable');
	});

	it('uses the stored view, and says so, when the live quote is refused', () => {
		chain.oracle = { price8: 3_000n * E8, quoted: false, refusal: 'No reliable price', isLoading: false, isDeployed: true };
		const { result } = renderHook(() => useCollateralRatio(11155111, OWNER, PAXG));
		expect(result.current.ratioPercent).toBe(160);
		expect(result.current.source).toBe('stored');
	});

	it('uses the stored view, and says so, in a build with no oracle configured', () => {
		// No oracle address: there is no quote to wait for, so the ratio must not load for ever.
		chain.oracle = { price8: undefined, quoted: false, refusal: undefined, isLoading: false, isDeployed: false };
		const { result } = renderHook(() => useCollateralRatio(11155111, OWNER, PAXG));
		expect(result.current.ratioPercent).toBe(160);
		expect(result.current.source).toBe('stored');
	});

	it('never prices the ratio at the plain feed fallback', () => {
		// A fresh validated feed but no quote yet: not the liquidation price, so no ratio.
		chain.oracle = { price8: 3_000n * E8, quoted: false, refusal: undefined, isLoading: true, isDeployed: true };
		const { result } = renderHook(() => useCollateralRatio(11155111, OWNER, PAXG));
		expect(result.current.ratioPercent).toBeUndefined();
	});

	it('reads no debt as Infinity', () => {
		chain.storedRatio = NO_DEBT_RATIO;
		chain.liquidationPrice = 0n;
		const { result } = renderHook(() => useCollateralRatio(11155111, OWNER, PAXG));
		expect(result.current.ratioPercent).toBe(Infinity);
		expect(result.current.status).toBe('none');
	});
});
