/**
 * Hand-written subset of the Uniswap v3 QuoterV2 ABI: the single quote the dapp needs.
 *
 * quoteExactInputSingle is deliberately non-view on-chain (it performs the swap and
 * reverts inside the pool callback to read the result), so it must be read through a
 * simulation (wagmi useSimulateContract) rather than useReadContract. A pool with no
 * liquidity reverts with "swaps entirely within 0-liquidity regions are not supported",
 * and a pool that does not exist reverts with no data; both mean "no route".
 */
export const uniswapQuoterV2Abi = [
	{
		inputs: [
			{
				components: [
					{ internalType: 'address', name: 'tokenIn', type: 'address' },
					{ internalType: 'address', name: 'tokenOut', type: 'address' },
					{ internalType: 'uint256', name: 'amountIn', type: 'uint256' },
					{ internalType: 'uint24', name: 'fee', type: 'uint24' },
					{ internalType: 'uint160', name: 'sqrtPriceLimitX96', type: 'uint160' },
				],
				internalType: 'struct IQuoterV2.QuoteExactInputSingleParams',
				name: 'params',
				type: 'tuple',
			},
		],
		name: 'quoteExactInputSingle',
		outputs: [
			{ internalType: 'uint256', name: 'amountOut', type: 'uint256' },
			{ internalType: 'uint160', name: 'sqrtPriceX96After', type: 'uint160' },
			{ internalType: 'uint32', name: 'initializedTicksCrossed', type: 'uint32' },
			{ internalType: 'uint256', name: 'gasEstimate', type: 'uint256' },
		],
		stateMutability: 'nonpayable',
		type: 'function',
	},
] as const;
