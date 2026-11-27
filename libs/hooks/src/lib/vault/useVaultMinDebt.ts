import { useReadContract } from 'wagmi';
import { GOLD_VAULT_MIN_DEBT } from '@goldstandard/constants';
import {
  getGoldVaultContractConfig,
  goldVaultAbi,
  type GoldVaultChainId,
} from '@goldstandard/constants';

/**
 * GoldVault.minDebt as the chain reports it. Governed since 2026-10-22 (100 GSUSD on the
 * testnet harness, 1,000 on mainnet), so the forms must not assume the contract default.
 * Until the read lands, and while it fails, the answer is the figure the target chain
 * launched with (GOLD_VAULT_MIN_DEBT), never the Sepolia figure on a mainnet build.
 */
export function useVaultMinDebt(chainId: GoldVaultChainId | undefined): bigint {
	const config = getGoldVaultContractConfig(chainId);
	const { data } = useReadContract({
		...config,
		abi: goldVaultAbi,
		functionName: 'minDebt',
		query: { enabled: Boolean(config), staleTime: 60_000 },
	});
	return (data as bigint | undefined) ?? GOLD_VAULT_MIN_DEBT;
}
