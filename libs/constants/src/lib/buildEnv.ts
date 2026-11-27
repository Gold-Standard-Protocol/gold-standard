// The checks a dapp build makes on its VITE_* environment before it bundles anything.
// Pure: apps/dapp/vite.config.mts gathers
// the environment and calls checkBuildEnv from its buildStart hook. Like targetChainValue.ts
// this file uses no @goldstandard/* alias, so the Vite config can load it by relative path.
//
// A message never repeats the value of a URL variable: an RPC URL carries its provider key.
import { getAddress, isAddress } from 'viem';
import { MAINNET_PAXG_ADDRESS, MAINNET_XAUT_ADDRESS } from './mainnetTokens';
import { parseRpcUrls } from './rpcUrls';

const MAINNET_CHAIN_ID = 1;
const SEPOLIA_CHAIN_ID = 11155111;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** What contracts/scripts/lib/serviceEnv.ts prints for a value the operator must supply. */
const UNFILLED_MARKER = '<fill in';
/** The WalletConnect id the wallet layer has always treated as "not configured". */
const WALLETCONNECT_PLACEHOLDER = 'YOUR_PROJECT_ID';
/** Set to 1 to build mainnet from a checkout that carries apps/dapp/.env.local on purpose. */
export const ALLOW_ENV_LOCAL_VARIABLE = 'VITE_ALLOW_ENV_LOCAL';

/** Every protocol contract address a mainnet bundle reads; none has a usable fallback. */
export const REQUIRED_MAINNET_ADDRESS_VARIABLES = [
	'VITE_GOLD_VAULT_ADDRESS',
	'VITE_GOLD_ORACLE_ADDRESS',
	'VITE_GUSD_ADDRESS',
	'VITE_STABILITY_MODULE_ADDRESS',
	'VITE_STABILITY_POOL_ADDRESS',
	'VITE_STABILITY_RESERVE_ADDRESS',
	'VITE_SURPLUS_BUFFER_ADDRESS',
	'VITE_SILO_FACTORY_ADDRESS',
	'VITE_VAULT_REGISTRY_ADDRESS',
] as const;

/** Addresses the bundle works without, but which must be real addresses when they are set. */
const OPTIONAL_ADDRESS_VARIABLES = ['VITE_UNISWAP_ROUTER', 'VITE_UNISWAP_QUOTER', 'VITE_GSUSD_MARKET_TOKEN'] as const;

/** The token overrides a mainnet build may carry only when they name the canonical token. */
const CANONICAL_MAINNET_TOKENS = [
	{ variable: 'VITE_PAXG_ADDRESS', symbol: 'PAXG', address: MAINNET_PAXG_ADDRESS },
	{ variable: 'VITE_XAUT_ADDRESS', symbol: 'XAUT', address: MAINNET_XAUT_ADDRESS },
] as const;

export type BuildEnv = Readonly<Record<string, string | undefined>>;

export interface BuildEnvInput {
	/** The chain the build targets, already resolved from VITE_TARGET_CHAIN_ID. */
	chainId: number;
	/** Every VITE_* value Vite loaded from the process environment and the .env files. */
	env: BuildEnv;
	/** True when the env directory holds a .env.local file, which Vite loads in every mode. */
	hasEnvLocalFile: boolean;
}

export interface BuildEnvReport {
	/** Each one refuses the build. */
	problems: readonly string[];
	/** Printed, but the build goes on. */
	warnings: readonly string[];
}

const valueOf = (env: BuildEnv, key: string): string => env[key]?.trim() ?? '';

const isUnfilled = (value: string): boolean => value.toLowerCase().includes(UNFILLED_MARKER);

const unfilledVariables = (env: BuildEnv): readonly string[] =>
	Object.keys(env)
		.filter((key) => key.startsWith('VITE_') && isUnfilled(valueOf(env, key)))
		.sort();

const isHttpsUrl = (value: string): boolean => {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return url.protocol === 'https:' && url.hostname !== '';
};

/**
 * True when a URL still carries a template placeholder such as <key> or <provider>, typed or
 * percent-encoded. No real URL holds an angle bracket: the URL standard encodes both.
 */
const hasAnglePlaceholder = (value: string): boolean => /[<>]|%3c|%3e/i.test(value);

const ANGLE_PLACEHOLDER_FAULT =
	'still holds an angle-bracket placeholder such as <key>; replace every placeholder with its real value';

/** Why `value` cannot be a mainnet endpoint, or undefined when it can. Never repeats the value. */
const httpsUrlFault = (value: string): string | undefined => {
	if (hasAnglePlaceholder(value)) return ANGLE_PLACEHOLDER_FAULT;
	return isHttpsUrl(value) ? undefined : 'is not an https URL';
};

/** Why `value` cannot be a contract address, or undefined when it can. */
const addressFault = (value: string): string | undefined => {
	if (!isAddress(value)) return `"${value}" is not a valid address (check its length and its EIP-55 checksum)`;
	if (getAddress(value) === ZERO_ADDRESS) return 'is the zero address';
	return undefined;
};

const unfilledProblems = (unfilled: readonly string[]): readonly string[] =>
	unfilled.map((key) => `${key} still holds its "<fill in: ...>" placeholder; give it a real value or remove the line.`);

const sepoliaProblems = (env: BuildEnv): readonly string[] =>
	valueOf(env, 'VITE_PAXG_ADDRESS') === ''
		? [
				'a Sepolia build needs VITE_PAXG_ADDRESS (config.paxgToken in contracts/deployments/sepolia.json); without it the dapp lists no PAXG.',
			]
		: [];

const rpcProblems = (env: BuildEnv): readonly string[] => {
	const urls = parseRpcUrls(env['VITE_MAINNET_RPC_URL']);
	if (urls.length === 0) {
		return [
			'VITE_MAINNET_RPC_URL is unset; a mainnet build needs one or more https RPC URLs, separated by commas, or every read falls back to a rate-limited public endpoint.',
		];
	}
	return urls.flatMap((url, index) => {
		const fault = httpsUrlFault(url);
		return fault === undefined ? [] : [`VITE_MAINNET_RPC_URL entry ${index + 1} of ${urls.length} ${fault}.`];
	});
};

const requiredHttpsProblems = (env: BuildEnv, key: string, purpose: string): readonly string[] => {
	const value = valueOf(env, key);
	if (value === '') return [`${key} is unset; a mainnet build needs ${purpose} as an https URL.`];
	const fault = httpsUrlFault(value);
	if (fault === undefined) return [];
	return [fault === ANGLE_PLACEHOLDER_FAULT ? `${key} ${fault}.` : `${key} ${fault}; the page policy blocks anything else.`];
};

const optionalHttpsProblems = (env: BuildEnv, key: string): readonly string[] => {
	const value = valueOf(env, key);
	const fault = value === '' ? undefined : httpsUrlFault(value);
	return fault === undefined ? [] : [`${key} ${fault}.`];
};

const requiredAddressProblems = (env: BuildEnv): readonly string[] =>
	REQUIRED_MAINNET_ADDRESS_VARIABLES.flatMap((key) => {
		const value = valueOf(env, key);
		if (value === '') return [`${key} is unset; a mainnet build needs every protocol contract address.`];
		const fault = addressFault(value);
		return fault === undefined ? [] : [`${key} ${fault}.`];
	});

const optionalAddressProblems = (env: BuildEnv): readonly string[] =>
	OPTIONAL_ADDRESS_VARIABLES.flatMap((key) => {
		const value = valueOf(env, key);
		const fault = value === '' ? undefined : addressFault(value);
		return fault === undefined ? [] : [`${key} ${fault}.`];
	});

interface NamedAddress {
	/** How a message names the holder: a variable, or a bundled token. */
	name: string;
	/** Lower-cased, so two spellings of one address compare equal. */
	address: string;
}

/** The bundled gold tokens: a protocol contract variable that names one is a pasting mistake. */
const BUNDLED_TOKEN_ADDRESSES: readonly NamedAddress[] = CANONICAL_MAINNET_TOKENS.map(({ symbol, address }) => ({
	name: `the mainnet ${symbol} token`,
	address: address.toLowerCase(),
}));

/** Every contract variable that holds a usable address; a malformed one has its own problem line. */
const setContractAddresses = (env: BuildEnv): readonly NamedAddress[] =>
	[...REQUIRED_MAINNET_ADDRESS_VARIABLES, ...OPTIONAL_ADDRESS_VARIABLES]
		.map((name) => ({ name, value: valueOf(env, name) }))
		.filter(({ value }) => value !== '' && addressFault(value) === undefined)
		.map(({ name, value }) => ({ name, address: value.toLowerCase() }));

/**
 * Each protocol contract, the Uniswap router, the Uniswap quoter and the token GSUSD trades
 * against on the outside market is a different contract, and none of them is a gold token. One address pasted into two variables is refused, naming
 * the variable and the first holder of the same address.
 */
const duplicateAddressProblems = (env: BuildEnv): readonly string[] => {
	const contracts = setContractAddresses(env);
	return contracts.flatMap(({ name, address }, index) => {
		const earlier = [...BUNDLED_TOKEN_ADDRESSES, ...contracts.slice(0, index)].find(
			(other) => other.address === address
		);
		return earlier === undefined
			? []
			: [`${name} holds the same address as ${earlier.name}; every contract variable needs its own address.`];
	});
};

const tokenProblems = (env: BuildEnv): readonly string[] =>
	CANONICAL_MAINNET_TOKENS.flatMap(({ variable, symbol, address }) => {
		const value = valueOf(env, variable);
		if (value === '' || value.toLowerCase() === address.toLowerCase()) return [];
		return [
			`${variable} "${value}" is not mainnet ${symbol} (${address}); remove the line or set it to that address.`,
		];
	});

const deployBlockProblems = (env: BuildEnv): readonly string[] => {
	const value = valueOf(env, 'VITE_DEPLOY_BLOCK');
	return /^[1-9]\d*$/.test(value)
		? []
		: ['VITE_DEPLOY_BLOCK must be the block the vault was deployed in, a positive whole number; the activity feed starts there.'];
};

const envLocalProblems = ({ env, hasEnvLocalFile }: BuildEnvInput): readonly string[] =>
	hasEnvLocalFile && valueOf(env, ALLOW_ENV_LOCAL_VARIABLE) !== '1'
		? [
				`apps/dapp/.env.local exists and Vite loads it in every mode, so a mainnet build would inherit any value it holds that .env.production.local does not set. Build from a fresh clone, or set ${ALLOW_ENV_LOCAL_VARIABLE}=1 to accept it.`,
			]
		: [];

/** The one variable that switches the ledger page on; the dapp reads it as the exact text "true". */
export const LEDGER_ENABLED_VARIABLE = 'VITE_LEDGER_ENABLED';

/**
 * A misspelt switch must not pass as "off": the page is in a bundle only for the exact value
 * true, so anything other than true, false or nothing at all stops the build.
 */
const ledgerFlagProblems = (env: BuildEnv): readonly string[] => {
	const value = env[LEDGER_ENABLED_VARIABLE];
	return value === undefined || value === '' || value === 'true' || value === 'false'
		? []
		: [`${LEDGER_ENABLED_VARIABLE} must be true or false when it is set; remove the line to leave the ledger page out of the build.`];
};

/** One emitted file of a build, as the bundler hands it over: chunks carry code, assets do not. */
export interface EmittedFile {
	fileName: string;
	code: string;
}

/** The lazily loaded page chunk is named after its module, and only the page calls these procedures. */
const LEDGER_CHUNK_NAME = /LedgerPage/;
const LEDGER_CODE_MARKER = 'ledgerRouter';

/**
 * A build without VITE_LEDGER_ENABLED=true must be the build it was before the ledger page
 * existed. The page is behind a build time constant, so its chunk is not emitted; this
 * check holds that true whatever later changes do to the flag: any emitted file that is
 * the page chunk or carries its tRPC calls stops the build.
 */
export const ledgerCodeProblems = (env: BuildEnv, files: readonly EmittedFile[]): readonly string[] => {
	if (env[LEDGER_ENABLED_VARIABLE] === 'true') return [];
	const leaked = files
		.filter((file) => LEDGER_CHUNK_NAME.test(file.fileName) || file.code.includes(LEDGER_CODE_MARKER))
		.map((file) => file.fileName);
	return leaked.length === 0
		? []
		: [
				`${LEDGER_ENABLED_VARIABLE} is not true, yet the bundle carries ledger page code in ${leaked.join(', ')}. The flag must stay a build time constant (apps/dapp/src/app/ledger/ledgerFlag.ts) so that the page is left out.`,
			];
};

const walletConnectWarnings = (env: BuildEnv): readonly string[] => {
	const id = valueOf(env, 'VITE_WALLETCONNECT_PROJECT_ID');
	return id === '' || id === WALLETCONNECT_PLACEHOLDER
		? ['VITE_WALLETCONNECT_PROJECT_ID is not set, so this build offers no WalletConnect option for mobile wallets.']
		: [];
};

const mainnetProblems = (input: BuildEnvInput, unfilled: readonly string[]): readonly string[] => {
	// An unfilled variable already has its own line: drop the follow-on format complaint about it.
	const flagged = (problem: string): boolean => unfilled.some((key) => problem.startsWith(`${key} `));
	const env = input.env;
	return [
		...envLocalProblems(input),
		...rpcProblems(env),
		...requiredHttpsProblems(env, 'VITE_API_URL', "the API's public tRPC endpoint"),
		...optionalHttpsProblems(env, 'VITE_SOURCE_URL'),
		...deployBlockProblems(env),
		...requiredAddressProblems(env),
		...optionalAddressProblems(env),
		...duplicateAddressProblems(env),
		...tokenProblems(env),
	].filter((problem) => !flagged(problem));
};

/**
 * Judges the environment of a build whose target chain is already known. Every build refuses an
 * unfilled placeholder. A Sepolia build needs its PAXG mock. A mainnet build also needs https
 * RPC and API URLs with no <placeholder> left in them, every protocol contract address, each
 * one distinct, the deploy block, and token overrides that name the canonical PAXG and XAUT,
 * and it refuses a checkout's .env.local. Every build refuses a VITE_LEDGER_ENABLED that is
 * neither true nor false.
 */
export const checkBuildEnv = (input: BuildEnvInput): BuildEnvReport => {
	const unfilled = unfilledVariables(input.env);
	if (input.chainId === SEPOLIA_CHAIN_ID) {
		return { problems: [...unfilledProblems(unfilled), ...ledgerFlagProblems(input.env), ...sepoliaProblems(input.env)], warnings: [] };
	}
	if (input.chainId !== MAINNET_CHAIN_ID) {
		return { problems: [...unfilledProblems(unfilled), ...ledgerFlagProblems(input.env)], warnings: [] };
	}
	return {
		problems: [...unfilledProblems(unfilled), ...ledgerFlagProblems(input.env), ...mainnetProblems(input, unfilled)],
		warnings: unfilled.includes('VITE_WALLETCONNECT_PROJECT_ID') ? [] : walletConnectWarnings(input.env),
	};
};

/** One message for the whole refusal, so an operator fixes every problem in one pass. */
export const buildEnvRefusal = (problems: readonly string[]): string =>
	problems.length === 1
		? `Refusing to build the dapp: ${problems[0]}`
		: `Refusing to build the dapp, for ${problems.length} reasons:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`;
