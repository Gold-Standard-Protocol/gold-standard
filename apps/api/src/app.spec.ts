import { createServer, request as httpRequest, type Server } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { initTRPC } from '@trpc/server';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { createApp, type Api, type AppOptions } from './app';

const DAPP_HEADERS = join(__dirname, '../../dapp/public/_headers');
const batchPath = (calls: number): string => Array.from({ length: calls }, (_, i) => `proc${i}`).join(',');

/** A real tRPC router, because the rate limiter has to agree with the adapter about what a request is. */
const t = initTRPC.create();
const realTrpc = createExpressMiddleware({
  router: t.router({ a: t.procedure.query(() => 'a'), b: t.procedure.query(() => 'b'), c: t.procedure.query(() => 'c') }),
});

/** A request sent exactly as written: fetch would tidy the target, drop a fragment and refuse a bad Host. */
const rawGet = (base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: new URL(base).port, method: 'GET', path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });

/** The API process shape: tRPC behind a rate limit, and the dapp build beside it in production. */
describe('createApp', () => {
  const trpc = (req: Request, res: Response): void => {
    res.json({ ok: true, path: req.path });
  };
  let dist: string;
  let servers: Server[] = [];
  const apis: Api[] = [];

  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), 'gsusd-dapp-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>gsUSD</title>');
    copyFileSync(DAPP_HEADERS, join(dist, '_headers'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log("bundle")');
    for (const folder of ['abi', 'fonts', 'images']) mkdirSync(join(dist, folder));
    writeFileSync(join(dist, 'abi', 'Present.json'), '{"abi":[]}');
    writeFileSync(join(dist, 'fonts', 'present.woff2'), 'font');
    writeFileSync(join(dist, 'images', 'present.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    mkdirSync(join(dist, '.well-known'));
    writeFileSync(join(dist, '.well-known', 'security.txt'), 'Contact: mailto:security@goldstandard.finance\n');
    writeFileSync(join(dist, '.env'), 'SECRET=1\n');
  });

  afterEach(async () => {
    apis.splice(0).forEach((api) => api.dispose());
    await Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));
    servers = [];
  });

  async function listen(options: AppOptions): Promise<string> {
    const api = createApp(options);
    apis.push(api);
    const server = createServer(api.app);
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('serves the shell for the root and for client-side routes, uncached', async () => {
    const base = await listen({ trpc, dappDist: dist });
    for (const path of ['/', '/vault', '/liquidations/0xabc']) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('gsUSD');
    }
  });

  it('serves hashed bundles as immutable and keeps a missing bundle a 404', async () => {
    const base = await listen({ trpc, dappDist: dist });
    const bundle = await fetch(`${base}/assets/app-abc123.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await bundle.text()).toContain('bundle');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  });

  it('never marks a 404 under assets/ immutable, so a chunk missing mid-deploy is fetched again once it is back', async () => {
    const base = await listen({ trpc, dappDist: dist });
    // The last one is refused by denyForbiddenPaths, the others fall through express.static.
    for (const path of ['/assets/missing.js', '/assets/missing', '/assets/.hidden.js']) {
      const res = await fetch(base + path);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });

  it('answers a missing ABI, font, image or other file with a 404 instead of the shell', async () => {
    const base = await listen({ trpc, dappDist: dist });
    for (const path of ['/abi/Removed.json', '/fonts/missing.woff2', '/images/missing.png', '/missing.json', '/favicon.ico']) {
      const res = await fetch(base + path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('<title>gsUSD</title>');
    }
  });

  it('keeps a 404 for an extensionless path under the asset folders', async () => {
    const base = await listen({ trpc, dappDist: dist });
    for (const path of ['/abi/Removed', '/fonts/missing', '/images/missing', '/abi/', '/assets/missing']) {
      const res = await fetch(base + path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('<title>gsUSD</title>');
    }
  });

  it('still serves real files from the asset folders and the shell for client routes', async () => {
    const base = await listen({ trpc, dappDist: dist });
    expect(await (await fetch(`${base}/abi/Present.json`)).json()).toEqual({ abi: [] });
    expect(await (await fetch(`${base}/fonts/present.woff2`)).text()).toBe('font');
    expect((await fetch(`${base}/images/present.svg`)).status).toBe(200);
    for (const path of ['/', '/vault', '/vault/liquidate', '/docs/introduction']) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('<title>gsUSD</title>');
    }
  });

  it('keeps /trpc on the tRPC handler and non-GET requests off the shell', async () => {
    const base = await listen({ trpc, dappDist: dist });
    const res = await fetch(`${base}/trpc/tokensRouter.getAll`);
    expect(await res.json()).toEqual({ ok: true, path: '/tokensRouter.getAll' });
    expect((await fetch(`${base}/vault`, { method: 'POST' })).status).toBe(404);
  });

  it('serves only the tRPC surface without a dapp build', async () => {
    const base = await listen({ trpc });
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/trpc/health`)).status).toBe(200);
  });

  describe('response headers when the API serves the dapp', () => {
    it('sends the _headers set on the shell and on bundles, without X-Powered-By or HSTS over plain HTTP', async () => {
      const base = await listen({ trpc, dappDist: dist });
      for (const path of ['/', '/vault', '/assets/app-abc123.js']) {
        const res = await fetch(base + path);
        expect(res.headers.get('x-powered-by')).toBeNull();
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
        // Only the Safe web app may frame the dapp; X-Frame-Options cannot name an origin.
        expect(res.headers.get('content-security-policy')).toContain('frame-ancestors https://app.safe.global;');
        expect(res.headers.get('x-frame-options')).toBeNull();
        expect(res.headers.get('strict-transport-security')).toBeNull();
      }
    });

    it('sends HSTS once the request arrived over TLS at a trusted proxy', async () => {
      const base = await listen({ trpc, dappDist: dist, trustProxyHops: 1 });
      const res = await fetch(`${base}/`, { headers: { 'x-forwarded-proto': 'https' } });
      expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
      const untrusted = await listen({ trpc, dappDist: dist });
      const plain = await fetch(`${untrusted}/`, { headers: { 'x-forwarded-proto': 'https' } });
      expect(plain.headers.get('strict-transport-security')).toBeNull();
    });

    it('serves security.txt but never _headers or a dotfile', async () => {
      const base = await listen({ trpc, dappDist: dist });
      const securityTxt = await fetch(`${base}/.well-known/security.txt`);
      expect(securityTxt.status).toBe(200);
      expect(securityTxt.headers.get('content-type')).toContain('text/plain');
      expect(await securityTxt.text()).toContain('security@goldstandard.finance');
      expect((await fetch(`${base}/.well-known/missing.txt`)).status).toBe(404);
      for (const path of ['/_headers', '/.env', '/%2eenv', '/assets/../_headers']) {
        const res = await fetch(base + path);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain('Content-Security-Policy');
      }
    });

    it('omits X-Powered-By and sends nosniff on the tRPC surface alone too', async () => {
      const base = await listen({ trpc });
      const res = await fetch(`${base}/trpc/a`);
      expect(res.headers.get('x-powered-by')).toBeNull();
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('sends HSTS on the tRPC surface over TLS, its own host or beside the dapp, and a 429 too', async () => {
      for (const options of [{ trpc }, { trpc, dappDist: dist }]) {
        const base = await listen({ ...options, trustProxyHops: 1, rateMaxRequests: 1 });
        const tls = { headers: { 'x-forwarded-proto': 'https' } };
        const first = await fetch(`${base}/trpc/a`, tls);
        expect(first.status).toBe(200);
        expect(first.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
        const limited = await fetch(`${base}/trpc/a`, tls);
        expect(limited.status).toBe(429);
        expect(limited.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
      }
      const plain = await listen({ trpc, trustProxyHops: 1 });
      expect((await fetch(`${plain}/trpc/a`)).headers.get('strict-transport-security')).toBeNull();
    });
  });

  describe('rate limiting', () => {
    it('rate limits the tRPC surface per client', async () => {
      const base = await listen({ trpc, rateMaxRequests: 2 });
      expect((await fetch(`${base}/trpc/a`)).status).toBe(200);
      expect((await fetch(`${base}/trpc/a`)).status).toBe(200);
      const limited = await fetch(`${base}/trpc/a`);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
      expect(await limited.json()).toEqual({ error: 'Too many requests' });
    });

    it('keys on the forwarded client behind the configured hops and on the peer otherwise', async () => {
      const trusted = await listen({ trpc, rateMaxRequests: 1, trustProxyHops: 1 });
      expect((await fetch(`${trusted}/trpc/a`, { headers: { 'x-forwarded-for': '203.0.113.1' } })).status).toBe(200);
      expect((await fetch(`${trusted}/trpc/a`, { headers: { 'x-forwarded-for': '203.0.113.1' } })).status).toBe(429);
      expect((await fetch(`${trusted}/trpc/a`, { headers: { 'x-forwarded-for': '203.0.113.2' } })).status).toBe(200);
      const untrusted = await listen({ trpc, rateMaxRequests: 1 });
      expect((await fetch(`${untrusted}/trpc/a`, { headers: { 'x-forwarded-for': '203.0.113.1' } })).status).toBe(200);
      expect((await fetch(`${untrusted}/trpc/a`, { headers: { 'x-forwarded-for': '203.0.113.2' } })).status).toBe(429);
    });

    it('counts each batched call and rejects an oversized batch', async () => {
      const base = await listen({ trpc, rateMaxRequests: 15 });
      const tooLarge = await fetch(`${base}/trpc/${batchPath(50)}?batch=1`);
      expect(tooLarge.status).toBe(400);
      expect(await tooLarge.json()).toEqual({ error: 'Batch too large: at most 20 calls per request' });
      expect((await fetch(`${base}/trpc/${batchPath(10)}?batch=1`)).status).toBe(200);
      expect((await fetch(`${base}/trpc/${batchPath(10)}?batch=1`)).status).toBe(429);
    });

    it('an encoded comma or a repeated batch parameter does not hide a large batch', async () => {
      const base = await listen({ trpc, rateMaxRequests: 1_000 });
      expect((await fetch(`${base}/trpc/${batchPath(50).replace(/,/g, '%2C')}?batch=1`)).status).toBe(400);
      expect((await fetch(`${base}/trpc/${batchPath(50)}?batch=1&batch=0`)).status).toBe(400);
    });

    it('counts a batch exactly as the tRPC adapter reads it: fragment, Host header and all', async () => {
      const fragment = await listen({ trpc: realTrpc, rateMaxRequests: 3 });
      const batch = await rawGet(fragment, '/trpc/a,b,c?batch=1#x');
      expect(batch.status).toBe(200);
      expect(JSON.parse(batch.body)).toHaveLength(3);
      expect((await rawGet(fragment, '/trpc/a')).status).toBe(429);

      const host = await listen({ trpc: realTrpc, rateMaxRequests: 3 });
      const viaHost = await rawGet(host, '/trpc/a,b,c', { host: 'x?batch=1&y=' });
      expect(JSON.parse(viaHost.body)).toHaveLength(3);
      expect((await rawGet(host, '/trpc/a')).status).toBe(429);
    });

    it('answers 400 to a request target or Host header the adapter cannot parse, and stays up', async () => {
      const base = await listen({ trpc: realTrpc });
      const absolute = await rawGet(base, 'http://evil.example/trpc/a');
      expect(absolute.status).toBe(400);
      expect(JSON.parse(absolute.body)).toEqual({ error: 'Malformed request' });
      expect((await rawGet(base, '/trpc/a', { host: 'bad host' })).status).toBe(400);
      expect((await rawGet(base, '/trpc/a', { host: 'x:notaport' })).status).toBe(400);
      expect(await (await fetch(`${base}/trpc/a`)).json()).toEqual({ result: { data: 'a' } });
    });

    it('turns a rejection from the tRPC handler into a 500 instead of ending the process', async () => {
      const failing = (): Promise<void> => Promise.reject(new Error('adapter blew up'));
      const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const base = await listen({ trpc: failing as unknown as AppOptions['trpc'] });
      const res = await fetch(`${base}/trpc/a`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal error' });
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
      expect((await fetch(`${base}/trpc/a`)).status).toBe(500);
    });

    it('a 429 carries the CORS headers for an allowed origin', async () => {
      const base = await listen({ trpc, rateMaxRequests: 1, corsOrigins: ['https://goldstandard.finance'] });
      const headers = { origin: 'https://goldstandard.finance' };
      expect((await fetch(`${base}/trpc/a`, { headers })).status).toBe(200);
      const limited = await fetch(`${base}/trpc/a`, { headers });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('access-control-allow-origin')).toBe('https://goldstandard.finance');
      expect(limited.headers.get('vary')).toContain('Origin');
    });
  });

  describe('cross-origin access', () => {
    it('sends no CORS headers unless configured', async () => {
      const base = await listen({ trpc });
      const res = await fetch(`${base}/trpc/a`, { headers: { origin: 'https://goldstandardfinance.eth.limo' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('opens the surface to any origin with "*", preflight included', async () => {
      const base = await listen({ trpc, corsOrigins: '*' });
      const preflight = await fetch(`${base}/trpc/a`, {
        method: 'OPTIONS',
        headers: { origin: 'https://goldstandardfinance.eth.limo', 'access-control-request-method': 'POST' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
      expect(preflight.headers.get('access-control-allow-headers')).toContain('content-type');
      const res = await fetch(`${base}/trpc/a`, { headers: { origin: 'https://anything.example' } });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('allows exact origins only when given a list', async () => {
      const base = await listen({ trpc, corsOrigins: ['https://goldstandard.finance'] });
      const allowed = await fetch(`${base}/trpc/a`, { headers: { origin: 'https://goldstandard.finance' } });
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://goldstandard.finance');
      expect(allowed.headers.get('vary')).toContain('Origin');
      const denied = await fetch(`${base}/trpc/a`, { headers: { origin: 'https://evil.example' } });
      expect(denied.status).toBe(200);
      expect(denied.headers.get('access-control-allow-origin')).toBeNull();
      const deniedPreflight = await fetch(`${base}/trpc/a`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
      expect(deniedPreflight.status).toBe(403);
    });
  });

  describe('the usage ledger download', () => {
    const body = 'address,debtGsusdDays\n';
    const ledgerRecord = {
      csvPath: '/usage-ledger.csv',
      jsonPath: '/usage-ledger.json',
      csv: (_req: Request, res: Response): void => {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.end(body);
      },
      json: (_req: Request, res: Response): void => {
        res.json({ sha256: 'ab' });
      },
    };

    it('serves the CSV and the JSON at their own paths, also when the API serves the dapp beside them', async () => {
      for (const options of [{ trpc, ledgerRecord }, { trpc, ledgerRecord, dappDist: dist }]) {
        const base = await listen(options);
        const csv = await fetch(`${base}/usage-ledger.csv`);
        expect(csv.status).toBe(200);
        expect(await csv.text()).toBe(body);
        expect(csv.headers.get('x-content-type-options')).toBe('nosniff');
        expect(await (await fetch(`${base}/usage-ledger.json`)).json()).toEqual({ sha256: 'ab' });
      }
    });

    it('is not there when the shell is given none: the path is a missing file, not the page', async () => {
      const base = await listen({ trpc, dappDist: dist });
      expect((await fetch(`${base}/usage-ledger.csv`)).status).toBe(404);
    });

    it('is read only: every method but GET and HEAD is refused', async () => {
      const base = await listen({ trpc, ledgerRecord });
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const res = await fetch(`${base}/usage-ledger.csv`, { method });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');
      }
      expect((await fetch(`${base}/usage-ledger.csv`, { method: 'HEAD' })).status).toBe(200);
    });

    it('sits behind the same limiter as the tRPC surface, and shares its budget', async () => {
      const base = await listen({ trpc, ledgerRecord, rateMaxRequests: 3 });
      expect((await fetch(`${base}/usage-ledger.csv`)).status).toBe(200);
      expect((await fetch(`${base}/usage-ledger.json`)).status).toBe(200);
      expect((await fetch(`${base}/trpc/a`)).status).toBe(200);
      const limited = await fetch(`${base}/usage-ledger.csv`);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await fetch(`${base}/trpc/a`)).status).toBe(429);
    });

    it('carries HSTS over TLS and the CORS headers for an allowed origin', async () => {
      const base = await listen({ trpc, ledgerRecord, trustProxyHops: 1, corsOrigins: ['https://goldstandard.finance'] });
      const res = await fetch(`${base}/usage-ledger.json`, { headers: { origin: 'https://goldstandard.finance', 'x-forwarded-proto': 'https' } });
      expect(res.headers.get('strict-transport-security')).toContain('max-age=');
      expect(res.headers.get('access-control-allow-origin')).toBe('https://goldstandard.finance');
      const other = await fetch(`${base}/usage-ledger.json`, { headers: { origin: 'https://evil.example' } });
      expect(other.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('turns a handler that rejects into a plain 500, without taking the API down', async () => {
      const failing = { ...ledgerRecord, csv: async (): Promise<void> => Promise.reject(new Error('boom')) };
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const base = await listen({ trpc, ledgerRecord: failing });
      expect((await fetch(`${base}/usage-ledger.csv`)).status).toBe(500);
      expect((await fetch(`${base}/trpc/a`)).status).toBe(200);
      error.mockRestore();
    });
  });
});
