// Checks on the CoinGecko response and the cached quote, importing only the import-free
// cache keys so specs need neither axios nor @goldstandard/constants.

import { PRICES_MAX_AGE_MS } from './priceCacheKeys';

/**
 * The longest a 429 may hold the refresh back. CoinGecko's public tier limits per minute,
 * so a Retry-After of hours is a misbehaving or hostile answer; obeyed, it would leave the
 * dapp and the keeper's watchdog on one quote for that long.
 */
export const MAX_BACKOFF_MS = 5 * 60_000;

/** A Retry-After in seconds as milliseconds, at most MAX_BACKOFF_MS; undefined when unusable. */
export const retryAfterMs = (header: unknown): number | undefined => {
  if (typeof header !== 'string' && typeof header !== 'number') return undefined;
  if (typeof header === 'string' && header.trim() === '') return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds * 1000, MAX_BACKOFF_MS);
};

export interface ValidPrices {
  /** The entries whose usd is a finite positive number, as CoinGecko sent them. */
  prices: Record<string, { usd: number }>;
  /** The ids dropped for a missing, non-numeric, non-finite or non-positive usd. */
  rejected: string[];
}

/**
 * The simple/price body with every unusable price removed, so a zero, a negative, NaN or
 * Infinity never reaches the cache that the dapp displays and the keeper compares the
 * oracle with. A dropped id is absent from the cached quote until a good one arrives.
 */
export const validPrices = (body: unknown): ValidPrices => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { prices: {}, rejected: [] };
  }
  const accepted: Array<[string, { usd: number }]> = [];
  const rejected: string[] = [];
  for (const [id, record] of Object.entries(body as Record<string, unknown>)) {
    const usd = typeof record === 'object' && record !== null ? (record as Record<string, unknown>)['usd'] : undefined;
    if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) {
      accepted.push([id, { usd }]);
    } else {
      rejected.push(id);
    }
  }
  return { prices: Object.fromEntries(accepted), rejected };
};

/**
 * The cached quote for the requested ids, each stamped with the
 * time it was fetched, or nothing at all once the quote is older than maxAgeMs or carries
 * no usable timestamp. A stopped refresh then reads as a missing price, which the dapp
 * names ("Price feed unavailable, retrying"), instead of a frozen one shown as live.
 */
export const servablePrices = <T extends object>(
  cached: Record<string, T> | null | undefined,
  updatedAt: unknown,
  priceIds: readonly string[],
  now: number,
  maxAgeMs: number = PRICES_MAX_AGE_MS
): Record<string, T & { updatedAt: number }> => {
  if (!cached || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return {};
  if (now - updatedAt > maxAgeMs) return {};
  return Object.fromEntries(
    Object.entries(cached)
      .filter(([id]) => priceIds.includes(id))
      .map(([id, record]) => [id, { ...record, updatedAt }])
  );
};
