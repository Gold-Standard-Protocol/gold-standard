import { describe, expect, it } from 'vitest';
import {
	ALLOW_ENV_LOCAL_VARIABLE,
	REQUIRED_MAINNET_ADDRESS_VARIABLES,
	buildEnvRefusal,
	checkBuildEnv,
	ledgerCodeProblems,
	type BuildEnv,
} from './buildEnv';
import { MAINNET_PAXG_ADDRESS, MAINNET_XAUT_ADDRESS } from './mainnetTokens';
import { TOKEN_LIST } from './tokens';

const MAINNET = 1;
const SEPOLIA = 11155111;
const RPC_KEY = 'secret-provider-key';

/** A distinct, valid, non-zero address per variable. */
const addressFor = (index: number): string => `0x${(index + 1).toString(16).padStart(40, '0')}`;

const MAINNET_ENV: BuildEnv = {
	VITE_TARGET_CHAIN_ID: '1',
	VITE_MAINNET_RPC_URL: `https://rpc-one.example/v2/${RPC_KEY}, https://rpc-two.example/${RPC_KEY}`,
	VITE_API_URL: 'https://api.example/trpc',
	VITE_SOURCE_URL: 'https://code.example/gold-standard',
	VITE_WALLETCONNECT_PROJECT_ID: 'a-real-project-id',
	VITE_DEPLOY_BLOCK: '21000000',
	...Object.fromEntries(REQUIRED_MAINNET_ADDRESS_VARIABLES.map((key, index) => [key, addressFor(index)])),
	VITE_PAXG_ADDRESS: MAINNET_PAXG_ADDRESS,
	VITE_XAUT_ADDRESS: MAINNET_XAUT_ADDRESS,
	VITE_UNISWAP_ROUTER: addressFor(40),
	VITE_UNISWAP_QUOTER: addressFor(41),
	VITE_DEX_POOL_FEE: '3000',
};

const mainnet = (overrides: BuildEnv = {}, hasEnvLocalFile = false) =>
	checkBuildEnv({ chainId: MAINNET, env: { ...MAINNET_ENV, ...overrides }, hasEnvLocalFile });

describe('checkBuildEnv on a mainnet build', () => {
	it('admits the block the service env printer writes once its placeholders are filled', () => {
		expect(mainnet()).toEqual({ problems: [], warnings: [] });
	});

	it('admits a single RPC URL and no token overrides, which fall back to the bundled tokens', () => {
		const report = mainnet({
			VITE_MAINNET_RPC_URL: 'https://rpc-one.example',
			VITE_PAXG_ADDRESS: undefined,
			VITE_XAUT_ADDRESS: undefined,
		});
		expect(report.problems).toEqual([]);
	});

	it.each(['VITE_MAINNET_RPC_URL', 'VITE_API_URL'])('refuses a build that leaves %s unset', (key) => {
		expect(mainnet({ [key]: undefined }).problems).toEqual([expect.stringContaining(`${key} is unset`)]);
		expect(mainnet({ [key]: '  ' }).problems).toEqual([expect.stringContaining(`${key} is unset`)]);
	});

	it('refuses an API URL that is not https, which the page policy would block', () => {
		expect(mainnet({ VITE_API_URL: 'http://api.example/trpc' }).problems).toEqual([
			expect.stringContaining('VITE_API_URL is not an https URL'),
		]);
		expect(mainnet({ VITE_API_URL: '/trpc' }).problems).toHaveLength(1);
	});

	it('names the RPC entry that is not https without repeating any URL or its key', () => {
		const report = mainnet({ VITE_MAINNET_RPC_URL: `https://rpc-one.example/${RPC_KEY},http://rpc-two.example/${RPC_KEY}` });
		expect(report.problems).toEqual(['VITE_MAINNET_RPC_URL entry 2 of 2 is not an https URL.']);
		expect(mainnet({ VITE_MAINNET_RPC_URL: `wss://rpc.example/${RPC_KEY}` }).problems.join('\n')).not.toContain(RPC_KEY);
	});

	// docs/MAINNET.md writes the RPC value as https://<provider-a>/<key>: a host filled in and a
	// key forgotten parses as a valid https URL, and every read through it would fail.
	it.each([
		['a typed <key>', `https://rpc-one.example/v2/<key>,https://rpc-two.example/${RPC_KEY}`, 1],
		['a percent-encoded <key>', `https://rpc-one.example/${RPC_KEY},https://rpc-two.example/%3Ckey%3e`, 2],
		['a placeholder host', `https://<provider-a>/${RPC_KEY},https://rpc-two.example/${RPC_KEY}`, 1],
		['a placeholder in the query', `https://rpc-one.example/${RPC_KEY},https://rpc-two.example/?apikey=<key>`, 2],
	])('refuses an RPC entry that still holds %s, without repeating the URL', (_case, value, entry) => {
		const report = mainnet({ VITE_MAINNET_RPC_URL: value });
		expect(report.problems).toEqual([
			`VITE_MAINNET_RPC_URL entry ${entry} of 2 still holds an angle-bracket placeholder such as <key>; replace every placeholder with its real value.`,
		]);
		expect(report.problems.join('\n')).not.toContain(RPC_KEY);
		expect(report.problems.join('\n')).not.toContain('example');
	});

	it.each(['VITE_API_URL', 'VITE_SOURCE_URL'])('refuses a %s that still holds an angle-bracket placeholder', (key) => {
		for (const value of ['https://api.example/<path>', 'https://<host>/trpc', 'https://api.example/%3Cpath%3E']) {
			expect(mainnet({ [key]: value }).problems).toEqual([
				`${key} still holds an angle-bracket placeholder such as <key>; replace every placeholder with its real value.`,
			]);
		}
	});

	it('reports a printer placeholder once, not also as an angle-bracket placeholder', () => {
		expect(mainnet({ VITE_API_URL: "<fill in: the API's public tRPC endpoint>" }).problems).toEqual([
			expect.stringContaining('VITE_API_URL still holds its "<fill in: ...>" placeholder'),
		]);
	});

	it('refuses one address pasted into several contract variables, naming each pair', () => {
		const vault = addressFor(0);
		const report = mainnet({ VITE_GOLD_ORACLE_ADDRESS: vault, VITE_GUSD_ADDRESS: vault.toUpperCase().replace('0X', '0x') });
		expect(report.problems).toEqual([
			'VITE_GOLD_ORACLE_ADDRESS holds the same address as VITE_GOLD_VAULT_ADDRESS; every contract variable needs its own address.',
			'VITE_GUSD_ADDRESS holds the same address as VITE_GOLD_VAULT_ADDRESS; every contract variable needs its own address.',
		]);
	});

	it('refuses a Uniswap address that repeats a protocol contract or the other Uniswap address', () => {
		expect(mainnet({ VITE_UNISWAP_ROUTER: addressFor(2) }).problems).toEqual([
			expect.stringContaining('VITE_UNISWAP_ROUTER holds the same address as VITE_GUSD_ADDRESS'),
		]);
		expect(mainnet({ VITE_UNISWAP_QUOTER: addressFor(40) }).problems).toEqual([
			expect.stringContaining('VITE_UNISWAP_QUOTER holds the same address as VITE_UNISWAP_ROUTER'),
		]);
	});

	it('refuses a contract variable that names a bundled gold token', () => {
		expect(mainnet({ VITE_GUSD_ADDRESS: MAINNET_PAXG_ADDRESS }).problems).toEqual([
			'VITE_GUSD_ADDRESS holds the same address as the mainnet PAXG token; every contract variable needs its own address.',
		]);
		expect(mainnet({ VITE_STABILITY_POOL_ADDRESS: MAINNET_XAUT_ADDRESS.toLowerCase() }).problems).toEqual([
			expect.stringContaining('VITE_STABILITY_POOL_ADDRESS holds the same address as the mainnet XAUT token'),
		]);
	});

	it('reports a malformed address once, never as a duplicate as well', () => {
		expect(mainnet({ VITE_GOLD_ORACLE_ADDRESS: '0x1234', VITE_GUSD_ADDRESS: '0x1234' }).problems).toEqual([
			expect.stringContaining('VITE_GOLD_ORACLE_ADDRESS "0x1234" is not a valid address'),
			expect.stringContaining('VITE_GUSD_ADDRESS "0x1234" is not a valid address'),
		]);
	});

	it('judges an address by its trimmed value, the one the bundle reads', () => {
		expect(mainnet({ VITE_GOLD_VAULT_ADDRESS: ` ${addressFor(0)}\n` }).problems).toEqual([]);
	});

	it('refuses every variable that still holds a printer placeholder, once each', () => {
		const report = mainnet({
			VITE_MAINNET_RPC_URL: '<fill in: mainnet RPC URL the browser may call>',
			VITE_API_URL: "<fill in: the API's public tRPC endpoint>",
			VITE_SOURCE_URL: '<fill in: the public repository URL>',
			VITE_WALLETCONNECT_PROJECT_ID: '<fill in: WalletConnect Cloud project id>',
		});
		expect(report.problems).toHaveLength(4);
		for (const key of ['VITE_API_URL', 'VITE_MAINNET_RPC_URL', 'VITE_SOURCE_URL', 'VITE_WALLETCONNECT_PROJECT_ID']) {
			expect(report.problems.filter((problem) => problem.startsWith(`${key} `))).toEqual([
				expect.stringContaining('placeholder'),
			]);
		}
		expect(report.warnings).toEqual([]);
	});

	it.each(REQUIRED_MAINNET_ADDRESS_VARIABLES)('refuses a build whose %s is unset, malformed or zero', (key) => {
		expect(mainnet({ [key]: undefined }).problems).toEqual([expect.stringContaining(`${key} is unset`)]);
		expect(mainnet({ [key]: '0x1234' }).problems).toEqual([expect.stringContaining(`${key} "0x1234" is not a valid address`)]);
		expect(mainnet({ [key]: `0x${'0'.repeat(40)}` }).problems).toEqual([`${key} is the zero address.`]);
	});

	it('refuses an address whose mixed case breaks the EIP-55 checksum', () => {
		const broken = MAINNET_PAXG_ADDRESS.replace('De22', 'dE22');
		expect(mainnet({ VITE_GOLD_VAULT_ADDRESS: broken }).problems).toEqual([
			expect.stringContaining('VITE_GOLD_VAULT_ADDRESS'),
		]);
	});

	it('checks the optional Uniswap addresses only when they are set', () => {
		expect(mainnet({ VITE_UNISWAP_ROUTER: undefined, VITE_UNISWAP_QUOTER: undefined }).problems).toEqual([]);
		expect(mainnet({ VITE_UNISWAP_ROUTER: 'router' }).problems).toEqual([
			expect.stringContaining('VITE_UNISWAP_ROUTER "router" is not a valid address'),
		]);
	});

	it.each([
		['VITE_PAXG_ADDRESS', 'PAXG', MAINNET_PAXG_ADDRESS],
		['VITE_XAUT_ADDRESS', 'XAUT', MAINNET_XAUT_ADDRESS],
	])('refuses a %s override that is not canonical mainnet %s', (key, symbol, canonical) => {
		const sepoliaMock = '0x5ccd1c3Cf37261EbA2f681b2848271C9e1De4c6e';
		expect(mainnet({ [key]: sepoliaMock }).problems).toEqual([
			`${key} "${sepoliaMock}" is not mainnet ${symbol} (${canonical}); remove the line or set it to that address.`,
		]);
		expect(mainnet({ [key]: canonical.toLowerCase() }).problems).toEqual([]);
	});

	it('judges token overrides against the same addresses the token list bundles', () => {
		const bundled = (symbol: string) => TOKEN_LIST.find((token) => token.symbol === symbol)?.addresses[MAINNET];
		expect(bundled('PAXG')).toBe(MAINNET_PAXG_ADDRESS);
		expect(bundled('XAUT')).toBe(MAINNET_XAUT_ADDRESS);
	});

	it.each([undefined, '0', 'latest', '-5', '1.5'])('refuses VITE_DEPLOY_BLOCK %j', (value) => {
		expect(mainnet({ VITE_DEPLOY_BLOCK: value }).problems).toEqual([expect.stringContaining('VITE_DEPLOY_BLOCK')]);
	});

	it('refuses a checkout that carries .env.local unless the build accepts it by name', () => {
		expect(mainnet({}, true).problems).toEqual([expect.stringContaining('apps/dapp/.env.local exists')]);
		expect(mainnet({ [ALLOW_ENV_LOCAL_VARIABLE]: '1' }, true).problems).toEqual([]);
	});

	it.each([undefined, '', 'YOUR_PROJECT_ID'])('warns, without refusing, when the WalletConnect id is %j', (id) => {
		const report = mainnet({ VITE_WALLETCONNECT_PROJECT_ID: id });
		expect(report.problems).toEqual([]);
		expect(report.warnings).toEqual([expect.stringContaining('VITE_WALLETCONNECT_PROJECT_ID is not set')]);
	});

	it('lists every problem at once', () => {
		const report = mainnet({ VITE_API_URL: undefined, VITE_GUSD_ADDRESS: undefined, VITE_XAUT_ADDRESS: addressFor(99) });
		expect(report.problems).toHaveLength(3);
	});
});

describe('checkBuildEnv on a Sepolia build', () => {
	const sepolia = (env: BuildEnv, hasEnvLocalFile = true) => checkBuildEnv({ chainId: SEPOLIA, env, hasEnvLocalFile });

	it('needs only the PAXG mock, and accepts .env.local, http RPCs and mock tokens', () => {
		const report = sepolia({
			VITE_TARGET_CHAIN_ID: '11155111',
			VITE_PAXG_ADDRESS: '0x5ccd1c3Cf37261EbA2f681b2848271C9e1De4c6e',
			VITE_XAUT_ADDRESS: addressFor(7),
			VITE_SEPOLIA_RPC_URL: 'http://127.0.0.1:8546',
		});
		expect(report).toEqual({ problems: [], warnings: [] });
	});

	it.each([undefined, '  '])('refuses a build whose VITE_PAXG_ADDRESS is %j', (paxg) => {
		expect(sepolia({ VITE_PAXG_ADDRESS: paxg }).problems).toEqual([
			expect.stringContaining('a Sepolia build needs VITE_PAXG_ADDRESS'),
		]);
	});

	it('leaves angle brackets and repeated addresses alone, which only a mainnet build is held to', () => {
		const report = sepolia({
			VITE_PAXG_ADDRESS: addressFor(3),
			VITE_SEPOLIA_RPC_URL: 'https://sepolia.example/<key>',
			VITE_GOLD_VAULT_ADDRESS: addressFor(5),
			VITE_GUSD_ADDRESS: addressFor(5),
		});
		expect(report.problems).toEqual([]);
	});

	it('refuses an unfilled placeholder there too', () => {
		const report = sepolia({ VITE_PAXG_ADDRESS: addressFor(3), VITE_API_URL: '<fill in: the API endpoint>' });
		expect(report.problems).toEqual([expect.stringContaining('VITE_API_URL still holds its')]);
	});
});

describe('checkBuildEnv on the ledger switch', () => {
	const sepoliaEnv: BuildEnv = { VITE_PAXG_ADDRESS: '0x5ccd1c3Cf37261EbA2f681b2848271C9e1De4c6e' };

	it.each([undefined, '', 'true', 'false'])('admits VITE_LEDGER_ENABLED=%j on every chain', (value) => {
		expect(mainnet({ VITE_LEDGER_ENABLED: value }).problems).toEqual([]);
		expect(checkBuildEnv({ chainId: SEPOLIA, env: { ...sepoliaEnv, VITE_LEDGER_ENABLED: value }, hasEnvLocalFile: false }).problems).toEqual([]);
		expect(checkBuildEnv({ chainId: 31337, env: { VITE_LEDGER_ENABLED: value }, hasEnvLocalFile: false }).problems).toEqual([]);
	});

	it.each(['TRUE', 'True', 'yes', '1', 'on', ' true', 'true '])('refuses VITE_LEDGER_ENABLED=%j, which the dapp would read as off', (value) => {
		const expected = [expect.stringContaining('VITE_LEDGER_ENABLED must be true or false')];
		expect(mainnet({ VITE_LEDGER_ENABLED: value }).problems).toEqual(expected);
		expect(checkBuildEnv({ chainId: SEPOLIA, env: { ...sepoliaEnv, VITE_LEDGER_ENABLED: value }, hasEnvLocalFile: false }).problems).toEqual(expected);
		expect(checkBuildEnv({ chainId: 31337, env: { VITE_LEDGER_ENABLED: value }, hasEnvLocalFile: false }).problems).toEqual(expected);
	});

	it('leaves a mainnet build that does not name the variable exactly as it was', () => {
		expect(mainnet()).toEqual({ problems: [], warnings: [] });
	});
});

describe('ledgerCodeProblems', () => {
	const today = [
		{ fileName: 'assets/index-CTN98OK-.js', code: 'const a=1;' },
		{ fileName: 'assets/VaultDashboard-DWspZkRa.js', code: 'vaultsRouter.owners' },
		{ fileName: 'assets/index.css', code: '' },
	];
	const pageChunk = { fileName: 'assets/LedgerPage-DDtNKVAx.js', code: 'x.ledgerRouter.status.useQuery()' };

	it.each([undefined, '', 'false'])('passes a build with the flag %j that carries no ledger code', (value) => {
		expect(ledgerCodeProblems({ VITE_LEDGER_ENABLED: value }, today)).toEqual([]);
	});

	it.each([undefined, '', 'false'])('refuses a build with the flag %j that emitted the page chunk', (value) => {
		const problems = ledgerCodeProblems({ VITE_LEDGER_ENABLED: value }, [...today, pageChunk]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('assets/LedgerPage-DDtNKVAx.js');
		expect(problems[0]).toContain('VITE_LEDGER_ENABLED is not true');
	});

	it('refuses ledger calls that ended up in another chunk under another name', () => {
		const merged = { fileName: 'assets/index-abc.js', code: 'e5=k.lazy(()=>t.ledgerRouter.account)' };
		expect(ledgerCodeProblems({}, [...today, merged])[0]).toContain('assets/index-abc.js');
	});

	it('passes the page chunk in a build with the flag on', () => {
		expect(ledgerCodeProblems({ VITE_LEDGER_ENABLED: 'true' }, [...today, pageChunk])).toEqual([]);
	});
});

describe('buildEnvRefusal', () => {
	it('keeps a single problem on one line', () => {
		expect(buildEnvRefusal(['VITE_API_URL is unset.'])).toBe('Refusing to build the dapp: VITE_API_URL is unset.');
	});

	it('lists several problems in one message', () => {
		expect(buildEnvRefusal(['first.', 'second.'])).toBe(
			'Refusing to build the dapp, for 2 reasons:\n  - first.\n  - second.'
		);
	});
});
