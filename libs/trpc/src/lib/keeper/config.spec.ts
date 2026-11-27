import { DEFAULT_PRICE_API_URL, DEFAULT_STUCK_TX_REPLACE_SECONDS, parseKeeperConfig } from './config';

const VALID_KEY = `0x${'ab'.repeat(32)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

const validEnv = (
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> => ({
  KEEPER_RPC_URL: 'https://sepolia.example.org/rpc',
  GOLD_VAULT_ADDRESS: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  GOLD_ORACLE_ADDRESS: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
  STABILITY_MODULE_ADDRESS: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0',
  GSUSD_ADDRESS: '0x5fc8d32690cc91d4c39d9d3abcbd16989f875707',
  STABILITY_POOL_ADDRESS: '0x0165878a594ca255338adfa4d48449f69242eb8f',
  PAXG_TOKEN: '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9',
  XAUT_TOKEN: '0xdc64a140aa3e981100a9beca4e685f962f0cf6c9',
  REDIS_HOST: '127.0.0.1',
  ...overrides,
});

describe('parseKeeperConfig', () => {
  it('defaults dry run to true so the keeper is safe to run with no key', () => {
    const result = parseKeeperConfig(validEnv());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.dryRun).toBe(true);
      expect(result.config.privateKey).toBeUndefined();
    }
  });

  it('keeps dry run enabled for values other than the literal "false"', () => {
    for (const value of ['0', 'no', 'off', 'live', 'falsey']) {
      const result = parseKeeperConfig(validEnv({ KEEPER_DRY_RUN: value }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.dryRun).toBe(true);
      }
    }
  });

  it('disables dry run only for trimmed lowercased "false"', () => {
    for (const value of ['false', ' FALSE ', 'False']) {
      const result = parseKeeperConfig(
        validEnv({ KEEPER_DRY_RUN: value, KEEPER_PRIVATE_KEY: VALID_KEY })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.dryRun).toBe(false);
      }
    }
  });

  it('treats the private key as optional in dry run', () => {
    const result = parseKeeperConfig(validEnv({ KEEPER_DRY_RUN: 'true' }));
    expect(result.ok).toBe(true);
  });

  it('requires the private key when dry run is disabled', () => {
    const result = parseKeeperConfig(validEnv({ KEEPER_DRY_RUN: 'false' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('KEEPER_PRIVATE_KEY');
    }
  });

  it('rejects a malformed private key without echoing its value', () => {
    const result = parseKeeperConfig(
      validEnv({ KEEPER_PRIVATE_KEY: '0xdeadbeef' })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain('deadbeef');
    }
  });

  it('accepts a well-formed private key when dry run is disabled', () => {
    const result = parseKeeperConfig(
      validEnv({ KEEPER_DRY_RUN: 'false', KEEPER_PRIVATE_KEY: VALID_KEY })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.privateKey).toBe(VALID_KEY);
    }
  });

  it('rejects the zero address for GOLD_VAULT_ADDRESS', () => {
    const result = parseKeeperConfig(
      validEnv({ GOLD_VAULT_ADDRESS: ZERO_ADDRESS })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('GOLD_VAULT_ADDRESS');
    }
  });

  it('accepts a zero XAUT_TOKEN and yields xautToken undefined', () => {
    const result = parseKeeperConfig(validEnv({ XAUT_TOKEN: ZERO_ADDRESS }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.xautToken).toBeUndefined();
    }
  });

  it('treats a missing XAUT_TOKEN as xautToken undefined', () => {
    const result = parseKeeperConfig(validEnv({ XAUT_TOKEN: undefined }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.xautToken).toBeUndefined();
    }
  });

  it('defaults the chain id to 11155111', () => {
    const result = parseKeeperConfig(validEnv());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.chainId).toBe(11155111);
    }
  });

  it('accepts chain id 1', () => {
    const result = parseKeeperConfig(validEnv({ KEEPER_CHAIN_ID: '1' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.chainId).toBe(1);
    }
  });

  it('rejects chain id 5', () => {
    const result = parseKeeperConfig(validEnv({ KEEPER_CHAIN_ID: '5' }));
    expect(result.ok).toBe(false);
  });

  it('defaults the interval to 60 seconds', () => {
    const result = parseKeeperConfig(validEnv());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.intervalSeconds).toBe(60);
    }
  });

  it('accepts a custom positive integer interval', () => {
    const result = parseKeeperConfig(
      validEnv({ KEEPER_INTERVAL_SECONDS: '15' })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.intervalSeconds).toBe(15);
    }
  });

  it('rejects a non-positive interval', () => {
    const result = parseKeeperConfig(
      validEnv({ KEEPER_INTERVAL_SECONDS: '0' })
    );
    expect(result.ok).toBe(false);
  });

  it('reports an incomplete environment with a single reason', () => {
    const result = parseKeeperConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Keeper environment incomplete');
    }
  });

  it('defaults direct liquidation to disabled and enables it only for "true"', () => {
    const defaulted = parseKeeperConfig(validEnv());
    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) {
      expect(defaulted.config.enableDirect).toBe(false);
    }

    const enabled = parseKeeperConfig(
      validEnv({ KEEPER_ENABLE_DIRECT: ' TRUE ' })
    );
    expect(enabled.ok).toBe(true);
    if (enabled.ok) {
      expect(enabled.config.enableDirect).toBe(true);
    }
  });
});

describe('parseKeeperConfig vault registry', () => {
  it('treats a missing VAULT_REGISTRY_ADDRESS as no registry', () => {
    const result = parseKeeperConfig(validEnv());
    expect(result.ok && result.config.vaultRegistryAddress).toBeUndefined();
  });

  it('treats the zero address as no registry', () => {
    const result = parseKeeperConfig(validEnv({ VAULT_REGISTRY_ADDRESS: ZERO_ADDRESS }));
    expect(result.ok && result.config.vaultRegistryAddress).toBeUndefined();
  });

  it('checksums a configured registry address', () => {
    const result = parseKeeperConfig(
      validEnv({ VAULT_REGISTRY_ADDRESS: '0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6' })
    );
    expect(result.ok && result.config.vaultRegistryAddress).toBe(
      '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6'
    );
  });

  it('rejects a malformed registry address', () => {
    const result = parseKeeperConfig(validEnv({ VAULT_REGISTRY_ADDRESS: '0xnope' }));
    expect(result.ok).toBe(false);
  });
});

describe('parseKeeperConfig interval bounds', () => {
  it('rejects an interval below five seconds with a clear reason', () => {
    const result = parseKeeperConfig(validEnv({ KEEPER_INTERVAL_SECONDS: '4' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('at least 5 seconds');
  });

  it('rejects an interval above one day, which would overflow the timer', () => {
    const result = parseKeeperConfig(validEnv({ KEEPER_INTERVAL_SECONDS: '2147484' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('at most 86400 seconds');
  });

  it('accepts both bounds: no oracle duty ties the tick to a cadence any more', () => {
    expect(parseKeeperConfig(validEnv({ KEEPER_INTERVAL_SECONDS: '5' })).ok).toBe(true);
    expect(parseKeeperConfig(validEnv({ KEEPER_INTERVAL_SECONDS: '86400' })).ok).toBe(true);
  });
});

describe('parseKeeperConfig retired observation cadence', () => {
  it('carries no depth observation cadence', () => {
    const result = parseKeeperConfig(validEnv());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).not.toHaveProperty('depthObserveSeconds');
  });

  it('refuses KEEPER_DEPTH_OBSERVE_SECONDS rather than ignoring it, since the duty it tuned is gone', () => {
    for (const value of ['120', '300']) {
      const result = parseKeeperConfig(validEnv({ KEEPER_DEPTH_OBSERVE_SECONDS: value }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('KEEPER_DEPTH_OBSERVE_SECONDS');
        expect(result.reason).toContain('retired');
      }
    }
  });

  it('treats an empty KEEPER_DEPTH_OBSERVE_SECONDS as unset', () => {
    expect(parseKeeperConfig(validEnv({ KEEPER_DEPTH_OBSERVE_SECONDS: '' })).ok).toBe(true);
  });
});

describe('parseKeeperConfig fee ceilings', () => {
  it('defaults to 150 gwei max fee and 3 gwei priority', () => {
    const result = parseKeeperConfig(validEnv());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.maxFeePerGasWei).toBe(150_000_000_000n);
      expect(result.config.maxPriorityFeePerGasWei).toBe(3_000_000_000n);
    }
  });

  it('reads decimal gwei values', () => {
    const result = parseKeeperConfig(
      validEnv({ KEEPER_MAX_FEE_GWEI: '42.5', KEEPER_MAX_PRIORITY_FEE_GWEI: '0.1' })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.maxFeePerGasWei).toBe(42_500_000_000n);
      expect(result.config.maxPriorityFeePerGasWei).toBe(100_000_000n);
    }
  });

  it('rejects a priority ceiling above the fee ceiling and a zero fee ceiling', () => {
    expect(
      parseKeeperConfig(validEnv({ KEEPER_MAX_FEE_GWEI: '1', KEEPER_MAX_PRIORITY_FEE_GWEI: '2' }))
        .ok
    ).toBe(false);
    expect(parseKeeperConfig(validEnv({ KEEPER_MAX_FEE_GWEI: '0' })).ok).toBe(false);
  });

  it('rejects a non-numeric ceiling', () => {
    expect(parseKeeperConfig(validEnv({ KEEPER_MAX_FEE_GWEI: 'fast' })).ok).toBe(false);
  });
});

describe('parseKeeperConfig owner sources', () => {
  it('marks Redis configured when REDIS_URL or REDIS_HOST is set', () => {
    const byUrl = parseKeeperConfig(
      validEnv({ REDIS_HOST: undefined, REDIS_URL: 'redis://cache.internal:6379' })
    );
    expect(byUrl.ok && byUrl.config.redisConfigured).toBe(true);
    const byHost = parseKeeperConfig(validEnv());
    expect(byHost.ok && byHost.config.redisConfigured).toBe(true);
  });

  it('runs without Redis when the registry is configured', () => {
    const result = parseKeeperConfig(
      validEnv({
        REDIS_HOST: undefined,
        VAULT_REGISTRY_ADDRESS: '0x1111111111111111111111111111111111111111',
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.redisConfigured).toBe(false);
  });

  it('defaults the price watchdog alert gap to 100 basis points', () => {
    const result = parseKeeperConfig(validEnv());
    expect(result.ok && result.config.priceWatchdogAlertBps).toBe(100);
  });

  it('reads a custom price watchdog alert gap', () => {
    const result = parseKeeperConfig(validEnv({ PRICE_WATCHDOG_ALERT_BPS: '250' }));
    expect(result.ok && result.config.priceWatchdogAlertBps).toBe(250);
  });

  it.each(['0', '-5', '12.5', 'wide', '5001'])(
    'rejects a price watchdog alert gap of %s with a clear reason',
    (value) => {
      const result = parseKeeperConfig(validEnv({ PRICE_WATCHDOG_ALERT_BPS: value }));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain('PRICE_WATCHDOG_ALERT_BPS');
    }
  );

  it('refuses to start with neither Redis nor a registry', () => {
    const result = parseKeeperConfig(validEnv({ REDIS_HOST: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('No vault owner source');
  });
});

describe('parseKeeperConfig stuck transaction replacement', () => {
  it('defaults the replacement age to five minutes', () => {
    const result = parseKeeperConfig(validEnv());
    expect(result.ok && result.config.stuckTxReplaceSeconds).toBe(DEFAULT_STUCK_TX_REPLACE_SECONDS);
    expect(DEFAULT_STUCK_TX_REPLACE_SECONDS).toBe(300);
  });

  it('reuses reads within a tick for four seconds unless KEEPER_READ_CACHE_MS says otherwise', () => {
    const byDefault = parseKeeperConfig(validEnv());
    expect(byDefault.ok && byDefault.config.readCacheMs).toBe(4_000);
    const blank = parseKeeperConfig(validEnv({ KEEPER_READ_CACHE_MS: '' }));
    expect(blank.ok && blank.config.readCacheMs).toBe(4_000);
    const off = parseKeeperConfig(validEnv({ KEEPER_READ_CACHE_MS: '0' }));
    expect(off.ok && off.config.readCacheMs).toBe(0);
    const tuned = parseKeeperConfig(validEnv({ KEEPER_READ_CACHE_MS: '2500' }));
    expect(tuned.ok && tuned.config.readCacheMs).toBe(2_500);
  });

  it('refuses a KEEPER_READ_CACHE_MS that is negative, fractional, not a number or a block long', () => {
    for (const value of ['-1', '1.5', 'soon', '10001', '12000']) {
      expect(parseKeeperConfig(validEnv({ KEEPER_READ_CACHE_MS: value })).ok).toBe(false);
    }
    expect(parseKeeperConfig(validEnv({ KEEPER_READ_CACHE_MS: '10000' })).ok).toBe(true);
  });

  it('reads a custom replacement age', () => {
    const result = parseKeeperConfig(validEnv({ KEEPER_STUCK_TX_REPLACE_SECONDS: '900' }));
    expect(result.ok && result.config.stuckTxReplaceSeconds).toBe(900);
  });

  it.each(['0', '59', '86401', '90.5', 'soon'])(
    'rejects a replacement age of %s with a clear reason',
    (value) => {
      const result = parseKeeperConfig(validEnv({ KEEPER_STUCK_TX_REPLACE_SECONDS: value }));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain('KEEPER_STUCK_TX_REPLACE_SECONDS');
    }
  );
});

describe('parseKeeperConfig off-chain price source', () => {
  const registryOnly = (overrides: Record<string, string | undefined> = {}) =>
    validEnv({ REDIS_HOST: undefined, VAULT_REGISTRY_ADDRESS: '0x0165878a594ca255338adfa4d48449f69242eb8f', ...overrides });

  it('reads the API cache when Redis is configured and fetches the price itself otherwise', () => {
    const withRedis = parseKeeperConfig(validEnv());
    expect(withRedis.ok && withRedis.config.offChainPriceSource).toBe('redis');
    const without = parseKeeperConfig(registryOnly());
    expect(without.ok && without.config.offChainPriceSource).toBe('http');
    expect(without.ok && without.config.priceApiUrl).toBe(DEFAULT_PRICE_API_URL);
  });

  it('honours an explicit choice, trimmed and case-insensitive', () => {
    const http = parseKeeperConfig(validEnv({ KEEPER_OFFCHAIN_PRICES: ' HTTP ' }));
    expect(http.ok && http.config.offChainPriceSource).toBe('http');
    const none = parseKeeperConfig(registryOnly({ KEEPER_OFFCHAIN_PRICES: 'none' }));
    expect(none.ok && none.config.offChainPriceSource).toBe('none');
  });

  it('refuses redis without a Redis, an unknown source and a malformed price URL', () => {
    const redis = parseKeeperConfig(registryOnly({ KEEPER_OFFCHAIN_PRICES: 'redis' }));
    expect(redis.ok).toBe(false);
    expect(!redis.ok && redis.reason).toContain('REDIS_URL or REDIS_HOST');
    const unknown = parseKeeperConfig(validEnv({ KEEPER_OFFCHAIN_PRICES: 'coingecko' }));
    expect(!unknown.ok && unknown.reason).toContain('redis, http or none');
    const url = parseKeeperConfig(validEnv({ KEEPER_PRICE_API_URL: 'ftp://prices.example' }));
    expect(!url.ok && url.reason).toContain('KEEPER_PRICE_API_URL');
  });

  it('accepts a mirror for the price endpoint', () => {
    const mirror = parseKeeperConfig(registryOnly({ KEEPER_PRICE_API_URL: ' https://prices.example/simple/price ' }));
    expect(mirror.ok && mirror.config.priceApiUrl).toBe('https://prices.example/simple/price');
  });
});

describe('parseKeeperConfig read endpoints', () => {
  const KEYED = 'https://eth-mainnet.example.com/v2/secret-provider-key';

  it('reads nothing besides KEEPER_RPC_URL when KEEPER_READ_RPC_URLS is unset or blank', () => {
    const unset = parseKeeperConfig(validEnv());
    expect(unset.ok && unset.config.readRpcUrls).toEqual([]);
    const blank = parseKeeperConfig(validEnv({ KEEPER_READ_RPC_URLS: ' , ' }));
    expect(blank.ok && blank.config.readRpcUrls).toEqual([]);
  });

  it('reads a comma-separated list in order, trimmed, without repeats or KEEPER_RPC_URL itself', () => {
    const result = parseKeeperConfig(
      validEnv({
        KEEPER_READ_RPC_URLS: ` ${KEYED} , https://sepolia.example.org/rpc, https://read-two.example.org ,${KEYED}`,
      })
    );
    expect(result.ok && result.config.readRpcUrls).toEqual([
      { url: KEYED, entry: 1 },
      { url: 'https://read-two.example.org', entry: 3 },
    ]);
  });

  it('keeps each URL numbered by its position in the variable after blanks and repeats are dropped', () => {
    const result = parseKeeperConfig(
      validEnv({ KEEPER_READ_RPC_URLS: `https://sepolia.example.org/rpc,,${KEYED},${KEYED},https://read-two.example.org` })
    );
    expect(result.ok && result.config.readRpcUrls).toEqual([
      { url: KEYED, entry: 3 },
      { url: 'https://read-two.example.org', entry: 5 },
    ]);
  });

  it.each(['ftp://read.example.org', 'not a url', 'https://', 'https://read.example.org/a b'])(
    'refuses the entry %s by its position and never echoes it',
    (bad) => {
      const result = parseKeeperConfig(validEnv({ KEEPER_READ_RPC_URLS: `${KEYED},${bad}` }));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain('KEEPER_READ_RPC_URLS entry 2');
      expect(!result.ok && result.reason).not.toContain(bad);
      expect(!result.ok && result.reason).not.toContain('secret-provider-key');
    }
  );
});

describe('parseKeeperConfig late feed warning', () => {
  it('defaults to the 24 hour heartbeat, a 15 minute margin and an hourly repeat', () => {
    const result = parseKeeperConfig(validEnv());
    expect(result.ok && result.config.feedHeartbeatSeconds).toBe(86_400);
    expect(result.ok && result.config.feedLateMarginSeconds).toBe(900);
    expect(result.ok && result.config.feedLateRepeatSeconds).toBe(3_600);
  });

  it('reads custom values, a zero margin included', () => {
    const result = parseKeeperConfig(
      validEnv({
        KEEPER_FEED_HEARTBEAT_SECONDS: '3600',
        KEEPER_FEED_LATE_MARGIN_SECONDS: '0',
        KEEPER_FEED_LATE_REPEAT_SECONDS: '600',
      })
    );
    expect(result.ok && result.config.feedHeartbeatSeconds).toBe(3_600);
    expect(result.ok && result.config.feedLateMarginSeconds).toBe(0);
    expect(result.ok && result.config.feedLateRepeatSeconds).toBe(600);
  });

  it.each([
    ['KEEPER_FEED_HEARTBEAT_SECONDS', '59'],
    ['KEEPER_FEED_HEARTBEAT_SECONDS', '604801'],
    ['KEEPER_FEED_HEARTBEAT_SECONDS', '1.5'],
    ['KEEPER_FEED_HEARTBEAT_SECONDS', 'daily'],
    ['KEEPER_FEED_LATE_MARGIN_SECONDS', '-1'],
    ['KEEPER_FEED_LATE_MARGIN_SECONDS', '86401'],
    ['KEEPER_FEED_LATE_REPEAT_SECONDS', '59'],
    ['KEEPER_FEED_LATE_REPEAT_SECONDS', '86401'],
  ])('rejects %s=%s by name', (name, value) => {
    const result = parseKeeperConfig(validEnv({ [name]: value }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(name);
  });
});

describe('parseKeeperConfig KEEPER_HEARTBEAT_URL', () => {
  const SECRET_URL = 'https://hc.example.com/ping/5b1f2c3d-secret';

  it('sends no ping unless the variable is set', () => {
    const result = parseKeeperConfig(validEnv());
    expect(result.ok && result.config.heartbeatUrl).toBeUndefined();
    const blank = parseKeeperConfig(validEnv({ KEEPER_HEARTBEAT_URL: '   ' }));
    expect(blank.ok && blank.config.heartbeatUrl).toBeUndefined();
  });

  it('accepts an https URL, trimmed', () => {
    const result = parseKeeperConfig(validEnv({ KEEPER_HEARTBEAT_URL: ` ${SECRET_URL} ` }));
    expect(result.ok && result.config.heartbeatUrl).toBe(SECRET_URL);
  });

  it.each([
    ['plain http', 'http://hc.example.com/ping/5b1f2c3d-secret'],
    ['another scheme', 'ftp://hc.example.com/ping/5b1f2c3d-secret'],
    ['no scheme', 'hc.example.com/ping/5b1f2c3d-secret'],
    ['embedded credentials', 'https://user:5b1f2c3d-secret@hc.example.com/ping'],
    ['a space inside', 'https://hc.example.com/ping/5b1f2c3d-secret extra'],
    ['no host', 'https://?token=5b1f2c3d-secret'],
  ])('refuses %s without echoing the value', (_label, value) => {
    const result = parseKeeperConfig(validEnv({ KEEPER_HEARTBEAT_URL: value }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('KEEPER_HEARTBEAT_URL');
      expect(result.reason).not.toContain('5b1f2c3d-secret');
      expect(result.reason).not.toContain('hc.example.com');
    }
  });
});
