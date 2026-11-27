import { describe, expect, it } from 'vitest';
import { toStabilityReserveState, type StabilityReserveRead } from './useStabilityReserve';

const flags = { isDeployed: true, isLoading: false, isError: false };
const ok = (result: unknown): StabilityReserveRead => ({ status: 'success', result });

// The hook's read order: assets, redeemableCollateral, remainingDailyCapacity,
// currentSpreadPpm, coveragePpm, reserveValueUsd, gsusdInventory, assetPaused.
function reads(pausedUntil: bigint, paused: StabilityReserveRead): StabilityReserveRead[] {
	return [
		ok([true, pausedUntil, 18, 0n, 200_000n, true]),
		ok(5n * 10n ** 18n),
		ok(10n ** 18n),
		ok(5_000n),
		ok(250_000n),
		ok(10_000n * 10n ** 18n),
		ok(0n),
		paused,
	];
}

describe('toStabilityReserveState', () => {
	it('reads the pause from assetPaused, not from the pausedUntil timestamp in assets()', () => {
		// A pause set in the past has lapsed: the timestamp is non-zero, the contract says false.
		expect(toStabilityReserveState(reads(1_700_000_000n, ok(false)), flags).paused).toBe(false);
		expect(toStabilityReserveState(reads(1_900_000_000n, ok(true)), flags).paused).toBe(true);
	});

	it('keeps the rest of the shape its callers read', () => {
		const state = toStabilityReserveState(reads(0n, ok(false)), flags);
		expect(state).toMatchObject({
			isDeployed: true,
			supported: true,
			paused: false,
			redeemable: 5n * 10n ** 18n,
			remainingToday: 10n ** 18n,
			spreadPpm: 5_000n,
			spreadPercent: 0.5,
			coveragePpm: 250_000n,
			coveragePercent: 25,
			reserveValueUsd: 10_000n * 10n ** 18n,
			inventory: 0n,
		});
	});

	it('answers undefined for a failed pause read and for no reads at all', () => {
		expect(toStabilityReserveState(reads(0n, { status: 'failure' }), flags).paused).toBeUndefined();
		const empty = toStabilityReserveState(undefined, { isDeployed: false, isLoading: true, isError: false });
		expect(empty.paused).toBeUndefined();
		expect(empty.supported).toBeUndefined();
		expect(empty.isLoading).toBe(true);
	});
});
