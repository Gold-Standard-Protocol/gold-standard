import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { type Address } from 'viem';
import { getStabilityReserveContractConfig, type GoldVaultChainId } from '@goldstandard/constants';
import { Token } from '@goldstandard/models';

/** One `assets` read as wagmi returns it inside useReadContracts. */
export interface ReserveAssetRead {
	status: 'success' | 'failure';
	result?: unknown;
}

/**
 * Keeps the gold tokens the reserve supports, in the order given. A paused asset stays:
 * the panel explains the pause. A failed read, or a token the reserve never listed,
 * counts as not supported. Pure and exported for tests.
 */
export function filterReserveAssets(
	tokens: readonly Token[],
	reads: readonly ReserveAssetRead[] | undefined
): Token[] | undefined {
	if (!reads) return undefined;
	return tokens.filter((_, i) => {
		const read = reads[i];
		// assets(token) => [supported, pausedUntil, decimals, minReserve, dailyCapPpm, listed]
		return read?.status === 'success' && Array.isArray(read.result) && read.result[0] === true;
	});
}

/**
 * The gold tokens a reserve swap may pay out. On a PAXG-first deployment XAUT is not a
 * reserve asset, so offering it led only to "The reserve does not hold this gold token
 * yet"; it appears with no dapp release once governance lists it. Undefined while the
 * reads are loading or when no reserve is deployed.
 */
export function useReserveAssetTokens(
	chainId: GoldVaultChainId | undefined,
	tokens: readonly Token[]
): Token[] | undefined {
	const config = getStabilityReserveContractConfig(chainId);

	const contracts = useMemo(() => {
		if (!config) return [];
		return tokens.map((token) => ({
			...config,
			functionName: 'assets' as const,
			args: [token.address as Address] as const,
		}));
	}, [config, tokens]);

	const { data } = useReadContracts({
		contracts,
		// Asset support changes only through the 48 hour timelock.
		query: { enabled: contracts.length > 0, staleTime: 60_000 },
	});

	return useMemo(() => filterReserveAssets(tokens, data), [tokens, data]);
}
