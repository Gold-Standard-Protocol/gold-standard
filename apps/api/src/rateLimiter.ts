import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * Fixed-window in-memory rate limit for the public tRPC surface. The dapp polls owners
 * every 30 to 60 seconds, so 120 requests per minute per client leaves an order of magnitude of
 * headroom for legitimate clients while bounding Redis read pressure from abusive callers.
 * Dependency-free by design.
 *
 * A client is an IPv4 address or an IPv6 /64 (one subscriber allocation holds 2^64
 * addresses, so keying on the full address let one host rotate through them for free).
 * An IPv6 request also counts against its /48, at IPV6_SITE_LIMIT_MULTIPLIER times the
 * client limit: a /48 holds 65,536 /64s, so one holder could
 * otherwise rotate through them for 65,536 times the limit. A request passes only when
 * both buckets have room and is counted in both; a refused one is counted in neither.
 * The map is hard-capped and evicts the oldest window in O(1), and expired windows are
 * pruned on a timer rather than on the request path, so a flood of distinct addresses
 * cannot make every new request scan the whole map.
 */
export const RATE_WINDOW_MS = 60_000;
export const RATE_MAP_MAX_SIZE = 50_000;
/** Calls per batched tRPC request; the dapp batches a handful of queries per page at most. */
export const MAX_BATCH_SIZE = 20;
/**
 * How many clients' worth of requests one IPv6 /48 may make. A /48 is one site's
 * allocation at most providers, but a carrier may number many subscribers out of one, so
 * the bound sits well above a single client while far below the 65,536 /64s it holds.
 */
export const IPV6_SITE_LIMIT_MULTIPLIER = 16;
const UNKNOWN_CLIENT = 'unknown';
const IPV6_HEXTETS = 8;
const PREFIX_HEXTETS = 4;
const SITE_PREFIX_HEXTETS = 3;

export interface RateLimiterOptions {
  maxRequests: number;
  /** Requests per window for one IPv6 /48; maxRequests times IPV6_SITE_LIMIT_MULTIPLIER by default. */
  maxRequestsPerSite?: number;
  windowMs?: number;
  maxKeys?: number;
  maxBatchSize?: number;
  /** Injected clock for specs; defaults to Date.now. */
  now?: () => number;
}

export interface RateLimiter {
  handle: RequestHandler;
  /** Live keys, for specs and diagnostics. */
  size: () => number;
  /** Drops every expired window; runs on a timer in production. */
  prune: () => void;
  dispose: () => void;
}

interface RateWindow {
  count: number;
  windowStart: number;
}

const ipv4FromHextets = (high: number, low: number): string => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

/** The eight hextets of a valid IPv6 address, with :: and a dotted IPv4 tail expanded. */
const expandIPv6 = (address: string): readonly number[] | undefined => {
  const withoutZone = address.split('%')[0] ?? address;
  const lastColon = withoutZone.lastIndexOf(':');
  const tail = withoutZone.slice(lastColon + 1);
  const octets = tail.includes('.') ? tail.split('.').map(Number) : undefined;
  const hexTail = octets === undefined ? undefined : `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  const normalised = hexTail === undefined ? withoutZone : `${withoutZone.slice(0, lastColon + 1)}${hexTail}`;
  const [head, rest] = normalised.split('::');
  const headParts = head === '' ? [] : head.split(':');
  const restParts = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = IPV6_HEXTETS - headParts.length - restParts.length;
  if (missing < 0 || (rest === undefined && missing !== 0)) return undefined;
  return [...headParts, ...Array<string>(missing).fill('0'), ...restParts].map((hextet) => Number.parseInt(hextet, 16));
};

const isIPv4Mapped = (hextets: readonly number[]): boolean =>
  hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff;

const prefixOf = (hextets: readonly number[], count: number): string =>
  hextets.slice(0, count).map((hextet) => hextet.toString(16)).join(':');

/** The bucket an address falls into: the IPv4 address itself, or the /64 prefix of an IPv6 address. */
export const clientKey = (ip: string | undefined): string => {
  if (ip === undefined || ip === '') return UNKNOWN_CLIENT;
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return ip;
  const hextets = expandIPv6(ip);
  if (hextets === undefined) return ip;
  if (isIPv4Mapped(hextets)) return ipv4FromHextets(hextets[6], hextets[7]);
  return `${prefixOf(hextets, PREFIX_HEXTETS)}::/64`;
};

/** The coarser bucket of an IPv6 address, its /48 prefix; undefined for IPv4 and anything unparseable. */
export const siteKey = (ip: string | undefined): string | undefined => {
  if (ip === undefined || !isIPv6(ip)) return undefined;
  const hextets = expandIPv6(ip);
  if (hextets === undefined || isIPv4Mapped(hextets)) return undefined;
  return `${prefixOf(hextets, SITE_PREFIX_HEXTETS)}::/48`;
};

/** What the tRPC adapter does with the Host header: `new Headers(req.headers).get('host')`, then string interpolation. */
const hostHeader = (headers: Request['headers']): string => String(headers.host?.trim() ?? null);

/**
 * How many procedure calls a request carries, or undefined when tRPC could not even parse it.
 * It reads the request the way the adapter does: `batch` comes from the search parameters of
 * `http://<Host><url>` (so a `#` ends the query string and a Host header can open one), and the
 * procedure path is Express's `req.path`, decoded and split on commas. Counting from the raw
 * query string or from a normalised URL path would each let a large batch through as one call.
 */
export const requestCost = (req: Pick<Request, 'url' | 'path' | 'headers'>): number | undefined => {
  if (!req.url.startsWith('/')) return undefined;
  let searchParams: URLSearchParams;
  try {
    searchParams = new URL(`http://${hostHeader(req.headers)}${req.url}`).searchParams;
  } catch {
    return undefined;
  }
  if (searchParams.get('batch') !== '1') return 1;
  const rawPath = req.path.replace(/^\//, '');
  try {
    return decodeURIComponent(rawPath).split(',').length;
  } catch {
    return rawPath.split(/,|%2c/i).length;
  }
};

const secondsUntil = (deadline: number, now: number): number => Math.max(1, Math.ceil((deadline - now) / 1000));

interface Bucket {
  key: string;
  limit: number;
  live: RateWindow | undefined;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const windowMs = options.windowMs ?? RATE_WINDOW_MS;
  const maxKeys = options.maxKeys ?? RATE_MAP_MAX_SIZE;
  const maxBatchSize = options.maxBatchSize ?? MAX_BATCH_SIZE;
  const maxRequestsPerSite = options.maxRequestsPerSite ?? options.maxRequests * IPV6_SITE_LIMIT_MULTIPLIER;
  const now = options.now ?? Date.now;
  // Insertion order doubles as window-start order because a reset window is re-inserted.
  const windows = new Map<string, RateWindow>();

  const prune = (): void => {
    const at = now();
    for (const [key, window] of windows) {
      if (at - window.windowStart >= windowMs) windows.delete(key);
    }
  };

  const evictOldest = (): void => {
    const oldest = windows.keys().next();
    if (!oldest.done) windows.delete(oldest.value);
  };

  const timer = setInterval(prune, windowMs);
  timer.unref();

  const liveWindow = (key: string, at: number): RateWindow | undefined => {
    const existing = windows.get(key);
    return existing !== undefined && at - existing.windowStart < windowMs ? existing : undefined;
  };

  const record = (bucket: Bucket, cost: number, at: number): void => {
    if (bucket.live) {
      windows.set(bucket.key, { ...bucket.live, count: bucket.live.count + cost });
      return;
    }
    if (windows.has(bucket.key)) windows.delete(bucket.key);
    else if (windows.size >= maxKeys) evictOldest();
    windows.set(bucket.key, { count: cost, windowStart: at });
  };

  /** The client's bucket and, for IPv6, its /48 bucket, each with its window as of `at`. */
  const bucketsFor = (ip: string | undefined, at: number): Bucket[] => {
    const client = clientKey(ip);
    const site = siteKey(ip);
    return [
      { key: client, limit: options.maxRequests, live: liveWindow(client, at) },
      ...(site === undefined ? [] : [{ key: site, limit: maxRequestsPerSite, live: liveWindow(site, at) }]),
    ];
  };

  const handle = (req: Request, res: Response, next: NextFunction): void => {
    const cost = requestCost(req);
    if (cost === undefined) {
      res.status(400).json({ error: 'Malformed request' });
      return;
    }
    if (cost > maxBatchSize) {
      res.status(400).json({ error: `Batch too large: at most ${maxBatchSize} calls per request` });
      return;
    }
    const at = now();
    const buckets = bucketsFor(req.ip, at);
    const full = buckets.find((bucket) => (bucket.live?.count ?? 0) + cost > bucket.limit);
    if (full) {
      res.setHeader('Retry-After', String(secondsUntil((full.live?.windowStart ?? at) + windowMs, at)));
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    for (const bucket of buckets) record(bucket, cost, at);
    next();
  };

  return { handle, size: () => windows.size, prune, dispose: () => clearInterval(timer) };
}
