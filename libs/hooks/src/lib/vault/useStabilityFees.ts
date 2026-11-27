import { useReadContract } from 'wagmi';
import { type Address, formatUnits, keccak256, encodePacked } from 'viem';
import { getStabilityModuleContractConfig, type GoldVaultChainId } from '@goldstandard/constants';

export function useStabilityFees(
	chainId: GoldVaultChainId | undefined,
	userAddress: Address | undefined,
	collateralToken: Address | undefined,
	principalDebt: bigint | undefined
) {
	const config = getStabilityModuleContractConfig(chainId);
	const collateralId = collateralToken ? keccak256(encodePacked(['address'], [collateralToken])) : undefined;

	const { data: currentDebtRaw, isLoading, isError } = useReadContract({
		...config,
		functionName: 'getCurrentDebt',
		args: userAddress && collateralId ? [userAddress, collateralId] : undefined,
		query: {
			enabled: !!config && !!userAddress && !!collateralId,
			refetchInterval: 10_000,
		},
	});

	const currentDebt = currentDebtRaw as bigint | undefined;
	const accruedFees = currentDebt && principalDebt && currentDebt > principalDebt
		? currentDebt - principalDebt
		: 0n;

	// Six decimals, not eighteen. Raw formatUnits rendered accrued fees as
	// "1.904459396501021015 GSUSD", which is unreadable and overflowed its row. Six is
	// enough to show a fee that has only just started accruing, and the exact wei value
	// is still available to callers as `accruedFees`.
	const accruedFeesFormatted = trimDecimals(formatUnits(accruedFees, 18), 6);
	const currentDebtFormatted = currentDebt
		? trimDecimals(formatUnits(currentDebt, 18), 6)
		: '0';

	return { currentDebt, accruedFees, accruedFeesFormatted, currentDebtFormatted, isLoading, isError };
}

/** Truncates a decimal string, never rounding up past the true value. */
function trimDecimals(value: string, places: number): string {
	const [whole, fraction] = value.split('.');
	if (!fraction) return whole;
	const kept = fraction.slice(0, places).replace(/0+$/, '');
	return kept.length > 0 ? `${whole}.${kept}` : whole;
}
