/** One gold token in the stability pool: what the pool holds and what it has recorded. */
export interface PoolHolding {
  held: bigint;
  recorded: bigint;
}

/** A pool that holds everything it has recorded, in parts per million. */
export const FULLY_HELD_PPM = 1_000_000n;

/**
 * The share of its recorded gold the stability pool still holds, in parts per million, for
 * the token where that share is lowest. Gold beyond the record (a transfer not yet absorbed,
 * a donation) counts as fully held, and so does a token with nothing recorded. A reading
 * below 1,000,000 means gold left the pool without a claim: an issuer wiped its balance.
 * The next absorption or claim rewrites the record, so the reading is low only between the
 * loss and that call.
 */
export const lowestHeldShare = (holdings: readonly PoolHolding[]): bigint =>
  holdings.reduce((lowest, { held, recorded }) => {
    if (recorded === 0n || held >= recorded) return lowest;
    const share = (held * FULLY_HELD_PPM) / recorded;
    return share < lowest ? share : lowest;
  }, FULLY_HELD_PPM);
