import axios, { isAxiosError } from 'axios';
import { TOKEN_LIST } from '@goldstandard/constants';
import { cache } from '../config/cacheManager';
import { PRICES_CACHE_KEY, PRICES_UPDATED_AT_CACHE_KEY } from './priceCacheKeys';
import { retryAfterMs, servablePrices, validPrices } from './priceResponse';

export interface PriceRecord {
    usd: string;
}

const BACKOFF_KEY = 'prices:backoffUntil';
/** Fallback hold after a 429 without a Retry-After header. CoinGecko's public tier is per minute. */
const DEFAULT_BACKOFF_MS = 60_000;

/**
 * Fetches spot prices into the cache. The market price is display-only in the dapp
 * (every contract decision prices at the oracle), so a failed refresh must never do
 * more than keep the last cached quote a little longer: fetchCachedPrices stops serving
 * it after PRICES_MAX_AGE_MS. A 429 sets a back-off so the
 * scheduler stops hammering the provider, and an error logs as one line rather than
 * the whole AxiosError, which used to dump several hundred lines per miss.
 */
export const fetchAndUpdatePrices = async (): Promise<void> => {
    // cache.get resolves null on a miss (and undefined on a store error, swallowed here).
    const backoffUntil = await cache.get<number>(BACKOFF_KEY).catch(() => undefined);
    if (typeof backoffUntil === 'number' && Date.now() < backoffUntil) {
        return;
    }
    console.log('Fetching prices at:', new Date().toLocaleTimeString());
    const priceIds = TOKEN_LIST.map((token) => token.priceApiId).join(',');

    try {
        const response = await axios.get(
            `https://api.coingecko.com/api/v3/simple/price?ids=${priceIds}&vs_currencies=usd`,
            { timeout: 10_000 }
        );
        // A zero, negative or non-finite price never reaches the
        // cache the dapp shows and the keeper's watchdog reads; a body with no usable price
        // leaves the last good quote, and its age, in place.
        const { prices, rejected } = validPrices(response.data);
        if (rejected.length > 0) {
            console.error(`Price fetch returned unusable prices for ${rejected.join(', ')}; not cached`);
        }
        if (Object.keys(prices).length === 0) {
            return;
        }
        await cache.set(PRICES_CACHE_KEY, prices);
        // The keeper's price watchdog compares on-chain prices with this quote and must
        // be able to tell a fresh one from a quote left behind by a stopped refresh.
        await cache.set(PRICES_UPDATED_AT_CACHE_KEY, Date.now());
        console.log('Prices updated:', prices);
    } catch (error) {
        if (isAxiosError(error)) {
            const status = error.response?.status;
            const holdMs =
                status === 429 ? retryAfterMs(error.response?.headers?.['retry-after']) ?? DEFAULT_BACKOFF_MS : 0;
            if (holdMs > 0) {
                await cache.set(BACKOFF_KEY, Date.now() + holdMs, holdMs).catch(() => undefined);
            }
            console.error(
                `Price fetch failed: ${status ?? error.code ?? 'network'} ${error.message}` +
                    (holdMs > 0 ? `; backing off ${Math.round(holdMs / 1000)}s, serving cached prices` : '')
            );
            return;
        }
        console.error('Price fetch failed:', error instanceof Error ? error.message : String(error));
    }
};

/** A cached price as the route serves it: the quote and the time it was fetched, in ms since the epoch. */
export interface QuotedPriceRecord extends PriceRecord {
    updatedAt: number;
}

/** The requested quotes, or {} on a miss or once the quote is older than PRICES_MAX_AGE_MS. */
export const fetchCachedPrices = async (priceIds: string[]): Promise<Record<string, QuotedPriceRecord>> => {
    try {
        const [cachedPrices, updatedAt] = await Promise.all([
            cache.get<Record<string, PriceRecord>>(PRICES_CACHE_KEY),
            cache.get<number>(PRICES_UPDATED_AT_CACHE_KEY),
        ]);
        if (!cachedPrices) {
            console.log('No cached prices found');
            return {};
        }
        return servablePrices(cachedPrices, updatedAt, priceIds, Date.now());
    } catch (error) {
        console.error('Error fetching cached prices:', error);
        return {};
    }
};
