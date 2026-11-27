import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRefreshWindow, resetRefreshWindow, startRefreshWindow } from './refreshWindow';

describe('refreshWindow', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetRefreshWindow();
	});
	afterEach(() => vi.useRealTimers());

	it('is closed before any confirmation', () => {
		expect(getRefreshWindow()).toEqual({ startedAt: null, active: false });
	});

	it('opens for the duration and then closes while keeping when it started', () => {
		startRefreshWindow(1_000, 5_000);
		expect(getRefreshWindow()).toEqual({ startedAt: 5_000, active: true });
		vi.advanceTimersByTime(999);
		expect(getRefreshWindow().active).toBe(true);
		vi.advanceTimersByTime(1);
		expect(getRefreshWindow()).toEqual({ startedAt: 5_000, active: false });
	});

	it('restarts on a second confirmation instead of closing early', () => {
		startRefreshWindow(1_000, 5_000);
		vi.advanceTimersByTime(800);
		startRefreshWindow(1_000, 5_800);
		vi.advanceTimersByTime(500);
		expect(getRefreshWindow()).toEqual({ startedAt: 5_800, active: true });
		vi.advanceTimersByTime(500);
		expect(getRefreshWindow().active).toBe(false);
	});
});
