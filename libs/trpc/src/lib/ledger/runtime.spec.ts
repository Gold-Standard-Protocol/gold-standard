import type { LedgerConfig } from './env';

const redisConstructor = jest.fn();
let config: LedgerConfig | undefined;

jest.mock('ioredis', () => {
  const Redis = jest.fn().mockImplementation((...args: unknown[]) => {
    redisConstructor(...args);
    return { on: jest.fn(), disconnect: jest.fn() };
  });
  return { __esModule: true, default: Redis, Redis };
});
jest.mock('./env', () => ({ getLedgerConfig: () => config }));

import { getLedgerRuntime } from './runtime';
import { testConfig } from './testSupport';

describe('getLedgerRuntime', () => {
  it('is undefined and opens nothing while the ledger is off', () => {
    config = undefined;
    expect(getLedgerRuntime()).toBeUndefined();
    expect(getLedgerRuntime()).toBeUndefined();
    expect(redisConstructor).not.toHaveBeenCalled();
  });

  it('builds one lazily connected Redis client, and no chain client, once the ledger is on', () => {
    config = testConfig();
    const runtime = getLedgerRuntime();
    expect(runtime?.config).toBe(config);
    expect(Object.keys(runtime ?? {}).sort()).toEqual(['config', 'record', 'store']);
    expect(getLedgerRuntime()).toBe(runtime);
    expect(redisConstructor).toHaveBeenCalledTimes(1);
    expect(redisConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ lazyConnect: true, connectTimeout: 5_000, commandTimeout: 5_000, maxRetriesPerRequest: 1 })
    );
  });
});
