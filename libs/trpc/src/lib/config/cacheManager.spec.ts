import { createRedisCache } from './cacheManager';
import type { RedisCacheHandle } from './cacheManager';

// Port 1 is reserved and nothing listens on it, like a keeper VPS with no Redis.
const CLOSED_PORT_CONFIG = {
  host: '127.0.0.1',
  port: 1,
  maxRetriesPerRequest: null,
} as const;

const withinMs = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

describe('createRedisCache against a closed port', () => {
  let handle: RedisCacheHandle;
  const status: string[] = [];

  beforeAll(() => {
    handle = createRedisCache(CLOSED_PORT_CONFIG, {
      onStatus: (message) => {
        status.push(message);
      },
    });
  });

  afterAll(() => {
    handle.close();
  });

  it('rejects a Keyv read within a bounded time instead of crashing or hanging', async () => {
    await expect(withinMs(handle.keyv.get<string>('missing'), 15_000)).rejects.toBeInstanceOf(
      Error
    );
  }, 20_000);

  it('resolves a cache-manager read to null, the miss its callers already handle', async () => {
    await expect(withinMs(handle.cache.get<string>('missing'), 15_000)).resolves.toBeNull();
  }, 20_000);

  it('reports the outage once, not once per failed command', async () => {
    await expect(withinMs(handle.keyv.get<string>('missing-again'), 15_000)).rejects.toBeInstanceOf(
      Error
    );
    expect(status.filter((line) => line.includes('Redis unavailable'))).toHaveLength(1);
    expect(status[0]).toContain('127.0.0.1:1');
  }, 20_000);
});
