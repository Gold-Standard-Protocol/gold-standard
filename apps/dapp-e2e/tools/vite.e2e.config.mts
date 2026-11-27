import { defineConfig, mergeConfig, type Plugin } from 'vite';
import base from '../../dapp/vite.config.mts';

const E2E_RPC = process.env['E2E_RPC_URL'] ?? 'http://127.0.0.1:8546';

/**
 * The page's own policy allows RPC connections over https only, which is right for every
 * deployment and wrong for the one local node the suite talks to. In e2e mode alone the
 * meta policy also admits that node, so the policy itself stays under test.
 */
function admitLocalNode(): Plugin {
	return {
		name: 'goldstandard:e2e-admit-local-node',
		transformIndexHtml(html) {
			const directive = "connect-src 'self' https: wss:";
			if (!html.includes(directive)) {
				throw new Error(`index.html no longer contains "${directive}"; the e2e node cannot be admitted to the page policy.`);
			}
			return html.replace(directive, `${directive} ${E2E_RPC}`);
		},
	};
}

/**
 * The dapp's own Vite config plus what the Nx dev-server executor normally adds: the
 * /trpc proxy to the API, which serves prices and the vault-owner index, and the proxy for
 * the Usage Ledger's download.
 * The token list is bundled with the dapp; its addresses and
 * the contract addresses come from apps/dapp/.env.e2e.local (loaded by `--mode e2e`,
 * root apps/dapp) for the target chain.
 */
export default mergeConfig(
	base,
	defineConfig({
		plugins: [admitLocalNode()],
		server: {
			port: Number(process.env['E2E_DAPP_PORT'] ?? 4201),
			strictPort: true,
			host: 'localhost',
			// up.mjs writes .env.e2e.local just before it starts this server, and Vite restarts on
			// any change to an env file it watches. When the macOS file event lands after startup,
			// the restart kills the dependency scan mid-run and every page loads blank ("error while
			// updating dependencies ... browserHash"), most reliably right after an npm ci empties
			// the optimizer cache. The values are read once at start, so the file is not watched.
			watch: { ignored: ['**/apps/dapp/.env.e2e.local'] },
			proxy: {
				'/trpc': {
					target: process.env['E2E_API_URL'] ?? 'http://localhost:3333',
					changeOrigin: true,
				},
				// The Usage Ledger's whole record, which the API serves beside its tRPC endpoint.
				'/usage-ledger.csv': { target: process.env['E2E_API_URL'] ?? 'http://localhost:3333', changeOrigin: true },
				'/usage-ledger.json': { target: process.env['E2E_API_URL'] ?? 'http://localhost:3333', changeOrigin: true },
			},
		},
	})
);
