import type { Address } from 'viem';
import { retryAfterMs, validPrices } from '../jobs/priceResponse';
import { DEFAULT_PRICE_API_URL } from './config';
import type { KeeperConfig } from './config';
import { describeError } from './decode';
import { PRICE_API_IDS, parseUsdPrice } from './offChainPrices';
import type { OffChainPriceRead, OffChainPriceSource } from './ports';

/**
 * The off-chain market price fetched by the keeper itself, for a keeper host with no Redis,
 * which is the recommended mainnet shape. The same aggregator endpoint
 * the API's price job uses, at most one request per watchdog tick, display grade and read
 * only: the quote reaches a log line and never a transaction. A failed request leaves the
 * last good price in place until it is older than the maximum age; after that the watchdog
 * says it has nothing to compare the oracle with, exactly as it does without any source.
 */

export { DEFAULT_PRICE_API_URL };
/** A directly fetched price is refreshed every tick, so it goes stale far sooner than the API cache's quote may. */
export const HTTP_PRICE_MAX_AGE_MS = 10 * 60 * 1000;
/** Never more than one request in this window, whatever the tick interval; both tokens share the one request. */
export const HTTP_PRICE_MIN_INTERVAL_MS = 30_000;
export const HTTP_PRICE_TIMEOUT_MS = 10_000;
/** The pause after a 429 that carries no usable Retry-After. */
const DEFAULT_BACKOFF_MS = 60_000;

/** The slice of fetch the source uses, so specs pass a stub and no HTTP library is involved. */
export type PriceFetch = (
  url: string,
  init: { signal: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface HttpOffChainPriceOptions {
  url?: string;
  fetch?: PriceFetch;
  /** Injectable clock for specs; Date.now otherwise. */
  now?: () => number;
}

interface Quote {
  price: bigint;
  updatedAt: number;
}

export const createHttpOffChainPriceSource = (
  config: Pick<KeeperConfig, 'paxgToken' | 'xautToken'>,
  options: HttpOffChainPriceOptions = {}
): OffChainPriceSource => {
  const url = options.url ?? DEFAULT_PRICE_API_URL;
  const fetchPrices: PriceFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const ids =
    config.xautToken === undefined ? [PRICE_API_IDS.paxg] : [PRICE_API_IDS.paxg, PRICE_API_IDS.xaut];
  const quotes = new Map<string, Quote>();
  let nextRequestAt = 0;
  let lastFailure: string | undefined;

  const idFor = (token: Address): string | undefined => {
    if (token === config.paxgToken) return PRICE_API_IDS.paxg;
    if (config.xautToken !== undefined && token === config.xautToken) return PRICE_API_IDS.xaut;
    return undefined;
  };

  const refresh = async (): Promise<void> => {
    if (now() < nextRequestAt) return;
    nextRequestAt = now() + HTTP_PRICE_MIN_INTERVAL_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_PRICE_TIMEOUT_MS);
    try {
      const response = await fetchPrices(`${url}?ids=${ids.join(',')}&vs_currencies=usd`, {
        signal: controller.signal,
      });
      if (response.status === 429) {
        // The public tier limits per minute; obey the header within the API's own cap.
        const wait = retryAfterMs(response.headers.get('retry-after')) ?? DEFAULT_BACKOFF_MS;
        nextRequestAt = now() + wait;
        lastFailure = `rate limited (HTTP 429); next request in ${Math.round(wait / 1000)} s`;
        return;
      }
      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`;
        return;
      }
      // The same checks the API applies before caching: a zero, negative or non-finite
      // price never becomes a quote, and an id missing from the body keeps its last one.
      const { prices } = validPrices(await response.json());
      const fetchedAt = now();
      for (const id of ids) {
        const price = parseUsdPrice(prices[id]?.usd);
        if (price !== undefined) quotes.set(id, { price, updatedAt: fetchedAt });
      }
      lastFailure = Object.keys(prices).length === 0 ? 'the response carried no usable price' : undefined;
    } catch (error) {
      lastFailure = describeError(error);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    getUsdPrice: async (token): Promise<OffChainPriceRead> => {
      const id = idFor(token);
      if (id === undefined) {
        return { ok: false, reason: `no aggregator price id for ${token}` };
      }
      await refresh();
      const quote = quotes.get(id);
      const because = lastFailure === undefined ? '' : `: ${lastFailure}`;
      if (quote === undefined) {
        return { ok: false, reason: `no ${id} price fetched yet${because}` };
      }
      const ageMs = now() - quote.updatedAt;
      if (ageMs > HTTP_PRICE_MAX_AGE_MS) {
        return {
          ok: false,
          reason: `the last ${id} price is ${Math.round(ageMs / 1000)} seconds old, older than the ${HTTP_PRICE_MAX_AGE_MS / 1000} second limit${because}`,
        };
      }
      return { ok: true, price: quote.price, updatedAt: quote.updatedAt, source: `coingecko:${id}` };
    },
  };
};
