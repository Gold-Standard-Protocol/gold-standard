import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_DELAYS_MS } from './scheduleRefreshes';
import {
	cancelConfirmationRefreshes,
	pendingConfirmationRefreshes,
	scheduleConfirmationRefresh,
} from './refreshScheduler';

describe('refresh schedule', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		cancelConfirmationRefreshes();
	});
	afterEach(() => vi.useRealTimers());

	it('refreshes at the receipt and again over the following seconds', () => {
		const refresh = vi.fn();
		scheduleConfirmationRefresh(refresh);
		expect(refresh).not.toHaveBeenCalled();
		vi.advanceTimersByTime(0);
		expect(refresh).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(REFRESH_DELAYS_MS[REFRESH_DELAYS_MS.length - 1]);
		expect(refresh).toHaveBeenCalledTimes(REFRESH_DELAYS_MS.length);
		expect(pendingConfirmationRefreshes()).toBe(0);
	});

	it('covers at least ten seconds of RPC lag and starts immediately', () => {
		expect(REFRESH_DELAYS_MS[0]).toBe(0);
		expect(Math.max(...REFRESH_DELAYS_MS)).toBeGreaterThanOrEqual(10_000);
	});

	it('lets a second confirmation add its run instead of cancelling the first', () => {
		const first = vi.fn();
		const second = vi.fn();
		scheduleConfirmationRefresh(first, [0, 100, 200]);
		vi.advanceTimersByTime(50);
		scheduleConfirmationRefresh(second, [0, 100, 200]);
		vi.advanceTimersByTime(1_000);
		expect(first).toHaveBeenCalledTimes(3);
		expect(second).toHaveBeenCalledTimes(3);
	});

	it('stops every pending refresh when cancelled for an account or chain change', () => {
		const refresh = vi.fn();
		scheduleConfirmationRefresh(refresh, [0, 100, 200]);
		vi.advanceTimersByTime(0);
		cancelConfirmationRefreshes();
		vi.advanceTimersByTime(1_000);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(pendingConfirmationRefreshes()).toBe(0);
	});
});
