/**
 * When to re-read the chain after a transaction confirms, in milliseconds after the
 * receipt. A single refetch at the receipt is not enough: a load-balanced public RPC can
 * answer it from a node that has not yet included the block, and the stale value then
 * sits until the next poll (ten to thirty seconds), which reads as "the transaction did
 * not work". A few follow-ups over the next ten seconds ride that lag out; after that the
 * ordinary polling owns the reads. The timers themselves live in refreshScheduler.
 */
export const REFRESH_DELAYS_MS: readonly number[] = [0, 1_500, 4_000, 8_000, 12_000];
