import { getAddress, zeroAddress } from 'viem';
import type { Address } from 'viem';
import { collateralIdForToken } from './collateral';
import type { KeeperConfig } from './config';
import { createOracleHealthWatch, runOracleHealthWatch } from './oracleHealthWatch';
import type { KeeperJobDeps, KeeperLogger, KeeperReadClient, KeeperTxSender } from './ports';

const VAULT = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
const ORACLE = getAddress('0xe7f1725e7734ce288f8367e1bb143e90bb3f0512');
const PAXG = getAddress('0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9');
const XAUT = getAddress('0xdc64a140aa3e981100a9beca4e685f962f0cf6c9');
const C_FEED = getAddress('0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0');
const G_FEED = getAddress('0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6');
const KEEPER_ACCOUNT = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');

/** $4,000 in eight decimals. */
const GOLD = 400_000_000_000n;
const NOW = 1_800_000_000n;
const FRESH = NOW - 60n;
const STALE = NOW - 90_000n;
const pct = (base: bigint, hundredths: bigint): bigint => (base * hundredths) / 10_000n;

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

interface Round {
  answer: bigint;
  updatedAt: bigint;
}

type Outcome = bigint | { revert: string } | 'unreachable';

interface StubOptions {
  paused?: boolean;
  frozen?: Address[];
  c?: Round;
  g?: Round;
  quote?: Outcome;
  borrow?: Outcome;
  reserve?: Outcome;
  /** GoldOracle.frozenUntil(token), read only for a frozen token. */
  frozenUntil?: bigint;
  /** GoldOracle.stalenessThreshold; 90,000 when unset. */
  stalenessThreshold?: bigint;
}

const fresh = (answer: bigint): Round => ({ answer, updatedAt: FRESH });

/** The variant C liquidation price for the default 2% cap: min(max(C, G), G x 1.02). */
const ruleFor = (c: bigint, g: bigint = GOLD): bigint => {
  const cap = pct(g, 10_200n);
  const high = c > g ? c : g;
  return high > cap ? cap : high;
};

const createStub = (options: StubOptions): { read: KeeperReadClient; calls: string[] } => {
  const calls: string[] = [];
  const round = ({ answer, updatedAt }: Round): readonly unknown[] => [5n, answer, updatedAt, updatedAt, 5n];
  // Read at call time, so a spec can move the feed between ticks.
  const current = (): Round => options.c ?? fresh(GOLD);
  const outcome = (value: Outcome | undefined, fallback: bigint): bigint => {
    const resolved = value ?? fallback;
    if (resolved === 'unreachable') throw new Error('fetch failed');
    if (typeof resolved !== 'bigint') throw new Error(`execution reverted: ${resolved.revert}`);
    return resolved;
  };
  return {
    calls,
    read: {
      getBlockTimestamp: async () => NOW,
      readContract: async ({ address, functionName, args }) => {
        calls.push(functionName);
        const token = args?.[0];
        switch (functionName) {
          case 'paused':
            return options.paused ?? false;
          case 'collateralTypes':
            // Every token is an active collateral here; withInactive below overrides it.
            return [PAXG, 1_200_000n, 1_100_000n, 50_000n, 0n, 0n, true];
          case 'tokenFrozen':
            return (options.frozen ?? []).includes(token as Address);
          case 'feeds':
            return [C_FEED, GOLD, true];
          case 'anchorFeed':
            return G_FEED;
          case 'goldBandPpm':
            return 20_000n;
          case 'liquidationClampPpm':
            return 20_000n;
          case 'stalenessThreshold':
            return options.stalenessThreshold ?? 90_000n;
          case 'frozenUntil':
            return options.frozenUntil ?? 0n;
          case 'latestRoundData':
            if (address === C_FEED) return round(current());
            if (address === G_FEED) return round(options.g ?? fresh(GOLD));
            throw new Error(`Unexpected feed ${address}`);
          case 'quoteTokenPrice':
            return outcome(options.quote, ruleFor(current().answer));
          case 'quoteBorrowPrice':
            return outcome(options.borrow, current().answer < GOLD ? current().answer : GOLD);
          case 'quoteReservePrice':
            return outcome(options.reserve, current().answer > GOLD ? current().answer : GOLD);
          default:
            throw new Error(`Unexpected read: ${functionName}`);
        }
      },
    },
  };
};

/** Answers collateralTypes as inactive for the listed tokens, keyed by the id the job asks for. */
const withInactive = (read: KeeperReadClient, inactiveIds: Set<unknown>): KeeperReadClient => ({
  ...read,
  readContract: async (call) =>
    call.functionName === 'collateralTypes' && inactiveIds.has(call.args?.[0])
      ? [zeroAddress, 0n, 0n, 0n, 0n, 0n, false]
      : read.readContract(call),
});

const createDeps = (
  read: KeeperReadClient,
  tx?: KeeperTxSender
): { deps: KeeperJobDeps; events: LoggedEvent[]; sends: string[] } => {
  const { log, events } = createStubLogger();
  const sends: string[] = [];
  const sender: KeeperTxSender = tx ?? {
    account: KEEPER_ACCOUNT,
    simulateAndSend: async ({ functionName }) => {
      sends.push(functionName);
      return { ok: true, hash: `0x${'78'.repeat(32)}` };
    },
  };
  return { deps: { read, tx: sender, owners: { getOwners: async () => [] }, log }, events, sends };
};

const find = (events: LoggedEvent[], name: string): LoggedEvent | undefined =>
  events.find((entry) => entry.event === name);

describe('runOracleHealthWatch (variant C)', () => {
  it('stays silent in normal operation', async () => {
    const { read } = createStub({ c: fresh(pct(GOLD, 10_050n)) });
    const { deps, events, sends } = createDeps(read);

    await runOracleHealthWatch(deps, baseConfig());

    expect(events).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('stays silent while C sits below gold inside the band, where liquidation values the token at gold', async () => {
    const { read } = createStub({ c: fresh(pct(GOLD, 9_900n)) });
    const { deps, events } = createDeps(read);

    await runOracleHealthWatch(deps, baseConfig());

    expect(events).toEqual([]);
  });

  it('reports a refused price at error level, naming the unhealthy feed, with a guardian hint', async () => {
    const { read } = createStub({
      c: { answer: GOLD, updatedAt: STALE },
      quote: { revert: 'No reliable price' },
      borrow: { revert: 'No reliable price' },
      reserve: { revert: 'No reliable price' },
    });
    const { deps, events } = createDeps(read);

    await runOracleHealthWatch(deps, baseConfig());

    const alert = find(events, 'oracle.price-refused');
    expect(alert?.level).toBe('error');
    expect(alert?.fields).toMatchObject({
      token: PAXG,
      reason: 'No reliable price',
      refusedBy: 'no-reliable-price',
      stoppedSources: ['C'],
      primaryStatus: 'stale',
      borrowRefusedReason: 'No reliable price',
      reserveRefusedReason: 'No reliable price',
    });
    expect(String(alert?.fields?.['detail'])).toContain('C has stopped (stale)');
    expect(String(alert?.fields?.['guardianHint'])).toContain('resume by themselves');
    expect(String(alert?.fields?.['guardianHint'])).not.toContain('lastKnownPrice and a valid C');
  });

  it('warns feed-invalid for each unhealthy feed, G included', async () => {
    const { read } = createStub({
      g: { answer: GOLD, updatedAt: STALE },
      quote: { revert: 'No reliable price' },
      borrow: { revert: 'No reliable price' },
      reserve: { revert: 'No reliable price' },
    });
    const { deps, events } = createDeps(read);

    await runOracleHealthWatch(deps, baseConfig());

    const invalid = find(events, 'oracle.feed-invalid');
    expect(invalid?.level).toBe('warn');
    expect(invalid?.fields).toMatchObject({ token: PAXG, stoppedSources: ['G'], goldStatus: 'stale' });
    expect(String(invalid?.fields?.['detail'])).toContain('G has stopped (stale)');
    expect(find(events, 'oracle.price-refused')?.fields).toMatchObject({ stoppedSources: ['G'] });
  });

  it('warns off-gold-band below the band: borrowing and reserve refused, liquidation values the token at gold', async () => {
    const c = pct(GOLD, 9_500n);
    const { read } = createStub({
      c: fresh(c),
      borrow: { revert: 'Off gold band' },
      reserve: { revert: 'Off gold band' },
    });
    const { deps, events } = createDeps(read);

    await runOracleHealthWatch(deps, baseConfig());

    const alert = find(events, 'oracle.off-gold-band');
    expect(alert?.level).toBe('warn');
    expect(alert?.fields).toMatchObject({
      token: PAXG,
      side: 'below',
      rule: 'at-gold',
      liquidationPrice: GOLD,
      primaryGoldGapPpm: 50_000n,
      borrowRefusedReason: 'Off gold band',
      reserveRefusedReason: 'Off gold band',
    });
    const detail = String(alert?.fields?.['detail']);
    expect(detail).toContain('borrowing and reserve swaps are refused');
    expect(detail).toContain('values the token at gold');
    expect(detail).toContain('not liquidated');
    expect(find(events, 'oracle.price-refused')).toBeUndefined();
  });

  it('warns off-gold-band and premium-capped above the band, with the cap below the market', async () => {
    const c = pct(GOLD, 10_500n);
    const { read } = createStub({
      c: fresh(c),
      borrow: { revert: 'Off gold band' },
      reserve: { revert: 'Off gold band' },
    });
    const { deps, events } = createDeps(read);

    await runOracleHealthWatch(deps, baseConfig());

    expect(find(events, 'oracle.off-gold-band')?.fields).toMatchObject({ side: 'above', rule: 'premium-capped' });
    const capped = find(events, 'oracle.premium-capped');
    expect(capped?.level).toBe('warn');
    expect(capped?.fields).toMatchObject({
      token: PAXG,
      primaryPrice: c,
      liquidationPrice: pct(GOLD, 10_200n),
      liquidationCap: pct(GOLD, 10_200n),
    });
  });

  it('warns borrow-refused when liquidation prices inside the band yet borrowing or the reserve is refused', async () => {
    const { read } = createStub({ borrow: { revert: 'Off gold band' } });
    const { deps, events } = createDeps(read);

    await runOracleHealthWatch(deps, baseConfig());

    const alert = find(events, 'oracle.borrow-refused');
    expect(alert?.level).toBe('warn');
    expect(alert?.fields).toMatchObject({ borrowRefusedReason: 'Off gold band', liquidationPrice: GOLD });
  });

  it('never reads a retired view and never emits a retired alert', async () => {
    const { read, calls } = createStub({ c: fresh(pct(GOLD, 9_000n)), borrow: { revert: 'Off gold band' }, reserve: { revert: 'Off gold band' } });
    const { deps, events } = createDeps(read);

    await runOracleHealthWatch(deps, baseConfig());

    for (const name of ['confirmationFeed', 'agreementBandPpm', 'breachSince', 'quoteBreach', 'quoteLiquidationFloor', 'quoteDepth', 'readPrice']) {
      expect(calls).not.toContain(name);
    }
    for (const name of ['oracle.band-breach', 'oracle.depth-observation-late']) {
      expect(events.map((entry) => entry.event)).not.toContain(name);
    }
  });

  it('reads only the pause while the oracle is paused', async () => {
    const { read, calls } = createStub({ paused: true });
    const { deps, events } = createDeps(read);

    await runOracleHealthWatch(deps, baseConfig());

    expect(events.map((entry) => `${entry.level}:${entry.event}`)).toEqual(['info:oracle.already-paused']);
    expect(calls).toEqual(['paused']);
  });

  it('notes a frozen token at info with when the freeze lapses, and still watches the other', async () => {
    const until = NOW + 14n * 86_400n;
    const { read } = createStub({ frozen: [PAXG], frozenUntil: until, quote: { revert: 'No reliable price' } });
    const { deps, events } = createDeps(read);

    await runOracleHealthWatch(deps, baseConfig({ xautToken: XAUT }));

    expect(find(events, 'oracle.token-already-frozen')?.fields).toMatchObject({ token: PAXG, frozenUntil: until });
    expect(find(events, 'oracle.price-refused')?.fields).toMatchObject({ token: XAUT });
  });

  it('skips a token that is not an active vault collateral without a word', async () => {
    const stub = createStub({ quote: { revert: 'No reliable price' } });
    const read = withInactive(stub.read, new Set([collateralIdForToken(XAUT)]));
    const { deps, events } = createDeps(read);

    await runOracleHealthWatch(deps, baseConfig({ xautToken: XAUT }));

    expect(events.map((entry) => entry.fields?.['token'])).toEqual([PAXG]);
  });

  it('never sends and never calls a state-changing oracle function', async () => {
    const { read, calls } = createStub({
      c: { answer: GOLD, updatedAt: STALE },
      quote: { revert: 'No reliable price' },
    });
    const { deps, sends } = createDeps(read);

    await runOracleHealthWatch(deps, baseConfig({ dryRun: false }));

    expect(sends).toEqual([]);
    for (const name of ['freezeToken', 'getTokenPrice', 'getBorrowPrice', 'getReservePrice', 'observeBand']) {
      expect(calls).not.toContain(name);
    }
  });

  it('reports an unreachable quote as a job error, not as a refusal', async () => {
    const { read } = createStub({ quote: 'unreachable' });
    const { deps, events } = createDeps(read);

    await runOracleHealthWatch(deps, baseConfig());

    expect(find(events, 'oracle.price-refused')).toBeUndefined();
    expect(find(events, 'keeper.job-error')?.fields).toMatchObject({ job: 'oracle-health', token: PAXG });
  });

  it('never throws when every read fails', async () => {
    const failing: KeeperReadClient = {
      readContract: async () => {
        throw new Error('rpc down');
      },
    };
    const { deps, events } = createDeps(failing);

    await expect(runOracleHealthWatch(deps, baseConfig())).resolves.toBeUndefined();
    expect(find(events, 'keeper.job-error')).toBeDefined();
  });
});

// The oracle refuses a token once
// C or G is 90,000 s old and both launch feeds write every 24 hours, so a heartbeat about an
// hour late stops borrowing, reserve swaps and liquidation. The keeper said nothing before
// the refusal; it now warns once a feed that still prices passes its heartbeat plus a margin.
describe('the oracle health watch early warning for a late feed', () => {
  const HEARTBEAT = 86_400n;
  const MARGIN = 900n;
  const aged = (seconds: bigint): Round => ({ answer: GOLD, updatedAt: NOW - seconds });
  const late = (events: LoggedEvent[]): LoggedEvent[] => events.filter((entry) => entry.event === 'oracle.feed-late');

  /** A watch with a clock the spec moves, in milliseconds. */
  const clocked = (options: StubOptions) => {
    const clock = { at: 1_000_000 };
    const { read } = createStub(options);
    const { deps, events } = createDeps(read);
    return { deps: { ...deps, now: () => clock.at }, events, clock, options };
  };

  it('says nothing at exactly the heartbeat plus the margin', async () => {
    const { deps, events } = clocked({ c: aged(HEARTBEAT + MARGIN), g: aged(HEARTBEAT + MARGIN) });

    await createOracleHealthWatch()(deps, baseConfig());

    expect(events).toEqual([]);
  });

  it('warns one second past the heartbeat plus the margin, naming the feed and the time left', async () => {
    const { deps, events } = clocked({ c: aged(HEARTBEAT + MARGIN + 1n) });

    await createOracleHealthWatch()(deps, baseConfig());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'warn',
      event: 'oracle.feed-late',
      fields: {
        token: PAXG,
        source: 'C',
        feed: C_FEED,
        updatedAt: NOW - 87_301n,
        ageSeconds: 87_301n,
        heartbeatSeconds: 86_400,
        marginSeconds: 900,
        lateAfterSeconds: 87_300n,
        stalenessThreshold: 90_000n,
        secondsUntilRefused: 2_699n,
      },
    });
  });

  it('warns for the gold reference as well as the market feed', async () => {
    const { deps, events } = clocked({ c: aged(88_000n), g: aged(89_000n) });

    await createOracleHealthWatch()(deps, baseConfig());

    expect(late(events).map((entry) => entry.fields?.['source'])).toEqual(['C', 'G']);
  });

  it('warns once for a gold reference two tokens share', async () => {
    const { deps, events } = clocked({ g: aged(88_000n) });

    await createOracleHealthWatch()(deps, baseConfig({ xautToken: XAUT }));

    expect(late(events)).toHaveLength(1);
    expect(late(events)[0]?.fields).toMatchObject({ source: 'G', feed: G_FEED });
  });

  it('warns when the feed turns late and then at most once per repeat interval', async () => {
    const { deps, events, clock } = clocked({ c: aged(88_000n) });
    const watch = createOracleHealthWatch();
    const config = baseConfig({ feedLateRepeatSeconds: 3_600 });

    await watch(deps, config);
    clock.at += 60_000;
    await watch(deps, config);
    clock.at += 3_539_000;
    await watch(deps, config);
    expect(late(events)).toHaveLength(1);

    clock.at += 1_000;
    await watch(deps, config);
    expect(late(events)).toHaveLength(2);
  });

  it('warns at once for a new late spell after the feed wrote again', async () => {
    const { deps, events, clock, options } = clocked({ c: aged(88_000n) });
    const watch = createOracleHealthWatch();

    await watch(deps, baseConfig());
    options.c = fresh(GOLD);
    clock.at += 60_000;
    await watch(deps, baseConfig());
    options.c = aged(88_000n);
    clock.at += 60_000;
    await watch(deps, baseConfig());

    expect(late(events)).toHaveLength(2);
  });

  it('leaves a feed that is already stale to the refusal events, which stay at error', async () => {
    const { deps, events } = clocked({ c: aged(90_000n), quote: { revert: 'No reliable price' } });

    await createOracleHealthWatch()(deps, baseConfig());

    expect(late(events)).toEqual([]);
    expect(find(events, 'oracle.price-refused')?.level).toBe('error');
    expect(find(events, 'oracle.feed-invalid')?.level).toBe('warn');
  });

  it('follows a configured heartbeat and margin', async () => {
    const config = baseConfig({ feedHeartbeatSeconds: 3_600, feedLateMarginSeconds: 0 });
    const onTime = clocked({ c: aged(3_600n) });
    const overdue = clocked({ c: aged(3_601n) });

    await createOracleHealthWatch()(onTime.deps, config);
    await createOracleHealthWatch()(overdue.deps, config);

    expect(late(onTime.events)).toEqual([]);
    expect(late(overdue.events)).toHaveLength(1);
  });

  describe('when the heartbeat plus the margin is not below the oracle stalenessThreshold', () => {
    const conflicts = (events: LoggedEvent[]): LoggedEvent[] =>
      late(events).filter((entry) => entry.fields?.['source'] === undefined);
    const feeds = (events: LoggedEvent[]): LoggedEvent[] =>
      late(events).filter((entry) => entry.fields?.['source'] !== undefined);

    it('says the configured warning cannot fire and falls back to the heartbeat alone', async () => {
      const { deps, events } = clocked({ stalenessThreshold: 87_000n, c: aged(86_401n) });

      await createOracleHealthWatch()(deps, baseConfig());

      expect(conflicts(events)).toHaveLength(1);
      expect(conflicts(events)[0]).toMatchObject({
        level: 'warn',
        fields: {
          token: PAXG,
          heartbeatSeconds: 86_400,
          marginSeconds: 900,
          configuredLateAfterSeconds: 87_300n,
          lateAfterSeconds: 86_400n,
          stalenessThreshold: 87_000n,
        },
      });
      expect(String(conflicts(events)[0]?.fields?.['detail'])).toContain('KEEPER_FEED_LATE_MARGIN_SECONDS');
      expect(feeds(events)).toHaveLength(1);
      expect(feeds(events)[0]?.fields).toMatchObject({
        source: 'C',
        ageSeconds: 86_401n,
        configuredLateAfterSeconds: 87_300n,
        lateAfterSeconds: 86_400n,
        secondsUntilRefused: 599n,
      });
      expect(String(feeds(events)[0]?.fields?.['detail'])).toContain('past the fallback late mark (86400 s)');
    });

    it('names the conflict even while every feed is fresh, and no feed as late', async () => {
      const { deps, events } = clocked({ stalenessThreshold: 87_000n, c: aged(86_400n) });

      await createOracleHealthWatch()(deps, baseConfig());

      expect(conflicts(events)).toHaveLength(1);
      expect(feeds(events)).toEqual([]);
    });

    it('treats a mark one second below the threshold as unreachable, since that age is already stale', async () => {
      const reachable = clocked({ stalenessThreshold: 87_302n });
      const unreachable = clocked({ stalenessThreshold: 87_301n });

      await createOracleHealthWatch()(reachable.deps, baseConfig());
      await createOracleHealthWatch()(unreachable.deps, baseConfig());

      expect(late(reachable.events)).toEqual([]);
      expect(conflicts(unreachable.events)).toHaveLength(1);
    });

    it('falls back to half the threshold when the heartbeat leaves no room either', async () => {
      const onTime = clocked({ stalenessThreshold: 300n, c: aged(150n), g: aged(150n) });
      const overdue = clocked({ stalenessThreshold: 300n, c: aged(151n), g: aged(150n) });

      await createOracleHealthWatch()(onTime.deps, baseConfig());
      await createOracleHealthWatch()(overdue.deps, baseConfig());

      expect(feeds(onTime.events)).toEqual([]);
      expect(conflicts(onTime.events)[0]?.fields).toMatchObject({ lateAfterSeconds: 150n });
      expect(feeds(overdue.events)).toHaveLength(1);
      expect(feeds(overdue.events)[0]?.fields).toMatchObject({ lateAfterSeconds: 150n, secondsUntilRefused: 149n });
    });

    it('repeats the conflict at most once per repeat interval, once per token', async () => {
      const { deps, events, clock } = clocked({ stalenessThreshold: 87_000n });
      const watch = createOracleHealthWatch();
      const config = baseConfig({ xautToken: XAUT, feedLateRepeatSeconds: 3_600 });

      await watch(deps, config);
      clock.at += 3_599_000;
      await watch(deps, config);
      expect(conflicts(events).map((entry) => entry.fields?.['token'])).toEqual([PAXG, XAUT]);

      clock.at += 1_000;
      await watch(deps, config);
      expect(conflicts(events)).toHaveLength(4);
    });

    it('warns at once when the conflict returns after the threshold was raised again', async () => {
      const { deps, events, clock, options } = clocked({ stalenessThreshold: 87_000n });
      const watch = createOracleHealthWatch();

      await watch(deps, baseConfig());
      options.stalenessThreshold = 90_000n;
      clock.at += 60_000;
      await watch(deps, baseConfig());
      options.stalenessThreshold = 87_000n;
      clock.at += 60_000;
      await watch(deps, baseConfig());

      expect(conflicts(events)).toHaveLength(2);
    });
  });

  it('says nothing when the block timestamp cannot be read, since the age is then unknown', async () => {
    const { deps, events } = clocked({ c: aged(88_000n) });
    const blind: KeeperJobDeps = { ...deps, read: { readContract: deps.read.readContract } };

    await createOracleHealthWatch()(blind, baseConfig());

    expect(late(events)).toEqual([]);
  });

  it('has no memory when run as a single tick', async () => {
    const { deps, events } = clocked({ c: aged(88_000n) });

    await runOracleHealthWatch(deps, baseConfig());
    await runOracleHealthWatch(deps, baseConfig());

    expect(late(events)).toHaveLength(2);
  });
});
