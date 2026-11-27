import { useReadContract } from 'wagmi';
import { type Address } from 'viem';
import { getGoldVaultContractConfig, type GoldVaultChainId } from '@goldstandard/constants';
import { useOraclePrice } from '../stability/useOraclePrice';
import { useCollateralParams } from './useCollateralParams';
import { useLiquidationPrice } from './useLiquidationPrice';
import { RATIO_PRECISION, ratioToPercent, resolveCollateralRatio, type LiveQuote, type RatioSource } from './liveRatio';

/**
 * Where a ratio stands against the governed ratios of its collateral: at or above the comfort line
 * (the minimum ratio plus the same distance again
 * as the minimum sits above the liquidation ratio; 150% at 130% and 110%), at or above the
 * minimum, below the minimum, or below the liquidation ratio. 'none' when there is no debt
 * or nothing is known yet.
 */
export type RatioStatus = 'healthy' | 'warning' | 'danger' | 'liquidatable' | 'none';

/** Percent thresholds, each derived from the collateral's governed ratios. Pure. */
export function ratioBands(minRatioPercent: number, liquidationRatioPercent: number) {
	return {
		liquidation: liquidationRatioPercent,
		minimum: minRatioPercent,
		comfort: minRatioPercent + Math.max(minRatioPercent - liquidationRatioPercent, 0),
	};
}

/** The verdict for a ratio in percent against governed ratios in percent. Pure. */
export function ratioStatus(
	ratioPercent: number | undefined,
	governed: { minRatioPercent: number | undefined; liquidationRatioPercent: number | undefined }
): RatioStatus {
	if (ratioPercent === undefined || ratioPercent === Infinity) return 'none';
	if (governed.minRatioPercent === undefined || governed.liquidationRatioPercent === undefined) return 'none';
	const bands = ratioBands(governed.minRatioPercent, governed.liquidationRatioPercent);
	if (ratioPercent >= bands.comfort) return 'healthy';
	if (ratioPercent >= bands.minimum) return 'warning';
	if (ratioPercent >= bands.liquidation) return 'danger';
	return 'liquidatable';
}

/**
 * The vault's collateral ratio as the user should see it.
 *
 * GoldVault.getCollateralisationRatio prices at the oracle's lastKnownPrice, which only a
 * state-changing read moves, so in a quiet fall it showed "Healthy" while the vault was
 * already liquidatable at the price liquidate settles at. The ratio now comes from the live
 * liquidation quote as the keeper computes it: liquidationRatio x quoteTokenPrice /
 * getLiquidationPrice. The stored view is used only when that quote is refused, and then
 * `source` is 'stored' so the card can say so.
 */
export function useCollateralRatio(
	chainId: GoldVaultChainId | undefined,
	userAddress: Address | undefined,
	collateralToken?: Address
) {
	const config = getGoldVaultContractConfig(chainId);

	const stored = useReadContract({
		...config,
		functionName: 'getCollateralisationRatio',
		args: userAddress ? [userAddress] : undefined,
		query: {
			enabled: !!config && !!userAddress,
			refetchInterval: 10_000,
		},
	});
	// Same query as the position card's liquidation price, so wagmi serves both from one read.
	const liquidationPrice = useLiquidationPrice(chainId, userAddress);
	const params = useCollateralParams(chainId, collateralToken);
	const oracle = useOraclePrice(chainId, collateralToken, 'liquidation');

	const storedRatio = stored.data as bigint | undefined;
	const liquidationRatio =
		params.liquidationRatioPercent === undefined
			? undefined
			: BigInt(Math.round(params.liquidationRatioPercent * Number(RATIO_PRECISION / 100n)));
	// The live quote is refused when the oracle says no, equally unusable when the
	// collateral's liquidation ratio cannot be read, and absent in a build with no oracle
	// configured; in every case the stored view stands in, labelled as such, rather than
	// the ratio loading for ever (the liquidation list already decides this way).
	const paramsFailed = !params.isLoading && collateralToken !== undefined && liquidationRatio === undefined;
	const quote: LiveQuote =
		oracle.quoted && oracle.price8 !== undefined
			? { price8: oracle.price8 }
			: !oracle.isDeployed || oracle.refusal !== undefined || paramsFailed
				? { refused: true }
				: undefined;
	const resolved = resolveCollateralRatio({
		storedRatio,
		liquidationPrice: liquidationPrice.priceRaw,
		liquidationRatio,
		quote,
	});

	const ratio = resolved.ratio;
	// `ratio ? ... : undefined` swallowed a genuine 0n, which the vault reports when its
	// collateral is worthless while debt is outstanding: the single most dangerous state the
	// protocol can produce. Test against undefined, not truthiness.
	const ratioPercent = ratio === undefined ? undefined : ratioToPercent(ratio);
	const status = ratioStatus(ratioPercent, params);

	return {
		ratio,
		ratioPercent,
		status,
		/** 'live' at the liquidation quote, 'stored' at the oracle's last recorded price. */
		source: resolved.source as RatioSource | undefined,
		minRatioPercent: params.minRatioPercent,
		liquidationRatioPercent: params.liquidationRatioPercent,
		/** True while the chain has not yet told us the ratio, never a stand-in for "no debt". */
		isUnknown: ratio === undefined,
		isLoading: stored.isLoading || liquidationPrice.isLoading || params.isLoading || oracle.isLoading,
		isError: stored.isError && ratio === undefined,
	};
}
