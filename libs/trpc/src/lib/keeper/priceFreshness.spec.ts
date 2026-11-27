import { getAddress, zeroAddress } from 'viem';
import type { Address } from 'viem';
import { collateralIdForToken } from './collateral';
import type { KeeperConfig } from './config';
import { runPriceFreshness } from './priceFreshness';
import type {
  KeeperJobDeps,
  KeeperLogger,
  KeeperReadClient,
  KeeperTxSender,
} from './ports';

const VAULT = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
const ORACLE = getAddress('0xe7f1725e7734ce288f8367e1bb143e90bb3f0512');
const STABILITY_MODULE = getAddress(
  '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0'
);
const PAXG = getAddress('0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9');
const XAUT = getAddress('0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6');
const POOL = getAddress('0xdc64a140aa3e981100a9beca4e685f962f0cf6c9');
const GSUSD = getAddress('0x5fc8d32690cc91d4c39d9d3abcbd16989f875707');
const KEEPER_ACCOUNT = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');
const TX_HASH = `0x${'34'.repeat(32)}` as const;

/** The deployed default gold band, 2% in parts per million: the poke band is half of it. */
const GOLD_BAND_PPM = 20_000n;
/** $2000/oz, 8 decimals: what quoteTokenPrice answers by default. */
const LIVE = 200_000_000_000n;
/** The latest block's timestamp in every fixture. */
const NOW = 1_800_000_000n;

const baseConfig = (overrides: Partial<KeeperConfig> = {}): KeeperConfig => ({
  chainId: 11155111,
  rpcUrl: 'https://sepolia.example.org/rpc',
  dryRun: false,
  enableDirect: false,
  intervalSeconds: 60,
  goldVaultAddress: VAULT,
  goldOracleAddress: ORACLE,
  stabilityModuleAddress: STABILITY_MODULE,
  gsusdAddress: GSUSD,
  stabilityPoolAddress: POOL,
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
  return {
    log: {
      info: (event, fields) => events.push({ level: 'info', event, fields }),
      warn: (event, fields) => events.push({ level: 'warn', event, fields }),
      error: (event, fields) => events.push({ level: 'error', event, fields }),
    },
    events,
  };
};

interface ReadStubOptions {
  lastKnown?: bigint;
  /** quoteTokenPrice: the price getTokenPrice would record now. */
  quoted?: bigint;
  /** Make quoteTokenPrice refuse with this reason ("Off gold band" and so on). */
  quoteRevert?: string;
  goldBandPpm?: bigint;
  paused?: boolean;
  /** Tokens the guardian or governance has frozen. */
  frozen?: Address[];
  /** Tokens without an active GoldVault collateral type (XAUT on a PAXG-first launch). */
  inactive?: Address[];
  throwOn?: string;
}

const createStubRead = (
  options: ReadStubOptions = {}
): { read: KeeperReadClient; calls: { functionName: string; token: unknown }[] } => {
  const calls: { functionName: string; token: unknown }[] = [];
  const inactiveIds = new Set<unknown>((options.inactive ?? []).map(collateralIdForToken));
  return {
    calls,
    read: {
      getBlockTimestamp: async () => NOW,
      readContract: async ({ functionName, args }) => {
        calls.push({ functionName, token: args?.[0] });
        if (options.throwOn === functionName) {
          throw new Error('rpc down');
        }
        switch (functionName) {
          case 'paused':
            return options.paused ?? false;
          case 'collateralTypes':
            return inactiveIds.has(args?.[0])
              ? [zeroAddress, 0n, 0n, 0n, 0n, 0n, false]
              : [PAXG, 1_200_000n, 1_100_000n, 50_000n, 0n, 0n, true];
          case 'tokenFrozen':
            return (options.frozen ?? []).includes(args?.[0] as Address);
          case 'quoteTokenPrice':
            if (options.quoteRevert !== undefined) {
              throw new Error(`execution reverted: ${options.quoteRevert}`);
            }
            return options.quoted ?? LIVE;
          case 'getLastKnownPrice':
            return options.lastKnown ?? LIVE;
          case 'goldBandPpm':
            return options.goldBandPpm ?? GOLD_BAND_PPM;
          default:
            throw new Error(`Unexpected read: ${functionName} ${String(args)}`);
        }
      },
    },
  };
};

interface StubTx {
  tx: KeeperTxSender;
  sends: { address: Address; functionName: string; args: readonly unknown[] }[];
}

const createStubTx = (ok = true): StubTx => {
  const sends: StubTx['sends'] = [];
  return {
    tx: {
      account: KEEPER_ACCOUNT,
      simulateAndSend: async ({ address, functionName, args }) => {
        sends.push({ address, functionName, args });
        return ok
          ? { ok: true, hash: TX_HASH }
          : { ok: false, reason: 'reverted' };
      },
    },
    sends,
  };
};

const createDeps = (
  read: KeeperReadClient,
  tx: KeeperTxSender | undefined
): { deps: KeeperJobDeps; events: LoggedEvent[] } => {
  const { log, events } = createStubLogger();
  return {
    deps: { read, tx, owners: { getOwners: async () => [] }, log },
    events,
  };
};

const eventNames = (events: LoggedEvent[]): string[] =>
  events.map((entry) => entry.event);

describe('runPriceFreshness', () => {
  it('does nothing while lastKnownPrice sits within half the gold band of the quoted price', async () => {
    const { tx, sends } = createStubTx();
    const { read } = createStubRead({ lastKnown: LIVE, quoted: (LIVE * 1005n) / 1000n });
    const { deps, events } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig());

    expect(sends).toEqual([]);
    expect(events).toEqual([]);
  });

  it('re-anchors lastKnownPrice once drift reaches half the gold band', async () => {
    const quoted = (LIVE * 1015n) / 1000n;
    const { tx, sends } = createStubTx();
    const { read } = createStubRead({ lastKnown: LIVE, quoted });
    const { deps, events } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig());

    expect(sends).toEqual([{ address: ORACLE, functionName: 'getTokenPrice', args: [PAXG] }]);
    expect(events.find((entry) => entry.event === 'oracle.price-stale')?.fields).toMatchObject({
      token: PAXG,
      lastKnownPrice: LIVE,
      quotedPrice: quoted,
      pokeThreshold: GOLD_BAND_PPM / 2n,
      unseeded: false,
    });
    expect(events.find((entry) => entry.event === 'oracle.price-reanchored')?.fields).toMatchObject({
      from: LIVE,
      to: quoted,
    });
  });

  it('reads the poke band from the token\'s own gold band', async () => {
    const { tx, sends } = createStubTx();
    const { read } = createStubRead({ lastKnown: LIVE, quoted: (LIVE * 102n) / 100n, goldBandPpm: 50_000n });
    const { deps } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig());

    expect(sends).toEqual([]);
  });

  it('seeds an unread token whose lastKnownPrice is still zero', async () => {
    const { tx, sends } = createStubTx();
    const { read } = createStubRead({ lastKnown: 0n });
    const { deps } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig());

    expect(sends).toHaveLength(1);
    expect(sends[0]?.functionName).toBe('getTokenPrice');
  });

  it.each(['No reliable price'])(
    'stays silent and sends nothing while quoteTokenPrice refuses with %s',
    async (reason) => {
      // The oracle health job reports the refusal once per tick; a poke would revert.
      const { tx, sends } = createStubTx();
      const { read } = createStubRead({ lastKnown: 0n, quoteRevert: reason });
      const { deps, events } = createDeps(read, tx);

      await runPriceFreshness(deps, baseConfig());

      expect(sends).toEqual([]);
      expect(events).toEqual([]);
    }
  );

  it('stays silent while the oracle is paused, since getTokenPrice is whenNotPaused', async () => {
    const { tx, sends } = createStubTx();
    const { read } = createStubRead({ paused: true, lastKnown: LIVE, quoted: LIVE * 2n });
    const { deps, events } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig());

    expect(sends).toEqual([]);
    expect(events).toEqual([]);
  });

  it('skips a frozen token, whose getTokenPrice reverts, and still pokes the others', async () => {
    const { tx, sends } = createStubTx();
    const { read } = createStubRead({ frozen: [PAXG], lastKnown: LIVE, quoted: (LIVE * 106n) / 100n });
    const { deps, events } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig({ xautToken: XAUT }));

    expect(sends.map((send) => send.args[0])).toEqual([XAUT]);
    expect(eventNames(events)).not.toContain('keeper.job-error');
  });

  it('skips a token that is not an active vault collateral quietly, before any price read', async () => {
    const { tx, sends } = createStubTx();
    const { read, calls } = createStubRead({ inactive: [XAUT], lastKnown: 0n });
    const { deps, events } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig({ xautToken: XAUT }));

    expect(sends.map((send) => send.args[0])).toEqual([PAXG]);
    expect(events.filter((entry) => entry.fields?.['token'] === XAUT)).toEqual([]);
    expect(calls.filter((call) => call.token === XAUT)).toEqual([]);
  });

  it('sends nothing in dry run but still reports the drift', async () => {
    const { tx, sends } = createStubTx();
    const { read } = createStubRead({ lastKnown: LIVE, quoted: (LIVE * 106n) / 100n });
    const { deps, events } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig({ dryRun: true }));

    expect(sends).toEqual([]);
    expect(eventNames(events)).toContain('oracle.price-stale');
    expect(eventNames(events)).toContain('keeper.dry-run');
  });

  it('covers XAUT too once it is an active collateral', async () => {
    const { tx, sends } = createStubTx();
    const { read } = createStubRead({ lastKnown: LIVE, quoted: (LIVE * 106n) / 100n });
    const { deps } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig({ xautToken: XAUT }));

    expect(sends.map((send) => send.args[0])).toEqual([PAXG, XAUT]);
  });

  it('never throws when a read fails, and keeps going', async () => {
    const { tx } = createStubTx();
    const { read } = createStubRead({ throwOn: 'getLastKnownPrice' });
    const { deps, events } = createDeps(read, tx);

    await expect(runPriceFreshness(deps, baseConfig({ xautToken: XAUT }))).resolves.toBeUndefined();
    expect(events.filter((entry) => entry.event === 'keeper.job-error')).toHaveLength(2);
  });

  it('reports a failed re-anchor rather than swallowing it', async () => {
    const { tx } = createStubTx(false);
    const { read } = createStubRead({ lastKnown: LIVE, quoted: (LIVE * 106n) / 100n });
    const { deps, events } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig());

    expect(eventNames(events)).toContain('keeper.tx-failed');
  });
});

describe('runPriceFreshness waits for the poke to mine', () => {
  const withReceipt = (
    outcome: 'success' | 'reverted' | 'throw'
  ): { tx: KeeperTxSender; order: string[] } => {
    const order: string[] = [];
    const { tx } = createStubTx();
    return {
      order,
      tx: {
        ...tx,
        simulateAndSend: async (call) => {
          order.push(`send:${call.functionName}`);
          return tx.simulateAndSend(call);
        },
        waitForReceipt: async (hash) => {
          order.push(`wait:${hash}`);
          if (outcome === 'throw') throw new Error('receipt wait timed out');
          return { status: outcome };
        },
      },
    };
  };

  it('returns only after the getTokenPrice receipt, and reports the re-anchor once it has mined', async () => {
    const { tx, order } = withReceipt('success');
    const { read } = createStubRead({ lastKnown: LIVE, quoted: (LIVE * 106n) / 100n });
    const { deps, events } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig());

    expect(order).toEqual(['send:getTokenPrice', `wait:${TX_HASH}`]);
    expect(eventNames(events)).toContain('oracle.price-reanchored');
  });

  it('reports a poke that reverted on chain as failed, not re-anchored', async () => {
    const { tx } = withReceipt('reverted');
    const { read } = createStubRead({ lastKnown: LIVE, quoted: (LIVE * 106n) / 100n });
    const { deps, events } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig());

    expect(eventNames(events)).not.toContain('oracle.price-reanchored');
    expect(events.find((entry) => entry.event === 'keeper.tx-failed')?.fields).toMatchObject({
      functionName: 'getTokenPrice',
      hash: TX_HASH,
    });
  });

  it('reports an unreadable poke receipt as an unknown outcome with the hash', async () => {
    const { tx } = withReceipt('throw');
    const { read } = createStubRead({ lastKnown: LIVE, quoted: (LIVE * 106n) / 100n });
    const { deps, events } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig());

    expect(eventNames(events)).not.toContain('oracle.price-reanchored');
    expect(events.find((entry) => entry.event === 'keeper.tx-outcome-unknown')?.fields).toMatchObject({
      functionName: 'getTokenPrice',
      hash: TX_HASH,
      reason: 'receipt wait timed out',
    });
  });
});

describe('runPriceFreshness under variant C: no observation duty', () => {
  it('sends only the getTokenPrice poke and reads no band, breach, floor or depth view', async () => {
    const { tx, sends } = createStubTx();
    const { read, calls } = createStubRead({ lastKnown: LIVE, quoted: (LIVE * 106n) / 100n });
    const { deps, events } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig());

    expect(sends.map((send) => send.functionName)).toEqual(['getTokenPrice']);
    const retired = ['observeBand', 'quoteBreach', 'quoteLiquidationFloor', 'quoteDepth', 'depthRecord', 'MAX_OBSERVATION_GAP'];
    expect(calls.filter((call) => retired.includes(call.functionName))).toEqual([]);
    expect(eventNames(events)).not.toContain('oracle.band-breach');
    expect(eventNames(events)).not.toContain('oracle.depth-observation-late');
  });

  it('sends nothing at all while the price sits off the gold band and the quote holds still', async () => {
    // Off the band below, quoteTokenPrice values the token at gold; nothing needs recording.
    const { tx, sends } = createStubTx();
    const { read } = createStubRead({ lastKnown: LIVE, quoted: LIVE });
    const { deps, events } = createDeps(read, tx);

    await runPriceFreshness(deps, baseConfig());

    expect(sends).toEqual([]);
    expect(events).toEqual([]);
  });
});
