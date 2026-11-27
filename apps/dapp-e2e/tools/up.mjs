/**
 * Bring up everything the dapp end-to-end suite needs, in one process tree:
 *
 *   1. a Hardhat node on 8546 presenting Sepolia's chain id (E2E_NODE_CHAIN_ID), with
 *      Multicall3 placed at its canonical address (the dapp batches reads through it,
 *      and a fresh chain has no code there),
 *   2. the mock gold tokens and feeds, then the protocol, via the real deploy scripts,
 *   3. a real Uniswap v3 from vendored artifacts with a seeded GSUSD/PAXG pool, a seeded
 *      reserve, a deployer vault and a liquidation victim's vault, so every page and
 *      every flow has state,
 *   4. the test wallet (the node's account #1) funded with PAXG, XAUT and GSUSD,
 *   5. the API on 3334 against this chain, in its own Redis namespace, with the
 *      indexer at zero confirmations and the usage ledger switched on
 *      (E2E_API_URL points at an API you run instead),
 *   6. apps/dapp/.env.e2e.local written from the deployment snapshot,
 *   7. the dapp on 4201 in e2e mode, proxying /trpc to that API.
 *
 * Playwright runs this as its web server and waits for the dapp URL. Stopping the
 * process stops the node, the API and the dapp with it. Needs Redis on 127.0.0.1:6379
 * (or REDIS_HOST) for the API.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTRACTS = resolve(ROOT, 'contracts');
// Execute JavaScript entry points directly: npm's .bin shims are shell scripts on
// Unix and .cmd wrappers on Windows, neither of which spawn can execute portably.
const HARDHAT_BIN = resolve(CONTRACTS, 'node_modules/hardhat/internal/cli/cli.js');
const VITE_BIN = resolve(ROOT, 'node_modules/vite/bin/vite.js');
const RPC_PORT = 8546;
const DAPP_PORT = 4201;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const API_PORT = 3334;
const API = process.env.E2E_API_URL ?? `http://127.0.0.1:${API_PORT}`;
const OWN_API = !process.env.E2E_API_URL;
const NX_PACKAGE = resolve(ROOT, 'node_modules/nx');
const NX_BIN = resolve(NX_PACKAGE, JSON.parse(readFileSync(resolve(NX_PACKAGE, 'package.json'), 'utf8')).bin.nx);
const SEPOLIA_CHAIN_ID = '0xaa36a7';

// Hardhat's deterministic accounts: #0 deploys and holds the governance roles, #1 is the
// wallet, #2 the victim of the direct liquidation, #3 the pool's liquidity provider,
// #4 the victim of the pool liquidation.
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const VICTIM = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const LIQUIDITY_PROVIDER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const POOL_VICTIM = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
// Multicall3's canonical address on every chain; the runtime bytecode is vendored from Sepolia.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_CODE = resolve(dirname(fileURLToPath(import.meta.url)), 'multicall3.runtime.hex');
// Generous ceilings so no test hits one; the ramp is a mainnet concern.
const CEILING_WEI = 1_000_000n * 10n ** 18n;

const children = [];
const log = (line) => console.log(`[e2e-up] ${line}`);

// The node and the dapp are spawned as direct binaries (not through npx, which would
// swallow the signal) and stay in this process's group: Playwright stops its web server
// by killing that group, so nothing can outlive a run, and our own handlers cover a
// SIGINT or SIGTERM aimed at this process alone.
function killChild(child) {
	if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}

function stopAll(code = 0) {
	for (const child of children) killChild(child);
	process.exit(code);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
process.on('exit', () => {
	for (const child of children) killChild(child);
});

function assertPortFree(port, what) {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once('error', () =>
			reject(new Error(`Port ${port} is in use: stop the old ${what} first (lsof -nP -iTCP:${port} -sTCP:LISTEN).`))
		);
		server.once('listening', () => server.close(() => resolvePort()));
		server.listen(port, '127.0.0.1');
	});
}

function run(label, args, env = {}) {
	log(label);
	const result = spawnSync(process.execPath, [HARDHAT_BIN, 'run', ...args], {
		cwd: CONTRACTS,
		env: { ...process.env, ...env },
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.status !== 0) {
		throw new Error(`${label} failed\n${result.stdout}\n${result.stderr}`);
	}
	return result.stdout;
}

async function waitFor(check, what, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check().catch(() => false)) return;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`Timed out waiting for ${what}.`);
}

async function rpc(method, params = []) {
	const res = await fetch(RPC, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const body = await res.json();
	if (body.error) throw new Error(`${method}: ${body.error.message}`);
	return body.result;
}

async function rpcChainId() {
	return rpc('eth_chainId');
}

async function installMulticall3() {
	const code = readFileSync(MULTICALL3_CODE, 'utf8').trim();
	await rpc('hardhat_setCode', [MULTICALL3, code]);
	// getBlockNumber() must answer, or every batched read in the dapp fails silently.
	const answer = await rpc('eth_call', [{ to: MULTICALL3, data: '0x42cbb15c' }, 'latest']);
	if (typeof answer !== 'string' || answer.length !== 66) throw new Error('Multicall3 did not answer after setCode.');
	log(`Multicall3 installed at ${MULTICALL3}`);
}

function parseEnvBlock(stdout, keys) {
	const out = {};
	for (const key of keys) {
		const match = stdout.match(new RegExp(`^${key}=(0x[0-9a-fA-F]{40})$`, 'm'));
		if (!match) throw new Error(`deploy-testnet-mocks did not print ${key}`);
		out[key] = match[1];
	}
	return out;
}

/**
 * The API against this chain: prices and the vault-owner indexer that the liquidations
 * page reads first. The dapp's token list no longer comes from here (it is
 * bundled); the token route is only the readiness probe. Its own Redis
 * namespace per run, so nothing from the dev API or an earlier run leaks in, and zero
 * indexer confirmations because the local chain only advances when something is mined.
 */
async function startApi(snap) {
	const apiAnswers = () => fetch(`${API}/trpc/tokensRouter.getAll`).then((r) => r.ok).catch(() => false);
	if (!OWN_API) {
		if (!(await apiAnswers())) throw new Error(`E2E_API_URL=${API} is not answering.`);
		log(`using the API at ${API}`);
		return undefined;
	}
	await assertPortFree(API_PORT, 'end-to-end API');
	log('building the API');
	const built = spawnSync(process.execPath, [NX_BIN, 'build', 'api'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	if (built.status !== 0) throw new Error(`nx build api failed\n${built.stdout}\n${built.stderr}`);
	const namespace = `e2e-${Date.now()}`;
	log(`starting the API on ${API_PORT} (Redis namespace ${namespace})`);
	const api = spawn(process.execPath, [resolve(ROOT, 'dist/apps/api/main.js')], {
		cwd: ROOT,
		env: {
			...process.env,
			PORT: String(API_PORT),
			REDIS_NAMESPACE: namespace,
			SEPOLIA_RPC_URL: RPC,
			INDEXER_CHAIN_ID: '11155111',
			INDEXER_CONFIRMATIONS: '0',
			GOLD_VAULT_ADDRESS: snap.addresses.vault,
			GOLD_VAULT_DEPLOY_BLOCK: String(snap.deployBlock ?? 0),
			// The usage ledger is on in this suite. It records from an hour before the run, so the
			// vault and pool specs leave usage on it, and it reads the chain at zero confirmations
			// for the same reason the owner indexer does. The seeded Uniswap pool pairs GSUSD with
			// gold, not with a dollar, so the liquidity dimension stays off here.
			LEDGER_START_TIMESTAMP: String(Math.floor(Date.now() / 1000) - 3600),
			LEDGER_STABILITY_POOL_ADDRESS: snap.addresses.stabilityPool,
			LEDGER_CONFIRMATIONS: '0',
			VITE_PAXG_ADDRESS: snap.config.paxgToken,
			VITE_XAUT_ADDRESS: snap.config.xautToken,
			VITE_GUSD_ADDRESS: snap.addresses.stablecoin,
		},
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	children.push(api);
	api.on('exit', (code) => {
		if (code !== null && code !== 0) {
			console.error(`[e2e-up] API exited with ${code} (is Redis running on ${process.env.REDIS_HOST ?? '127.0.0.1'}:6379?)`);
			stopAll(1);
		}
	});
	await waitFor(apiAnswers, 'the API', 90_000);
	return { namespace };
}

async function main() {
	await assertPortFree(RPC_PORT, 'end-to-end node');
	await assertPortFree(DAPP_PORT, 'end-to-end dapp');

	log(`starting Hardhat node on ${RPC_PORT} as chain ${parseInt(SEPOLIA_CHAIN_ID, 16)}`);
	const node = spawn(process.execPath, [HARDHAT_BIN, 'node', '--port', String(RPC_PORT)], {
		cwd: CONTRACTS,
		env: { ...process.env, E2E_NODE_CHAIN_ID: String(parseInt(SEPOLIA_CHAIN_ID, 16)) },
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	children.push(node);
	node.on('exit', (code) => {
		if (code !== null && code !== 0) {
			console.error(`[e2e-up] Hardhat node exited with ${code}`);
			stopAll(1);
		}
	});
	await waitFor(async () => (await rpcChainId()) === SEPOLIA_CHAIN_ID, 'the node', 60_000);
	await installMulticall3();

	const mocks = parseEnvBlock(
		run('deploying mock gold tokens and feeds', ['scripts/deploy-testnet-mocks.ts', '--network', 'e2e']),
		['PAXG_TOKEN', 'XAUT_TOKEN', 'PAXG_FEED', 'XAUT_FEED', 'XAU_USD_ANCHOR_FEED']
	);
	run('deploying the protocol', ['scripts/deploy.ts', '--network', 'e2e'], {
		...mocks,
		TIMELOCK_PROPOSER: DEPLOYER,
		TIMELOCK_EXECUTOR: DEPLOYER,
		TIMELOCK_GUARDIAN: DEPLOYER,
		PAXG_DEBT_CEILING: CEILING_WEI.toString(),
		XAUT_DEBT_CEILING: CEILING_WEI.toString(),
		MIN_GSUSD_RESERVE: '0',
	});
	run('deploying Uniswap v3', ['scripts/deploy-e2e-dex.ts', '--network', 'e2e']);
	const uniswap = JSON.parse(readFileSync(resolve(CONTRACTS, 'deployments/e2e.json'), 'utf8')).config.uniswap;
	run('seeding the GSUSD/PAXG pool', ['scripts/seed-testnet-dex.ts', '--network', 'e2e'], {
		...mocks,
		LP_ADDRESS: LIQUIDITY_PROVIDER,
		UNISWAP_FACTORY: uniswap.factory,
		UNISWAP_POSITION_MANAGER: uniswap.positionManager,
		UNISWAP_QUOTER: uniswap.quoter,
		POOL_FEE: String(uniswap.poolFee),
		PAXG_LP: '5',
	});
	run('seeding the Stability Reserve', ['scripts/seed-testnet-reserve.ts', '--network', 'e2e'], {
		...mocks,
		SEED_PAXG: '20',
	});
	// seed-testnet-position expects the signer to hold the gold already.
	run('minting PAXG to the deployer', ['scripts/mint-testnet-collateral.ts', '--network', 'e2e'], {
		...mocks,
		MINT_TO: DEPLOYER,
		MINT_PAXG: '50',
		MINT_XAUT: '0',
	});
	run('opening the deployer vault', ['scripts/seed-testnet-position.ts', '--network', 'e2e'], {
		...mocks,
		SEED_COLLATERAL: '40',
		SEED_DEBT: '40000',
	});
	const funded = run('funding the test wallet', ['scripts/fund-e2e-wallet.ts', '--network', 'e2e'], {
		E2E_WALLET: WALLET,
		FUND_PAXG: '100',
		FUND_XAUT: '100',
		FUND_GSUSD: '5000',
	});
	for (const line of funded.trim().split('\n')) log(line);
	const victim = run('opening the liquidation victim vault', ['scripts/e2e-victim.ts', '--network', 'e2e'], {
		E2E_VICTIM: VICTIM,
		VICTIM_PAXG: '0.5',
		VICTIM_DEBT: '1400',
	});
	log(victim.trim());
	// Smaller, because the pool may only absorb strictly less than it holds, and the wallet
	// leaves 500 GSUSD in the pool after its own deposit-and-withdraw suite.
	const poolVictim = run('opening the pool liquidation victim vault', ['scripts/e2e-victim.ts', '--network', 'e2e'], {
		E2E_VICTIM: POOL_VICTIM,
		VICTIM_PAXG: '0.15',
		VICTIM_DEBT: '420',
	});
	log(poolVictim.trim());

	const snap = JSON.parse(readFileSync(resolve(CONTRACTS, 'deployments/e2e.json'), 'utf8'));
	const a = snap.addresses;
	const ownApi = await startApi(snap);
	const env = {
		VITE_TARGET_CHAIN_ID: '11155111',
		VITE_SEPOLIA_RPC_URL: RPC,
		VITE_E2E_WALLET: WALLET,
		VITE_DEPLOY_BLOCK: String(snap.deployBlock ?? 0),
		VITE_GOLD_VAULT_ADDRESS: a.vault,
		VITE_GOLD_ORACLE_ADDRESS: a.oracle,
		VITE_GUSD_ADDRESS: a.stablecoin,
		VITE_PAXG_ADDRESS: snap.config.paxgToken,
		VITE_XAUT_ADDRESS: snap.config.xautToken,
		VITE_SILO_FACTORY_ADDRESS: a.siloFactory,
		VITE_STABILITY_MODULE_ADDRESS: a.stabilityModule,
		VITE_STABILITY_POOL_ADDRESS: a.stabilityPool,
		VITE_STABILITY_RESERVE_ADDRESS: a.reserve,
		VITE_SURPLUS_BUFFER_ADDRESS: a.surplusBuffer,
		// The liquidations page falls back to the registry when the API owner index is down.
		...(a.vaultRegistry ? { VITE_VAULT_REGISTRY_ADDRESS: a.vaultRegistry } : {}),
		VITE_UNISWAP_ROUTER: snap.config.uniswap.router,
		VITE_UNISWAP_QUOTER: snap.config.uniswap.quoter,
		VITE_DEX_POOL_FEE: String(snap.config.uniswap.poolFee),
		// The ledger page is built into the end-to-end dapp (15-ledger.spec.ts).
		VITE_LEDGER_ENABLED: 'true',
		// Not a VITE_ variable, so the bundle never sees it: 15-ledger.spec.ts uses it to drop the
		// ledger index, which specs that revert the chain leave describing blocks that are gone.
		...(ownApi ? { SUITE_REDIS_NAMESPACE: ownApi.namespace } : {}),
	};
	const envFile = resolve(ROOT, 'apps/dapp/.env.e2e.local');
	writeFileSync(
		envFile,
		`# Written by apps/dapp-e2e/tools/up.mjs for the current end-to-end run. Not for humans.\n` +
			Object.entries(env)
				.map(([k, v]) => `${k}=${v}`)
				.join('\n') +
			'\n'
	);
	log(`wrote ${envFile}`);

	log(`starting the dapp on ${DAPP_PORT} in e2e mode, /trpc -> ${API}`);
	const dapp = spawn(process.execPath, [VITE_BIN, '--config', 'apps/dapp-e2e/tools/vite.e2e.config.mts', '--mode', 'e2e'], {
		cwd: ROOT,
		env: { ...process.env, E2E_DAPP_PORT: String(DAPP_PORT), E2E_API_URL: API },
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	children.push(dapp);
	dapp.on('exit', (code) => {
		if (code !== null && code !== 0) {
			console.error(`[e2e-up] dapp exited with ${code}`);
			stopAll(1);
		}
	});
	await waitFor(async () => (await fetch(`http://localhost:${DAPP_PORT}/`)).ok, 'the dapp', 120_000);
	log(`ready: dapp http://localhost:${DAPP_PORT}, node ${RPC}, wallet ${WALLET}, api ${API}`);
}

main().catch((error) => {
	console.error(`[e2e-up] ${error instanceof Error ? error.message : error}`);
	stopAll(1);
});
