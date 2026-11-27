/**
 * Hand-written subset of the Uniswap SwapRouter02 ABI: the single-hop exact-input swap and
 * the deadline form of multicall that carries it.
 *
 * SwapRouter02 differs from the original SwapRouter: its ExactInputSingleParams carries
 * NO deadline field (deadlines go through multicall(deadline, data) instead). Passing the
 * v1 struct shape to this router silently mis-encodes the call, so keep this in step
 * with the deployed router, never with the v1 interface.
 *
 * The router has three multicall overloads; only multicall(uint256 deadline, bytes[] data)
 * is listed, so the name resolves to the one that reverts "Transaction too old" once the
 * deadline has passed.
 */
export const uniswapSwapRouter02Abi = [
	{
		inputs: [
			{ internalType: 'uint256', name: 'deadline', type: 'uint256' },
			{ internalType: 'bytes[]', name: 'data', type: 'bytes[]' },
		],
		name: 'multicall',
		outputs: [{ internalType: 'bytes[]', name: '', type: 'bytes[]' }],
		stateMutability: 'payable',
		type: 'function',
	},
	{
		inputs: [
			{
				components: [
					{ internalType: 'address', name: 'tokenIn', type: 'address' },
					{ internalType: 'address', name: 'tokenOut', type: 'address' },
					{ internalType: 'uint24', name: 'fee', type: 'uint24' },
					{ internalType: 'address', name: 'recipient', type: 'address' },
					{ internalType: 'uint256', name: 'amountIn', type: 'uint256' },
					{ internalType: 'uint256', name: 'amountOutMinimum', type: 'uint256' },
					{ internalType: 'uint160', name: 'sqrtPriceLimitX96', type: 'uint160' },
				],
				internalType: 'struct IV3SwapRouter.ExactInputSingleParams',
				name: 'params',
				type: 'tuple',
			},
		],
		name: 'exactInputSingle',
		outputs: [{ internalType: 'uint256', name: 'amountOut', type: 'uint256' }],
		stateMutability: 'payable',
		type: 'function',
	},
] as const;
