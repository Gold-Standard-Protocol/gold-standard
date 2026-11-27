import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { type Address } from 'viem';
import { getStabilityReserveContractConfig, type GoldVaultChainId } from '@goldstandard/constants';

export interface StabilityReserveState {
	/** False until VITE_STABILITY_RESERVE_ADDRESS points at a real deployment. */
	isDeployed: boolean;
	supported: boolean | undefined;
	/** True while the guardian's asset pause holds; it lapses on its own after 14 days. */
	paused: boolean | undefined;
	/** Gold above the floor, in the token's decimals: what swaps may draw on. */
	redeemable: bigint | undefined;
	/** Gold still allowed out of this asset today, honouring floor and daily cap. */
	remainingToday: bigint | undefined;
	/** The spread a swap pays right now, ppm and percent. */
	spreadPpm: bigint | undefined;
	spreadPercent: number | undefined;
	/** Redeemable reserve value ÷ circulating GSUSD, ppm and percent. */
	coveragePpm: bigint | undefined;
	coveragePercent: number | undefined;
	/** USD value (18 dec) of redeemable gold across every asset. */
	reserveValueUsd: bigint | undefined;
	/** GSUSD the reserve holds from swaps. Not revenue. */
	inventory: bigint | undefined;
	isLoading: boolean;
	isError: boolean;
}

/**
 * Live state of the Gold Stability Reserve for one asset plus the reserve-wide
 * figures. Every value is a view; nothing here moves the oracle. Refetches every ten
 * seconds because the spread and remaining capacity move with each swap.
 */
export function useStabilityReserve(
	chainId: GoldVaultChainId | undefined,
	token: Address | undefined
): StabilityReserveState {
	const config = getStabilityReserveContractConfig(chainId);

	const contracts = useMemo(() => {
		if (!config || !token) return [];
		return [
			{ ...config, functionName: 'assets' as const, args: [token] as const },
			{ ...config, functionName: 'redeemableCollateral' as const, args: [token] as const },
			{ ...config, functionName: 'remainingDailyCapacity' as const, args: [token] as const },
			{ ...config, functionName: 'currentSpreadPpm' as const },
			{ ...config, functionName: 'coveragePpm' as const },
			{ ...config, functionName: 'reserveValueUsd' as const },
			{ ...config, functionName: 'gsusdInventory' as const },
			// The pause is a timestamp that lapses (assets(token) carries pausedUntil); the
			// contract answers whether it still holds, so no client clock is involved.
			{ ...config, functionName: 'assetPaused' as const, args: [token] as const },
		];
	}, [config, token]);

	const { data, isLoading, isError } = useReadContracts({
		contracts,
		query: { enabled: contracts.length > 0, refetchInterval: 10_000 },
	});

	return useMemo(
		() => toStabilityReserveState(data, { isDeployed: !!config, isLoading, isError }),
		[config, data, isLoading, isError]
	);
}

/** One read as wagmi returns it inside useReadContracts. */
export interface StabilityReserveRead {
	status: 'success' | 'failure';
	result?: unknown;
}

/**
 * Maps the reads useStabilityReserve issues, in its order, to the state it returns. Pure and
 * exported for tests. `paused` comes from assetPaused(token), never from assets(token): the
 * second field of assets(token) is the timestamp the pause lapses at.
 */
export function toStabilityReserveState(
	reads: readonly StabilityReserveRead[] | undefined,
	flags: { isDeployed: boolean; isLoading: boolean; isError: boolean }
): StabilityReserveState {
	const at = (i: number): unknown => (reads?.[i]?.status === 'success' ? reads[i].result : undefined);
	const bigintAt = (i: number): bigint | undefined => {
		const v = at(i);
		return typeof v === 'bigint' ? v : undefined;
	};
	// assets(token) => [supported, pausedUntil, decimals, minReserve, dailyCapPpm, listed]
	const asset = at(0) as readonly [boolean, bigint, number, bigint, bigint, boolean] | undefined;
	const pausedRead = at(7);
	const spreadPpm = bigintAt(3);
	const coveragePpm = bigintAt(4);
	return {
		isDeployed: flags.isDeployed,
		supported: asset?.[0],
		paused: typeof pausedRead === 'boolean' ? pausedRead : undefined,
		redeemable: bigintAt(1),
		remainingToday: bigintAt(2),
		spreadPpm,
		spreadPercent: spreadPpm !== undefined ? Number(spreadPpm) / 10_000 : undefined,
		coveragePpm,
		coveragePercent: coveragePpm !== undefined ? Number(coveragePpm) / 10_000 : undefined,
		reserveValueUsd: bigintAt(5),
		inventory: bigintAt(6),
		isLoading: flags.isLoading,
		isError: flags.isError,
	};
}
