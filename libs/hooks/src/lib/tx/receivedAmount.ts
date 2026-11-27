import { erc20Abi, isAddressEqual, parseEventLogs, type Address, type Log } from 'viem';

/**
 * How much of `token` reached `recipient` in a confirmed receipt, summed over the
 * token's Transfer logs.
 *
 * A swap only promises a minimum; the amount it actually paid is whatever the pool
 * or the reserve transferred when it landed. Reading the Transfer logs covers both
 * venues with one rule, since each pays the caller with a plain ERC-20 transfer.
 *
 * Returns undefined when the receipt carries no such transfer (wrong receipt, a
 * reverted transaction, or the inputs are not known yet).
 */
export function decodeReceivedAmount(
	logs: readonly Log[] | undefined,
	token: Address | undefined,
	recipient: Address | undefined
): bigint | undefined {
	if (!logs || logs.length === 0 || !token || !recipient) return undefined;
	const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: [...logs] }).filter(
		event => isAddressEqual(event.address, token) && isAddressEqual(event.args.to, recipient)
	);
	if (transfers.length === 0) return undefined;
	return transfers.reduce((total, event) => total + event.args.value, 0n);
}
