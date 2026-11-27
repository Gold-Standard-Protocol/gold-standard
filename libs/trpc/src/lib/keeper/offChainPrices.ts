import type { Address } from 'viem';
import { getCacheHandle } from '../config/cacheManager';
import { PRICES_CACHE_KEY, PRICES_MAX_AGE_MS, PRICES_UPDATED_AT_CACHE_KEY } from '../jobs/priceCacheKeys';
import type { KeeperConfig } from './config';
import { describeError } from './decode';
import type { OffChainPriceRead, OffChainPriceSource } from './ports';

/**
 * The off-chain market price the price watchdog compares the oracle with: the API's own
 * cached aggregator quote (libs/trpc/src/lib/jobs/fetchPrices.ts), read from the same
 * Redis entry. No new HTTP dependency, and the quote is display grade: it only ever
 * reaches a log line, never a transaction.
 */

/** The aggregator ids the API fetches, mirroring priceApiId in libs/constants tokens.ts. */
export const PRICE_API_IDS = {
  paxg: 'pax-gold',
  xaut: 'tether-gold',
} as const;

/**
 * A cached quote older than this is treated as missing: the API refreshes every few
 * minutes, and an entry left behind by a stopped refresh would raise false alarms. The
 * price route stops serving the quote at the same age.
 */
export const OFF_CHAIN_PRICE_MAX_AGE_MS = PRICES_MAX_AGE_MS;

const PRICE_DECIMALS = 8;
const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * A positive USD amount, as a number or a plain decimal string, in the oracle's 8
 * decimals; undefined for anything else. Digits past the eighth are truncated.
 */
export const parseUsdPrice = (value: unknown): bigint | undefined => {
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const match = PLAIN_DECIMAL.exec(String(value).trim());
  if (match === null) return undefined;
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(PRICE_DECIMALS, '0').slice(0, PRICE_DECIMALS);
  const price = BigInt(whole) * 10n ** BigInt(PRICE_DECIMALS) + BigInt(fraction);
  return price > 0n ? price : undefined;
};

/** The one read the source needs; the shared cache by default, a stub in specs. */
export interface PriceCacheStore {
  get(key: string): Promise<unknown>;
}

// Through Keyv rather than cache-manager, as the owner source does: cache-manager
// swallows a store failure and answers null, which would hide an outage as a miss.
const sharedStore: PriceCacheStore = {
  get: (key) => getCacheHandle().keyv.get<unknown>(key),
};

const usdOf = (prices: unknown, id: string): unknown => {
  if (typeof prices !== 'object' || prices === null) return undefined;
  const record: unknown = (prices as Record<string, unknown>)[id];
  if (typeof record !== 'object' || record === null) return undefined;
  return (record as Record<string, unknown>)['usd'];
};

export const createCachedOffChainPriceSource = (
  config: Pick<KeeperConfig, 'paxgToken' | 'xautToken'>,
  store: PriceCacheStore = sharedStore,
  now: () => number = Date.now
): OffChainPriceSource => {
  const idFor = (token: Address): string | undefined => {
    if (token === config.paxgToken) return PRICE_API_IDS.paxg;
    if (config.xautToken !== undefined && token === config.xautToken) return PRICE_API_IDS.xaut;
    return undefined;
  };
  return {
    getUsdPrice: async (token): Promise<OffChainPriceRead> => {
      const id = idFor(token);
      if (id === undefined) {
        return { ok: false, reason: `no aggregator price id for ${token}` };
      }
      let prices: unknown;
      let updatedAt: unknown;
      try {
        prices = await store.get(PRICES_CACHE_KEY);
        updatedAt = await store.get(PRICES_UPDATED_AT_CACHE_KEY);
      } catch (error) {
        return { ok: false, reason: `price cache unreadable: ${describeError(error)}` };
      }
      const price = parseUsdPrice(usdOf(prices, id));
      if (price === undefined) {
        return { ok: false, reason: `no cached ${id} price` };
      }
      if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
        return { ok: false, reason: `the cached ${id} price carries no timestamp, so its age is unknown` };
      }
      const ageMs = now() - updatedAt;
      if (ageMs > OFF_CHAIN_PRICE_MAX_AGE_MS) {
        return {
          ok: false,
          reason: `the cached ${id} price is ${Math.round(ageMs / 1000)} seconds old, older than the ${OFF_CHAIN_PRICE_MAX_AGE_MS / 1000} second limit`,
        };
      }
      return { ok: true, price, updatedAt, source: `api-cache:${id}` };
    },
  };
};
