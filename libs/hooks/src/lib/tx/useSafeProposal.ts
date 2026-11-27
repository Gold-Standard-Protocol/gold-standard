import { useQuery } from '@tanstack/react-query';
import type { Address, Hash } from 'viem';
import { usePublicClient } from 'wagmi';
import { proposalPollInterval, readSafeExecution, type ProposalConnector, type SafeExecution } from './safeProposal';

interface UseSafeProposalParams {
	connector: ProposalConnector | undefined;
	/** The Safe that holds the proposal. */
	safe: Address | undefined;
	/** The proposal to follow; undefined follows nothing. */
	safeTxHash: Hash | undefined;
}

/**
 * Follows one Safe proposal until it executes. Undefined while it is outstanding, and while
 * the Safe or the chain cannot be asked: the proposal was made either way, and nothing more
 * is known about it.
 */
export function useSafeProposal({ connector, safe, safeTxHash }: UseSafeProposalParams): SafeExecution | undefined {
	const client = usePublicClient();
	const { data } = useQuery({
		queryKey: ['safeProposal', safe, safeTxHash],
		queryFn: () => {
			if (!connector || !client || !safe || !safeTxHash) throw new Error('No Safe proposal to follow.');
			return readSafeExecution({ connector, client, safe, safeTxHash });
		},
		enabled: Boolean(connector && client && safe && safeTxHash),
		// An executed proposal cannot change. An outstanding one is asked about on a slow timer,
		// which React Query pauses while the tab is hidden, and whenever the tab is looked at again.
		refetchInterval: (query) =>
			query.state.data ? false : proposalPollInterval(query.state.dataUpdateCount + query.state.errorUpdateCount),
		refetchOnWindowFocus: (query) => (query.state.data ? false : 'always'),
		// A public node a block behind the Safe's cannot place the receipt yet; it can a moment later.
		retry: 2,
	});
	return data ?? undefined;
}
