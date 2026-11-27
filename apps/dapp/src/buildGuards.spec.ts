// @vitest-environment node
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLogger, resolveConfig, type ResolvedConfig } from 'vite';
import { REQUIRED_MAINNET_ADDRESS_VARIABLES } from '@goldstandard/constants';

/**
 * These run the real `vite build` with the dapp's own
 * config, because the browser parser alone let a build with an unsupported target chain
 * exit 0 and ship a bundle that throws on load. The guard refuses in buildStart, before
 * any module is loaded, so a refused build takes seconds.
 */
const WORKSPACE_ROOT = resolve(__dirname, '../../..');
const VITE_BIN = join(WORKSPACE_ROOT, 'node_modules/vite/bin/vite.js');
const BUILD_TIMEOUT_MS = 120_000;
/** Any address will do: the guard only refuses a Sepolia build that leaves it unset. */
const SEPOLIA_PAXG = '0x5ccd1c3Cf37261EbA2f681b2848271C9e1De4c6e';

/**
 * The parent environment without the test runner's own variables (VITEST_*, NODE_ENV) or
 * any VITE_* value it loaded, plus the overrides, so each build sees only what the case sets.
 */
const buildEnvironment = (overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({
	...Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith('VITE') && key !== 'NODE_ENV')
	),
	...overrides,
});

/**
 * Runs a production build of the dapp into a throwaway directory and removes it afterwards.
 * Vite still loads the checkout's own apps/dapp/.env files, so one that sets VITE_E2E_WALLET
 * makes every build here refuse for that reason first.
 */
const buildDapp = (overrides: Readonly<Record<string, string>>): SpawnSyncReturns<string> => {
	const outDir = mkdtempSync(join(tmpdir(), 'goldstandard-dapp-build-'));
	try {
		return spawnSync(
			process.execPath,
			[VITE_BIN, 'build', '--config', 'apps/dapp/vite.config.mts', '--outDir', outDir, '--emptyOutDir'],
			{ cwd: WORKSPACE_ROOT, encoding: 'utf8', env: buildEnvironment(overrides), timeout: BUILD_TIMEOUT_MS }
		);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
};

describe('dapp build guards', () => {
	it.each(['invalid-chain', ' 5 '])(
		'refuses a build whose VITE_TARGET_CHAIN_ID is %j, naming the value and the accepted values',
		(raw) => {
			const result = buildDapp({ VITE_TARGET_CHAIN_ID: raw });
			const output = `${result.stdout}\n${result.stderr}`;
			expect(result.error).toBeUndefined();
			expect(result.status).not.toBe(0);
			expect(output).toContain(`VITE_TARGET_CHAIN_ID "${raw}"`);
			expect(output).toContain('"1" (mainnet)');
			expect(output).toContain('"11155111" (Sepolia)');
		},
		BUILD_TIMEOUT_MS
	);

	// The release path: an empty value in the shell overrides a 1 in any .env file and would
	// build the Sepolia frontend, so the build refuses it.
	it(
		'refuses a build whose VITE_TARGET_CHAIN_ID is empty, naming the chains it may name',
		() => {
			const result = buildDapp({ VITE_TARGET_CHAIN_ID: '' });
			const output = `${result.stdout}\n${result.stderr}`;
			expect(result.error).toBeUndefined();
			expect(result.status).not.toBe(0);
			expect(output).toContain('VITE_TARGET_CHAIN_ID is unset or empty');
			expect(output).toContain('"1" (mainnet) or "11155111" (Sepolia)');
		},
		BUILD_TIMEOUT_MS
	);

	// A full build, so this one takes longer: it proves the guard still admits Sepolia.
	it(
		'still completes a Sepolia build with an explicit VITE_TARGET_CHAIN_ID',
		() => {
			const result = buildDapp({ VITE_TARGET_CHAIN_ID: '11155111', VITE_PAXG_ADDRESS: SEPOLIA_PAXG });
			expect(result.error).toBeUndefined();
			expect(result.stderr).not.toContain('Refusing to build');
			expect(result.status).toBe(0);
		},
		BUILD_TIMEOUT_MS
	);
});

/**
 * An unset VITE_TARGET_CHAIN_ID takes its own branches in
 * the guard, and the release build reads the value from apps/dapp/.env.production.local. A
 * spawned build cannot leave the variable unset or confine it to one file, because Vite loads
 * apps/dapp/.env.local in every mode and its command line has no envDir option. These resolve
 * the dapp config in process against a temporary envDir that holds only the .env files a case
 * writes, with every VITE_* variable removed, then run the guard's buildStart hook as a build
 * does next, but bundle nothing.
 */
const CONFIG_FILE = join(WORKSPACE_ROOT, 'apps/dapp/vite.config.mts');
const TARGET_CHAIN_GUARD = 'goldstandard:refuse-unsupported-target-chain-in-builds';

/**
 * What a mainnet build must carry besides its chain: the
 * dapp block scripts/print-service-env.ts prints, with its placeholders filled. Token overrides
 * are left out, so the bundled mainnet PAXG and XAUT apply.
 */
const MAINNET_BUILD_ENV: Readonly<Record<string, string>> = {
	VITE_MAINNET_RPC_URL: 'https://rpc-one.example/key,https://rpc-two.example/key',
	VITE_API_URL: 'https://api.example/trpc',
	VITE_SOURCE_URL: 'https://code.example/gold-standard',
	VITE_WALLETCONNECT_PROJECT_ID: 'build-guard-spec-project',
	VITE_DEPLOY_BLOCK: '21000000',
	...Object.fromEntries(
		REQUIRED_MAINNET_ADDRESS_VARIABLES.map((key, index) => [key, `0x${(index + 1).toString(16).padStart(40, '0')}`])
	),
};

/** The same block as the text of an .env file, with the chain it targets. */
const mainnetEnvFile = (overrides: Readonly<Record<string, string>> = {}): string =>
	Object.entries({ VITE_TARGET_CHAIN_ID: '1', ...MAINNET_BUILD_ENV, ...overrides })
		.map(([key, value]) => `${key}=${value}\n`)
		.join('');

/** Adds the mainnet block, less the named variables, to the stubbed environment. */
const stubMainnetEnv = (omit: readonly string[] = []): void => {
	Object.entries(MAINNET_BUILD_ENV)
		.filter(([key]) => !omit.includes(key))
		.forEach(([key, value]) => vi.stubEnv(key, value));
};

/**
 * Removes every VITE_* variable for this test, then sets the target chain unless it stays unset,
 * and the Sepolia PAXG address a Sepolia build needs unless `paxgAddress` is null (left unset).
 */
const stubOnlyTargetChain = (targetChain: string | undefined, paxgAddress: string | null = SEPOLIA_PAXG): void => {
	Object.keys(process.env)
		.filter((key) => key.startsWith('VITE_'))
		.forEach((key) => vi.stubEnv(key, undefined));
	// The config fills VITE_BUILD_COMMIT from git when it is missing; a fixed value keeps that
	// write out of this process and is restored with the other stubs.
	vi.stubEnv('VITE_BUILD_COMMIT', 'build-guard-spec');
	// Stubbed even when unset, so whatever an .env file leaves behind is restored afterwards.
	vi.stubEnv('VITE_TARGET_CHAIN_ID', targetChain);
	vi.stubEnv('VITE_PAXG_ADDRESS', paxgAddress ?? undefined);
};

/** Resolves the dapp config for `command` in `mode`, with only the given .env files in play. */
const resolveBuildConfig = async (
	mode: string,
	envFiles: Readonly<Record<string, string>> = {},
	command: 'build' | 'serve' = 'build',
	onWarning: (message: string) => void = () => undefined
): Promise<ResolvedConfig> => {
	const envDir = mkdtempSync(join(tmpdir(), 'goldstandard-dapp-env-'));
	try {
		Object.entries(envFiles).forEach(([name, content]) => writeFileSync(join(envDir, name), content));
		const customLogger = { ...createLogger('silent'), warn: onWarning };
		return await resolveConfig({ configFile: CONFIG_FILE, envDir, mode, customLogger }, command);
	} finally {
		rmSync(envDir, { recursive: true, force: true });
	}
};

/** Runs the target chain guard's buildStart hook from a resolved config, as a build does. */
const runTargetChainGuard = async (config: ResolvedConfig): Promise<void> => {
	const hook = config.plugins.find((plugin) => plugin.name === TARGET_CHAIN_GUARD)?.buildStart;
	const handler = typeof hook === 'function' ? hook : hook?.handler;
	if (handler === undefined) throw new Error(`The dapp config has no ${TARGET_CHAIN_GUARD} buildStart hook`);
	// The guard reads only what its configResolved hook saved, never its plugin context or options.
	await Reflect.apply(handler, undefined, []);
};

describe('dapp build guards in process', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// The mainnet cases guard the release path: a guard that admitted only Sepolia would pass
	// every other case in this file yet stop `npx nx build dapp` with VITE_TARGET_CHAIN_ID=1.
	it.each<[label: string, chain: string, targetChain: string | undefined]>([
		['"11155111"', 'Sepolia', '11155111'],
		['"1"', 'mainnet', '1'],
		['" 1 " with surrounding whitespace', 'mainnet', ' 1 '],
	])(
		'admits a build whose VITE_TARGET_CHAIN_ID is %s, which selects %s',
		async (_label, chain, targetChain) => {
			// Mainnet takes no PAXG override here: the Sepolia mock is not mainnet PAXG.
			stubOnlyTargetChain(targetChain, chain === 'mainnet' ? null : SEPOLIA_PAXG);
			if (chain === 'mainnet') stubMainnetEnv();
			await expect(runTargetChainGuard(await resolveBuildConfig('production'))).resolves.toBeUndefined();
		},
		BUILD_TIMEOUT_MS
	);

	// A build that names no chain would ship the Sepolia frontend without a word. `vite build`
	// makes a production bundle in development mode too, so that mode gets no fallback either.
	it.each<[label: string, mode: string, targetChain: string | undefined]>([
		['unset', 'production', undefined],
		['empty', 'production', ''],
		['only whitespace', 'production', '  '],
		['unset', 'development', undefined],
	])(
		'refuses a build whose VITE_TARGET_CHAIN_ID is %s, in %s mode',
		async (_label, mode, targetChain) => {
			stubOnlyTargetChain(targetChain);
			await expect(runTargetChainGuard(await resolveBuildConfig(mode))).rejects.toThrow(
				'VITE_TARGET_CHAIN_ID is unset or empty'
			);
		},
		BUILD_TIMEOUT_MS
	);

	// apply: 'build' is all that keeps the guard away from the dev server, vitest and the e2e
	// flow: Vite runs buildStart when a dev server starts, so the guard would refuse there too.
	it(
		'leaves the dev server and vitest alone, even with an unsupported value',
		async () => {
			stubOnlyTargetChain('invalid-chain');
			const config = await resolveBuildConfig('development', {}, 'serve');
			expect(config.plugins.map((plugin) => plugin.name)).not.toContain(TARGET_CHAIN_GUARD);
		},
		BUILD_TIMEOUT_MS
	);

	// Sepolia PAXG has no bundled fallback, so a Sepolia build
	// without it would list no PAXG. Mainnet falls back to the real token and needs nothing.
	it.each<[label: string, paxgAddress: string | null]>([
		['unset', null],
		['only whitespace', '  '],
	])(
		'refuses a Sepolia build whose VITE_PAXG_ADDRESS is %s',
		async (_label, paxgAddress) => {
			stubOnlyTargetChain('11155111', paxgAddress);
			await expect(runTargetChainGuard(await resolveBuildConfig('production'))).rejects.toThrow(
				'a Sepolia build needs VITE_PAXG_ADDRESS'
			);
		},
		BUILD_TIMEOUT_MS
	);

	it(
		'admits a mainnet build with no VITE_PAXG_ADDRESS',
		async () => {
			stubOnlyTargetChain('1', null);
			stubMainnetEnv();
			await expect(runTargetChainGuard(await resolveBuildConfig('production'))).resolves.toBeUndefined();
		},
		BUILD_TIMEOUT_MS
	);

	// The control case: the guard still runs under this harness, so the cases above can fail.
	it(
		'still refuses an unsupported VITE_TARGET_CHAIN_ID under the same harness',
		async () => {
			stubOnlyTargetChain('invalid-chain');
			await expect(runTargetChainGuard(await resolveBuildConfig('production'))).rejects.toThrow(
				'VITE_TARGET_CHAIN_ID "invalid-chain"'
			);
		},
		BUILD_TIMEOUT_MS
	);

	// The release path: docs/MAINNET.md has the operator paste the dapp block into
	// apps/dapp/.env.production.local, so the guard must judge the value Vite loaded from that
	// file, not only one in the process environment.
	it.each<[label: string, content: string, refusal: string | undefined]>([
		['refuses an unsupported value', 'VITE_TARGET_CHAIN_ID=invalid-chain\n', 'VITE_TARGET_CHAIN_ID "invalid-chain"'],
		['refuses a misspelt variable name', 'VITE_TARGET_CHAINID=1\n', 'VITE_TARGET_CHAIN_ID is unset or empty'],
		['admits a mainnet block', mainnetEnvFile(), undefined],
	])(
		'%s that only .env.production.local sets',
		async (_label, content, refusal) => {
			stubOnlyTargetChain(undefined, null);
			const guard = runTargetChainGuard(
				await resolveBuildConfig('production', { '.env.production.local': content })
			);
			if (refusal === undefined) {
				await expect(guard).resolves.toBeUndefined();
			} else {
				await expect(guard).rejects.toThrow(refusal);
			}
		},
		BUILD_TIMEOUT_MS
	);

	// Nx resolves this config with command 'build' and mode 'development' to infer the dapp's
	// targets (@nx/vite and @nx/vitest), so resolving must never refuse: a bad value in a local
	// .env file would otherwise stop every nx command in the workspace, not only the build.
	it(
		'lets Nx resolve the config with an unsupported value and leaves the refusal to the build',
		async () => {
			stubOnlyTargetChain(undefined);
			const resolving = resolveBuildConfig('development', { '.env.local': 'VITE_TARGET_CHAIN_ID=31337\n' });
			await expect(resolving).resolves.toBeDefined();
			await expect(runTargetChainGuard(await resolving)).rejects.toThrow('VITE_TARGET_CHAIN_ID "31337"');
		},
		BUILD_TIMEOUT_MS
	);
});

/**
 * A mainnet bundle is pinned and named by an ENS
 * content hash, so the guard judges the whole VITE_* environment before anything is bundled.
 * The rules themselves are covered in libs/constants/src/lib/buildEnv.spec.ts; these prove the
 * dapp's own config feeds them what Vite loaded and refuses in buildStart.
 */
describe('dapp build guards on the mainnet environment', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it(
		'refuses a mainnet build that names only its chain, listing every missing value in one message',
		async () => {
			stubOnlyTargetChain('1', null);
			const guard = runTargetChainGuard(await resolveBuildConfig('production'));
			await expect(guard).rejects.toThrow(/Refusing to build the dapp, for \d+ reasons:/);
			for (const key of ['VITE_MAINNET_RPC_URL', 'VITE_API_URL', 'VITE_DEPLOY_BLOCK', ...REQUIRED_MAINNET_ADDRESS_VARIABLES]) {
				await expect(guard).rejects.toThrow(key);
			}
		},
		BUILD_TIMEOUT_MS
	);

	it(
		'refuses the printed dapp block while a placeholder is still unfilled',
		async () => {
			stubOnlyTargetChain(undefined, null);
			const block = mainnetEnvFile({ VITE_API_URL: "<fill in: the API's public tRPC endpoint>" });
			const guard = runTargetChainGuard(await resolveBuildConfig('production', { '.env.production.local': block }));
			await expect(guard).rejects.toThrow('VITE_API_URL still holds its "<fill in: ...>" placeholder');
		},
		BUILD_TIMEOUT_MS
	);

	it(
		'refuses a token override that is not canonical mainnet PAXG, as a Sepolia value left in an env file would be',
		async () => {
			stubOnlyTargetChain('1', SEPOLIA_PAXG);
			stubMainnetEnv();
			await expect(runTargetChainGuard(await resolveBuildConfig('production'))).rejects.toThrow(
				`VITE_PAXG_ADDRESS "${SEPOLIA_PAXG}" is not mainnet PAXG`
			);
		},
		BUILD_TIMEOUT_MS
	);

	it(
		'refuses a mainnet build beside a .env.local, whose values it would inherit, unless the build accepts it',
		async () => {
			stubOnlyTargetChain('1', null);
			stubMainnetEnv();
			const envLocal = { '.env.local': 'VITE_SEPOLIA_RPC_URL=https://sepolia.example\n' };
			await expect(runTargetChainGuard(await resolveBuildConfig('production', envLocal))).rejects.toThrow(
				'apps/dapp/.env.local exists'
			);
			vi.stubEnv('VITE_ALLOW_ENV_LOCAL', '1');
			await expect(runTargetChainGuard(await resolveBuildConfig('production', envLocal))).resolves.toBeUndefined();
		},
		BUILD_TIMEOUT_MS
	);

	it(
		'warns, and still builds, when a mainnet build has no WalletConnect project id',
		async () => {
			stubOnlyTargetChain('1', null);
			stubMainnetEnv(['VITE_WALLETCONNECT_PROJECT_ID']);
			const warnings: string[] = [];
			const config = await resolveBuildConfig('production', {}, 'build', (message) => warnings.push(message));
			await expect(runTargetChainGuard(config)).resolves.toBeUndefined();
			expect(warnings.filter((message) => message.includes('VITE_WALLETCONNECT_PROJECT_ID'))).toHaveLength(1);
		},
		BUILD_TIMEOUT_MS
	);

	it(
		'refuses an RPC URL whose host is filled in while its <key> placeholder is not, without repeating it',
		async () => {
			stubOnlyTargetChain('1', null);
			stubMainnetEnv();
			vi.stubEnv('VITE_MAINNET_RPC_URL', 'https://rpc-one.example/secret-provider-key,https://rpc-two.example/v2/<key>');
			const guard = runTargetChainGuard(await resolveBuildConfig('production'));
			await expect(guard).rejects.toThrow(
				'VITE_MAINNET_RPC_URL entry 2 of 2 still holds an angle-bracket placeholder such as <key>'
			);
			await expect(guard).rejects.not.toThrow('secret-provider-key');
			await expect(guard).rejects.not.toThrow('rpc-two.example');
		},
		BUILD_TIMEOUT_MS
	);

	it(
		'refuses one address pasted into two contract variables, naming both',
		async () => {
			stubOnlyTargetChain('1', null);
			stubMainnetEnv();
			vi.stubEnv('VITE_GUSD_ADDRESS', MAINNET_BUILD_ENV['VITE_GOLD_VAULT_ADDRESS'] ?? '');
			await expect(runTargetChainGuard(await resolveBuildConfig('production'))).rejects.toThrow(
				'VITE_GUSD_ADDRESS holds the same address as VITE_GOLD_VAULT_ADDRESS'
			);
		},
		BUILD_TIMEOUT_MS
	);

	it(
		'never repeats an RPC URL, which carries the provider key, in its refusal',
		async () => {
			stubOnlyTargetChain('1', null);
			stubMainnetEnv();
			vi.stubEnv('VITE_MAINNET_RPC_URL', 'http://rpc.example/secret-provider-key');
			const guard = runTargetChainGuard(await resolveBuildConfig('production'));
			await expect(guard).rejects.toThrow('VITE_MAINNET_RPC_URL entry 1 of 1 is not an https URL.');
			await expect(guard).rejects.not.toThrow('secret-provider-key');
		},
		BUILD_TIMEOUT_MS
	);
});
