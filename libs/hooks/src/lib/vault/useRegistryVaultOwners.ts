import { useQuery } from '@tanstack/react-query';
import { readContract } from '@wagmi/core';
import { useConfig } from 'wagmi';
import { type Address } from 'viem';
import { getVaultRegistryContractConfig, type GoldVaultChainId } from '@goldstandard/constants';

/** Owners per VaultRegistry.vaultOwners page. */
export const REGISTRY_PAGE_SIZE = 500n;
/**
 * Most pages a walk reads before it treats the registry as a fault rather than following it
 * forever. Only a short page ends a walk, so a registry of 100,000 owners or more at
 * REGISTRY_PAGE_SIZE fails: exactly 100,000 fills all 200 pages and would need a short
 * 201st. The walk then throws instead of returning the owners it has read, so the hook
 * reports an error and the liquidations page says that it cannot list eligible positions
 * rather than show part of them as the whole list.
 */
export const REGISTRY_MAX_PAGES = 200;

/**
 * Every owner the registry lists, one bounded page at a time, until a short page ends the
 * list. The registry removes an owner by moving the last one into its slot, so a walk that
 * races a removal can see an owner twice; duplicates are dropped. Pure and exported for tests.
 */
export async function walkRegistryOwners(
	readPage: (offset: bigint, limit: bigint) => Promise<readonly Address[]>,
	pageSize: bigint = REGISTRY_PAGE_SIZE,
	maxPages: number = REGISTRY_MAX_PAGES
): Promise<Address[]> {
	const owners = new Set<Address>();
	for (let page = 0; page < maxPages; page++) {
		const batch = await readPage(BigInt(page) * pageSize, pageSize);
		for (const owner of batch) owners.add(owner);
		if (BigInt(batch.length) < pageSize) return [...owners];
	}
	throw new Error(`The vault registry listed more than ${maxPages} pages of owners`);
}

/**
 * Open vault owners from the on-chain VaultRegistry. The
 * liquidations page lists owners from the API's index first; when that index is down or
 * says it is unavailable, this keeps the page working with nothing but the chain.
 */
export function useRegistryVaultOwners(chainId: GoldVaultChainId | undefined, enabled: boolean) {
	const wagmiConfig = useConfig();
	const registry = getVaultRegistryContractConfig(chainId);

	const query = useQuery({
		queryKey: ['vaultRegistryOwners', chainId, registry?.address],
		queryFn: () => {
			if (!registry) return Promise.resolve([] as Address[]);
			return walkRegistryOwners((offset, limit) =>
				readContract(wagmiConfig, {
					address: registry.address,
					abi: registry.abi,
					functionName: 'vaultOwners',
					args: [offset, limit],
					chainId,
				})
			);
		},
		enabled: enabled && !!registry,
		refetchInterval: 60_000,
	});

	return {
		/** False until VITE_VAULT_REGISTRY_ADDRESS names a deployment. */
		isDeployed: !!registry,
		owners: query.data,
		isLoading: query.isLoading,
		isError: query.isError,
	};
}
