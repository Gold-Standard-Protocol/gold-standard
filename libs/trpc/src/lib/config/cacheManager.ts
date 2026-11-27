import { createCache } from 'cache-manager';
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import Keyv from 'keyv';
import KeyvRedis from '@keyv/redis';

import { redisConfig } from './redisConfig';
import type { RedisConnectionConfig } from './redisConfig';

export type RedisCache = ReturnType<typeof createCache>;

export interface RedisCacheHandle {
  /** cache-manager's view: a store failure is swallowed and reads resolve null. */
  cache: RedisCache;
  /** The Keyv layer underneath: the same keys and values, but a store failure rejects. */
  keyv: Keyv;
  /** Drops the connection without waiting on a reply, for shutdown and specs. */
  close(): void;
}

export interface RedisCacheOptions {
  /** Receives one line when Redis goes away and one when it returns; stderr by default. */
  onStatus?: (message: string) => void;
}

export const REDIS_CONNECT_TIMEOUT_MS = 5_000;
export const REDIS_COMMAND_TIMEOUT_MS = 5_000;
const RETRY_STEP_MS = 200;
const RETRY_CEILING_MS = 5_000;

export const connectionOptions = (config: RedisConnectionConfig): RedisOptions => ({
  ...config,
  lazyConnect: true,
  connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
  commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  // One retry per command: during an outage a read rejects within about a second
  // instead of waiting in the offline queue for Redis to come back.
  maxRetriesPerRequest: 1,
  retryStrategy: (attempt) => Math.min(attempt * RETRY_STEP_MS, RETRY_CEILING_MS),
});

const writeStderr = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/**
 * A cache-manager instance over one ioredis client. Every layer that re-emits the
 * client's errors (the client, KeyvRedis and Keyv) has a listener, because an
 * 'error' event with no listener throws out of the emitter and ends the process:
 * an unreachable Redis used to crash the API and the keeper on first use. Here it
 * is reported once per outage and every read or write rejects until it returns.
 */
export const createRedisCache = (
  config: RedisConnectionConfig,
  options: RedisCacheOptions = {}
): RedisCacheHandle => {
  const report = options.onStatus ?? writeStderr;
  const client = new Redis(connectionOptions(config));
  let outageReported = false;
  client.on('error', (error: Error) => {
    if (outageReported) return;
    outageReported = true;
    report(
      `Redis unavailable at ${config.host}:${config.port}: ${error.message}; cache reads and writes fail until it returns`
    );
  });
  client.on('ready', () => {
    if (outageReported) report(`Redis connection to ${config.host}:${config.port} restored`);
    outageReported = false;
  });
  const store = new KeyvRedis(client);
  const ignore = (): undefined => undefined;
  store.on('error', ignore);
  const keyv = new Keyv({ store });
  keyv.on('error', ignore);
  return {
    cache: createCache({ stores: [keyv] }),
    keyv,
    close: () => {
      client.disconnect();
    },
  };
};

let sharedHandle: RedisCacheHandle | undefined;

/** The process-wide connection, created on first use so an unused import never opens a socket. */
export const getCacheHandle = (): RedisCacheHandle => {
  sharedHandle ??= createRedisCache(redisConfig);
  return sharedHandle;
};

export const getCache = (): RedisCache => getCacheHandle().cache;

export const cache = {
  get: <T>(key: string): Promise<T | null> => getCache().get<T>(key),
  set: <T>(key: string, value: T, ttlMs?: number): Promise<T> =>
    getCache().set<T>(key, value, ttlMs),
  del: (key: string): Promise<boolean> => getCache().del(key),
};
