import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { BaseError, ContractFunctionRevertedError, type Address } from 'viem';
import { getGoldOracleContractConfig, type GoldVaultChainId } from '@goldstandard/constants';

export interface OraclePriceState {
	/** False until VITE_GOLD_ORACLE_ADDRESS points at a real deployment. */
	isDeployed: boolean;
	/** Token price with 8 decimals, or undefined when no price is available. */
	price8: bigint | undefined;
	/** True when the validated (fresh) price is in use; false on fallback. */
	isLive: boolean;
	/**
	 * Set when the purpose-specific quote (quoteBorrowPrice, quoteTokenPrice or
	 * quoteReservePrice) was refused: the contract's own reason, "Off gold band" or "No
	 * reliable price". The action would revert on chain with the same reason, so the form
	 * should say so rather than offer it.
	 */
	refusal: string | undefined;
	/**
	 * True when price8 is the purpose's own quote rather than the plain feed fallback. The
	 * vault health ratio is computed only from the liquidation quote itself.
	 */
	quoted: boolean;
	isLoading: boolean;
	isError: boolean;
}

/**
 * Picks the price the preview should use: the validated price when the oracle
 * reports it fresh, otherwise the last known price when one exists. Pure and
 * exported for tests.
 */
export function pickOraclePrice(
	validatedPrice: bigint | undefined,
	validatedOk: boolean | undefined,
	lastKnownPrice: bigint | undefined
): { price8: bigint | undefined; isLive: boolean } {
	if (validatedOk === true && validatedPrice !== undefined && validatedPrice > 0n) {
		return { price8: validatedPrice, isLive: true };
	}
	if (lastKnownPrice !== undefined && lastKnownPrice > 0n) {
		return { price8: lastKnownPrice, isLive: false };
	}
	return { price8: undefined, isLive: false };
}

/**
 * Which price the preview must mirror (docs/ORACLE_IMPLEMENTATION_PLAN.md section 3, variant
 * C; C is Chainlink PAXG/USD and G Chainlink XAU/USD):
 *   - 'borrow': minting and indebted withdrawals, min(C, G) while C sits inside the gold
 *     band, refused "Off gold band" outside it;
 *   - 'liquidation': the liquidation trigger and settlement, min(max(C, G), G x (1 + m)),
 *     never refused for being off the band;
 *   - 'reserve': reserve swaps, max(C, G) while C sits inside the gold band, refused "Off
 *     gold band" outside it;
 *   - 'reference': the plain feed read for comparisons that execute nothing.
 * Every quote is refused "No reliable price" while C or G is unhealthy.
 */
export type OraclePricePurpose = 'borrow' | 'liquidation' | 'reserve' | 'reference';

const QUOTE_FUNCTIONS = {
	borrow: 'quoteBorrowPrice',
	liquidation: 'quoteTokenPrice',
	reserve: 'quoteReservePrice',
} as const;

type QuotedPurpose = keyof typeof QUOTE_FUNCTIONS;

/** The oracle view a purpose is priced at; undefined for a plain reference read. Pure. */
export function quoteFunctionFor(
	purpose: OraclePricePurpose
): (typeof QUOTE_FUNCTIONS)[QuotedPurpose] | undefined {
	return purpose === 'reference' ? undefined : QUOTE_FUNCTIONS[purpose];
}

/**
 * The quote, when the purpose has one and it answered; otherwise the plain feed pick, marked
 * not live, with the quote's refusal reason. Pure and exported for tests.
 */
export function pickQuotedPrice(
	quote: bigint | undefined,
	refusal: string | undefined,
	fallback: { price8: bigint | undefined; isLive: boolean }
): { price8: bigint | undefined; isLive: boolean; refusal: string | undefined } {
	if (quote !== undefined && quote > 0n) return { price8: quote, isLive: true, refusal: undefined };
	if (refusal !== undefined) return { price8: fallback.price8, isLive: false, refusal };
	return { ...fallback, refusal: undefined };
}

/** The revert reason inside a failed read, when the contract gave one. */
function revertReason(error: unknown): string | undefined {
	if (!(error instanceof BaseError)) return undefined;
	const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
	return reverted instanceof ContractFunctionRevertedError ? (reverted.reason ?? reverted.shortMessage) : error.shortMessage;
}

/**
 * Reads the oracle price for a collateral token using only view functions
 * (getValidatedPrice and getLastKnownPrice). getTokenPrice is state-changing
 * and must never be used for UI reads. The returned price drives the preview;
 * final pricing settles on-chain at execution.
 */
export function useOraclePrice(
	chainId: GoldVaultChainId | undefined,
	token: Address | undefined,
	purpose: OraclePricePurpose = 'reference'
): OraclePriceState {
	const config = getGoldOracleContractConfig(chainId);

	const contracts = useMemo(() => {
		if (!config || !token) return [];
		const reads = [
			{ address: config.address, abi: config.abi, functionName: 'getValidatedPrice' as const, args: [token] as const },
			{ address: config.address, abi: config.abi, functionName: 'getLastKnownPrice' as const, args: [token] as const },
		] as const;
		const quote = quoteFunctionFor(purpose);
		if (quote === undefined) return [...reads];
		return [...reads, { address: config.address, abi: config.abi, functionName: quote, args: [token] as const }];
	}, [config, token, purpose]);

	const { data, isLoading, isError } = useReadContracts({
		contracts,
		query: { enabled: contracts.length > 0, refetchInterval: 10_000 },
	});

	return useMemo(() => {
		const validatedResult = data?.[0];
		const lastKnownResult = data?.[1];

		const validated =
			validatedResult?.status === 'success'
				? (validatedResult.result as readonly [bigint, boolean])
				: undefined;
		const lastKnown =
			lastKnownResult?.status === 'success' ? (lastKnownResult.result as bigint) : undefined;

		const plain = pickOraclePrice(validated?.[0], validated?.[1], lastKnown);
		const quoteResult = data?.[2];
		const quote = quoteResult?.status === 'success' ? (quoteResult.result as bigint) : undefined;
		const refusal = quoteResult?.status === 'failure' ? revertReason(quoteResult.error) : undefined;
		const { price8, isLive, refusal: reason } = pickQuotedPrice(quote, refusal, plain);

		const quoted = quote !== undefined && quote > 0n;
		return { isDeployed: !!config, price8, isLive, refusal: reason, quoted, isLoading, isError };
	}, [config, data, isLoading, isError]);
}
