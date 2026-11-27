import type { Request, Response } from 'express';
import {
  clientKey,
  createRateLimiter,
  IPV6_SITE_LIMIT_MULTIPLIER,
  RATE_MAP_MAX_SIZE,
  requestCost,
  siteKey,
  type RateLimiter,
} from './rateLimiter';

interface Outcome {
  passed: boolean;
  status: number;
  body: unknown;
  retryAfter: string | undefined;
}

/** Express's `req.path`: the raw URL up to the first query or fragment delimiter. */
const pathOf = (url: string): string => url.split(/[?#]/, 1)[0] ?? '';

/** A request as the limiter sees it: the client address, the raw URL tRPC would parse and a Host header. */
const request = (ip: string, path = '/a', search = '', host = 'api.example'): Request =>
  ({ ip, url: `${path}${search}`, path: pathOf(`${path}${search}`), headers: { host } }) as unknown as Request;

const hit = (limiter: RateLimiter, req: Request): Outcome => {
  const outcome: Outcome = { passed: false, status: 200, body: undefined, retryAfter: undefined };
  const res = {
    status(code: number) {
      outcome.status = code;
      return res;
    },
    json(body: unknown) {
      outcome.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      if (name === 'Retry-After') outcome.retryAfter = value;
      return res;
    },
  };
  limiter.handle(req, res as unknown as Response, () => {
    outcome.passed = true;
  });
  return outcome;
};

const batchPath = (calls: number): string => Array.from({ length: calls }, (_, i) => `proc${i}`).join(',');

describe('clientKey', () => {
  it('keys IPv4 on the address and IPv6 on the /64 prefix', () => {
    expect(clientKey('1.2.3.4')).toBe('1.2.3.4');
    expect(clientKey('2001:db8:0:0:1::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('2001:db8::2:0:0:1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('2001:db8:0:1::1')).toBe('2001:db8:0:1::/64');
    expect(clientKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
  });

  it('normalises IPv4-mapped IPv6 to the IPv4 address', () => {
    expect(clientKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(clientKey('::ffff:102:304')).toBe('1.2.3.4');
  });

  it('falls back to a fixed key for a missing address and keeps an unparseable one as is', () => {
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey('')).toBe('unknown');
    expect(clientKey('not-an-ip')).toBe('not-an-ip');
  });
});

describe('siteKey', () => {
  it('keys an IPv6 address on its /48 prefix', () => {
    expect(siteKey('2001:db8:1:2::1')).toBe('2001:db8:1::/48');
    expect(siteKey('2001:db8:1:ffff:1:2:3:4')).toBe('2001:db8:1::/48');
    expect(siteKey('2001:db8::1')).toBe('2001:db8:0::/48');
  });

  it('gives IPv4, IPv4-mapped and unparseable addresses no site bucket', () => {
    expect(siteKey('1.2.3.4')).toBeUndefined();
    expect(siteKey('::ffff:1.2.3.4')).toBeUndefined();
    expect(siteKey(undefined)).toBeUndefined();
    expect(siteKey('not-an-ip')).toBeUndefined();
  });
});

describe('requestCost', () => {
  const cost = (url: string, host = 'api.example'): number | undefined =>
    requestCost({ url, path: pathOf(url), headers: { host } } as unknown as Pick<Request, 'url' | 'path' | 'headers'>);

  it('counts one call for a plain request and every call in a tRPC batch', () => {
    expect(cost('/tokensRouter.getAll')).toBe(1);
    expect(cost('/a,b,c')).toBe(1);
    expect(cost('/a,b,c?batch=1')).toBe(3);
    expect(cost('/a?batch=1')).toBe(1);
  });

  it('counts a comma hidden as %2C, in either case, exactly as tRPC decodes it', () => {
    expect(cost('/a%2Cb%2Cc?batch=1')).toBe(3);
    expect(cost('/a%2cb%2Cc,d?batch=1')).toBe(4);
    expect(cost('/a%2Cb%2Cc')).toBe(1);
  });

  it('follows the first batch parameter, as URLSearchParams.get does in tRPC', () => {
    expect(cost('/a,b,c?batch=1&batch=0')).toBe(3);
    expect(cost('/a,b,c?batch=0&batch=1')).toBe(1);
    expect(cost('/a,b,c?input=%7B%7D&batch=1')).toBe(3);
    expect(cost('/a,b,c?batch[]=1')).toBe(1);
  });

  it('counts a path whose escapes do not decode by its raw separators', () => {
    expect(cost('/a,b%2Cc%?batch=1')).toBe(3);
  });

  it('ends the query string at a fragment marker, because the adapter builds a URL', () => {
    expect(cost('/a,b,c,d?batch=1#x')).toBe(4);
    expect(cost('/a,b,c,d?batch=1&input=1#')).toBe(4);
    expect(cost('/a,b,c,d#?batch=1')).toBe(1);
    expect(cost('/a,b,c,d?x=1#&batch=1')).toBe(1);
  });

  it('lets a Host header that opens a query string switch batching on, as the adapter would', () => {
    expect(cost('/a,b,c,d', 'x?batch=1&y=')).toBe(4);
    expect(cost('/a,b,c,d', 'x?batch=1')).toBe(1);
    expect(cost('/a,b,c,d?batch=1', 'x#')).toBe(1);
  });

  it('refuses what the adapter could not turn into a URL', () => {
    expect(cost('http://evil.example/a')).toBeUndefined();
    expect(cost('*')).toBeUndefined();
    expect(cost('/a', 'bad host')).toBeUndefined();
    expect(cost('/a', 'x:notaport')).toBeUndefined();
    expect(cost('/a', '[')).toBeUndefined();
  });
});

describe('createRateLimiter', () => {
  const limiters: RateLimiter[] = [];
  const make = (options: Parameters<typeof createRateLimiter>[0]): RateLimiter => {
    const limiter = createRateLimiter(options);
    limiters.push(limiter);
    return limiter;
  };
  afterEach(() => {
    limiters.splice(0).forEach((limiter) => limiter.dispose());
  });

  it('admits up to the limit per window and answers 429 with Retry-After beyond it', () => {
    let clock = 1_000_000;
    const limiter = make({ maxRequests: 2, now: () => clock });
    expect(hit(limiter, request('1.2.3.4')).passed).toBe(true);
    expect(hit(limiter, request('1.2.3.4')).passed).toBe(true);
    const limited = hit(limiter, request('1.2.3.4'));
    expect(limited).toMatchObject({ passed: false, status: 429, body: { error: 'Too many requests' }, retryAfter: '60' });
    clock += 60_000;
    expect(hit(limiter, request('1.2.3.4')).passed).toBe(true);
  });

  it('two addresses in one IPv6 /64 share a bucket, and an IPv4-mapped address shares the IPv4 bucket', () => {
    const limiter = make({ maxRequests: 1 });
    expect(hit(limiter, request('2001:db8:0:0:1::1')).passed).toBe(true);
    expect(hit(limiter, request('2001:db8::2:0:0:1')).status).toBe(429);
    expect(hit(limiter, request('2001:db8:0:1::1')).passed).toBe(true);
    expect(hit(limiter, request('1.2.3.4')).passed).toBe(true);
    expect(hit(limiter, request('::ffff:1.2.3.4')).status).toBe(429);
  });

  describe('an IPv6 /48 shares a coarser bucket', () => {
    /** The i-th /64 inside one /48. */
    const inSite = (site: string, i: number): string => `${site}:${i.toString(16)}::1`;

    it('caps a host rotating through the /64s of one /48 at the site limit', () => {
      const limiter = make({ maxRequests: 2 });
      const siteLimit = 2 * IPV6_SITE_LIMIT_MULTIPLIER;
      const outcomes = Array.from({ length: siteLimit + 8 }, (_, i) => hit(limiter, request(inSite('2001:db8:1', i))));
      expect(outcomes.filter((outcome) => outcome.passed)).toHaveLength(siteLimit);
      expect(outcomes.slice(siteLimit).every((outcome) => outcome.status === 429)).toBe(true);
      // Another /48 is untouched.
      expect(hit(limiter, request(inSite('2001:db8:2', 0))).passed).toBe(true);
    });

    it('keeps the per-/64 limit inside a /48 that still has room', () => {
      const limiter = make({ maxRequests: 2 });
      expect(hit(limiter, request('2001:db8:1:5::1')).passed).toBe(true);
      expect(hit(limiter, request('2001:db8:1:5::2')).passed).toBe(true);
      expect(hit(limiter, request('2001:db8:1:5::3')).status).toBe(429);
      expect(hit(limiter, request('2001:db8:1:6::1')).passed).toBe(true);
    });

    it('counts a refused request against neither bucket', () => {
      const limiter = make({ maxRequests: 2, maxRequestsPerSite: 4 });
      hit(limiter, request('2001:db8:1:5::1'));
      hit(limiter, request('2001:db8:1:5::1'));
      for (let i = 0; i < 10; i++) expect(hit(limiter, request('2001:db8:1:5::1')).status).toBe(429);
      // Two of the site's four are spent; the refusals took none.
      expect(hit(limiter, request('2001:db8:1:6::1')).passed).toBe(true);
      expect(hit(limiter, request('2001:db8:1:7::1')).passed).toBe(true);
      expect(hit(limiter, request('2001:db8:1:8::1')).status).toBe(429);
    });

    it('answers a site refusal with the site window in Retry-After', () => {
      let clock = 1_000_000;
      const limiter = make({ maxRequests: 5, maxRequestsPerSite: 1, now: () => clock });
      expect(hit(limiter, request('2001:db8:1:1::1')).passed).toBe(true);
      clock += 20_000;
      expect(hit(limiter, request('2001:db8:1:2::1'))).toMatchObject({ status: 429, retryAfter: '40' });
    });

    it('leaves IPv4 clients with their single bucket', () => {
      const limiter = make({ maxRequests: 1, maxRequestsPerSite: 1 });
      expect(hit(limiter, request('1.2.3.4')).passed).toBe(true);
      expect(hit(limiter, request('1.2.3.5')).passed).toBe(true);
    });
  });

  it('100,000 distinct clients inside one window take bounded time and bounded memory', () => {
    const limiter = make({ maxRequests: 120 });
    const started = process.hrtime.bigint();
    for (let i = 0; i < 100_000; i++) {
      hit(limiter, request(`10.${(i >> 16) & 0xff}.${(i >> 8) & 0xff}.${i & 0xff}`));
    }
    const elapsedMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(limiter.size()).toBeLessThanOrEqual(RATE_MAP_MAX_SIZE);
  });

  it('evicts the oldest window first when the map is full', () => {
    let clock = 0;
    const limiter = make({ maxRequests: 1, maxKeys: 2, now: () => clock });
    hit(limiter, request('10.0.0.1'));
    clock += 10;
    hit(limiter, request('10.0.0.2'));
    clock += 10;
    hit(limiter, request('10.0.0.3'));
    expect(limiter.size()).toBe(2);
    expect(hit(limiter, request('10.0.0.1')).passed).toBe(true);
    expect(hit(limiter, request('10.0.0.3')).status).toBe(429);
  });

  it('prunes expired windows off the request path', () => {
    let clock = 0;
    const limiter = make({ maxRequests: 5, now: () => clock });
    hit(limiter, request('10.0.0.1'));
    hit(limiter, request('10.0.0.2'));
    clock += 60_000;
    hit(limiter, request('10.0.0.3'));
    expect(limiter.size()).toBe(3);
    limiter.prune();
    expect(limiter.size()).toBe(1);
  });

  describe('tRPC batches', () => {
    it('counts every call in a batch against the limit', () => {
      const limiter = make({ maxRequests: 15 });
      expect(hit(limiter, request('1.2.3.4', `/${batchPath(10)}`, '?batch=1')).passed).toBe(true);
      expect(hit(limiter, request('1.2.3.4', `/${batchPath(10)}`, '?batch=1')).status).toBe(429);
      expect(hit(limiter, request('1.2.3.4', `/${batchPath(5)}`, '?batch=1')).passed).toBe(true);
    });

    it('cannot be sidestepped with an encoded comma or a repeated batch parameter', () => {
      const limiter = make({ maxRequests: 1_000 });
      const encoded = batchPath(50).replace(/,/g, '%2C');
      expect(hit(limiter, request('1.2.3.4', `/${encoded}`, '?batch=1')).status).toBe(400);
      expect(hit(limiter, request('1.2.3.4', `/${batchPath(50)}`, '?batch=1&batch=0')).status).toBe(400);
      expect(limiter.size()).toBe(0);
    });

    it('counts a batch whose query string ends in a fragment, and one opened by the Host header', () => {
      const limiter = make({ maxRequests: 1_000 });
      expect(hit(limiter, request('1.2.3.4', `/${batchPath(50)}`, '?batch=1#x')).status).toBe(400);
      expect(hit(limiter, request('1.2.3.4', `/${batchPath(50)}`, '', 'x?batch=1&y=')).status).toBe(400);
      expect(limiter.size()).toBe(0);
    });

    it('answers 400 to a request the adapter could not parse, without counting it', () => {
      const limiter = make({ maxRequests: 1_000 });
      const absolute = hit(limiter, request('1.2.3.4', 'http://evil.example/a'));
      expect(absolute).toMatchObject({ passed: false, status: 400, body: { error: 'Malformed request' } });
      expect(hit(limiter, request('1.2.3.4', '/a', '', 'bad host')).status).toBe(400);
      expect(limiter.size()).toBe(0);
    });

    it('rejects an oversized batch with a clear error before it reaches tRPC', () => {
      const limiter = make({ maxRequests: 1_000 });
      const rejected = hit(limiter, request('1.2.3.4', `/${batchPath(50)}`, '?batch=1'));
      expect(rejected).toMatchObject({ passed: false, status: 400, body: { error: 'Batch too large: at most 20 calls per request' } });
      expect(limiter.size()).toBe(0);
      expect(hit(limiter, request('1.2.3.4', `/${batchPath(20)}`, '?batch=1')).passed).toBe(true);
    });
  });
});
