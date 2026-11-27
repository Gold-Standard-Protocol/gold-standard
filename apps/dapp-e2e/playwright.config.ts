import { defineConfig } from '@playwright/test';

/**
 * Dapp end-to-end suite against a local chain.
 *
 * `tools/up.mjs` brings up a Hardhat node presenting Sepolia's chain id, deploys the
 * protocol with the real deploy scripts, seeds it, funds the test wallet and starts the
 * dapp in e2e mode on port 4201. The wallet is the node's own account #1, connected
 * through wagmi's mock connector, so no key is involved and the installed Chrome drives
 * the flows. Run with `npx nx e2e dapp-e2e`.
 */
const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:4201';

export default defineConfig({
	testDir: './src',
	outputDir: '../../dist/.playwright/dapp-e2e/results',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 120_000,
	expect: { timeout: 30_000 },
	reporter: [
		['list'],
		['html', { outputFolder: '../../dist/.playwright/dapp-e2e/report', open: 'never' }],
	],
	use: {
		baseURL,
		channel: 'chrome',
		headless: true,
		viewport: { width: 1280, height: 900 },
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	webServer: {
		command: 'node apps/dapp-e2e/tools/up.mjs',
		cwd: '../..',
		url: baseURL,
		timeout: 360_000,
		// Every run starts from a fresh chain; up.mjs refuses to start over a stale one.
		// E2E_REUSE=1 attaches to a bootstrap you started yourself, for debugging.
		reuseExistingServer: process.env['E2E_REUSE'] === '1',
		stdout: 'pipe',
		stderr: 'pipe',
	},
});
