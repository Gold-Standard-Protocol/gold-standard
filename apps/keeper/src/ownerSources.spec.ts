import { getAddress } from 'viem';
import { createRedisVaultOwnerSource } from '@goldstandard/trpc/keeper';
import type { KeeperConfig, KeeperLogger, KeeperReadClient } from '@goldstandard/trpc/keeper';
import { createOwnerSource } from './ownerSources';

// The real keeper library, with the Redis source wrapped so a test can see how it is built.
jest.mock('@goldstandard/trpc/keeper', () => {
  const actual = jest.requireActual<typeof import('@goldstandard/trpc/keeper')>('@goldstandard/trpc/keeper');
  return { ...actual, createRedisVaultOwnerSource: jest.fn(actual.createRedisVaultOwnerSource) };
});

const REGISTRY = getAddress('0x00000000000000000000000000000000000a0007');

const config = (overrides: Partial<KeeperConfig>): KeeperConfig => ({
  chainId: 11155111,
  rpcUrl: 'https://rpc.example.org',
  dryRun: true,
  enableDirect: false,
  intervalSeconds: 60,
  maxFeePerGasWei: 100n * 10n ** 9n,
  maxPriorityFeePerGasWei: 2n * 10n ** 9n,
  redisConfigured: false,
  goldVaultAddress: getAddress('0x00000000000000000000000000000000000a0001'),
  goldOracleAddress: getAddress('0x00000000000000000000000000000000000a0002'),
  stabilityModuleAddress: getAddress('0x00000000000000000000000000000000000a0003'),
  gsusdAddress: getAddress('0x00000000000000000000000000000000000a0006'),
  stabilityPoolAddress: getAddress('0x00000000000000000000000000000000000a0005'),
  paxgToken: getAddress('0x00000000000000000000000000000000000a0004'),
  xautToken: undefined,
  vaultRegistryAddress: REGISTRY,
  priceWatchdogAlertBps: 100,
  stuckTxReplaceSeconds: 300,
  readCacheMs: 4_000,
  feedHeartbeatSeconds: 86_400,
  feedLateMarginSeconds: 900,
  feedLateRepeatSeconds: 3_600,
  offChainPriceSource: 'none',
  priceApiUrl: 'https://price.example.org/simple',
  ...overrides,
});

const createStubLogger = (): { log: KeeperLogger; events: string[] } => {
  const events: string[] = [];
  const record =
    (level: string) =>
    (event: string, fields?: Record<string, unknown>): void => {
      events.push(`${level}:${event}:${String(fields?.['job'])}`);
    };
  return { log: { info: record('info'), warn: record('warn'), error: record('error') }, events };
};

/** A registry that answers every read as an address with no code would. */
const noCode: KeeperReadClient = {
  readContract: async ({ functionName }) => {
    throw new Error(`The contract function "${functionName}" returned no data ("0x").`);
  },
};

const emptyRegistry: KeeperReadClient = {
  readContract: async ({ functionName }) => (functionName === 'vaultOwnerCount' ? 0n : []),
};

describe('createOwnerSource', () => {
  // The registry-only keeper, the runbook shape, read
  // its one source directly rather than through the union, so a registry it could never
  // read logged one warn per tick and nothing paged while every vault went unwatched.
  it('pages a registry-only keeper whose registry read fails', async () => {
    const { log, events } = createStubLogger();
    const { owners, names } = createOwnerSource(config({}), noCode, log);

    await expect(owners.getOwners()).resolves.toEqual([]);

    expect(names).toEqual(['registry']);
    expect(events).toEqual([
      'warn:keeper.job-error:vault-registry-owner-source',
      'error:keeper.job-error:vault-owner-sources',
    ]);
  });

  it('says nothing for a registry-only keeper whose registry is read and empty', async () => {
    const { log, events } = createStubLogger();
    const { owners } = createOwnerSource(config({}), emptyRegistry, log);

    await expect(owners.getOwners()).resolves.toEqual([]);
    expect(events).toEqual([]);
  });

  it('names every owner list the keeper reads', () => {
    const { log } = createStubLogger();
    const both = createOwnerSource(config({ redisConfigured: true }), emptyRegistry, log);
    const redisOnly = createOwnerSource(
      config({ redisConfigured: true, vaultRegistryAddress: undefined }),
      emptyRegistry,
      log
    );

    expect(both.names).toEqual(['registry', 'redis']);
    expect(redisOnly.names).toEqual(['redis']);
  });

  // Without readThroughUnion a healthy keeper whose
  // registry is read beside a capped indexer set paged at error on every tick, and a
  // Redis-only keeper paged twice, once from the source and once from the union.
  it('builds the Redis source to report through the union', () => {
    const { log } = createStubLogger();
    jest.mocked(createRedisVaultOwnerSource).mockClear();

    createOwnerSource(config({ redisConfigured: true }), emptyRegistry, log);

    expect(jest.mocked(createRedisVaultOwnerSource)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(createRedisVaultOwnerSource)).toHaveBeenCalledWith(11155111, log, undefined, {
      readThroughUnion: true,
    });
  });
});
