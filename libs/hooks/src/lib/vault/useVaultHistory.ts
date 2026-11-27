import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { numberToHex, type Address } from 'viem';
import {
	getDeployBlock,
	getGoldVaultContractConfig,
	getStabilityReserveContractConfig,
	type GoldVaultChainId,
} from '@goldstandard/constants';
import { historyTopics, type RawLog, type VaultHistoryItem } from './vaultHistory';
import { createHistoryScanner } from './vaultHistoryScan';

/**
 * One scanner for the app: its cursor and timestamp cache outlive any one mount, so going
 * back to the vault page resumes the scan instead of walking the deployment again.
 */
const scanner = createHistoryScanner();

/**
 * Everything this wallet has done with the vault and the reserve, newest first, read
 * straight from the contract events. One eth_getLogs per block chunk covers deposits,
 * withdrawals, mints, repayments, liquidations against the wallet and reserve swaps,
 * because every one of those events carries the wallet as its first indexed argument.
 *
 * Amounts are what the contracts emitted: a full repayment shows the debt actually
 * taken, not the ceiling that was submitted. Re-reads after every confirmed write
 * through the global invalidation in useRefreshOnConfirmation. Each re-read after the
 * first scans only the blocks since the last one (vaultHistoryScan), so the poll and the
 * refresh rounds cost one eth_getLogs and the headers of new entries.
 */
export function useVaultHistory(chainId: GoldVaultChainId | undefined, user: Address | undefined) {
	const client = usePublicClient({ chainId });
	const vault = getGoldVaultContractConfig(chainId);
	const reserve = getStabilityReserveContractConfig(chainId);
	const fromBlock = getDeployBlock(chainId);

	return useQuery({
		queryKey: ['vault-history', chainId, user, vault?.address, reserve?.address, fromBlock.toString()],
		enabled: !!client && !!user && !!vault,
		refetchInterval: 30_000,
		queryFn: async (): Promise<VaultHistoryItem[]> => {
			if (!client || !user || !vault) return [];
			const address = reserve ? [vault.address, reserve.address] : [vault.address];
			const topics = historyTopics(user);
			return scanner.scan(
				{
					getBlockNumber: () => client.getBlockNumber(),
					getLogs: async (from, to) =>
						(await client.request({
							method: 'eth_getLogs',
							params: [{ address, fromBlock: numberToHex(from), toBlock: numberToHex(to), topics }],
						})) as RawLog[],
					getBlockTimestamp: async (blockNumber) => Number((await client.getBlock({ blockNumber })).timestamp),
				},
				{
					key: [chainId, user, vault.address, reserve?.address ?? '', fromBlock.toString()].join(':').toLowerCase(),
					chainId: client.chain.id,
					user,
					fromBlock,
				}
			);
		},
	});
}
