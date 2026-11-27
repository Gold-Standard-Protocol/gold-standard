import { useSimulateContract } from 'wagmi';
import { type Address } from 'viem';
import { getStabilityPoolContractConfig, type GoldVaultChainId } from '@goldstandard/constants';
import { parseGsusdAmount } from './poolMath';
import { decodeClaimedAmount } from './claimReceipt';
import { decodeWithdrawnAmount } from './withdrawReceipt';
import { simulateQuery } from '../tx/simulateQuery';
import { liveRequest } from '../tx/liveRequest';
import { useTxWrite, type WriteCallbacks, type WriteFn } from '../tx/useTxWrite';

export type PoolActionType = 'deposit' | 'withdraw' | 'claim';

/**
 * Deposits GSUSD into the stability pool. The pool pulls GSUSD via
 * safeTransferFrom, so the caller must have approved the pool first
 * (handled by Guard.TokenApproval in the UI).
 */
export function useStabilityPoolDeposit(chainId: GoldVaultChainId | undefined, amount: string | undefined) {
	const config = getStabilityPoolContractConfig(chainId);
	const parsedAmount = parseGsusdAmount(amount);
	const args = parsedAmount !== undefined && parsedAmount > 0n ? ([parsedAmount] as const) : undefined;

	const simulation = useSimulateContract({
		...config,
		functionName: 'deposit',
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
		confirmationStatus: tx.confirmationStatus,
		isWritePending: tx.isWritePending,
		writeError: tx.writeError,
		isSimulationSuccess: simulation.isSuccess,
		isSimulationError: simulation.isError,
		simulationError: simulation.error,
	};
}

/**
 * Withdraws GSUSD from the stability pool. The contract caps the amount to the
 * compounded effective deposit instead of reverting, so over-withdrawals
 * simulate successfully; the UI warns via clampWithdrawAmount.
 */
export function useStabilityPoolWithdraw(chainId: GoldVaultChainId | undefined, amount: string | undefined) {
	const config = getStabilityPoolContractConfig(chainId);
	const parsedAmount = parseGsusdAmount(amount);
	const args = parsedAmount !== undefined && parsedAmount > 0n ? ([parsedAmount] as const) : undefined;

	const simulation = useSimulateContract({
		...config,
		functionName: 'withdraw',
		// Simulate in the block the transaction will land in: the pool refuses a withdrawal in
		// the block of the caller's deposit, and 'latest' is that block right after depositing.
		blockTag: 'pending',
		args,
		query: simulateQuery(!!config && !!args),
	});
	const tx = useTxWrite();

	// The pool caps the amount asked for at the effective deposit; the event holds what it paid.
	const withdrawnAmount = decodeWithdrawnAmount(tx.receipt?.logs);

	const request = liveRequest(simulation, args);
	const write: WriteFn | undefined = request
		? (callbacks?: WriteCallbacks) => tx.writeContract(request, callbacks)
		: undefined;

	return {
		write,
		reset: tx.reset,
		txHash: tx.txHash,
		confirmationStatus: tx.confirmationStatus,
		withdrawnAmount,
		isWritePending: tx.isWritePending,
		writeError: tx.writeError,
		isSimulationSuccess: simulation.isSuccess,
		isSimulationError: simulation.isError,
		simulationError: simulation.error,
	};
}

/**
 * Claims the caller's pending collateral gain for one gold token. The contract
 * reverts with "No gains" when the gain is zero, so the simulation is gated on
 * `hasGain` to avoid showing a phantom simulation error in the UI.
 */
export function useStabilityPoolClaim(chainId: GoldVaultChainId | undefined, token: Address | undefined, hasGain: boolean) {
	const config = getStabilityPoolContractConfig(chainId);
	const args = token && hasGain ? ([token] as const) : undefined;

	const simulation = useSimulateContract({
		...config,
		functionName: 'claimCollateral',
		// Simulate in the block the transaction will land in, as the withdrawal does: the pool
		// refuses a claim in the block of the caller's deposit, and 'latest' is that block right
		// after a top-up.
		blockTag: 'pending',
		args,
		query: simulateQuery(!!config && !!args),
	});
	const tx = useTxWrite();

	// The pool pays the smaller of the gain and the gold it holds; the event holds what it paid.
	const claimedAmount = decodeClaimedAmount(tx.receipt?.logs);

	const request = liveRequest(simulation, args);
	const write: WriteFn | undefined = request
		? (callbacks?: WriteCallbacks) => tx.writeContract(request, callbacks)
		: undefined;

	return {
		write,
		reset: tx.reset,
		txHash: tx.txHash,
		confirmationStatus: tx.confirmationStatus,
		claimedAmount,
		isWritePending: tx.isWritePending,
		writeError: tx.writeError,
		isSimulationSuccess: simulation.isSuccess,
		isSimulationError: simulation.isError,
		simulationError: simulation.error,
	};
}
