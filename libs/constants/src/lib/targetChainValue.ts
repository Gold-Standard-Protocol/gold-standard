// The one table of VITE_TARGET_CHAIN_ID values a dapp build
// accepts. It imports nothing and reads no import.meta.env, so apps/dapp/vite.config.mts can load
// it by relative path (Vite's config loader does not apply the @goldstandard/* path aliases) and
// refuse a build with the same table the browser parser in targetChain.ts reads.

/** Each accepted trimmed value, the chain id it selects and the chain's name for messages. */
const ACCEPTED_TARGET_CHAINS = [
	{ value: '1', chainId: 1, name: 'mainnet' },
	{ value: '11155111', chainId: 11155111, name: 'Sepolia' },
	// An unset or empty value selects Sepolia, so the dev server and tests need no setting. A
	// build must still name its chain (see unnamedTargetChainMessage).
	{ value: '', chainId: 11155111, name: 'Sepolia' },
] as const;

/** The numeric chain ids a build may target; targetChain.ts checks them against ChainId. */
export type AcceptedTargetChainId = (typeof ACCEPTED_TARGET_CHAINS)[number]['chainId'];

type AcceptedTargetChain = (typeof ACCEPTED_TARGET_CHAINS)[number];

const describeAcceptedValue = ({ value, name }: AcceptedTargetChain): string =>
	value === '' ? `an unset or empty value (${name})` : `"${value}" (${name})`;

/** Joins phrases as "a, b or c". */
const joinWithOr = (phrases: readonly string[]): string =>
	phrases.length <= 1
		? phrases.join('')
		: `${phrases.slice(0, -1).join(', ')} or ${phrases[phrases.length - 1]}`;

const ACCEPTED_VALUES_TEXT = joinWithOr(ACCEPTED_TARGET_CHAINS.map(describeAcceptedValue));

/**
 * Returns the chain id a raw VITE_TARGET_CHAIN_ID selects after trimming, or undefined when
 * the value is not one a build accepts.
 */
export const resolveTargetChainValue = (
	raw: string | undefined
): AcceptedTargetChainId | undefined => {
	const trimmed = raw?.trim() ?? '';
	return ACCEPTED_TARGET_CHAINS.find((entry) => entry.value === trimmed)?.chainId;
};

/** Names an unsupported value and every accepted one, for the build guard and the parser. */
export const unsupportedTargetChainMessage = (raw: string): string =>
	`VITE_TARGET_CHAIN_ID "${raw}" is not a supported target chain; expected ${ACCEPTED_VALUES_TEXT}.`;

/** True when a raw VITE_TARGET_CHAIN_ID names a chain rather than falling back to Sepolia. */
export const namesTargetChain = (raw: string | undefined): boolean => (raw?.trim() ?? '') !== '';

const NAMED_VALUES_TEXT = joinWithOr(
	ACCEPTED_TARGET_CHAINS.filter((entry) => entry.value !== '').map(describeAcceptedValue)
);

/**
 * Why a build that names no chain is refused: the fallback would build the Sepolia frontend
 * without a word, and a misspelt variable name leaves the variable unset.
 */
export const unnamedTargetChainMessage = (): string =>
	`VITE_TARGET_CHAIN_ID is unset or empty, which builds the Sepolia frontend; a build must name its chain, ${NAMED_VALUES_TEXT}. A misspelt variable name leaves it unset.`;
