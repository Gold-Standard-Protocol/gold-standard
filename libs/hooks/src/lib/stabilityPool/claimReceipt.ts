import { parseEventLogs, type Log } from 'viem';
import { stabilityPoolAbi } from '@goldstandard/constants';

/**
 * The gold StabilityPool.claimCollateral actually paid, read from the CollateralClaimed
 * event in the confirmed receipt, in the token's own units.
 *
 * The pool pays the smaller of the caller's gain and the gold it holds and leaves
 * the rest claimable, so the gain read before the claim is only a ceiling. After an issuer
 * wipe or freeze the two differ, and the confirmation must name what arrived.
 *
 * Returns undefined when the receipt carries no CollateralClaimed log (wrong receipt, or a
 * reverted transaction).
 */
export function decodeClaimedAmount(logs: readonly Log[] | undefined): bigint | undefined {
	if (!logs || logs.length === 0) return undefined;
	const events = parseEventLogs({ abi: stabilityPoolAbi, eventName: 'CollateralClaimed', logs: [...logs] });
	const last = events[events.length - 1];
	return last?.args.amount;
}
