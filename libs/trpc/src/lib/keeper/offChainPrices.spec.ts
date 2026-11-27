import { getAddress } from 'viem';
import { PRICES_CACHE_KEY, PRICES_UPDATED_AT_CACHE_KEY } from '../jobs/priceCacheKeys';
import {
  createCachedOffChainPriceSource,
  OFF_CHAIN_PRICE_MAX_AGE_MS,
  parseUsdPrice,
} from './offChainPrices';
import type { PriceCacheStore } from './offChainPrices';

const PAXG = getAddress('0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9');
const XAUT = getAddress('0xdc64a140aa3e981100a9beca4e685f962f0cf6c9');
const OTHER = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
const NOW = 1_800_000_000_000;

const storeOf = (entries: Record<string, unknown>): PriceCacheStore => ({
  get: async (key) => entries[key],
});

const fresh = (prices: unknown): PriceCacheStore =>
  storeOf({ [PRICES_CACHE_KEY]: prices, [PRICES_UPDATED_AT_CACHE_KEY]: NOW - 60_000 });

const source = (store: PriceCacheStore, options: { xautUnset?: boolean } = {}) =>
  createCachedOffChainPriceSource(
    { paxgToken: PAXG, xautToken: options.xautUnset === true ? undefined : XAUT },
    store,
    () => NOW
  );

describe('parseUsdPrice', () => {
  it('scales numbers and decimal strings to eight decimals', () => {
    expect(parseUsdPrice(4012.35)).toBe(401_235_000_000n);
    expect(parseUsdPrice('4012.123456789')).toBe(401_212_345_678n);
    expect(parseUsdPrice(4000)).toBe(400_000_000_000n);
  });

  it('refuses anything that is not a positive plain decimal', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1e3', 'abc', null, undefined, {}]) {
      expect(parseUsdPrice(value)).toBeUndefined();
    }
  });
});

describe('createCachedOffChainPriceSource', () => {
  it('reads the API cache entry for each token by its price id', async () => {
    const prices = fresh({ 'pax-gold': { usd: 4010 }, 'tether-gold': { usd: '3990.5' } });

    await expect(source(prices).getUsdPrice(PAXG)).resolves.toEqual({
      ok: true,
      price: 401_000_000_000n,
      updatedAt: NOW - 60_000,
      source: 'api-cache:pax-gold',
    });
    await expect(source(prices).getUsdPrice(XAUT)).resolves.toMatchObject({
      ok: true,
      price: 399_050_000_000n,
    });
  });

  it('answers not ok, with a reason, when the entry is missing', async () => {
    const result = await source(fresh({ 'tether-gold': { usd: 3990 } })).getUsdPrice(PAXG);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('pax-gold');
  });

  it('refuses a quote with no timestamp or one older than the maximum age', async () => {
    const untimed = storeOf({ [PRICES_CACHE_KEY]: { 'pax-gold': { usd: 4000 } } });
    expect((await source(untimed).getUsdPrice(PAXG)).ok).toBe(false);

    const stale = storeOf({
      [PRICES_CACHE_KEY]: { 'pax-gold': { usd: 4000 } },
      [PRICES_UPDATED_AT_CACHE_KEY]: NOW - OFF_CHAIN_PRICE_MAX_AGE_MS - 1,
    });
    const result = await source(stale).getUsdPrice(PAXG);
    expect(result.ok === false && result.reason).toContain('old');
  });

  it('answers not ok for a token it has no price id for, or an unset XAUT', async () => {
    const prices = fresh({ 'pax-gold': { usd: 4000 }, 'tether-gold': { usd: 4000 } });
    expect((await source(prices).getUsdPrice(OTHER)).ok).toBe(false);
    expect((await source(prices, { xautUnset: true }).getUsdPrice(XAUT)).ok).toBe(false);
  });

  it('turns a cache failure into a reason instead of throwing', async () => {
    const broken: PriceCacheStore = {
      get: async () => {
        throw new Error('Redis unavailable');
      },
    };
    const result = await source(broken).getUsdPrice(PAXG);
    expect(result.ok === false && result.reason).toContain('Redis unavailable');
  });
});
