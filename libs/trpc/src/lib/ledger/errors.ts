/**
 * The indexed state disagrees with itself or with the chain: an undecodable log, an
 * absorption the pool could not have made, a mirror that differs from the contract. A run
 * that meets one commits nothing more, and the indexer decides whether to rebuild.
 */
export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerIntegrityError';
  }
}

/**
 * The configured liquidity pool or position manager is not what the ledger can record: not
 * a pool of the position manager's factory, not a GSUSD pool, or a token the value at the
 * peg cannot be computed for. Nothing is indexed until the configuration is corrected.
 */
export class LedgerLiquiditySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerLiquiditySourceError';
  }
}
