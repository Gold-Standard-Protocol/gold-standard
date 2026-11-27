import { useAccount, useSimulateContract } from 'wagmi';
import { encodeFunctionData, type Address } from 'viem';
import { getDexConfig, uniswapSwapRouter02Abi, type GoldVaultChainId } from '@goldstandard/constants';
import { simulateQuery } from '../tx/simulateQuery';
import { liveRequest } from '../tx/liveRequest';
import { useTxWrite, type WriteCallbacks, type WriteFn } from '../tx/useTxWrite';
import { decodeReceivedAmount } from '../tx/receivedAmount';
import { useSwapDeadline } from './swapDeadline';

/**
 * Simulates and executes SwapRouter02.exactInputSingle() for a single-hop Uniswap v3
 * swap, with the connected account as recipient. Requires a prior approval of tokenIn
 * for the router (the Guard.TokenApproval step in the UI).
 *
 * amountOutMinimum is the slippage bound in tokenOut's decimals: the router reverts
 * with "Too little received" if the pool would pay less than that when the transaction
 * lands. The swap travels inside multicall(deadline, [exactInputSingle]) so the router
 * also reverts "Transaction too old" after the deadline; the
 * multicall itself is what is simulated and signed. Same return shape as useStabilitySwap
 * so the two legs share one review dialog. No protocol contract is involved on any path
 * through this call.
 */
export function useDexSwap(
	chainId: GoldVaultChainId | undefined,
	tokenIn: Address | undefined,
	tokenOut: Address | undefined,
	amountIn: bigint | undefined,
	amountOutMinimum: bigint | undefined,
	fee?: number
) {
	const config = getDexConfig(chainId);
	const { address: recipient } = useAccount();
	const poolFee = fee ?? config?.poolFee;
	const args =
		!!config &&
		recipient &&
		tokenIn &&
		tokenOut &&
		tokenIn !== tokenOut &&
		amountIn !== undefined &&
		amountIn > 0n &&
		amountOutMinimum !== undefined &&
		poolFee !== undefined
			? ([{ tokenIn, tokenOut, fee: poolFee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }] as const)
			: undefined;

	const deadline = useSwapDeadline();
	const multicallArgs = args
		? ([deadline, [encodeFunctionData({ abi: uniswapSwapRouter02Abi, functionName: 'exactInputSingle', args })]] as const)
		: undefined;

	const simulation = useSimulateContract({
		...config?.router,
		functionName: 'multicall',
		args: multicallArgs,
		query: simulateQuery(!!multicallArgs),
	});
	const tx = useTxWrite();

	// Undefined until the simulation has a request for these exact arguments, deadline
	// included, so a Confirm button can show it is checking instead of swallowing the click
	// or signing a stale request.
	const request = liveRequest(simulation, multicallArgs);
	const write: WriteFn | undefined = request
		? (callbacks?: WriteCallbacks) => tx.writeContract(request, callbacks)
		: undefined;

	return {
		write,
		reset: tx.reset,
		txHash: tx.txHash,
		/** What the pool actually paid, from the confirmed receipt; the quote was only an estimate. */
		receivedAmount: decodeReceivedAmount(tx.receipt?.logs, tokenOut, recipient),
		confirmationStatus: tx.confirmationStatus,
		isWritePending: tx.isWritePending,
		writeError: tx.writeError,
		isSimulationSuccess: simulation.isSuccess,
		isSimulationError: simulation.isError,
		simulationError: simulation.error,
	};
}
