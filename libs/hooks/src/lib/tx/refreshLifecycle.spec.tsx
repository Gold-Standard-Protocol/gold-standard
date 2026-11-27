import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useRefreshOnConfirmation } from './useRefreshOnConfirmation';
import { getRefreshWindow, resetRefreshWindow } from './refreshWindow';
import { cancelConfirmationRefreshes } from './refreshScheduler';
import { isRefreshedQuery } from './refreshFamilies';

/**
 * Leaving the page, or starting another transaction, must not cut the follow-up refreshes
 * short: the "updating" window would otherwise stay open with nothing left to refresh.
 */
describe('refresh lifecycle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetRefreshWindow();
		cancelConfirmationRefreshes();
	});
	afterEach(() => vi.useRealTimers());

	const setup = () => {
		const client = new QueryClient();
		const spy = vi.spyOn(client, 'invalidateQueries');
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
		return { spy, wrapper };
	};

	it('finishes all five refreshes after the page unmounts one second in', () => {
		const { spy, wrapper } = setup();
		const view = renderHook(() => useRefreshOnConfirmation('success'), { wrapper });
		vi.advanceTimersByTime(1_000);
		view.unmount();
		vi.advanceTimersByTime(14_000);
		expect(spy).toHaveBeenCalledTimes(5);
		expect(getRefreshWindow().active).toBe(false);
	});

	it('keeps refreshing when a second transaction starts while the first is refreshing', () => {
		const { spy, wrapper } = setup();
		const view = renderHook(({ s }: { s: 'pending' | 'success' }) => useRefreshOnConfirmation(s), {
			wrapper,
			initialProps: { s: 'success' as 'pending' | 'success' },
		});
		vi.advanceTimersByTime(1_000);
		view.rerender({ s: 'pending' });
		vi.advanceTimersByTime(14_000);
		expect(spy.mock.calls.length).toBeGreaterThanOrEqual(5);
	});

	it('invalidates only the families a confirmation can change', () => {
		const { spy, wrapper } = setup();
		renderHook(() => useRefreshOnConfirmation('success'), { wrapper });
		vi.advanceTimersByTime(0);
		const filters = spy.mock.calls[0]?.[0];
		expect(filters?.predicate).toBe(isRefreshedQuery);
		expect(isRefreshedQuery({ queryKey: ['readContract', {}] })).toBe(true);
		expect(isRefreshedQuery({ queryKey: ['useTokenBalances', {}] })).toBe(true);
		expect(isRefreshedQuery({ queryKey: ['vault-history', 1] })).toBe(true);
		expect(isRefreshedQuery({ queryKey: ['token', {}] })).toBe(false);
		expect(isRefreshedQuery({ queryKey: [['pricesRouter', 'prices'], {}] })).toBe(false);
	});

	it('refreshes the liquidation list reads, so a liquidated vault does not keep its old figures', () => {
		expect(isRefreshedQuery({ queryKey: ['undercollateralisedVaultReads', 11155111, '0xvault', '3:abc'] })).toBe(true);
		// The owner list itself only grows when a vault opens, which the page's poll covers.
		expect(isRefreshedQuery({ queryKey: ['vaultRegistryOwners', 11155111, '0xregistry'] })).toBe(false);
	});
});
