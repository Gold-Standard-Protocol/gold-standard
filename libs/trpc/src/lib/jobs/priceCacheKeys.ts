// Cache keys the API's price refresh writes and other readers share. Kept in a file of
// their own, with no imports, so the keeper can read the same entries without pulling
// axios or @goldstandard/constants (and its import.meta) into its bundle.

/** The CoinGecko simple/price response: { [priceApiId]: { usd: number } }. */
export const PRICES_CACHE_KEY = 'prices';

/** Milliseconds since the epoch at which PRICES_CACHE_KEY was last written. */
export const PRICES_UPDATED_AT_CACHE_KEY = 'prices:updatedAt';

/**
 * The oldest quote anyone may treat as current. The refresh runs every 30 s, so a quote
 * this old means the refresh has stopped or the provider has refused it for a while: the
 * price route then serves nothing and the keeper's watchdog treats the price as missing.
 */
export const PRICES_MAX_AGE_MS = 15 * 60 * 1000;
