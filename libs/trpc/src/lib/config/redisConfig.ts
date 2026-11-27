import { loadLocalEnv } from './loadEnv';

// Environment-driven so staging, production and CI never silently share a
// localhost default; localhost remains the development fallback.
//
// REDIS_URL (redis:// or rediss://, with credentials) is the preferred form and
// wins over the REDIS_HOST / REDIS_PORT pair. Every consumer (the cache, bullmq
// and the indexer queue) spreads these option fields into its own ioredis
// client, so a password or TLS requirement set once here reaches all of them.

export interface RedisConnectionConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
}

export interface ParsedRedisConfig {
  options: RedisConnectionConfig;
  /** True when the operator set REDIS_URL or REDIS_HOST; false means the localhost default. */
  configured: boolean;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 6379;

const parsePort = (raw: string | undefined): number | undefined => {
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
};

const parseDb = (pathname: string): number | undefined => {
  const db = Number(pathname.replace(/^\//, ''));
  return pathname.length > 1 && Number.isInteger(db) && db >= 0 ? db : undefined;
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value.trim();

/**
 * The parser's own error carries the whole input, password included, as a property that node
 * prints when the failure goes uncaught at startup, so it is replaced rather than rethrown
 * or chained as a cause.
 */
const parseUrl = (raw: string): URL => {
  try {
    return new URL(raw);
  } catch {
    throw new Error(
      'REDIS_URL is not a valid URL (percent-encode special characters in the password)'
    );
  }
};

const fromUrl = (raw: string): RedisConnectionConfig => {
  const url = parseUrl(raw);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(`REDIS_URL must use the redis:// or rediss:// scheme, got ${url.protocol}`);
  }
  const db = parseDb(url.pathname);
  const username = nonEmpty(decodeURIComponent(url.username));
  const password = nonEmpty(decodeURIComponent(url.password));
  return {
    host: url.hostname === '' ? DEFAULT_HOST : url.hostname,
    port: parsePort(url.port) ?? DEFAULT_PORT,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    ...(db === undefined ? {} : { db }),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
};

const fromHostAndPort = (env: Record<string, string | undefined>): RedisConnectionConfig => {
  const password = nonEmpty(env['REDIS_PASSWORD']);
  return {
    host: nonEmpty(env['REDIS_HOST']) ?? DEFAULT_HOST,
    port: parsePort(env['REDIS_PORT']) ?? DEFAULT_PORT,
    ...(password === undefined ? {} : { password }),
    ...(env['REDIS_TLS'] === 'true' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
};

/** Pure parser so specs can pass explicit environment objects. Throws on a malformed REDIS_URL. */
export const parseRedisConfig = (
  env: Record<string, string | undefined>
): ParsedRedisConfig => {
  const url = nonEmpty(env['REDIS_URL']);
  if (url !== undefined) {
    return { options: fromUrl(url), configured: true };
  }
  return {
    options: fromHostAndPort(env),
    configured: nonEmpty(env['REDIS_HOST']) !== undefined,
  };
};

// libs/trpc/.env first: the price queue imports this module
// before anything else had loaded the file, so its REDIS_URL was never seen.
loadLocalEnv();

const parsed = parseRedisConfig(process.env);

export const redisConfig: RedisConnectionConfig = parsed.options;
export const isRedisConfigured: boolean = parsed.configured;

/** The namespace a deployment gets when REDIS_NAMESPACE is unset. */
export const DEFAULT_NAMESPACE = 'goldstandard';

/**
 * The prefix of every key and queue a deployment writes, so deployments that share a
 * Redis (staging and production, a dev instance and the end-to-end suite) never read or
 * wipe each other's. The keeper must use the API's value to read its owner set.
 */
export const KEY_NAMESPACE = process.env['REDIS_NAMESPACE']?.trim() || DEFAULT_NAMESPACE;

/** BullMQ's key prefix under that namespace, for every queue a deployment runs. */
export const QUEUE_PREFIX = `bull:${KEY_NAMESPACE}`;
