import { getAddress } from 'viem';
import {
  createHttpOffChainPriceSource,
  DEFAULT_PRICE_API_URL,
  HTTP_PRICE_MAX_AGE_MS,
  HTTP_PRICE_MIN_INTERVAL_MS,
} from './httpOffChainPrices';
import type { PriceFetch } from './httpOffChainPrices';

const PAXG = getAddress('0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9');
const XAUT = getAddress('0xdc64a140aa3e981100a9beca4e685f962f0cf6c9');
const OTHER = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');
const T0 = 1_800_000_000_000;

type Reply = { status: number; body?: unknown; retryAfter?: string } | Error;

/** A fetch that answers from a queue of replies and records every request it saw. */
const createFetch = (replies: Reply[]) => {
  const requests: { url: string; signal: AbortSignal }[] = [];
  const fetchStub: PriceFetch = async (url, init) => {
    requests.push({ url, signal: init.signal });
    const reply = replies.shift() ?? { status: 200, body: {} };
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? reply.retryAfter ?? null : null) },
      json: async () => reply.body,
    };
  };
  return { fetchStub, requests };
};

const prices = { 'pax-gold': { usd: 3926.71 }, 'tether-gold': { usd: 3920.5 } };

describe('createHttpOffChainPriceSource', () => {
  it('fetches both ids in one request and answers each token from it', async () => {
    const clock = { now: T0 };
    const { fetchStub, requests } = createFetch([{ status: 200, body: prices }]);
    const source = createHttpOffChainPriceSource({ paxgToken: PAXG, xautToken: XAUT }, { fetch: fetchStub, now: () => clock.now });

    await expect(source.getUsdPrice(PAXG)).resolves.toEqual({
      ok: true,
      price: 392_671_000_000n,
      updatedAt: T0,
      source: 'coingecko:pax-gold',
    });
    await expect(source.getUsdPrice(XAUT)).resolves.toMatchObject({ ok: true, price: 392_050_000_000n, source: 'coingecko:tether-gold' });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${DEFAULT_PRICE_API_URL}?ids=pax-gold,tether-gold&vs_currencies=usd`);
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks for PAXG alone while XAUT is dormant, and knows no other token', async () => {
    const { fetchStub, requests } = createFetch([{ status: 200, body: prices }]);
    const source = createHttpOffChainPriceSource({ paxgToken: PAXG, xautToken: undefined }, { fetch: fetchStub, now: () => T0 });

    await expect(source.getUsdPrice(OTHER)).resolves.toEqual({ ok: false, reason: `no aggregator price id for ${OTHER}` });
    await expect(source.getUsdPrice(PAXG)).resolves.toMatchObject({ ok: true });
    expect(requests[0]?.url).toContain('ids=pax-gold&');
    expect(requests).toHaveLength(1);
  });

  it('makes one request per window and refreshes once the window has passed', async () => {
    const clock = { now: T0 };
    const { fetchStub, requests } = createFetch([
      { status: 200, body: prices },
      { status: 200, body: { 'pax-gold': { usd: 4000 } } },
    ]);
    const source = createHttpOffChainPriceSource({ paxgToken: PAXG, xautToken: undefined }, { fetch: fetchStub, now: () => clock.now });

    await source.getUsdPrice(PAXG);
    clock.now += HTTP_PRICE_MIN_INTERVAL_MS - 1;
    await expect(source.getUsdPrice(PAXG)).resolves.toMatchObject({ price: 392_671_000_000n, updatedAt: T0 });
    expect(requests).toHaveLength(1);

    clock.now += 1;
    await expect(source.getUsdPrice(PAXG)).resolves.toMatchObject({ price: 400_000_000_000n, updatedAt: clock.now });
    expect(requests).toHaveLength(2);
  });

  it('keeps the last good price through a failed request until it is older than the limit', async () => {
    const clock = { now: T0 };
    const { fetchStub } = createFetch([{ status: 200, body: prices }, new Error('fetch failed'), new Error('fetch failed')]);
    const source = createHttpOffChainPriceSource({ paxgToken: PAXG, xautToken: undefined }, { fetch: fetchStub, now: () => clock.now });

    await source.getUsdPrice(PAXG);
    clock.now += HTTP_PRICE_MIN_INTERVAL_MS;
    await expect(source.getUsdPrice(PAXG)).resolves.toMatchObject({ ok: true, price: 392_671_000_000n, updatedAt: T0 });

    clock.now = T0 + HTTP_PRICE_MAX_AGE_MS + 1;
    const stale = await source.getUsdPrice(PAXG);
    expect(stale.ok).toBe(false);
    expect(!stale.ok && stale.reason).toContain('older than the 600 second limit');
    expect(!stale.ok && stale.reason).toContain('fetch failed');
  });

  it('backs off after a 429 for the Retry-After it was given, and says why there is no price', async () => {
    const clock = { now: T0 };
    const { fetchStub, requests } = createFetch([{ status: 429, retryAfter: '120' }, { status: 200, body: prices }]);
    const source = createHttpOffChainPriceSource({ paxgToken: PAXG, xautToken: undefined }, { fetch: fetchStub, now: () => clock.now });

    const limited = await source.getUsdPrice(PAXG);
    expect(limited).toEqual({ ok: false, reason: 'no pax-gold price fetched yet: rate limited (HTTP 429); next request in 120 s' });

    clock.now += 119_000;
    await source.getUsdPrice(PAXG);
    expect(requests).toHaveLength(1);

    clock.now += 1_000;
    await expect(source.getUsdPrice(PAXG)).resolves.toMatchObject({ ok: true });
    expect(requests).toHaveLength(2);
  });

  it('never turns an unusable body into a quote', async () => {
    const { fetchStub } = createFetch([{ status: 200, body: { 'pax-gold': { usd: 0 } } }]);
    const source = createHttpOffChainPriceSource({ paxgToken: PAXG, xautToken: undefined }, { fetch: fetchStub, now: () => T0 });

    await expect(source.getUsdPrice(PAXG)).resolves.toEqual({
      ok: false,
      reason: 'no pax-gold price fetched yet: the response carried no usable price',
    });
  });

  it('reports a non-2xx status as the reason', async () => {
    const { fetchStub } = createFetch([{ status: 503 }]);
    const source = createHttpOffChainPriceSource({ paxgToken: PAXG, xautToken: undefined }, { fetch: fetchStub, now: () => T0 });

    await expect(source.getUsdPrice(PAXG)).resolves.toEqual({ ok: false, reason: 'no pax-gold price fetched yet: HTTP 503' });
  });
});
