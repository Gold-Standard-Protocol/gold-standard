import { getAddress, zeroAddress } from 'viem';
import type { Address } from 'viem';
import { collateralIdForToken } from './collateral';
import type { KeeperConfig } from './config';
import type {
  KeeperJobDeps,
  KeeperLogger,
  KeeperReadClient,
  KeeperTxSender,
  OffChainPriceRead,
  OffChainPriceSource,
} from './ports';
import { createPriceWatchdog, gapBps, runPriceWatchdog } from './priceWatchdog';

const VAULT = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
const ORACLE = getAddress('0xe7f1725e7734ce288f8367e1bb143e90bb3f0512');
const PAXG = getAddress('0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9');
const XAUT = getAddress('0xdc64a140aa3e981100a9beca4e685f962f0cf6c9');
const PRIMARY_FEED = getAddress('0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0');
const GOLD_FEED = getAddress('0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6');
const KEEPER_ACCOUNT = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');

/** $4,000 in eight decimals. */
const GOLD = 400_000_000_000n;
const UPDATED_AT = 1_800_000_000n;

const baseConfig = (overrides: Partial<KeeperConfig> = {}): KeeperConfig => ({
  chainId: 11155111,
  rpcUrl: 'https://sepolia.example.org/rpc',
  dryRun: false,
  enableDirect: false,
  intervalSeconds: 60,
  goldVaultAddress: VAULT,
  goldOracleAddress: ORACLE,
  stabilityModuleAddress: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  gsusdAddress: '0x5FC8d32690cc91D4c39d9d3aBcBD16989F875707',
  stabilityPoolAddress: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
  paxgToken: PAXG,
  xautToken: undefined,
  vaultRegistryAddress: undefined,
  maxFeePerGasWei: 150n * 10n ** 9n,
  maxPriorityFeePerGasWei: 3n * 10n ** 9n,
  redisConfigured: true,
  offChainPriceSource: 'redis',
  priceApiUrl: 'https://api.coingecko.com/api/v3/simple/price',
  priceWatchdogAlertBps: 100,
  stuckTxReplaceSeconds: 300,
  readCacheMs: 4_000,
  feedHeartbeatSeconds: 86_400,
  feedLateMarginSeconds: 900,
  feedLateRepeatSeconds: 3_600,
  ...overrides,
});

interface LoggedEvent {
  level: 'info' | 'warn' | 'error';
  event: string;
  fields?: Record<string, unknown>;
}

const createStubLogger = (): { log: KeeperLogger; events: LoggedEvent[] } => {
  const events: LoggedEvent[] = [];
  const push =
    (level: LoggedEvent['level']) =>
    (event: string, fields?: Record<string, unknown>): void => {
      events.push({ level, event, fields });
    };
  return { log: { info: push('info'), warn: push('warn'), error: push('error') }, events };
};

interface OracleStubOptions {
  /** quoteTokenPrice answer, or the revert reason it fails with. */
  quote?: bigint | { revert: string };
  borrow?: bigint;
  primary?: bigint;
  /** Token whose every read throws, to prove one token cannot stop the other. */
  failFor?: Address;
  /** Tokens without an active GoldVault collateral type (XAUT on a PAXG-first launch). */
  inactive?: Address[];
}

const createOracleStub = (options: OracleStubOptions): { read: KeeperReadClient; calls: string[] } => {
  const calls: string[] = [];
  const round = (answer: bigint): readonly unknown[] => [7n, answer, UPDATED_AT, UPDATED_AT, 7n];
  const inactiveIds = new Set<unknown>((options.inactive ?? []).map(collateralIdForToken));
  return {
    calls,
    read: {
      getBlockTimestamp: async () => UPDATED_AT + 60n,
      readContract: async ({ address, functionName, args }) => {
        calls.push(functionName === 'latestRoundData' ? `latestRoundData@${address}` : functionName);
        if (options.failFor !== undefined && args?.[0] === options.failFor) {
          throw new Error('fetch failed');
        }
        switch (functionName) {
          case 'collateralTypes':
            return inactiveIds.has(args?.[0])
              ? [zeroAddress, 0n, 0n, 0n, 0n, 0n, false]
              : [PAXG, 1_200_000n, 1_100_000n, 50_000n, 0n, 0n, true];
          case 'anchorFeed':
            return GOLD_FEED;
          case 'goldBandPpm':
            return 20_000n;
          case 'liquidationClampPpm':
            return 20_000n;
          case 'stalenessThreshold':
            return 90_000n;
          case 'quoteTokenPrice': {
            const quote = options.quote ?? GOLD;
            if (typeof quote !== 'bigint') {
              throw new Error(`execution reverted: ${quote.revert}`);
            }
            return quote;
          }
          case 'quoteBorrowPrice':
            return options.borrow ?? GOLD;
          case 'feeds':
            return [PRIMARY_FEED, GOLD, true];
          case 'latestRoundData':
            if (address === PRIMARY_FEED) return round(options.primary ?? GOLD);
            if (address === GOLD_FEED) return round(GOLD);
            throw new Error(`Unexpected feed ${address}`);
          default:
            throw new Error(`Unexpected read: ${functionName}`);
        }
      },
    },
  };
};

const offChainAt = (prices: Partial<Record<Address, bigint>>): OffChainPriceSource => ({
  getUsdPrice: async (token): Promise<OffChainPriceRead> => {
    const price = prices[token];
    return price === undefined
      ? { ok: false, reason: `no cached price for ${token}` }
      : { ok: true, price, updatedAt: 1_800_000_000_000, source: 'api-cache:test' };
  },
});

const createStubTx = (): { tx: KeeperTxSender; sends: string[] } => {
  const sends: string[] = [];
  return {
    sends,
    tx: {
      account: KEEPER_ACCOUNT,
      simulateAndSend: async ({ functionName }) => {
        sends.push(functionName);
        return { ok: true, hash: `0x${'56'.repeat(32)}` };
      },
    },
  };
};

const createDeps = (
  read: KeeperReadClient,
  offChainPrices: OffChainPriceSource | undefined,
  tx?: KeeperTxSender
): { deps: KeeperJobDeps; events: LoggedEvent[] } => {
  const { log, events } = createStubLogger();
  return {
    deps: { read, tx, owners: { getOwners: async () => [] }, log, offChainPrices },
    events,
  };
};

const find = (events: LoggedEvent[], name: string): LoggedEvent | undefined =>
  events.find((entry) => entry.event === name);

describe('gapBps', () => {
  it('measures the gap against the off-chain reference in basis points', () => {
    expect(gapBps(GOLD, (GOLD * 101n) / 100n)).toBe(100n);
    expect(gapBps(GOLD, (GOLD * 99n) / 100n)).toBe(100n);
    expect(gapBps(GOLD, GOLD)).toBe(0n);
    expect(gapBps(0n, GOLD)).toBe(0n);
  });
});

describe('runPriceWatchdog', () => {
  it('stays silent while every source sits within the alert gap of the market', async () => {
    const { read } = createOracleStub({ primary: (GOLD * 1005n) / 1000n });
    const { deps, events } = createDeps(read, offChainAt({ [PAXG]: GOLD }));

    await runPriceWatchdog(deps, baseConfig());

    expect(events).toEqual([]);
  });

  it('names the primary and the quoted price when the primary feed is the one off the market', async () => {
    const off = (GOLD * 98n) / 100n;
    const { read } = createOracleStub({ quote: off, primary: off });
    const { deps, events } = createDeps(read, offChainAt({ [PAXG]: GOLD }));

    await runPriceWatchdog(deps, baseConfig());

    const alert = find(events, 'oracle.price-divergence');
    expect(alert?.level).toBe('warn');
    expect(alert?.fields).toMatchObject({
      token: PAXG,
      offChainPrice: GOLD,
      diverged: ['quoteTokenPrice', 'primary'],
      quoteGapBps: 200n,
      primaryGapBps: 200n,
      alertBps: 100,
    });
  });

  it('names the primary alone when the quote holds at gold below it', async () => {
    // C pushed down 3%: the liquidation rule still values the token at gold.
    const { read } = createOracleStub({ quote: GOLD, primary: (GOLD * 97n) / 100n });
    const { deps, events } = createDeps(read, offChainAt({ [PAXG]: GOLD }));

    await runPriceWatchdog(deps, baseConfig());

    expect(find(events, 'oracle.price-divergence')?.fields).toMatchObject({ diverged: ['primary'] });
  });

  it('honours a configured alert gap', async () => {
    const { read } = createOracleStub({ primary: (GOLD * 102n) / 100n });
    const { deps, events } = createDeps(read, offChainAt({ [PAXG]: GOLD }));

    await runPriceWatchdog(deps, baseConfig({ priceWatchdogAlertBps: 300 }));

    expect(find(events, 'oracle.price-divergence')).toBeUndefined();
  });

  it('carries a quote refusal on the divergence alert and leaves the refusal alert to the health job', async () => {
    const primary = (GOLD * 103n) / 100n;
    const { read } = createOracleStub({ quote: { revert: 'No reliable price' }, primary });
    const { deps, events } = createDeps(read, offChainAt({ [PAXG]: GOLD }));

    await runPriceWatchdog(deps, baseConfig());

    expect(events.map((entry) => entry.event)).toEqual(['oracle.price-divergence']);
    expect(find(events, 'oracle.price-divergence')?.fields).toMatchObject({
      onChainPrice: undefined,
      quoteRevertReason: 'No reliable price',
      diverged: ['primary'],
    });
  });

  it('reads no retired pool source', async () => {
    const { read, calls } = createOracleStub({});
    const { deps } = createDeps(read, offChainAt({ [PAXG]: GOLD }));

    await runPriceWatchdog(deps, baseConfig());

    expect(calls).not.toContain('confirmationFeed');
    expect(calls).not.toContain('readPrice');
  });

  it('logs one warn line for every token without an off-chain price, and no alert', async () => {
    const { read } = createOracleStub({});
    const { deps, events } = createDeps(read, offChainAt({}));

    await runPriceWatchdog(deps, baseConfig({ xautToken: XAUT }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'warn', event: 'oracle.offchain-price-missing' });
    expect(events[0]?.fields?.['tokens']).toEqual([
      { token: PAXG, reason: `no cached price for ${PAXG}` },
      { token: XAUT, reason: `no cached price for ${XAUT}` },
    ]);
  });

  it('logs the same single warn line when the keeper has no off-chain source at all', async () => {
    const { read } = createOracleStub({});
    const { deps, events } = createDeps(read, undefined);

    await runPriceWatchdog(deps, baseConfig());

    expect(events.map((entry) => `${entry.level}:${entry.event}`)).toEqual([
      'warn:oracle.offchain-price-missing',
    ]);
  });

  it('reports a missing market price once per state, not once per tick, and says when it is back', async () => {
    const { read } = createOracleStub({});
    const prices: Partial<Record<Address, bigint>> = {};
    const { deps, events } = createDeps(read, offChainAt(prices));
    const watchdog = createPriceWatchdog();
    const config = baseConfig();

    // Three ticks with the same gap: one line.
    await watchdog(deps, config);
    await watchdog(deps, config);
    await watchdog(deps, config);
    expect(events.map((entry) => `${entry.level}:${entry.event}`)).toEqual(['warn:oracle.offchain-price-missing']);

    // The price arrives: the gap closes, once.
    prices[PAXG] = GOLD;
    await watchdog(deps, config);
    await watchdog(deps, config);
    expect(events.map((entry) => `${entry.level}:${entry.event}`)).toEqual([
      'warn:oracle.offchain-price-missing',
      'info:oracle.offchain-price-restored',
    ]);

    // It goes again: reported again.
    delete prices[PAXG];
    await watchdog(deps, config);
    expect(events.map((entry) => entry.event).filter((event) => event === 'oracle.offchain-price-missing')).toHaveLength(2);
  });

  it('never sends a transaction and never calls a state-changing price function', async () => {
    const { tx, sends } = createStubTx();
    const { read, calls } = createOracleStub({ quote: (GOLD * 9n) / 10n, primary: (GOLD * 9n) / 10n });
    const { deps, events } = createDeps(read, offChainAt({ [PAXG]: GOLD }), tx);

    await runPriceWatchdog(deps, baseConfig({ dryRun: false }));

    expect(find(events, 'oracle.price-divergence')).toBeDefined();
    expect(sends).toEqual([]);
    expect(calls).not.toContain('getTokenPrice');
    expect(calls).not.toContain('getBorrowPrice');
  });

  it('skips a token that is not an active vault collateral quietly', async () => {
    const { read } = createOracleStub({ inactive: [XAUT] });
    const { deps, events } = createDeps(read, offChainAt({}));

    await runPriceWatchdog(deps, baseConfig({ xautToken: XAUT }));

    expect(events).toHaveLength(1);
    expect(events[0]?.fields?.['tokens']).toEqual([{ token: PAXG, reason: `no cached price for ${PAXG}` }]);
  });

  it('keeps watching the other token when one token fails', async () => {
    const { read } = createOracleStub({ failFor: PAXG, primary: (GOLD * 105n) / 100n });
    const { deps, events } = createDeps(read, offChainAt({ [PAXG]: GOLD, [XAUT]: GOLD }));

    await runPriceWatchdog(deps, baseConfig({ xautToken: XAUT }));

    expect(find(events, 'oracle.price-divergence')?.fields?.['token']).toBe(XAUT);
  });
});
