/**
 * The token list a mainnet build publishes at /tokenlist.json, in the Uniswap Token Lists
 * format (https://tokenlists.org). Wallets, aggregators and listing sites read it to learn
 * the token's address, name and logo from the project's own origin.
 *
 * This file imports nothing, so apps/dapp/vite.config.mts can load it by relative path. The
 * token's name, symbol and decimals are repeated here for that reason; tokenList.spec.ts holds
 * them to the dapp's token table and to the contract source.
 */

const SITE_ORIGIN = 'https://goldstandard.finance';

/** GSUSD as its contract reports it. */
export const GSUSD_TOKEN = { name: 'Gold Standard Dollar', symbol: 'GSUSD', decimals: 18 } as const;

/** Where the build serves the official marks (apps/dapp/src/build/brandFiles.ts copies them). */
export const GSUSD_LOGO_URL = `${SITE_ORIGIN}/brand/gsusd-256.png`;
export const PROTOCOL_LOGO_URL = `${SITE_ORIGIN}/brand/protocol-256.png`;

/**
 * The list's own version. Token Lists asks for a major bump when a token is removed, a minor
 * bump when one is added and a patch bump when details of a listed token change.
 */
export const TOKEN_LIST_VERSION = { major: 1, minor: 0, patch: 0 } as const;

export interface PublishedToken {
	chainId: number;
	address: string;
	name: string;
	symbol: string;
	decimals: number;
	logoURI: string;
}

export interface PublishedTokenList {
	name: string;
	timestamp: string;
	version: { major: number; minor: number; patch: number };
	logoURI: string;
	keywords: string[];
	tokens: PublishedToken[];
}

export interface TokenListBuild {
	chainId: number;
	/** The GSUSD address the build was configured with. */
	gsusd: string | undefined;
	/** The commit day as YYYY-MM-DD: two builds of one commit publish the same file. */
	day: string | undefined;
}

const MAINNET_CHAIN_ID = 1;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const isAddressText = (value: string | undefined): value is string =>
	value !== undefined && /^0x[0-9a-fA-F]{40}$/.test(value) && value.toLowerCase() !== ZERO_ADDRESS;
const isDay = (value: string | undefined): value is string => {
	if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/**
 * The list for one build, or undefined when the build has nothing to publish: it is not for
 * mainnet, its GSUSD address is missing, or its commit day is unknown (the format requires a
 * timestamp, and the clock would make two builds of one commit differ).
 */
export function tokenListForBuild(build: TokenListBuild): PublishedTokenList | undefined {
	if (build.chainId !== MAINNET_CHAIN_ID || !isAddressText(build.gsusd) || !isDay(build.day)) return undefined;
	return {
		name: 'Gold Standard',
		timestamp: `${build.day}T00:00:00.000Z`,
		version: { ...TOKEN_LIST_VERSION },
		logoURI: PROTOCOL_LOGO_URL,
		keywords: ['gold', 'stablecoin', 'gsusd'],
		tokens: [{ chainId: MAINNET_CHAIN_ID, address: build.gsusd, ...GSUSD_TOKEN, logoURI: GSUSD_LOGO_URL }],
	};
}

/** The file's text: two-space JSON with a final newline. */
export const tokenListText = (list: PublishedTokenList): string => `${JSON.stringify(list, null, 2)}\n`;
