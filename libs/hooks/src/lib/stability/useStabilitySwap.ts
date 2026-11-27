import { useAccount, useSimulateContract } from 'wagmi';
import { type Address } from 'viem';
import { getStabilityReserveContractConfig, type GoldVaultChainId } from '@goldstandard/constants';
import { parseGsusdAmount } from '../stabilityPool';
import { simulateQuery } from '../tx/simulateQuery';
import { liveRequest } from '../tx/liveRequest';
import { useTxWrite, type WriteCallbacks, type WriteFn } from '../tx/useTxWrite';
import { decodeReceivedAmount } from '../tx/receivedAmount';

/**
 * Simulates and executes GoldStabilityReserve.swapGsusdForGold(). Requires a prior
 * GSUSD approval for the reserve (the Guard.TokenApproval step in the UI).
 *
 * minGoldOut is the slippage bound in the token's decimals: the transaction reverts
 * with "Slippage" if the live oracle price yields less than that before it confirms.
 * No vault is involved on any path through this call.
 */
export function useStabilitySwap(
	chainId: GoldVaultChainId | undefined,
	token: Address | undefined,
	gsusdAmount: string | undefined,
	minGoldOut: bigint | undefined
) {
	const config = getStabilityReserveContractConfig(chainId);
	const { address: account } = useAccount();
	const parsedAmount = parseGsusdAmount(gsusdAmount);
	const args =
		token && parsedAmount !== undefined && parsedAmount > 0n && minGoldOut !== undefined
			? ([token, parsedAmount, minGoldOut] as const)
			: undefined;

	const simulation = useSimulateContract({
		...config,
		functionName: 'swapGsusdForGold',
		args,
		query: simulateQuery(!!config && !!args),
	});
	const tx = useTxWrite();

	// Undefined until the simulation has a request for these exact arguments, so a Confirm
	// button can show it is checking instead of swallowing the click or signing a stale request.
	const request = liveRequest(simulation, args);
	const write: WriteFn | undefined = request
		? (callbacks?: WriteCallbacks) => tx.writeContract(request, callbacks)
		: undefined;

	return {
		write,
		reset: tx.reset,
		txHash: tx.txHash,
		/** The gold the reserve actually paid, from the confirmed receipt; the preview was only an estimate. */
		receivedAmount: decodeReceivedAmount(tx.receipt?.logs, token, account),
		confirmationStatus: tx.confirmationStatus,
		isWritePending: tx.isWritePending,
		writeError: tx.writeError,
		isSimulationSuccess: simulation.isSuccess,
		isSimulationError: simulation.isError,
		simulationError: simulation.error,
	};
}
