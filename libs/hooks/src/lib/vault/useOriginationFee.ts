import { useAccount, useReadContract } from 'wagmi';
import {
	getGoldVaultContractConfig,
	goldVaultAbi,
	type GoldVaultChainId,
} from '@goldstandard/constants';

export interface OriginationFee {
	/** GoldVault.originationFeeBps; undefined until the read lands. */
	bps: bigint | undefined;
	/** Whether the connected account is exempt; undefined until the read lands. */
	exempt: boolean | undefined;
}

/**
 * GoldVault's origination fee for the connected account. Governed (5 bps at launch, 0 to 100),
 * so the forms read it from the chain rather than assuming the launch value.
 */
export function useOriginationFee(chainId: GoldVaultChainId | undefined): OriginationFee {
	const config = getGoldVaultContractConfig(chainId);
	const { address } = useAccount();
	const { data: bps } = useReadContract({
		...config,
		abi: goldVaultAbi,
		functionName: 'originationFeeBps',
		query: { enabled: Boolean(config), staleTime: 60_000 },
	});
	const { data: exempt } = useReadContract({
		...config,
		abi: goldVaultAbi,
		functionName: 'originationFeeExempt',
		args: address ? [address] : undefined,
		query: { enabled: Boolean(config && address), staleTime: 60_000 },
	});
	return { bps: bps as bigint | undefined, exempt: exempt as boolean | undefined };
}
