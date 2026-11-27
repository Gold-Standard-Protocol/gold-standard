import { useReadContracts } from 'wagmi';
import { erc20Abi, zeroAddress, type Address } from 'viem';
import { findTokenInfoByAddress, type GoldVaultChainId } from '@goldstandard/constants';

export interface CollateralTokenMeta {
	/** Native decimals (PAXG 18, XAUT 6). Undefined until known; never a guess. */
	decimals: number | undefined;
	symbol: string | undefined;
	isLoading: boolean;
}

const UNKNOWN: CollateralTokenMeta = { decimals: undefined, symbol: undefined, isLoading: false };

/**
 * Decimals and symbol for a collateral token address.
 *
 * The token list answers instantly for the listed gold tokens. Anything else is read
 * from the ERC-20 itself, which is exactly what GoldVault does before it normalises an
 * amount. There is deliberately no default of 18: XAUT carries 6 decimals, and every
 * amount parsed, previewed or displayed at the wrong scale is out by 1e12.
 */
export function useCollateralToken(
	chainId: GoldVaultChainId | undefined,
	address: Address | undefined
): CollateralTokenMeta {
	const listed = findTokenInfoByAddress(address, chainId);
	const readFromChain = !listed && address !== undefined && address !== zeroAddress;

	const { data, isLoading } = useReadContracts({
		contracts:
			readFromChain && address
				? [
						{ address, abi: erc20Abi, functionName: 'decimals' },
						{ address, abi: erc20Abi, functionName: 'symbol' },
				  ]
				: [],
		// Decimals and symbol are immutable, so one read per token per session is plenty.
		query: { enabled: readFromChain, staleTime: Infinity },
	});

	if (listed) return { decimals: listed.decimals, symbol: listed.symbol, isLoading: false };
	if (!readFromChain) return UNKNOWN;

	const decimals = data?.[0]?.status === 'success' ? Number(data[0].result) : undefined;
	const symbol = data?.[1]?.status === 'success' ? String(data[1].result) : undefined;
	return { decimals, symbol, isLoading };
}
