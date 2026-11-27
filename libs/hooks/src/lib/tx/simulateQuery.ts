import { keepPreviousData } from '@tanstack/react-query';
import { BaseError, ContractFunctionRevertedError } from 'viem';

/** React Query's own default, kept for the failures that are worth retrying. */
const MAX_SIMULATION_RETRIES = 3;

/**
 * Retries a simulation only when the request failed, never when the contract answered it.
 * React Query's default retried a revert three times with backoff: the same call against
 * the same state reverts the same way, so the Confirm button said "Checking" for about seven
 * seconds before the reason appeared, and each refused amount cost four calls instead of one.
 * A failed HTTP request or a node error is still retried as before.
 * A revert from a node still behind an approval or a transaction is not lost by this: those
 * paths re-run the simulations on a schedule after the receipt (refreshScheduler).
 */
export function retrySimulationFailure(failureCount: number, error: Error): boolean {
	const reverted = error instanceof BaseError && Boolean(error.walk((cause) => cause instanceof ContractFunctionRevertedError));
	return !reverted && failureCount < MAX_SIMULATION_RETRIES;
}

/**
 * Query options for every `useSimulateContract` behind a Confirm button.
 *
 * While the simulation re-runs with new arguments (a fresh quote, an allowance that just
 * landed) the previous request stays available, so the write function and the button it
 * enables never flicker off. A click that lands during the refetch sends the last good
 * request, and the contract's own bounds (slippage, minimum debt) still apply on-chain.
 * Without this, a Confirm click in that window did nothing and showed nothing: CI caught
 * it as the review dialog surviving a resolved click. Once the inputs are no longer valid
 * the query is disabled and nothing is kept, so a stale request can never outlive its form.
 * A revert is the contract's answer and is shown at once (retrySimulationFailure).
 */
export function simulateQuery(enabled: boolean) {
	return {
		enabled,
		placeholderData: enabled ? keepPreviousData : undefined,
		retry: retrySimulationFailure,
	} as const;
}
