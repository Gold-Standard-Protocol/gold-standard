import { REFRESH_DELAYS_MS } from './scheduleRefreshes';

type Timer = ReturnType<typeof setTimeout>;

/**
 * The follow-up refreshes after a confirmation, owned here rather than by the hook that
 * started them. Owned by the hook, a navigation one second after the receipt cancelled
 * four of the five refreshes while the page still said "updating" for twelve seconds. A
 * second confirmation adds its own run alongside the first; only an account or chain
 * change clears the lot, because those reads are for a different account.
 */
const pending = new Set<Timer>();

/** Runs `refresh` once per delay. The timers survive any unmount. */
export function scheduleConfirmationRefresh(refresh: () => void, delays: readonly number[] = REFRESH_DELAYS_MS): void {
	delays.forEach((ms) => {
		const timer: Timer = setTimeout(() => {
			pending.delete(timer);
			refresh();
		}, ms);
		pending.add(timer);
	});
}

/** Drops every refresh still waiting. Called when the account or chain changes. */
export function cancelConfirmationRefreshes(): void {
	pending.forEach((timer) => clearTimeout(timer));
	pending.clear();
}

/** How many refreshes are still waiting, for tests. */
export function pendingConfirmationRefreshes(): number {
	return pending.size;
}
