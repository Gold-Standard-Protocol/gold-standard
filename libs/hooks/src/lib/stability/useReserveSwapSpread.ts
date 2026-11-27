import { useReadContract } from 'wagmi';
import { type Address } from 'viem';
import {
	getStabilityReserveContractConfig,
	goldStabilityReserveAbi,
	type GoldVaultChainId,
} from '@goldstandard/constants';

export interface ReserveSwapSpread {
	/** The spread quoteGoldOut reports for this amount, once it has landed. */
	spreadPpm: bigint | undefined;
	/**
	 * 'idle' while nothing is typed; 'quoting' while the read for this amount is in flight;
	 * 'quoted' once it landed; 'unavailable' when the read failed or the contract answered
	 * (0, 0), which it does for an unsupported asset or a refused price.
	 */
	status: 'idle' | 'quoting' | 'quoted' | 'unavailable';
}

/**
 * The spread a reserve swap of `gsusdIn` pays. The contract prices a swap at the tier of
 * the coverage it leaves behind, so a large swap can pay a dearer tier than
 * `currentSpreadPpm`; `quoteGoldOut` applies the same rule, so its spread is the one to
 * preview with. The status keeps a quote still in flight apart from one that will not
 * come, so the caller never previews a new amount at the marginal tier while it waits.
 */
export function useReserveSwapSpread(
	chainId: GoldVaultChainId | undefined,
	token: Address | undefined,
	gsusdIn: bigint | undefined
): ReserveSwapSpread {
	const config = getStabilityReserveContractConfig(chainId);
	const enabled = !!config && !!token && gsusdIn !== undefined && gsusdIn > 0n;
	const { data, isError } = useReadContract({
		...config,
		abi: goldStabilityReserveAbi,
		functionName: 'quoteGoldOut',
		args: enabled ? [token, gsusdIn] : undefined,
		query: { enabled, refetchInterval: 10_000 },
	});
	if (!enabled) return { spreadPpm: undefined, status: 'idle' };
	if (!data) return { spreadPpm: undefined, status: isError ? 'unavailable' : 'quoting' };
	const [, spreadPpm] = data;
	// quoteGoldOut answers (0, 0) for an unsupported or paused asset or a missing price.
	return spreadPpm > 0n ? { spreadPpm, status: 'quoted' } : { spreadPpm: undefined, status: 'unavailable' };
}
