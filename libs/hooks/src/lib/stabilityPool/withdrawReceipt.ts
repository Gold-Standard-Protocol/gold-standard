import { parseEventLogs, type Log } from 'viem';
import { stabilityPoolAbi } from '@goldstandard/constants';

/**
 * The amount StabilityPool.withdraw actually returned, read from the Withdrawn event in
 * the confirmed receipt.
 *
 * The pool caps a withdrawal at the caller's compounded deposit instead of reverting, so
 * the amount asked for is only a ceiling. Reporting it as withdrawn overstated every
 * capped withdrawal, so the confirmation reads the event instead.
 *
 * Returns undefined when the receipt carries no Withdrawn log (wrong receipt, or a
 * reverted transaction).
 */
export function decodeWithdrawnAmount(logs: readonly Log[] | undefined): bigint | undefined {
	if (!logs || logs.length === 0) return undefined;
	const events = parseEventLogs({ abi: stabilityPoolAbi, eventName: 'Withdrawn', logs: [...logs] });
	const last = events[events.length - 1];
	return last?.args.amount;
}
