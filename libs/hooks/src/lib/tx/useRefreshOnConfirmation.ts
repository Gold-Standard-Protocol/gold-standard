import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { REFRESH_DELAYS_MS } from './scheduleRefreshes';
import { scheduleConfirmationRefresh } from './refreshScheduler';
import { isRefreshedQuery } from './refreshFamilies';
import { startRefreshWindow } from './refreshWindow';

/**
 * Refresh on-chain reads once a transaction confirms.
 *
 * Without this, nothing invalidated after a write. Balances, vault position and pool
 * figures only moved on their own polling interval, so a user who deposited saw their
 * position unchanged for up to ten seconds after the transaction had already succeeded.
 * Combined with a confirmation dialog that never announced success, that read as
 * "the transaction did not work" when it had.
 *
 * The reads fire at the receipt and a few more times over the following seconds
 * (scheduleRefreshes), because a load-balanced public RPC can answer the first refetch
 * from a node still behind the block, and a stale debt figure that then sat for ten
 * seconds was reported as "debt not showing" on Sepolia. The schedule lives at module
 * level (refreshScheduler), so leaving the page does not cut it short.
 */
export function useRefreshOnConfirmation(
	status: 'error' | 'pending' | 'success' | undefined
): void {
	const queryClient = useQueryClient();
	// Confirmation status stays 'success' for as long as the hook is mounted, so guard
	// against re-invalidating on every render once it settles.
	const alreadyRefreshed = useRef(false);

	useEffect(() => {
		if (status !== 'success') {
			if (status === 'pending') alreadyRefreshed.current = false;
			return;
		}
		if (alreadyRefreshed.current) return;
		alreadyRefreshed.current = true;
		// Tell the page it is re-reading, for one second past the last scheduled refresh.
		startRefreshWindow(Math.max(...REFRESH_DELAYS_MS) + 1_000);
		scheduleConfirmationRefresh(() => {
			void queryClient.invalidateQueries({ predicate: isRefreshedQuery });
		});
	}, [status, queryClient]);
}
