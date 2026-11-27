import { KEEPER_EVENTS } from './alerts';
import type { KeeperConfig } from './config';
import { describeError } from './decode';
import { createTallyingLogger, reportHeartbeat } from './heartbeat';
import type { HeartbeatPinger, TallyingLogger } from './heartbeat';
import { createLiquidationWatch } from './liquidationWatch';
import { createOracleHealthWatch } from './oracleHealthWatch';
import { runPriceFreshness } from './priceFreshness';
import { createPriceWatchdog } from './priceWatchdog';
import type { KeeperJobDeps } from './ports';
import { runSignerBalanceWatch } from './signerBalance';

/**
 * Keeper scheduler.
 *
 * A plain setInterval loop, deliberately NOT bullmq: oracle-health liveness
 * must not depend on Redis health. Redis is touched only inside the optional
 * Redis VaultOwnerSource, whose client (createRedisCache) has error listeners
 * and bounded retries, so an outage is a warn and an empty list from that
 * source rather than a crash; the registry source and the other jobs continue.
 * Each tick runs the oracle health watch (alert only), then the signer balance watch (alert
 * only), then the price-freshness poke, then the read-only price watchdog, then the
 * liquidation watch, sequentially, each in its own try/catch emitting keeper.job-error.
 * A tick that ran to its end then writes one keeper.heartbeat line (how long it took, the
 * chain head, the vaults walked and the blocked and failed liquidations since the last one)
 * and, when it was clean and KEEPER_HEARTBEAT_URL is set, pings the hosted dead-man check
 * (see heartbeat.ts).
 * An overlapping tick is skipped with keeper.tick-skipped-overlap. The first tick
 * runs at start, so a deploy or a crash restart is not blind for one interval. SIGTERM
 * and SIGINT clear the interval and let in-flight work resolve before the
 * process exits, as the API drains its HTTP server (apps/api/src/shutdown.ts), for
 * at most KEEPER_SHUTDOWN_GRACE_MS.
 */

/**
 * How long a stop waits for the tick in flight. A tick can sit in a receipt wait for up to
 * three minutes (viem's default), longer than systemd's default 90 second stop timeout, after
 * which systemd kills the process. A minute leaves a clean exit inside that timeout. Leaving
 * a receipt wait loses nothing: the transaction is already broadcast, and on the next start
 * the pending-transaction guard in apps/keeper finds its nonce outstanding and waits for it.
 */
export const KEEPER_SHUTDOWN_GRACE_MS = 60_000;

export interface KeeperSchedulerOptions {
  /** KEEPER_SHUTDOWN_GRACE_MS unless a spec shortens it. */
  shutdownGraceMs?: number;
  /** The hosted dead-man ping, when KEEPER_HEARTBEAT_URL is set; pinged after a clean tick only. */
  heartbeat?: HeartbeatPinger;
  /**
   * The tally behind `deps.log`, when the caller built one so that lines written outside the
   * jobs' own logger are counted too: the owner sources log through the logger they were
   * constructed with, and their keeper.job-error for a tick with no owner list must mark
   * that tick as not clean. Pass it together with `deps.log` set to its `log`. Without it
   * the scheduler tallies the lines the jobs write through their deps.
   */
  tally?: TallyingLogger;
}

type KeeperJob = (deps: KeeperJobDeps, config: KeeperConfig) => Promise<void>;

/** Injectable job set so scheduler specs can observe ordering without module mocks. */
export interface KeeperJobs {
  /** Alert only: the final oracle lets only the guardian or governance freeze a token. */
  oracleHealthWatch: KeeperJob;
  /** Alert only: reports a keeper wallet too low on ETH to pay for liquidations. */
  signerBalance: KeeperJob;
  priceFreshness: KeeperJob;
  /** Read only: it never sends, and its off-chain price never reaches the chain. */
  priceWatchdog: KeeperJob;
  liquidationWatch: KeeperJob;
}

const DEFAULT_KEEPER_JOBS: KeeperJobs = {
  // One instance for the process: it remembers which feeds it has already called late, so
  // oracle.feed-late repeats at most once per KEEPER_FEED_LATE_REPEAT_SECONDS.
  oracleHealthWatch: createOracleHealthWatch(),
  signerBalance: runSignerBalanceWatch,
  priceFreshness: runPriceFreshness,
  // One instance for the process: it remembers which tokens it already said it has no
  // market price for, so the gap is reported when it appears and when it closes.
  priceWatchdog: createPriceWatchdog(),
  // One instance for the process: it remembers GoldVault.minDebt as last read, so a tick
  // whose read fails sizes with that figure and never with a constant.
  liquidationWatch: createLiquidationWatch(),
};

export interface KeeperHandle {
  stop(): Promise<void>;
}

export const startKeeper = (
  config: KeeperConfig,
  deps: KeeperJobDeps,
  jobs: KeeperJobs = DEFAULT_KEEPER_JOBS,
  options: KeeperSchedulerOptions = {}
): KeeperHandle => {
  const shutdownGraceMs = options.shutdownGraceMs ?? KEEPER_SHUTDOWN_GRACE_MS;
  let inFlight = false;
  let stopped = false;
  let currentTick: Promise<void> = Promise.resolve();
  // Every line the jobs and the scheduler write passes through the tally, which counts the
  // ones the heartbeat reports.
  const tally = options.tally ?? createTallyingLogger(deps.log);
  const jobDeps: KeeperJobDeps = { ...deps, log: tally.log };
  const now = deps.now ?? Date.now;

  const reportJobError = (name: string, error: unknown): void => {
    try {
      tally.log.error(KEEPER_EVENTS.jobError, {
        job: name,
        reason: describeError(error),
      });
    } catch (loggingError) {
      // A logger that throws (a closed stdout pipe, say) must not turn a handled job
      // failure into an unhandled rejection; stderr is the last resort.
      process.stderr.write(
        `keeper: logging ${name} failure failed: ${describeError(loggingError)}\n`
      );
    }
  };

  const runJob = async (name: string, job: KeeperJob): Promise<void> => {
    try {
      await job(jobDeps, config);
    } catch (error) {
      // A throwing job must never prevent the next job or crash the loop.
      reportJobError(name, error);
    }
  };

  /** The heartbeat line and, after a clean tick only, the hosted ping. Never throws. */
  const heartbeat = async (startedAtMs: number): Promise<void> => {
    try {
      const clean = await reportHeartbeat({
        read: deps.read,
        log: tally.log,
        tally: tally.take(),
        startedAtMs,
        nowMs: now(),
        intervalSeconds: config.intervalSeconds,
        dryRun: config.dryRun,
      });
      if (clean && options.heartbeat !== undefined) {
        await options.heartbeat.ping();
      }
    } catch (error) {
      // As for a job failure: a logger that throws must not become an unhandled rejection.
      process.stderr.write(`keeper: heartbeat failed: ${describeError(error)}\n`);
    }
  };

  const tick = async (): Promise<void> => {
    const startedAtMs = now();
    // Before the first job: a caching read client starts the tick from nothing. A failure
    // here is reported like a job's and never stops the tick, since every read still works
    // without it.
    const beginTick = deps.read.beginTick;
    if (beginTick !== undefined) await runJob('read-cache', () => beginTick.call(deps.read));
    await runJob('oracle-health', jobs.oracleHealthWatch);
    // Ahead of the first job that sends, so a wallet short of gas money is on record before
    // the poke or a liquidation fails for it.
    await runJob('signer-balance', jobs.signerBalance);
    // Before the liquidation watch: re-anchoring lastKnownPrice first means the
    // degraded fallback, GoldVault's own view and the dapp all read a fresh
    // price on this tick rather than the next one. The poke waits for its receipt,
    // so its nonce is settled before the liquidation
    // watch signs from the same account.
    await runJob('price-freshness', jobs.priceFreshness);
    // After the poke, so it compares the freshest on-chain state; before the liquidation
    // watch, so a quote revert is on record ahead of the vaults it blocks.
    await runJob('price-watchdog', jobs.priceWatchdog);
    await runJob('liquidation-watch', jobs.liquidationWatch);
    // There is deliberately no fee-accrual job. StabilityModule.accrueInterest is
    // permissionless but has no effect worth paying for: every state-changing entry
    // point accrues first, and every read projects the accumulator from elapsed time
    // without touching storage. Measured over a simulated year of daily pokes, the
    // difference was +354 wei per 1e18 of debt (~3.5e-14%), against a real gas bill on
    // every tick, per collateral, forever.
    await heartbeat(startedAtMs);
  };

  const onInterval = (): void => {
    if (inFlight) {
      tally.log.warn(KEEPER_EVENTS.tickSkippedOverlap, {
        intervalSeconds: config.intervalSeconds,
      });
      return;
    }
    inFlight = true;
    currentTick = tick()
      .catch((error: unknown) => {
        process.stderr.write(`keeper: tick failed outside a job: ${describeError(error)}\n`);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const interval = setInterval(onInterval, config.intervalSeconds * 1000);
  onInterval();

  const stop = async (): Promise<void> => {
    if (!stopped) {
      stopped = true;
      clearInterval(interval);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
    }
    // Let in-flight work resolve before the caller exits, within the grace.
    let grace: ReturnType<typeof setTimeout> | undefined;
    const abandoned = new Promise<true>((resolve) => {
      grace = setTimeout(() => resolve(true), shutdownGraceMs);
    });
    const outcome = await Promise.race([currentTick.then(() => false as const), abandoned]);
    clearTimeout(grace);
    if (outcome) {
      deps.log.warn(KEEPER_EVENTS.shutdownTickAbandoned, {
        graceSeconds: Math.floor(shutdownGraceMs / 1000),
      });
    }
  };

  function onSignal(): void {
    void stop().finally(() => process.exit(0));
  }
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  return { stop };
};
