import { existsSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { join, resolve } from 'node:path';

/**
 * Environment parsing for apps/api. Every numeric variable is parsed strictly: a value
 * that is not a plain decimal integer inside its range stops the process at startup with
 * a message naming the variable, because Number() turned "abc" into NaN (a limiter that
 * never blocks) and "" into 0 (a limiter that blocks everything).
 */
export type CorsOrigins = '*' | readonly string[];

export interface ApiConfig {
  port: number;
  host: string;
  trustProxyHops: number;
  rateMaxRequests: number;
  dappDist: string | undefined;
  corsOrigins: CorsOrigins | undefined;
}

export const DEFAULT_PORT = 3333;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_RATE_MAX_REQUESTS = 120;
export const MAX_TRUST_PROXY_HOPS = 16;
export const MAX_RATE_MAX_REQUESTS = 100_000;
const MAX_PORT = 65_535;

interface IntegerBounds {
  min: number;
  max: number;
  fallback: number;
}

const DECIMAL_INTEGER = /^\d+$/;

/** A plain decimal integer within [min, max], or the fallback when unset or blank. */
export const parseBoundedInteger = (name: string, raw: string | undefined, bounds: IntegerBounds): number => {
  const value = raw?.trim() ?? '';
  if (value === '') return bounds.fallback;
  const parsed = DECIMAL_INTEGER.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new Error(`${name} must be an integer between ${bounds.min} and ${bounds.max}, got "${raw}"`);
  }
  return parsed;
};

/**
 * How many proxy hops sit in front of this process. With 0 (the default) Express keys
 * the limiter on the socket peer, which behind any load balancer or CDN is one address
 * for every client, so one caller's 120 requests locked everyone out for the minute.
 * Set it to the exact hop count in production (1 behind a single TLS terminator): too
 * high and a client can spoof X-Forwarded-For to dodge the limit, too low and clients
 * share a bucket. Express trusts the socket peer as the first hop whoever it is, so the
 * count holds only while the counted proxies are the sole way in; API_HOST keeps the
 * listener on loopback for that reason.
 */
export const parseTrustProxyHops = (raw: string | undefined): number =>
  parseBoundedInteger('TRUST_PROXY_HOPS', raw, { min: 0, max: MAX_TRUST_PROXY_HOPS, fallback: 0 });

/** Requests per client per minute on the tRPC surface; batched calls count individually. */
export const parseRateMaxRequests = (raw: string | undefined): number =>
  parseBoundedInteger('RATE_MAX_REQUESTS', raw, { min: 1, max: MAX_RATE_MAX_REQUESTS, fallback: DEFAULT_RATE_MAX_REQUESTS });

export const parsePort = (raw: string | undefined): number =>
  parseBoundedInteger('PORT', raw, { min: 1, max: MAX_PORT, fallback: DEFAULT_PORT });

/**
 * The address the listener binds. With no host Node bound every interface, so a
 * client that reached the port directly passed for the proxy and chose its own rate-limit
 * key. Unset means loopback, where only the reverse proxy on the same machine reaches it
 * (docs/MAINNET.md section 4.6). An override must be one IP address, never a name, so the
 * bind cannot change with DNS: 0.0.0.0 or :: for every interface, which then needs a
 * firewall that admits the proxy alone whenever TRUST_PROXY_HOPS is above 0.
 */
export const parseApiHost = (raw: string | undefined): string => {
  const value = raw?.trim() ?? '';
  if (value === '') return DEFAULT_HOST;
  if (isIP(value) === 0) {
    throw new Error(`API_HOST must be an IP address such as 127.0.0.1, ::1 or 0.0.0.0, got "${raw}"`);
  }
  return value;
};

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** True for an address only this machine reaches: 127.0.0.0/8, ::1 or an IPv4-mapped loopback. */
export const isLoopbackHost = (host: string): boolean => {
  const family = isIP(host);
  if (family === 0) return false;
  return LOOPBACK.check(host, family === 4 ? 'ipv4' : 'ipv6');
};

/**
 * The startup warning for a listener off loopback while TRUST_PROXY_HOPS is above 0, or
 * undefined when the pair is safe as configured. Express takes whatever peer connects as
 * the first trusted hop, so a client that reaches the port directly writes its own
 * X-Forwarded-For and chooses its own rate-limit key. Only a firewall that admits the
 * counted proxies alone closes that, and this process cannot see one, so the pair is
 * flagged at every start rather than refused.
 */
export const trustProxyExposureWarning = (
  config: Pick<ApiConfig, 'host' | 'port' | 'trustProxyHops'>
): string | undefined => {
  if (config.trustProxyHops === 0 || isLoopbackHost(config.host)) return undefined;
  return `API_HOST ${config.host} is not a loopback address and TRUST_PROXY_HOPS is ${config.trustProxyHops}, so Express treats any peer that connects as a trusted proxy: a client that reaches port ${config.port} directly sets X-Forwarded-For and chooses its own rate-limit key. A firewall must admit only the counted proxies to port ${config.port}. When the proxy runs on this machine, leave API_HOST unset so the listener binds loopback.`;
};

/**
 * The dapp build directory from DAPP_DIST, or undefined when the API serves the tRPC
 * surface alone. A configured directory without an index.html or the _headers file that
 * carries its security policy fails at startup, not on the first visitor.
 */
export const resolveDappDist = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined;
  const dir = resolve(raw.trim());
  if (!existsSync(join(dir, 'index.html'))) {
    throw new Error(`DAPP_DIST=${raw} has no index.html; build the dapp first (npx nx build dapp) or unset DAPP_DIST`);
  }
  if (!existsSync(join(dir, '_headers'))) {
    throw new Error(`DAPP_DIST=${raw} has no _headers file; the dapp build copies it from apps/dapp/public`);
  }
  return dir;
};

/**
 * CORS_ORIGINS: "*" lets any origin read the API, which is the right setting for a public,
 * unauthenticated surface that a frontend on IPFS, an ENS gateway or a mirror must reach
 * (those origins cannot be enumerated). A comma-separated list allows exact origins only.
 * Unset keeps the default: browsers may call it from the API's own origin alone.
 */
export const parseCorsOrigins = (raw: string | undefined): CorsOrigins | undefined => {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value === '*') return '*';
  const origins = value.split(',').map((o) => o.trim()).filter((o) => o !== '');
  for (const origin of origins) {
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) {
      throw new Error(`CORS_ORIGINS entries must be origins such as https://app.example.com, got "${origin}"`);
    }
  }
  return origins;
};

/** The whole API configuration from one environment object, so a bad value fails before anything listens. */
export const readApiConfig = (env: NodeJS.ProcessEnv): ApiConfig => ({
  port: parsePort(env['PORT']),
  host: parseApiHost(env['API_HOST']),
  trustProxyHops: parseTrustProxyHops(env['TRUST_PROXY_HOPS']),
  rateMaxRequests: parseRateMaxRequests(env['RATE_MAX_REQUESTS']),
  dappDist: resolveDappDist(env['DAPP_DIST']),
  corsOrigins: parseCorsOrigins(env['CORS_ORIGINS']),
});
