import { afterEach, describe, expect, it, vi } from 'vitest';

const TODAY = ['/', '/vault', '/vault/liquidate', '/pool', '/swap', '/redeem', '/transparency', '/docs', '/docs/:slug', '/terms', '*'];

async function routePaths(): Promise<string[]> {
	vi.resetModules();
	const { appRoutes } = await import('./appRoutes');
	return appRoutes().map((route) => route.path);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('appRoutes', () => {
	// The first case imports the whole route table cold, which takes several seconds on a busy
	// machine: under a parallel workspace run it has overrun the default five second limit.
	it('is the route table of every earlier build when VITE_LEDGER_ENABLED is not set', async () => {
		expect(await routePaths()).toEqual(TODAY);
	}, 30_000);

	it.each(['false', 'TRUE', '1', ''])('has no /ledger route for VITE_LEDGER_ENABLED=%j', async (value) => {
		vi.stubEnv('VITE_LEDGER_ENABLED', value);
		expect(await routePaths()).toEqual(TODAY);
	});

	it('adds /ledger, and nothing else, for VITE_LEDGER_ENABLED=true', async () => {
		vi.stubEnv('VITE_LEDGER_ENABLED', 'true');
		const paths = await routePaths();
		expect(paths).toContain('/ledger');
		expect(paths.filter((path) => path !== '/ledger')).toEqual(TODAY);
		// The catch-all redirect stays last.
		expect(paths[paths.length - 1]).toBe('*');
	});
});
