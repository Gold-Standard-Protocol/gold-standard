import { useEffect, useRef } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { cancelConfirmationRefreshes } from './refreshScheduler';
import { resetRefreshWindow } from './refreshWindow';

/**
 * Ties the post-confirmation refresh schedule and its "updating" window to one account on
 * one chain. Switching either mid-window would otherwise keep refreshing, and labelling as
 * updating, figures that now belong to a different account. Mounted once, near the root.
 */
export function useRefreshScope(): void {
	const { address } = useAccount();
	const chainId = useChainId();
	const scope = `${chainId}:${address ?? ''}`;
	const previous = useRef(scope);

	useEffect(() => {
		if (previous.current === scope) return;
		previous.current = scope;
		cancelConfirmationRefreshes();
		resetRefreshWindow();
	}, [scope]);
}

/** Component form of useRefreshScope, for a provider tree that has nowhere else to call it. */
export function RefreshScope(): null {
	useRefreshScope();
	return null;
}
