import { useSimulateContract } from 'wagmi';
import { type Address } from 'viem';
import { getGoldVaultContractConfig, type GoldVaultChainId } from '@goldstandard/constants';
import { simulateQuery } from '../tx/simulateQuery';
import { liveRequest } from '../tx/liveRequest';
import { useTxWrite, type WriteCallbacks, type WriteFn } from '../tx/useTxWrite';
import { decodeRepaidAmount } from './repayReceipt';
import { parseVaultAmount } from './vaultAmount';

export type VaultActionType = 'deposit' | 'mint' | 'repay' | 'withdraw';

/** GSUSD always carries 18 decimals; the debt legs never depend on the collateral. */
const GSUSD_DECIMALS = 18;

export function useVaultDeposit(
	chainId: GoldVaultChainId | undefined,
	token: Address | undefined,
	amount: string | undefined,
	/**
	 * The collateral token's decimals. GoldVault takes NATIVE units, so parsing XAUT (6
	 * decimals) at 18 asked the vault for 1e12 times the typed amount. Undefined means
	 * "not known yet" and disables the simulation rather than guessing.
	 */
	tokenDecimals: number | undefined
) {
	const config = getGoldVaultContractConfig(chainId);
	const parsedAmount = parseVaultAmount(amount, tokenDecimals);
	const args = token && parsedAmount ? ([token, parsedAmount] as const) : undefined;

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

export function useVaultMint(chainId: GoldVaultChainId | undefined, amount: string | undefined) {
	const config = getGoldVaultContractConfig(chainId);
	const parsedAmount = parseVaultAmount(amount, GSUSD_DECIMALS);
	const args = parsedAmount ? ([parsedAmount] as const) : undefined;

	const simulation = useSimulateContract({
		...config,
		functionName: 'mint',
		// The ratio check runs in the block that includes the mint, after more fees have
		// accrued; judging it against 'latest' passed mints the wallet then refused to estimate.
		blockTag: 'pending',
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

export function useVaultRepay(chainId: GoldVaultChainId | undefined, amount: string | undefined) {
	const config = getGoldVaultContractConfig(chainId);
	// The repay box accepts free text; a stray letter must not throw mid-render.
	const parsedAmount = parseVaultAmount(amount, GSUSD_DECIMALS);
	const args = parsedAmount ? ([parsedAmount] as const) : undefined;

	const simulation = useSimulateContract({
		...config,
		functionName: 'repay',
		// Like mint and withdraw: the remaining-debt floor is judged in the block that
		// includes the repayment, after more fees have accrued.
		blockTag: 'pending',
		args,
		query: simulateQuery(!!config && !!args),
	});
	const tx = useTxWrite();

	// A full close submits a margin above the quoted debt; the contract clamps to what
	// is owed at inclusion and emits that. This is the figure the confirmation shows.
	const repaidAmount = decodeRepaidAmount(tx.receipt?.logs);

	const request = liveRequest(simulation, args);
	const write: WriteFn | undefined = request
		? (callbacks?: WriteCallbacks) => tx.writeContract(request, callbacks)
		: undefined;

	return {
		write,
		reset: tx.reset,
		txHash: tx.txHash,
		confirmationStatus: tx.confirmationStatus,
		repaidAmount,
		isWritePending: tx.isWritePending,
		writeError: tx.writeError,
		isSimulationSuccess: simulation.isSuccess,
		isSimulationError: simulation.isError,
		simulationError: simulation.error,
	};
}

export function useVaultWithdraw(
	chainId: GoldVaultChainId | undefined,
	amount: string | undefined,
	/** The vault's collateral token decimals; withdraw amounts are native units too. */
	tokenDecimals: number | undefined
) {
	const config = getGoldVaultContractConfig(chainId);
	const parsedAmount = parseVaultAmount(amount, tokenDecimals);
	const args = parsedAmount ? ([parsedAmount] as const) : undefined;

	const simulation = useSimulateContract({
		...config,
		functionName: 'withdraw',
		// Same reason as mint: the ratio is judged in the inclusion block, not the latest one.
		blockTag: 'pending',
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
