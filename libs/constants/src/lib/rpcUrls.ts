// The browser RPC endpoints a build names. This file imports nothing, so the build guard
// (buildEnv.ts, loaded by apps/dapp/vite.config.mts by relative path) and the wallet layer read
// a VITE_*_RPC_URL value with the same parser.

/**
 * Splits a VITE_MAINNET_RPC_URL or VITE_SEPOLIA_RPC_URL value into its endpoints: one URL, or
 * several separated by commas, in order of preference. Blank entries are dropped, so an unset
 * or empty value yields no endpoint.
 */
export const parseRpcUrls = (raw: string | undefined): readonly string[] =>
	(raw ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '');
