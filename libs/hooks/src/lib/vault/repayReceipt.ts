import { parseEventLogs, type Log } from 'viem';
import { goldVaultAbi } from '@goldstandard/constants';

/**
 * The amount GoldVault actually took in a repayment, read from the DebtRepaid event
 * in the confirmed receipt.
 *
 * A full close is submitted with a small margin above the quoted debt because fees
 * accrue every second and the quote is stale on arrival; the contract clamps the pull
 * to the debt at inclusion time and emits that clamped figure. Showing the submitted
 * ceiling as "repaid" overstated every close by the margin, so the confirmation reads
 * the event instead.
 *
 * Returns undefined when the receipt carries no DebtRepaid log (wrong receipt, or a
 * reverted transaction).
 */
export function decodeRepaidAmount(logs: readonly Log[] | undefined): bigint | undefined {
	if (!logs || logs.length === 0) return undefined;
	const events = parseEventLogs({ abi: goldVaultAbi, eventName: 'DebtRepaid', logs: [...logs] });
	const last = events[events.length - 1];
	return last?.args.amount;
}
