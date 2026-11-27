import { useSyncExternalStore } from 'react';

/**
 * The window after a confirmed transaction during which the page is re-reading the
 * chain (see scheduleRefreshes). Components use it to say "updating" while a figure
 * has not moved yet and "updated" once it has, so the seconds between a receipt and a
 * public RPC catching up never look like a transaction that did nothing.
 */
export interface RefreshWindow {
	/** When the most recent confirmation started a window, or null before the first. */
	startedAt: number | null;
	/** True while the scheduled refreshes are still running. */
	active: boolean;
}

let current: RefreshWindow = { startedAt: null, active: false };
let closeTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const emit = (next: RefreshWindow): void => {
	current = next;
	listeners.forEach((listener) => listener());
};

/** Opens (or restarts) the window for `durationMs`. Called by useRefreshOnConfirmation. */
export function startRefreshWindow(durationMs: number, now: number = Date.now()): void {
	if (closeTimer !== undefined) clearTimeout(closeTimer);
	emit({ startedAt: now, active: true });
	closeTimer = setTimeout(() => emit({ startedAt: current.startedAt, active: false }), durationMs);
}

const subscribe = (listener: () => void): (() => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
const getSnapshot = (): RefreshWindow => current;

/** The window as it stands, for code outside React and for tests. */
export const getRefreshWindow = getSnapshot;

/** The current refresh window, re-rendering the caller when it opens or closes. */
export function useRefreshWindow(): RefreshWindow {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test seam: forget any open window. */
export function resetRefreshWindow(): void {
	if (closeTimer !== undefined) clearTimeout(closeTimer);
	closeTimer = undefined;
	emit({ startedAt: null, active: false });
}
