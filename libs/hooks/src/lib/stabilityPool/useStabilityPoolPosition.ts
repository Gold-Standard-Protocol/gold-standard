import { useReadContracts } from 'wagmi';
import { type Address } from 'viem';
import { useMemo } from 'react';
import {
	getStabilityPoolContractConfig,
	stabilityPoolAbi,
	TOKEN_LIST,
	type GoldVaultChainId,
} from '@goldstandard/constants';

export interface PoolCollateralGain {
	token: Address;
	symbol: string;
	decimals: number;
	amount: bigint;
}

/**
 * Reads a depositor's stability pool position: effective (compounded) deposit,
 * total pool deposits, paused state and the pending collateral gain for each
 * gold token configured on the chain. Gains are returned in the NATIVE token
 * decimals (PAXG 18, XAUT 6), carried alongside each amount for formatting.
 *
 * When the pool contract address is unset (zero-address env fallback) the
 * config is undefined and everything returns undefined: the honest pre-launch
 * state. `isDeployed` lets the UI render that state explicitly.
 */
export function useStabilityPoolPosition(
	chainId: GoldVaultChainId | undefined,
	userAddress: Address | undefined
) {
	const config = getStabilityPoolContractConfig(chainId);

	const goldTokens = useMemo(() => {
		if (!chainId) return [];
		return TOKEN_LIST.flatMap((token) => {
			const address = token.addresses[chainId];
			if (!token.gold || !address) return [];
			return [{ address, symbol: token.symbol, decimals: token.decimals }];
		});
	}, [chainId]);

	const contracts = useMemo(() => {
		if (!config || !userAddress) return [];
		return [
			{
				address: config.address,
				abi: stabilityPoolAbi,
				functionName: 'getEffectiveDeposit' as const,
				args: [userAddress] as const,
			},
			{
				address: config.address,
				abi: stabilityPoolAbi,
				functionName: 'getTotalDeposits' as const,
			},
			{
				address: config.address,
				abi: stabilityPoolAbi,
				functionName: 'paused' as const,
			},
			...goldTokens.map((token) => ({
				address: config.address,
				abi: stabilityPoolAbi,
				functionName: 'getCollateralGain' as const,
				args: [userAddress, token.address] as const,
			})),
		];
	}, [config, userAddress, goldTokens]);

	const { data, isLoading, isError, refetch } = useReadContracts({
		contracts,
		query: {
			enabled: !!config && !!userAddress && contracts.length > 0,
			refetchInterval: 10_000,
		},
	});

	// Result assertions are justified by the verified StabilityPool ABI: the
	// first three reads return uint256, uint256 and bool respectively.
	const effectiveDeposit =
		data?.[0]?.status === 'success' ? (data[0].result as bigint) : undefined;
	const totalDeposits =
		data?.[1]?.status === 'success' ? (data[1].result as bigint) : undefined;
	const paused =
		data?.[2]?.status === 'success' ? (data[2].result as boolean) : undefined;

	const gains = useMemo<PoolCollateralGain[] | undefined>(() => {
		if (!data) return undefined;
		return goldTokens.flatMap((token, index) => {
			const result = data[3 + index];
			if (result?.status !== 'success') return [];
			return [
				{
					token: token.address,
					symbol: token.symbol,
					decimals: token.decimals,
					amount: result.result as bigint,
				},
			];
		});
	}, [data, goldTokens]);

	const isDeployed = !!config;

	return { effectiveDeposit, totalDeposits, paused, gains, isDeployed, isLoading, isError, refetch };
}
