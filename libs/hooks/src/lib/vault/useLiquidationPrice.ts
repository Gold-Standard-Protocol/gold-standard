import { useReadContract } from 'wagmi';
import { type Address, formatUnits } from 'viem';
import { getGoldVaultContractConfig, type GoldVaultChainId } from '@goldstandard/constants';

export function useLiquidationPrice(chainId: GoldVaultChainId | undefined, userAddress: Address | undefined) {
	const config = getGoldVaultContractConfig(chainId);

	const { data, isLoading, isError } = useReadContract({
		...config,
		functionName: 'getLiquidationPrice',
		args: userAddress ? [userAddress] : undefined,
		query: {
			enabled: !!config && !!userAddress,
			refetchInterval: 10_000,
		},
	});

	const priceRaw = data as bigint | undefined;
	// Oracle price has 8 decimals
	const priceFormatted = priceRaw ? formatUnits(priceRaw, 8) : undefined;

	return { priceRaw, priceFormatted, isLoading, isError };
}
