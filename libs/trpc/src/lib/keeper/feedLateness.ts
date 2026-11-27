import type { Address } from 'viem';
import { KEEPER_EVENTS } from './alerts';
import type { KeeperConfig } from './config';
import type { OracleSnapshot, SourceRound } from './oracleReads';
import type { KeeperJobDeps } from './ports';

/**
 * The early warning for a late feed.
 *
 * GoldOracle refuses every priced path for a token once C or G is stalenessThreshold old,
 * 90,000 s at most, while both launch feeds write on a 24 hour heartbeat: about an hour of
 * slack. Until now the keeper said nothing before the refusal itself (oracle.feed-invalid,
 * oracle.price-refused). This warns oracle.feed-late as soon as a feed that still prices is
 * older than KEEPER_FEED_HEARTBEAT_SECONDS plus KEEPER_FEED_LATE_MARGIN_SECONDS, when it
 * starts and then at most once per KEEPER_FEED_LATE_REPEAT_SECONDS while it lasts. A feed
 * that writes again is forgotten, so its next late spell warns at once. The age is judged
 * against the block timestamp, as GoldOracle judges it; without one nothing is said.
 *
 * The warning can only fire while the feed still prices, so the mark has to sit below the
 * oracle's stalenessThreshold, which governance can lower. When the configured heartbeat plus
 * margin leaves no room, the keeper says so (oracle.feed-late with no source, once per token
 * per repeat interval) and falls back to the heartbeat alone, or to half the threshold when
 * the heartbeat leaves no room either, so a late feed is still announced before the refusal.
 *
 * A feed already unhealthy is left to the refusal events. The record is keyed by feed
 * address, so the gold reference two tokens share warns once, not once per token.
 */
export interface FeedLatenessTracker {
  report(deps: KeeperJobDeps, config: KeeperConfig, token: Address, snapshot: OracleSnapshot): void;
}

type FeedLateConfig = Pick<KeeperConfig, 'feedHeartbeatSeconds' | 'feedLateMarginSeconds' | 'feedLateRepeatSeconds'>;

const JOB = 'oracle-health';

/** How old a healthy round is, or undefined when it or the block's time is unknown. */
const healthyAge = (round: SourceRound, now: bigint | undefined): bigint | undefined =>
  round.status === 'ok' && round.updatedAt !== undefined && now !== undefined ? now - round.updatedAt : undefined;

/** The age past which a feed counts as late, and whether the configured one had to be replaced. */
interface LateMark {
  lateAfter: bigint;
  configured: bigint;
  fallback: boolean;
}

/** A round is stale at age >= threshold and late at age > mark, so some age must fit between. */
const leavesRoom = (mark: bigint, stalenessThreshold: bigint): boolean => mark + 1n < stalenessThreshold;

const resolveLateMark = (config: FeedLateConfig, stalenessThreshold: bigint): LateMark => {
  const configured = BigInt(config.feedHeartbeatSeconds + config.feedLateMarginSeconds);
  if (leavesRoom(configured, stalenessThreshold)) return { lateAfter: configured, configured, fallback: false };
  const heartbeat = BigInt(config.feedHeartbeatSeconds);
  const lateAfter = leavesRoom(heartbeat, stalenessThreshold) ? heartbeat : stalenessThreshold / 2n;
  return { lateAfter, configured, fallback: true };
};

export const createFeedLatenessTracker = (): FeedLatenessTracker => {
  /** When each late feed was last warned about, in the keeper's clock (milliseconds). */
  const lastWarned = new Map<Address, number>();
  /** When each token's unreachable late mark was last warned about, in the same clock. */
  const lastConflictWarned = new Map<Address, number>();

  const due = (record: Map<Address, number>, key: Address, at: number, config: FeedLateConfig): boolean => {
    const last = record.get(key);
    // A clock that stepped back says nothing about the gap, so the warning goes out.
    return last === undefined || at < last || at - last >= config.feedLateRepeatSeconds * 1000;
  };

  const reportConflict = (
    deps: KeeperJobDeps,
    config: FeedLateConfig,
    token: Address,
    mark: LateMark,
    stalenessThreshold: bigint
  ): void => {
    if (!mark.fallback) {
      lastConflictWarned.delete(token);
      return;
    }
    const at = (deps.now ?? Date.now)();
    if (!due(lastConflictWarned, token, at, config)) return;
    lastConflictWarned.set(token, at);
    deps.log.warn(KEEPER_EVENTS.oracleFeedLate, {
      job: JOB,
      token,
      heartbeatSeconds: config.feedHeartbeatSeconds,
      marginSeconds: config.feedLateMarginSeconds,
      configuredLateAfterSeconds: mark.configured,
      lateAfterSeconds: mark.lateAfter,
      stalenessThreshold,
      detail: `KEEPER_FEED_HEARTBEAT_SECONDS plus KEEPER_FEED_LATE_MARGIN_SECONDS (${mark.configured} s) is not below the oracle stalenessThreshold (${stalenessThreshold} s), so the configured warning cannot fire before the refusal. Until the settings are lowered the keeper warns once a feed is older than ${mark.lateAfter} s instead`,
    });
  };

  const reportSource = (
    deps: KeeperJobDeps,
    config: FeedLateConfig,
    token: Address,
    source: 'C' | 'G',
    round: SourceRound,
    snapshot: OracleSnapshot,
    mark: LateMark
  ): void => {
    const age = healthyAge(round, snapshot.now);
    if (age === undefined) return;
    const { lateAfter } = mark;
    if (age <= lateAfter) {
      lastWarned.delete(round.feed);
      return;
    }
    const at = (deps.now ?? Date.now)();
    if (!due(lastWarned, round.feed, at, config)) return;
    lastWarned.set(round.feed, at);
    const untilRefused = snapshot.stalenessThreshold - age;
    const markName = mark.fallback ? 'the fallback late mark' : 'its heartbeat plus the margin';
    deps.log.warn(KEEPER_EVENTS.oracleFeedLate, {
      job: JOB,
      token,
      source,
      feed: round.feed,
      updatedAt: round.updatedAt,
      ageSeconds: age,
      heartbeatSeconds: config.feedHeartbeatSeconds,
      marginSeconds: config.feedLateMarginSeconds,
      configuredLateAfterSeconds: mark.configured,
      lateAfterSeconds: lateAfter,
      stalenessThreshold: snapshot.stalenessThreshold,
      secondsUntilRefused: untilRefused,
      detail: `${source} last wrote ${age} s ago, past ${markName} (${lateAfter} s). It still prices. If no round lands within ${untilRefused} s the oracle refuses every priced path for the token (borrowing, withdrawals from a vault with debt, reserve swaps and liquidation) until one does; repayment and deposits stay open`,
    });
  };

  return {
    report: (deps, config, token, snapshot) => {
      const mark = resolveLateMark(config, snapshot.stalenessThreshold);
      reportConflict(deps, config, token, mark, snapshot.stalenessThreshold);
      reportSource(deps, config, token, 'C', snapshot.primary, snapshot, mark);
      if (snapshot.gold !== undefined) {
        reportSource(deps, config, token, 'G', snapshot.gold, snapshot, mark);
      }
    },
  };
};
