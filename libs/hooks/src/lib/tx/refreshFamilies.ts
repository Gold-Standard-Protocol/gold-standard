import type { Query } from '@tanstack/react-query';

/**
 * The query families a confirmed transaction can change: contract reads, balances and
 * simulations, plus the custom keys this library builds for reads a transaction moves:
 * balances, vault history and the liquidation list's per-owner reads (left out, a
 * liquidated vault kept its old debt and collateral on the list for up to 30 seconds).
 * Token metadata, the API's price feed and the token list cannot move with a transaction,
 * and refetching them five times per confirmation was most of the 126 RPC calls counted
 * after one mint. The registry's owner list is left out too: it only grows when a vault
 * opens, its own poll covers that, and walking it five times per confirmation is pure cost.
 * Only mounted queries refetch, so the liquidation reads cost nothing off that page.
 */
export const REFRESHED_FAMILIES: ReadonlySet<string> = new Set([
	'readContract',
	'readContracts',
	'simulateContract',
	'balance',
	'estimateGas',
	'useTokenBalances',
	'vault-history',
	'undercollateralisedVaultReads',
]);

/** Predicate for `invalidateQueries`: only the families a confirmation can change. */
export function isRefreshedQuery(query: Pick<Query, 'queryKey'>): boolean {
	const [family] = query.queryKey;
	return typeof family === 'string' && REFRESHED_FAMILIES.has(family);
}
