import { useMemo } from 'react';
import { useSimulateContract } from 'wagmi';
import {
	BaseError,
	ContractFunctionRevertedError,
	ContractFunctionZeroDataError,
	type Address,
} from 'viem';
import { getDexConfig, type GoldVaultChainId } from '@goldstandard/constants';

export interface DexQuoteState {
	/** False until VITE_UNISWAP_QUOTER and VITE_UNISWAP_ROUTER point at real deployments. */
	isConfigured: boolean;
	/** Quoted output in tokenOut's decimals, or undefined while loading or on failure. */
	amountOut: bigint | undefined;
	isLoading: boolean;
	isError: boolean;
	/**
	 * True when the quote reverted, which for QuoterV2 means there is no route: either
	 * the pool does not exist at this fee tier or it holds no liquidity. A network
	 * failure is NOT reported here, so the UI never says "no liquidity" about an RPC
	 * that simply did not answer.
	 */
	noLiquidity: boolean;
	error: Error | null;
}

/**
 * Whether a failed quote simulation was the contract reverting, as opposed to the
 * RPC failing. Both arrive wrapped in a ContractFunctionExecutionError; only the
 * cause tells them apart. Pure and exported for tests.
 */
export function isQuoteRevert(error: unknown): boolean {
	if (!(error instanceof BaseError)) return false;
	const cause = error.walk(
		e => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError
	);
	return cause !== null;
}

/**
 * Quotes an exact-input single-hop swap through Uniswap v3 QuoterV2. The quoter is
 * non-view on-chain, so the read is a simulation whose `result` carries the output.
 * Refetches every ten seconds like the reserve reads, because the pool price moves
 * with every trade against it.
 */
export function useDexQuote(
	chainId: GoldVaultChainId | undefined,
	tokenIn: Address | undefined,
	tokenOut: Address | undefined,
	amountIn: bigint | undefined,
	fee?: number
): DexQuoteState {
	const config = getDexConfig(chainId);
	const poolFee = fee ?? config?.poolFee;
	const enabled =
		!!config && !!tokenIn && !!tokenOut && tokenIn !== tokenOut && amountIn !== undefined && amountIn > 0n && poolFee !== undefined;

	const { data, isLoading, isError, error } = useSimulateContract({
		...config?.quoter,
		functionName: 'quoteExactInputSingle',
		args:
			enabled && tokenIn && tokenOut && amountIn !== undefined && poolFee !== undefined
				? [{ tokenIn, tokenOut, amountIn, fee: poolFee, sqrtPriceLimitX96: 0n }]
				: undefined,
		query: {
			enabled,
			refetchInterval: 10_000,
			// A revert is an answer ("no route"), not a transient fault worth retrying.
			retry: false,
		},
	});

	return useMemo(
		() => ({
			isConfigured: !!config,
			amountOut: data?.result?.[0],
			isLoading,
			isError,
			noLiquidity: isError && isQuoteRevert(error),
			error: error ?? null,
		}),
		[config, data, isLoading, isError, error]
	);
}
