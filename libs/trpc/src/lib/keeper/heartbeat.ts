import { KEEPER_EVENTS } from './alerts';
import { describeError } from './decode';
import { LIQUIDATION_JOB } from './liquidationConstants';
import type { KeeperLogger, KeeperReadClient } from './ports';

/**
 * The keeper's dead-man signal.
 *
 * The keeper's only output is JSON lines, and a keeper that is dead, looping on a crash or
 * blind to its RPC writes nothing a rule can match. Three pieces close that gap:
 *   - a tally over the logger, counting the lines that mean liquidations are not happening
 *     (vault.liquidation-blocked, keeper.tx-failed for a liquidation, keeper.tx-outcome-unknown,
 *     keeper.job-error) since the previous heartbeat;
 *   - one keeper.heartbeat line per completed tick carrying those counts, how long the tick
 *     took, the chain head it read and how many vaults it walked, so "no heartbeat with ok
 *     true for three intervals" is one rule;
 *   - an optional GET to KEEPER_HEARTBEAT_URL after a tick that completed cleanly, so a hosted
 *     dead-man service can page without any log shipper. It is never sent after a tick that
 *     reported a job error or could not read the head, it never throws and only the host of
 *     the URL ever reaches a log line.
 */

/** What the tally counted since it was last taken. */
export interface TickTally {
  /** vault.liquidation-blocked lines: a liquidatable vault nothing was sent for. */
  blockedLiquidations: number;
  /**
   * keeper.tx-failed lines of the liquidation watch other than the allowance revoke, plus
   * keeper.approval-reverted: a liquidation that was attempted and did not happen.
   */
  failedLiquidations: number;
  /** keeper.tx-outcome-unknown lines: a broadcast whose receipt could not be read. */
  unknownOutcomes: number;
  /** keeper.job-error lines at any level. */
  jobErrors: number;
  /** keeper.tick-skipped-overlap lines: intervals that passed while this tick was running. */
  ticksSkipped: number;
  /** Owners the liquidation watch swept; undefined when it reported no sweep. */
  vaultsWalked: number | undefined;
  /** Of those, the vaults that carry debt; undefined when it reported no sweep. */
  vaultsWithDebt: number | undefined;
}

const EMPTY_TALLY: TickTally = {
  blockedLiquidations: 0,
  failedLiquidations: 0,
  unknownOutcomes: 0,
  jobErrors: 0,
  ticksSkipped: 0,
  vaultsWalked: undefined,
  vaultsWithDebt: undefined,
};

const numberField = (fields: Record<string, unknown> | undefined, name: string): number | undefined => {
  const value = fields?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const isLiquidationFailure = (fields: Record<string, unknown> | undefined): boolean =>
  fields?.['job'] === LIQUIDATION_JOB && fields['functionName'] !== 'approve-revoke';

/** The tally after one more log line; every other event leaves it as it was. */
const tallied = (tally: TickTally, event: string, fields: Record<string, unknown> | undefined): TickTally => {
  switch (event) {
    case KEEPER_EVENTS.vaultLiquidationBlocked:
      return { ...tally, blockedLiquidations: tally.blockedLiquidations + 1 };
    case KEEPER_EVENTS.txFailed:
      return isLiquidationFailure(fields) ? { ...tally, failedLiquidations: tally.failedLiquidations + 1 } : tally;
    case KEEPER_EVENTS.approvalReverted:
      return { ...tally, failedLiquidations: tally.failedLiquidations + 1 };
    case KEEPER_EVENTS.txOutcomeUnknown:
      return { ...tally, unknownOutcomes: tally.unknownOutcomes + 1 };
    case KEEPER_EVENTS.jobError:
      return { ...tally, jobErrors: tally.jobErrors + 1 };
    case KEEPER_EVENTS.tickSkippedOverlap:
      return { ...tally, ticksSkipped: tally.ticksSkipped + 1 };
    case KEEPER_EVENTS.vaultOwnerSweep:
      return {
        ...tally,
        vaultsWalked: numberField(fields, 'owners'),
        vaultsWithDebt: numberField(fields, 'withDebt'),
      };
    case KEEPER_EVENTS.vaultNoOwners:
      return { ...tally, vaultsWalked: 0, vaultsWithDebt: 0 };
    default:
      return tally;
  }
};

export interface TallyingLogger {
  /** Passes every line on unchanged and counts the ones the heartbeat reports. */
  log: KeeperLogger;
  /** The counts since the last take, which starts the next count from zero. */
  take(): TickTally;
}

export const createTallyingLogger = (inner: KeeperLogger): TallyingLogger => {
  let tally = EMPTY_TALLY;
  const count =
    (level: keyof KeeperLogger) =>
    (event: string, fields?: Record<string, unknown>): void => {
      tally = tallied(tally, event, fields);
      inner[level](event, fields);
    };
  return {
    log: { info: count('info'), warn: count('warn'), error: count('error') },
    take: () => {
      const taken = tally;
      tally = EMPTY_TALLY;
      return taken;
    },
  };
};

/**
 * A head older than this means the endpoint the keeper reads from has stopped following the
 * chain: mainnet and Sepolia produce a block every 12 seconds, so ten minutes is fifty
 * missed slots. The heartbeat then says ok false and the hosted check is not pinged.
 */
export const HEAD_STALE_SECONDS = 600;

/**
 * A head stamped further than this ahead of the keeper's clock means the host clock is slow.
 * The staleness check above subtracts the head's timestamp from that clock, so a slow clock
 * hides a stalled endpoint: with the host ten minutes behind, a head that stopped ten minutes
 * ago still reads as new. Two minutes is far more than block timestamps and a host on NTP
 * ever differ by. The heartbeat then says ok false and the hosted check is not pinged, the
 * same as for a stale head, because the keeper can no longer tell whether its head is fresh.
 */
export const HEAD_AHEAD_SECONDS = 120;

type HeadRead =
  | { kind: 'read'; number: bigint; ageSeconds: number }
  /** The read client has no head adapter (specs); nothing can be said either way. */
  | { kind: 'unavailable' }
  | { kind: 'failed'; reason: string };

const readHead = async (read: KeeperReadClient, nowMs: number): Promise<HeadRead> => {
  if (read.getHeadBlock === undefined) return { kind: 'unavailable' };
  try {
    const head = await read.getHeadBlock();
    return { kind: 'read', number: head.number, ageSeconds: Math.floor(nowMs / 1000) - Number(head.timestamp) };
  } catch (error) {
    return { kind: 'failed', reason: describeError(error) };
  }
};

const headFields = (head: HeadRead): Record<string, unknown> => {
  if (head.kind === 'read') {
    return {
      headBlock: head.number,
      headAgeSeconds: head.ageSeconds,
      ...(head.ageSeconds > HEAD_STALE_SECONDS ? { headStale: true } : {}),
      ...(head.ageSeconds < -HEAD_AHEAD_SECONDS ? { headAhead: true } : {}),
    };
  }
  return {
    headBlock: null,
    headAgeSeconds: null,
    ...(head.kind === 'failed' ? { headError: head.reason } : {}),
  };
};

const headHealthy = (head: HeadRead): boolean =>
  head.kind === 'unavailable' ||
  (head.kind === 'read' && head.ageSeconds <= HEAD_STALE_SECONDS && head.ageSeconds >= -HEAD_AHEAD_SECONDS);

export interface HeartbeatInput {
  read: KeeperReadClient;
  log: KeeperLogger;
  tally: TickTally;
  /** The keeper's clock, in milliseconds, as the tick began and now. */
  startedAtMs: number;
  nowMs: number;
  intervalSeconds: number;
  dryRun: boolean;
}

/**
 * Writes the keeper.heartbeat line for a tick that ran to its end and says whether the tick
 * was clean: no job reported an error and the chain head was read, is recent and is not
 * stamped ahead of the keeper's clock.
 */
export const reportHeartbeat = async (input: HeartbeatInput): Promise<boolean> => {
  const { tally } = input;
  const head = await readHead(input.read, input.nowMs);
  const ok = tally.jobErrors === 0 && headHealthy(head);
  input.log.info(KEEPER_EVENTS.heartbeat, {
    ok,
    tickSeconds: Math.max(0, input.nowMs - input.startedAtMs) / 1000,
    intervalSeconds: input.intervalSeconds,
    dryRun: input.dryRun,
    ...headFields(head),
    vaultsWalked: tally.vaultsWalked ?? null,
    vaultsWithDebt: tally.vaultsWithDebt ?? null,
    blockedLiquidations: tally.blockedLiquidations,
    failedLiquidations: tally.failedLiquidations,
    unknownOutcomes: tally.unknownOutcomes,
    jobErrors: tally.jobErrors,
    ticksSkipped: tally.ticksSkipped,
  });
  return ok;
};

/** How long the GET to KEEPER_HEARTBEAT_URL may take before it is abandoned. */
export const HEARTBEAT_PING_TIMEOUT_MS = 5_000;

/** The slice of fetch the ping uses, so specs pass a stub and no HTTP library is involved. */
export type HeartbeatFetch = (
  url: string,
  init: { method: 'GET'; signal: AbortSignal; redirect: 'error' }
) => Promise<HeartbeatResponse>;

/**
 * What the ping needs of the answer. The body is never read, so it is cancelled: an unread
 * body keeps its connection checked out until the response is garbage collected.
 */
export interface HeartbeatResponse {
  ok: boolean;
  status: number;
  body?: { cancel(): Promise<void> } | null;
}

export interface HeartbeatPingOptions {
  fetch?: HeartbeatFetch;
  timeoutMs?: number;
}

export interface HeartbeatPinger {
  /** The host of the URL, the only part of it that may be logged. */
  readonly host: string;
  /** GETs the URL once. Resolves whatever happens; a failure is a keeper.heartbeat-ping-failed warn. */
  ping(): Promise<void>;
}

/** Resolves once the signal aborts, so a wait can be bounded by the ping's own timeout. */
const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

/** Releases the connection of an answer whose body nobody reads, within the ping's timeout. */
const discardBody = async (body: HeartbeatResponse['body'], signal: AbortSignal): Promise<void> => {
  if (body === undefined || body === null) return;
  try {
    await Promise.race([body.cancel(), aborted(signal)]);
  } catch {
    // Deliberately ignored: the ping already has its answer, and a body that cannot be
    // cancelled (already closed or locked) holds nothing left to release.
  }
};

/**
 * The hosted dead-man ping. The URL is a capability, so no log line carries it: a failure is
 * reported with the host and either the HTTP status or the kind of error, never the error's
 * own text, which may quote the request. Redirects are refused, since following one would
 * send the request somewhere the operator did not configure.
 */
export const createHeartbeatPinger = (
  url: string,
  log: KeeperLogger,
  options: HeartbeatPingOptions = {}
): HeartbeatPinger => {
  const host = new URL(url).host;
  const request: HeartbeatFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? HEARTBEAT_PING_TIMEOUT_MS;

  const failed = (reason: string): void => {
    log.warn(KEEPER_EVENTS.heartbeatPingFailed, { host, reason });
  };

  const attempt = async (): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(url, { method: 'GET', signal: controller.signal, redirect: 'error' });
      // Before the timer is cleared, so a host that stalls after its headers is still bounded.
      await discardBody(response.body, controller.signal);
      if (!response.ok) failed(`HTTP ${response.status}`);
    } catch (error) {
      failed(
        controller.signal.aborted
          ? `no answer within ${timeoutMs} ms`
          : `request failed (${error instanceof Error ? error.name : 'unknown error'})`
      );
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    host,
    ping: async () => {
      try {
        await attempt();
      } catch (error) {
        // Only a logger that throws lands here; the ping must still never fail the tick.
        process.stderr.write(`keeper: reporting a failed heartbeat ping failed: ${describeError(error)}\n`);
      }
    },
  };
};
