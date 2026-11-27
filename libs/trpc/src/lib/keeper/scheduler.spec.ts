import { getAddress } from 'viem';
import type { Address } from 'viem';
import type { KeeperConfig } from './config';
import { createTallyingLogger } from './heartbeat';
import { runLiquidationWatch } from './liquidationWatch';
import type { KeeperJobDeps, KeeperLogger, KeeperReadClient, KeeperTxSender } from './ports';
import { runPriceFreshness } from './priceFreshness';
import { startKeeper } from './scheduler';
import type { KeeperJobs } from './scheduler';

const VAULT = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
const ORACLE = getAddress('0xe7f1725e7734ce288f8367e1bb143e90bb3f0512');
const STABILITY_MODULE = getAddress(
  '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0'
);
const PAXG = getAddress('0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9');

const INTERVAL_MS = 60_000;
/** The first tick runs at start: advancing by nothing lets it finish. */
const START = 0;

const TEST_CONFIG: KeeperConfig = {
  chainId: 11155111,
  rpcUrl: 'https://sepolia.example.org/rpc',
  dryRun: true,
  enableDirect: false,
  intervalSeconds: 60,
  goldVaultAddress: VAULT,
  goldOracleAddress: ORACLE,
  stabilityModuleAddress: STABILITY_MODULE,
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
};

interface LoggedEvent {
  level: 'info' | 'warn' | 'error';
  event: string;
  fields?: Record<string, unknown>;
}

const createStubLogger = (): { log: KeeperLogger; events: LoggedEvent[] } => {
  const events: LoggedEvent[] = [];
  return {
    log: {
      info: (event, fields) => {
        events.push({ level: 'info', event, fields });
      },
      warn: (event, fields) => {
        events.push({ level: 'warn', event, fields });
      },
      error: (event, fields) => {
        events.push({ level: 'error', event, fields });
      },
    },
    events,
  };
};

const createDeps = (): { deps: KeeperJobDeps; events: LoggedEvent[] } => {
  const { log, events } = createStubLogger();
  return {
    deps: {
      read: {
        readContract: async () => {
          throw new Error('not used by scheduler specs');
        },
      },
      tx: undefined,
      owners: { getOwners: async () => [] },
      log,
    },
    events,
  };
};

describe('startKeeper', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // A start, deploy or crash restart waited a
  // full interval before the first health check and walk.
  it('runs the first tick at start, without waiting one interval', async () => {
    const order: string[] = [];
    const jobs: KeeperJobs = {
      oracleHealthWatch: async () => {
        order.push('health');
      },
      signerBalance: async () => undefined,
      priceFreshness: async () => undefined,
      priceWatchdog: async () => undefined,
      liquidationWatch: async () => {
        order.push('liquidation');
      },
    };
    const { deps } = createDeps();
    const keeper = startKeeper(TEST_CONFIG, deps, jobs);

    await jest.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['health', 'liquidation']);

    await jest.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(order).toEqual(['health', 'liquidation']);
    await jest.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['health', 'liquidation', 'health', 'liquidation']);

    await keeper.stop();
  });

  // stop() awaited the tick in flight without bound, so a stop during a receipt
  // wait (up to 180 s) outlasted systemd's 90 s stop timeout and the process was killed.
  it('stops after the shutdown grace when the tick in flight does not finish', async () => {
    const jobs: KeeperJobs = {
      oracleHealthWatch: async () => undefined,
      signerBalance: async () => undefined,
      priceFreshness: async () => undefined,
      priceWatchdog: async () => undefined,
      // A receipt wait that never ends.
      liquidationWatch: () => new Promise<void>(() => undefined),
    };
    const { deps, events } = createDeps();
    const keeper = startKeeper(TEST_CONFIG, deps, jobs, { shutdownGraceMs: 5_000 });
    await jest.advanceTimersByTimeAsync(0);

    let stopped = false;
    void keeper.stop().then(() => {
      stopped = true;
    });
    await jest.advanceTimersByTimeAsync(4_999);
    expect(stopped).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    expect(events.find((entry) => entry.event === 'keeper.shutdown-tick-abandoned')).toMatchObject({
      level: 'warn',
      fields: { graceSeconds: 5 },
    });
  });

  it('stops as soon as the tick in flight finishes, inside the grace', async () => {
    let release: () => void = () => undefined;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    const jobs: KeeperJobs = {
      oracleHealthWatch: async () => undefined,
      signerBalance: async () => undefined,
      priceFreshness: async () => undefined,
      priceWatchdog: async () => undefined,
      liquidationWatch: () => hang,
    };
    const { deps, events } = createDeps();
    const keeper = startKeeper(TEST_CONFIG, deps, jobs, { shutdownGraceMs: 5_000 });
    await jest.advanceTimersByTimeAsync(0);

    let stopped = false;
    void keeper.stop().then(() => {
      stopped = true;
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(stopped).toBe(false);
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
    expect(events.map((entry) => entry.event)).not.toContain('keeper.shutdown-tick-abandoned');
  });

  it('runs oracle health, signer balance, price freshness, price watchdog and liquidation watch in order each tick', async () => {
    const order: string[] = [];
    const jobs: KeeperJobs = {
      oracleHealthWatch: async () => {
        order.push('health');
      },
      signerBalance: async () => {
        order.push('balance');
      },
      priceFreshness: async () => {
        order.push('price');
      },
      priceWatchdog: async () => {
        order.push('watchdog');
      },
      liquidationWatch: async () => {
        order.push('liquidation');
      },
    };
    const { deps } = createDeps();
    const keeper = startKeeper(TEST_CONFIG, deps, jobs);

    await jest.advanceTimersByTimeAsync(START);
    expect(order).toEqual(['health', 'balance', 'price', 'watchdog', 'liquidation']);

    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(order).toEqual([
      'health',
      'balance',
      'price',
      'watchdog',
      'liquidation',
      'health',
      'balance',
      'price',
      'watchdog',
      'liquidation',
    ]);

    await keeper.stop();
  });

  it('tells the read client a tick is starting, before the first job of every tick', async () => {
    const order: string[] = [];
    const jobs: KeeperJobs = {
      oracleHealthWatch: async () => {
        order.push('health');
      },
      signerBalance: async () => undefined,
      priceFreshness: async () => undefined,
      priceWatchdog: async () => undefined,
      liquidationWatch: async () => {
        order.push('liquidation');
      },
    };
    const { deps } = createDeps();
    deps.read.beginTick = async () => {
      order.push('begin');
    };
    const keeper = startKeeper(TEST_CONFIG, deps, jobs);

    await jest.advanceTimersByTimeAsync(START);
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(order).toEqual(['begin', 'health', 'liquidation', 'begin', 'health', 'liquidation']);

    await keeper.stop();
  });

  it('reports a failing tick start as keeper.job-error and still runs every job', async () => {
    const order: string[] = [];
    const jobs: KeeperJobs = {
      oracleHealthWatch: async () => {
        order.push('health');
      },
      signerBalance: async () => undefined,
      priceFreshness: async () => undefined,
      priceWatchdog: async () => undefined,
      liquidationWatch: async () => {
        order.push('liquidation');
      },
    };
    const { deps, events } = createDeps();
    deps.read.beginTick = async () => {
      throw new Error('prefetch exploded');
    };
    const keeper = startKeeper(TEST_CONFIG, deps, jobs);

    await jest.advanceTimersByTimeAsync(START);
    expect(order).toEqual(['health', 'liquidation']);
    expect(events).toContainEqual({
      level: 'error',
      event: 'keeper.job-error',
      fields: { job: 'read-cache', reason: 'prefetch exploded' },
    });

    await keeper.stop();
  });

  it('skips an overlapping tick with keeper.tick-skipped-overlap', async () => {
    let release: () => void = () => undefined;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    const healthCalls: number[] = [];
    const jobs: KeeperJobs = {
      oracleHealthWatch: async () => {
        healthCalls.push(healthCalls.length);
      },
      signerBalance: async () => undefined,
      priceFreshness: async () => undefined,
      priceWatchdog: async () => undefined,
      liquidationWatch: async () => {
        await hang;
      },
    };
    const { deps, events } = createDeps();
    const keeper = startKeeper(TEST_CONFIG, deps, jobs);

    await jest.advanceTimersByTimeAsync(START);
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(healthCalls).toHaveLength(1);
    expect(
      events.filter((entry) => entry.event === 'keeper.tick-skipped-overlap')
    ).toHaveLength(1);

    release();
    await keeper.stop();
  });

  it('lets a throwing job emit keeper.job-error without blocking later jobs', async () => {
    const order: string[] = [];
    const jobs: KeeperJobs = {
      oracleHealthWatch: async () => {
        throw new Error('health check exploded');
      },
      signerBalance: async () => undefined,
      priceFreshness: async () => undefined,
      priceWatchdog: async () => undefined,
      liquidationWatch: async () => {
        order.push('liquidation');
      },
    };
    const { deps, events } = createDeps();
    const keeper = startKeeper(TEST_CONFIG, deps, jobs);

    await jest.advanceTimersByTimeAsync(START);

    expect(order).toEqual(['liquidation']);
    const jobError = events.find(
      (entry) => entry.event === 'keeper.job-error'
    );
    expect(jobError?.fields).toMatchObject({
      job: 'oracle-health',
      reason: 'health check exploded',
    });

    await keeper.stop();
  });

  // An unreadable wallet balance is reported under the job's own name and costs the tick
  // nothing: the poke and the liquidation watch still run.
  it('reports a failed signer balance read as keeper.job-error and still liquidates', async () => {
    const order: string[] = [];
    const jobs: KeeperJobs = {
      oracleHealthWatch: async () => undefined,
      signerBalance: async () => {
        throw new Error('eth_getBalance failed');
      },
      priceFreshness: async () => {
        order.push('price');
      },
      priceWatchdog: async () => undefined,
      liquidationWatch: async () => {
        order.push('liquidation');
      },
    };
    const { deps, events } = createDeps();
    const keeper = startKeeper(TEST_CONFIG, deps, jobs);

    await jest.advanceTimersByTimeAsync(START);

    expect(order).toEqual(['price', 'liquidation']);
    expect(events.find((entry) => entry.event === 'keeper.job-error')?.fields).toMatchObject({
      job: 'signer-balance',
      reason: 'eth_getBalance failed',
    });

    await keeper.stop();
  });

  it('stop clears the interval so no further ticks run', async () => {
    const order: string[] = [];
    const jobs: KeeperJobs = {
      oracleHealthWatch: async () => {
        order.push('health');
      },
      signerBalance: async () => undefined,
      priceFreshness: async () => undefined,
      priceWatchdog: async () => undefined,
      liquidationWatch: async () => undefined,
    };
    const { deps } = createDeps();
    const keeper = startKeeper(TEST_CONFIG, deps, jobs);

    await jest.advanceTimersByTimeAsync(START);
    expect(order).toEqual(['health']);

    await keeper.stop();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(order).toEqual(['health']);
  });

  it('survives a logger that throws while reporting a failed job', async () => {
    const order: string[] = [];
    const jobs: KeeperJobs = {
      oracleHealthWatch: async () => {
        throw new Error('health check exploded');
      },
      signerBalance: async () => undefined,
      priceFreshness: async () => {
        order.push('price');
      },
      priceWatchdog: async () => undefined,
      liquidationWatch: async () => undefined,
    };
    const { deps } = createDeps();
    const throwingLog: KeeperLogger = {
      ...deps.log,
      error: () => {
        throw new Error('stdout closed');
      },
    };
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const keeper = startKeeper(TEST_CONFIG, { ...deps, log: throwingLog }, jobs);

    await jest.advanceTimersByTimeAsync(START);
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(order).toEqual(['price', 'price']);
    expect(unhandled).toEqual([]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('stdout closed'));

    process.removeListener('unhandledRejection', onUnhandled);
    stderr.mockRestore();
    await keeper.stop();
  });
});

describe('startKeeper with the real price-freshness and liquidation jobs', () => {
  const OWNER = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  const POOL = TEST_CONFIG.stabilityPoolAddress;
  const KEEPER_ACCOUNT = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');
  const TX_HASH = `0x${'56'.repeat(32)}` as const;
  /** $2000/oz, 8 decimals: the live quote. lastKnownPrice still sits 5% above it. */
  const LIVE = 200_000_000_000n;
  const LAST_KNOWN = 210_000_000_000n;
  const DEBT = 1_000n * 10n ** 18n;

  /** One chain view serving both jobs: a vault that went under on the fall the poke records. */
  const createChainRead = (): KeeperReadClient => ({
    readContract: async ({ address, functionName }) => {
      switch (functionName) {
        case 'collateralTypes':
          return [PAXG, 1_200_000n, 1_100_000n, 50_000n, 0n, 0n, true];
        case 'paused':
          return false;
        case 'tokenFrozen':
          return false;
        case 'quoteTokenPrice':
          return LIVE;
        case 'getLastKnownPrice':
          return LAST_KNOWN;
        case 'goldBandPpm':
          return 20_000n;
        case 'getVaultCurrentDebt':
          return DEBT;
        case 'vaults':
          // One PAXG backs 1,000 GSUSD: 200% at $2000 is healthy, so the liquidation price is set below.
          return [PAXG, 10n ** 18n, DEBT];
        case 'decimals':
          return 18;
        case 'getLiquidationPrice':
          // Above the live quote: liquidatable on this tick.
          return 220_000_000_000n;
        case 'totalDeposits':
          return 100_000n * 10n ** 18n;
        case 'minDebt':
          return 100n * 10n ** 18n;
        default:
          throw new Error(`Unexpected read: ${functionName} on ${address}`);
      }
    },
  });

  /**
   * The production sender refuses to sign while the account has a nonce outstanding
   * (assertNoPendingTransactions in apps/keeper). This stub models exactly that: a send
   * stays outstanding until its receipt is awaited.
   */
  const createNonceGuardedTx = (): { tx: KeeperTxSender; sends: string[]; refused: string[] } => {
    const sends: string[] = [];
    const refused: string[] = [];
    let outstanding = false;
    const tx: KeeperTxSender = {
      account: KEEPER_ACCOUNT,
      simulateAndSend: async ({ functionName }) => {
        if (outstanding) {
          refused.push(functionName);
          return {
            ok: false,
            reason: 'Keeper has a pending transaction or inconsistent nonce data; wait for confirmation before sending again.',
          };
        }
        outstanding = true;
        sends.push(functionName);
        return { ok: true, hash: TX_HASH };
      },
      waitForReceipt: async () => {
        outstanding = false;
        return { status: 'success' };
      },
    };
    return { tx, sends, refused };
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('liquidates in the same tick as the price poke instead of being refused by the pending nonce', async () => {
    const { log, events } = createStubLogger();
    const { tx, sends, refused } = createNonceGuardedTx();
    const deps: KeeperJobDeps = {
      read: createChainRead(),
      tx,
      owners: { getOwners: async (): Promise<Address[]> => [OWNER] },
      log,
    };
    const jobs: KeeperJobs = {
      oracleHealthWatch: async () => undefined,
      signerBalance: async () => undefined,
      priceFreshness: runPriceFreshness,
      priceWatchdog: async () => undefined,
      liquidationWatch: runLiquidationWatch,
    };
    const keeper = startKeeper({ ...TEST_CONFIG, dryRun: false, stabilityPoolAddress: POOL }, deps, jobs);

    await jest.advanceTimersByTimeAsync(START);

    expect(refused).toEqual([]);
    expect(sends).toEqual(['getTokenPrice', 'liquidateViaPool']);
    const names = events.map((entry) => entry.event);
    expect(names.indexOf('oracle.price-reanchored')).toBeLessThan(names.indexOf('vault.liquidated-via-pool'));
    expect(names).not.toContain('keeper.tx-failed');

    await keeper.stop();
  });

  // Every other spec passes its own job table. The default table is the one place the
  // balance watch and the liquidation watch that remembers minDebt are wired into the
  // keeper, and swapping either for a job of the same type compiles and passed every spec.
  // One spec only: the default jobs are a module-level singleton and keep their memory.
  it('runs the balance watch and a liquidation watch that remembers minDebt when given no job table', async () => {
    const E18 = 10n ** 18n;
    const chain = { liquidatable: false, minDebtReadable: true };
    const base = createChainRead();
    const read: KeeperReadClient = {
      readContract: async (request) => {
        switch (request.functionName) {
          case 'getLiquidationPrice':
            // Below the live quote on the first tick, above it on the second.
            return chain.liquidatable ? 220_000_000_000n : 150_000_000_000n;
          case 'totalDeposits':
            // Less than the 1,000 GSUSD debt: the pool can only take part of the vault.
            return 600n * E18;
          case 'minDebt':
            if (!chain.minDebtReadable) throw new Error('minDebt read failed');
            return 100n * E18;
          default:
            return base.readContract(request);
        }
      },
      getBalance: async () => 0n,
    };
    const { log, events } = createStubLogger();
    const { tx, sends } = createNonceGuardedTx();
    const sentArgs: unknown[] = [];
    const recordingTx: KeeperTxSender = {
      ...tx,
      simulateAndSend: async (request) => {
        if (request.functionName === 'liquidateViaPool') sentArgs.push(request.args);
        return tx.simulateAndSend(request);
      },
    };
    const deps: KeeperJobDeps = {
      read,
      tx: recordingTx,
      owners: { getOwners: async (): Promise<Address[]> => [OWNER] },
      log,
    };
    const keeper = startKeeper({ ...TEST_CONFIG, dryRun: false, stabilityPoolAddress: POOL }, deps);

    await jest.advanceTimersByTimeAsync(START);
    expect(sends).not.toContain('liquidateViaPool');

    chain.liquidatable = true;
    chain.minDebtReadable = false;
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);

    // An empty wallet is paged on both ticks, ahead of the jobs that send.
    expect(events.filter((entry) => entry.event === 'keeper.signer-balance-insufficient')).toHaveLength(2);
    // The pool's 600 less one wei leaves more than the 100 GSUSD minimum read on the first
    // tick. A watch with no memory sends no partial at all when the read fails.
    expect(sentArgs).toEqual([[OWNER, 600n * E18 - 1n]]);
    expect(events.find((entry) => entry.event === 'keeper.min-debt-unreadable')?.fields).toMatchObject({
      lastKnownMinDebt: 100n * E18,
    });

    await keeper.stop();
  });
});

// A keeper that is dead or blind wrote nothing a
// rule could match. Every completed tick now ends with one keeper.heartbeat line, and a clean
// tick pings the hosted dead-man check when one is configured.
describe('startKeeper heartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const quietJobs = (overrides: Partial<KeeperJobs> = {}): KeeperJobs => ({
    oracleHealthWatch: async () => undefined,
    signerBalance: async () => undefined,
    priceFreshness: async () => undefined,
    priceWatchdog: async () => undefined,
    liquidationWatch: async () => undefined,
    ...overrides,
  });

  const pinger = () => {
    const pings: number[] = [];
    return {
      pings,
      heartbeat: {
        host: 'hc.example.com',
        ping: async () => {
          pings.push(Date.now());
        },
      },
    };
  };

  const heartbeats = (events: LoggedEvent[]): LoggedEvent[] =>
    events.filter((entry) => entry.event === 'keeper.heartbeat');

  it('writes one heartbeat per completed tick, after the last job, and pings after a clean one', async () => {
    const { deps, events } = createDeps();
    const { pings, heartbeat } = pinger();
    const jobs = quietJobs({
      liquidationWatch: async (jobDeps) => {
        jobDeps.log.info('vault.owner-sweep', { owners: 12, read: 12, withDebt: 4, unread: 0 });
      },
    });
    const keeper = startKeeper(TEST_CONFIG, deps, jobs, { heartbeat });

    await jest.advanceTimersByTimeAsync(START);
    expect(events.map((entry) => entry.event)).toEqual(['vault.owner-sweep', 'keeper.heartbeat']);
    expect(heartbeats(events)[0]).toMatchObject({
      level: 'info',
      fields: { ok: true, vaultsWalked: 12, vaultsWithDebt: 4, blockedLiquidations: 0, failedLiquidations: 0, dryRun: true },
    });
    expect(pings).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(heartbeats(events)).toHaveLength(2);
    expect(pings).toHaveLength(2);

    await keeper.stop();
  });

  it('never pings after a tick in which a job failed, and says so on the heartbeat line', async () => {
    const { deps, events } = createDeps();
    const { pings, heartbeat } = pinger();
    const jobs = quietJobs({
      priceFreshness: async () => {
        throw new Error('rpc down');
      },
    });
    const keeper = startKeeper(TEST_CONFIG, deps, jobs, { heartbeat });

    await jest.advanceTimersByTimeAsync(START);

    expect(heartbeats(events)).toHaveLength(1);
    expect(heartbeats(events)[0]?.fields).toMatchObject({ ok: false, jobErrors: 1 });
    expect(pings).toEqual([]);

    await keeper.stop();
  });

  it('never pings after a tick in which a job logged its own keeper.job-error', async () => {
    const { deps } = createDeps();
    const { pings, heartbeat } = pinger();
    const jobs = quietJobs({
      liquidationWatch: async (jobDeps) => {
        jobDeps.log.error('keeper.job-error', { job: 'liquidation-watch', reason: 'no owner list was read' });
      },
    });
    const keeper = startKeeper(TEST_CONFIG, deps, jobs, { heartbeat });

    await jest.advanceTimersByTimeAsync(START);

    expect(pings).toEqual([]);
    await keeper.stop();
  });

  // The owner sources log through the logger they were built with, not through the jobs' deps.
  it('never pings after a tick in which a line written outside the jobs reported a job error', async () => {
    const { deps, events } = createDeps();
    const { pings, heartbeat } = pinger();
    const tally = createTallyingLogger(deps.log);
    const ownerSourceLog = tally.log;
    const jobs = quietJobs({
      liquidationWatch: async () => {
        ownerSourceLog.error('keeper.job-error', { job: 'vault-owner-union', reason: 'no owner list was read this tick' });
      },
    });
    const keeper = startKeeper(TEST_CONFIG, { ...deps, log: tally.log }, jobs, { heartbeat, tally });

    await jest.advanceTimersByTimeAsync(START);

    expect(heartbeats(events)).toHaveLength(1);
    expect(heartbeats(events)[0]?.fields).toMatchObject({ ok: false, jobErrors: 1 });
    expect(pings).toEqual([]);
    await keeper.stop();
  });

  it('never pings when the chain head cannot be read', async () => {
    const { deps, events } = createDeps();
    const { pings, heartbeat } = pinger();
    const blind: KeeperJobDeps = {
      ...deps,
      read: {
        ...deps.read,
        getHeadBlock: async () => {
          throw new Error('fetch failed');
        },
      },
    };
    const keeper = startKeeper(TEST_CONFIG, blind, quietJobs(), { heartbeat });

    await jest.advanceTimersByTimeAsync(START);

    expect(heartbeats(events)[0]?.fields).toMatchObject({ ok: false, headBlock: null, headError: 'fetch failed' });
    expect(pings).toEqual([]);
    await keeper.stop();
  });

  it('counts blocked and failed liquidations since the last heartbeat and starts again from zero', async () => {
    const { deps, events } = createDeps();
    let tick = 0;
    const jobs = quietJobs({
      liquidationWatch: async (jobDeps) => {
        tick += 1;
        if (tick > 1) return;
        jobDeps.log.error('vault.liquidation-blocked', { owner: '0x01' });
        jobDeps.log.error('vault.liquidation-blocked', { owner: '0x02' });
        jobDeps.log.error('keeper.tx-failed', { job: 'liquidation-watch', functionName: 'liquidate' });
      },
    });
    const keeper = startKeeper(TEST_CONFIG, deps, jobs);

    await jest.advanceTimersByTimeAsync(START);
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(heartbeats(events).map((entry) => entry.fields)).toMatchObject([
      { ok: true, blockedLiquidations: 2, failedLiquidations: 1 },
      { ok: true, blockedLiquidations: 0, failedLiquidations: 0 },
    ]);
    await keeper.stop();
  });

  it('writes no heartbeat while a tick is still running, and counts the intervals it overran', async () => {
    const { deps, events } = createDeps();
    const { pings, heartbeat } = pinger();
    let release: () => void = () => undefined;
    const jobs = quietJobs({
      liquidationWatch: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const keeper = startKeeper(TEST_CONFIG, deps, jobs, { heartbeat });

    await jest.advanceTimersByTimeAsync(START);
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(heartbeats(events)).toEqual([]);
    expect(pings).toEqual([]);

    release();
    await jest.advanceTimersByTimeAsync(0);

    expect(heartbeats(events)).toHaveLength(1);
    expect(heartbeats(events)[0]?.fields).toMatchObject({ ok: true, ticksSkipped: 2, tickSeconds: 120 });
    expect(pings).toHaveLength(1);
    await keeper.stop();
  });

  it('keeps ticking when the ping itself rejects', async () => {
    const { deps, events } = createDeps();
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const keeper = startKeeper(TEST_CONFIG, deps, quietJobs(), {
      heartbeat: {
        host: 'hc.example.com',
        ping: async () => {
          throw new Error('unexpected');
        },
      },
    });

    await jest.advanceTimersByTimeAsync(START);
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(heartbeats(events)).toHaveLength(2);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
    await keeper.stop();
  });
});
