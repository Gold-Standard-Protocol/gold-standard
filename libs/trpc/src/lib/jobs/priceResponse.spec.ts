import { OFF_CHAIN_PRICE_MAX_AGE_MS } from '../keeper/offChainPrices';
import { PRICES_MAX_AGE_MS } from './priceCacheKeys';
import { MAX_BACKOFF_MS, retryAfterMs, servablePrices, validPrices } from './priceResponse';

describe('retryAfterMs', () => {
  it('reads a Retry-After in seconds', () => {
    expect(retryAfterMs('30')).toBe(30_000);
    expect(retryAfterMs(45)).toBe(45_000);
  });

  it('caps a long Retry-After at a few minutes so the prices never go stale for a day', () => {
    expect(MAX_BACKOFF_MS).toBe(5 * 60_000);
    expect(retryAfterMs('86400')).toBe(MAX_BACKOFF_MS);
    expect(retryAfterMs(1e12)).toBe(MAX_BACKOFF_MS);
  });

  it.each([undefined, null, '', 'soon', '0', '-5', 'Infinity', Number.NaN, {}])(
    'ignores a Retry-After of %p',
    (header) => {
      expect(retryAfterMs(header)).toBeUndefined();
    }
  );
});

describe('validPrices', () => {
  it('keeps every finite positive price', () => {
    const result = validPrices({ 'pax-gold': { usd: 2650.12 }, 'tether-gold': { usd: 2641 } });
    expect(result).toEqual({
      prices: { 'pax-gold': { usd: 2650.12 }, 'tether-gold': { usd: 2641 } },
      rejected: [],
    });
  });

  it('drops a zero, negative, non-finite or non-numeric price before it is cached', () => {
    const result = validPrices({
      'pax-gold': { usd: 2650.12 },
      'tether-gold': { usd: 0 },
      'usd-coin': { usd: -1 },
      tether: { usd: Number.POSITIVE_INFINITY },
      dai: { usd: '1.00' },
      weth: {},
      wbtc: null,
    });
    expect(result.prices).toEqual({ 'pax-gold': { usd: 2650.12 } });
    expect(result.rejected.sort()).toEqual(['dai', 'tether', 'tether-gold', 'usd-coin', 'wbtc', 'weth']);
  });

  it.each([null, undefined, 'error', 42, []])('accepts nothing from a body of %p', (body) => {
    expect(validPrices(body).prices).toEqual({});
  });
});

describe('servablePrices', () => {
  const NOW = 1_800_000_000_000;
  const cached = { 'pax-gold': { usd: 4012.5 }, 'tether-gold': { usd: 3998 }, bitcoin: { usd: 1 } };

  it('matches the keeper watchdog limit, so the dapp and the keeper agree on what is too old', () => {
    expect(PRICES_MAX_AGE_MS).toBe(15 * 60 * 1000);
    expect(OFF_CHAIN_PRICE_MAX_AGE_MS).toBe(PRICES_MAX_AGE_MS);
  });

  it('serves the requested ids, each stamped with the time the quote was fetched', () => {
    const updatedAt = NOW - 30_000;
    expect(servablePrices(cached, updatedAt, ['pax-gold', 'tether-gold'], NOW)).toEqual({
      'pax-gold': { usd: 4012.5, updatedAt },
      'tether-gold': { usd: 3998, updatedAt },
    });
  });

  it('still serves a quote exactly at the limit', () => {
    expect(servablePrices(cached, NOW - PRICES_MAX_AGE_MS, ['pax-gold'], NOW)).toEqual({
      'pax-gold': { usd: 4012.5, updatedAt: NOW - PRICES_MAX_AGE_MS },
    });
  });

  it('serves nothing once the refresh has stopped for longer than the limit, rather than a frozen quote shown as live', () => {
    expect(servablePrices(cached, NOW - PRICES_MAX_AGE_MS - 1, ['pax-gold'], NOW)).toEqual({});
    expect(servablePrices(cached, NOW - 3 * 24 * 60 * 60 * 1000, ['pax-gold', 'tether-gold'], NOW)).toEqual({});
  });

  it.each([undefined, null, 'yesterday', Number.NaN, Number.POSITIVE_INFINITY])(
    'serves nothing when the quote carries no usable timestamp (%p), since its age is unknown',
    (updatedAt) => {
      expect(servablePrices(cached, updatedAt, ['pax-gold'], NOW)).toEqual({});
    }
  );

  it('serves nothing on a cache miss', () => {
    expect(servablePrices(null, NOW, ['pax-gold'], NOW)).toEqual({});
    expect(servablePrices(undefined, NOW, ['pax-gold'], NOW)).toEqual({});
  });
});
