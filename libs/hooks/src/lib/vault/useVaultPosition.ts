import { useReadContract } from 'wagmi';
import { type Address } from 'viem';
import { getGoldVaultContractConfig, type GoldVaultChainId } from '@goldstandard/constants';

export interface VaultPosition {
	collateralToken: Address;
	collateralAmount: bigint;
	debtAmount: bigint;
}

export function useVaultPosition(chainId: GoldVaultChainId | undefined, userAddress: Address | undefined) {
	const config = getGoldVaultContractConfig(chainId);

	const { data, isLoading, isError, isFetching, errorUpdateCount, refetch } = useReadContract({
		...config,
		functionName: 'vaults',
		args: userAddress ? [userAddress] : undefined,
		query: {
			enabled: !!config && !!userAddress,
			refetchInterval: 10_000,
		},
	});

	const position: VaultPosition | undefined = data
		? {
				collateralToken: (data as [Address, bigint, bigint])[0],
				collateralAmount: (data as [Address, bigint, bigint])[1],
				debtAmount: (data as [Address, bigint, bigint])[2],
			}
		: undefined;

	const hasPosition = position ? position.collateralAmount > 0n || position.debtAmount > 0n : false;
	// A read that has failed and never succeeded. React Query puts a query with no data back
	// to 'pending' at the start of every fetch, so `isError` alone comes and goes with each
	// retry during an outage; the count of settled failures does not.
	const hasFailed = data === undefined && (isError || errorUpdateCount > 0);

	return { position, hasPosition, isLoading, isError, isFetching, hasFailed, refetch };
}
