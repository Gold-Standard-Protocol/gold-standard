import { useSimulateContract } from 'wagmi';
import { type Address } from 'viem';
import { parseAmount } from '@goldstandard/utils';
import { getGoldVaultContractConfig, type GoldVaultChainId } from '@goldstandard/constants';
import { simulateQuery } from '../tx/simulateQuery';
import { liveRequest } from '../tx/liveRequest';
import { useTxWrite, type WriteCallbacks, type WriteFn } from '../tx/useTxWrite';

/**
 * The amount a liquidation call carries. A full liquidation sends 0: the contract then
 * settles the fee-inclusive debt at inclusion, which a figure typed seconds earlier can
 * never match exactly (it only ever undershoots, leaving a dust position the contract
 * now refuses).
 */
export function liquidationArg(debtToRepay: string | undefined, full: boolean): bigint | undefined {
	if (full) return 0n;
	// The shared parser never throws on malformed free-text input ("1.2.3", "1e", letters)
	// and refuses a zero, so user typing cannot crash the render cycle or send nothing.
	return parseAmount(debtToRepay, 18);
}

export function useLiquidate(
	chainId: GoldVaultChainId | undefined,
	vaultOwner: Address | undefined,
	debtToRepay: string | undefined,
	/** Liquidate the whole position (debtToRepay 0 on-chain) rather than the typed amount. */
	full = false
) {
	const config = getGoldVaultContractConfig(chainId);
	const parsedAmount = liquidationArg(debtToRepay, full);
	const args = vaultOwner && parsedAmount !== undefined ? ([vaultOwner, parsedAmount] as const) : undefined;

	const simulation = useSimulateContract({
		...config,
		functionName: 'liquidate',
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
 * Liquidation funded by the Stability Pool: the pool pays the debt out of its GSUSD
 * deposits and receives the seized gold, while the caller earns a keeper bounty from
 * the penalty for triggering it. No GSUSD leaves the caller's wallet, so no approval
 * is needed. Reverts "Pool insufficient" when the pool holds no more than the repayment it
 * would make: the debt, or the smaller discounted repayment for an underwater vault.
 */
export function useLiquidateViaPool(
	chainId: GoldVaultChainId | undefined,
	vaultOwner: Address | undefined,
	debtToRepay: string | undefined,
	full = false
) {
	const config = getGoldVaultContractConfig(chainId);
	const parsedAmount = liquidationArg(debtToRepay, full);
	const args = vaultOwner && parsedAmount !== undefined ? ([vaultOwner, parsedAmount] as const) : undefined;

	const simulation = useSimulateContract({
		...config,
		functionName: 'liquidateViaPool',
		args,
		query: simulateQuery(!!config && !!args),
	});
	const tx = useTxWrite();

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
