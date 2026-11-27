import { ChainId } from '@goldstandard/models';
import { resolveTargetChainValue, unsupportedTargetChainMessage } from './targetChainValue';

// Vite injects `import.meta.env` at build time. Read it through a locally-typed accessor so that
// consumers which compile this file type-check without needing vite/client ambient types in their
// own tsconfig (and without a triple-slash reference, which the lint config disallows).
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/** The chains a dapp build may target. Exactly one chain is selected per build. */
export type TargetChainId = ChainId.MAINNET | ChainId.SEPOLIA;

/**
 * Parses VITE_TARGET_CHAIN_ID into a supported chain id, using the accepted
 * values in targetChainValue.ts. A trimmed '1' selects mainnet; '11155111',
 * undefined or an empty value selects Sepolia. In development an unrecognised
 * value falls back to Sepolia with a warning naming the bad value. In a
 * production bundle it throws, but that only happens when the bundle loads in
 * the browser. The build itself fails earlier, in the buildStart guard in
 * apps/dapp/vite.config.mts, which checks the same table and also refuses a
 * build that leaves the variable unset or empty, as a misspelt variable name
 * does. An unset value still selects Sepolia
 * on the dev server and in tests.
 */
export const parseTargetChainId = (
	raw: string | undefined,
	isProduction = false
): TargetChainId => {
	const chainId = resolveTargetChainValue(raw);
	if (chainId !== undefined) return chainId;
	if (isProduction) {
		throw new Error(`Production bundle: ${unsupportedTargetChainMessage(raw ?? '')}`);
	}
	console.warn(
		`Unrecognised VITE_TARGET_CHAIN_ID "${raw}"; defaulting to Sepolia (11155111).`
	);
	return ChainId.SEPOLIA;
};

/** The single chain this build targets, baked in at build time. */
export const TARGET_CHAIN_ID: TargetChainId = parseTargetChainId(
	viteEnv['VITE_TARGET_CHAIN_ID'],
	viteEnv['PROD'] === 'true' || (viteEnv['PROD'] as unknown) === true
);

/** Block explorer base URL for each chain a build may target. */
export const EXPLORER_BASE_URL: Record<TargetChainId, string> = {
	[ChainId.MAINNET]: 'https://etherscan.io',
	[ChainId.SEPOLIA]: 'https://sepolia.etherscan.io',
};

/** Builds the explorer address page URL for the given chain. */
export const explorerAddressUrl = (chainId: TargetChainId, address: string): string =>
	`${EXPLORER_BASE_URL[chainId]}/address/${address}`;
