import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { keccak256, encodePacked, type Address } from 'viem';
import { getGoldVaultContractConfig, goldVaultAbi, type GoldVaultChainId } from '@goldstandard/constants';
import { ChainId, Token } from '@goldstandard/models';
import { useAllGoldTokens } from '../token';

/** One `collateralTypes` read as wagmi returns it inside useReadContracts. */
export interface CollateralTypeRead {
	status: 'success' | 'failure';
	result?: unknown;
}

/**
 * Keeps the gold tokens the vault lists as an ACTIVE collateral type, in the order given.
 * A read that failed, or a type that was never added, counts as not active: offering a
 * token the vault refuses ("Collateral type not active") only leads the user into a
 * reverting deposit. Pure and exported for tests.
 */
export function filterActiveCollateral(
	tokens: Record<string, Token>,
	reads: readonly CollateralTypeRead[] | undefined
): Record<string, Token> | undefined {
	if (!reads) return undefined;
	const entries = Object.entries(tokens);
	return Object.fromEntries(
		entries.filter((_, i) => {
			const read = reads[i];
			if (read?.status !== 'success' || !Array.isArray(read.result)) return false;
			// collateralTypes => [token, minRatio, liquidationRatio, penalty, debtCeiling, totalDebt, active]
			return read.result[6] === true;
		})
	);
}

/**
 * The gold tokens a new deposit may use: those the vault lists as active collateral. On a
 * PAXG-first deployment XAUT is registered in the oracle only, so it stays out of the picker
 * until governance activates it, and then appears with no dapp release. Undefined while the
 * token list or the vault reads are loading.
 */
export function useActiveCollateralTokens(chainId: ChainId): Record<string, Token> | undefined {
	const { data: goldTokens } = useAllGoldTokens(chainId);
	const config = getGoldVaultContractConfig(chainId as GoldVaultChainId);

	const contracts = useMemo(() => {
		if (!config || !goldTokens) return [];
		return Object.values(goldTokens).map((token) => ({
			address: config.address,
			abi: goldVaultAbi,
			functionName: 'collateralTypes' as const,
			args: [keccak256(encodePacked(['address'], [token.address as Address]))] as const,
		}));
	}, [config, goldTokens]);

	const { data } = useReadContracts({
		contracts,
		// Collateral types change only through the 48 hour timelock.
		query: { enabled: contracts.length > 0, staleTime: 60_000 },
	});

	return useMemo(
		() => (goldTokens ? filterActiveCollateral(goldTokens, data) : undefined),
		[goldTokens, data]
	);
}
