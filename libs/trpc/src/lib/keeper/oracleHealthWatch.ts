import type { Address } from 'viem';
import { goldOracleKeeperAbi } from './abis';
import { KEEPER_EVENTS } from './alerts';
import { configuredTokens, isActiveCollateral } from './collateral';
import type { KeeperConfig } from './config';
import { describeError, expectBigInt, expectBoolean } from './decode';
import { createFeedLatenessTracker } from './feedLateness';
import type { FeedLatenessTracker } from './feedLateness';
import {
  describeQuoteFailure,
  explainLiquidation,
  liquidationCap,
  quoteOraclePrice,
  readOracleSnapshot,
  snapshotFields,
  stoppedSources,
} from './oracleReads';
import type { LiquidationRule, OracleSnapshot, PriceQuote, RefusedBy, SourceRound } from './oracleReads';
import type { KeeperJobDeps } from './ports';

/**
 * Oracle health watch. ALERT ONLY.
 *
 * The final oracle (docs/ORACLE_IMPLEMENTATION_PLAN.md section 3, variant C) needs no call
 * from the keeper and has no permissionless circuit breaker: only the guardian or
 * governance can freeze a token, with freezeToken, so this job sends nothing. Per active
 * collateral token it reads C and G with their ages, the gold band g, the liquidation cap
 * m and the oracle's own answers (quoteTokenPrice, quoteBorrowPrice, quoteReservePrice),
 * then says what an operator needs to act on:
 *
 *   - oracle.price-refused (error): quoteTokenPrice refuses ("No reliable price": C or G
 *     unhealthy), so liquidation, borrowing and reserve swaps in the token all revert
 *     until both feeds answer again, when they resume by themselves; `stoppedSources`
 *     names the feeds and `guardianHint` what the guardian may do, since the keeper cannot;
 *   - oracle.feed-late (warn): C or G still prices but has not written for longer than its
 *     heartbeat plus a margin, the early warning before the refusal above; when it starts
 *     and then at most once per KEEPER_FEED_LATE_REPEAT_SECONDS (see feedLateness.ts);
 *   - oracle.feed-invalid (warn): C or G is unhealthy (stale, incomplete, no answer, a
 *     stamp ahead of the block or unreadable), one line naming the feed and why;
 *   - oracle.off-gold-band (warn): C sits outside the gold band, so borrowing and reserve
 *     swaps are refused ("Off gold band") while liquidation still prices: below the band at
 *     gold (a PAXG-specific depeg is not liquidated; GSUSD holders carry it), above it at
 *     min(C, G x (1 + m));
 *   - oracle.premium-capped (warn): C sits above G x (1 + m), so liquidation values the
 *     token at the cap, below its market price;
 *   - oracle.borrow-refused (warn): liquidation prices with C inside the band yet the
 *     borrow or reserve quote refuses, which the rules do not explain (a round moved
 *     between the reads, say);
 *   - oracle.already-paused and oracle.token-already-frozen (info): nothing to check.
 *
 * The contract's quote is the authority on whether a price exists; the off-chain mirror in
 * oracleReads.ts only explains it.
 */
const JOB = 'oracle-health';

const GUARDIAN_HINT =
  'Liquidations, reserve swaps and borrowing in this token are refused while this lasts and resume by themselves on the first healthy pair of feeds; nothing needs calling. Repayment and deposits stay open. If a feed looks manipulated, the guardian may freeze the token (GoldOracle.freezeToken) so nothing resumes before someone has looked. A pause does not help: getEmergencyPrice applies the same rule and refuses too, and lastKnownPrice never prices a seizure. A feed that never returns needs a timelocked setFeed or setAnchorFeed. The keeper can do none of this.';

const REFUSED_BY: Readonly<Record<string, RefusedBy | 'unsupported-token'>> = {
  'No reliable price': 'no-reliable-price',
  'Unsupported token': 'unsupported-token',
};

const readFlag = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  functionName: 'paused' | 'tokenFrozen',
  args?: readonly unknown[]
): Promise<boolean> =>
  expectBoolean(
    await deps.read.readContract({ address: config.goldOracleAddress, abi: goldOracleKeeperAbi, functionName, args }),
    `oracle.${functionName}`
  );

/** The borrow and reserve quotes, each as a price or the reason it was refused. */
interface BandedQuotes {
  borrow: PriceQuote;
  reserve: PriceQuote;
}

const bandedFields = ({ borrow, reserve }: BandedQuotes): Record<string, unknown> => ({
  ...(borrow.kind === 'ok' ? { borrowPrice: borrow.price } : { borrowRefusedReason: describeQuoteFailure(borrow) }),
  ...(reserve.kind === 'ok'
    ? { reservePrice: reserve.price }
    : { reserveRefusedReason: describeQuoteFailure(reserve) }),
});

/** quoteTokenPrice reverted or failed: the refusal, its rule and what can be done. */
const reportRefused = (
  deps: KeeperJobDeps,
  token: Address,
  quote: Exclude<PriceQuote, { kind: 'ok' }>,
  banded: BandedQuotes,
  snapshot: OracleSnapshot
): void => {
  if (quote.kind !== 'revert') {
    deps.log.warn(KEEPER_EVENTS.jobError, {
      job: JOB,
      token,
      reason:
        quote.kind === 'unreachable'
          ? `quoteTokenPrice unreachable: ${quote.detail}`
          : `quoteTokenPrice answered no data, so the deployed oracle predates the final pricing rules: ${quote.detail}`,
    });
    return;
  }
  // A pause or a freeze that landed between the reads above and the quote.
  if (quote.reason === 'EnforcedPause') {
    deps.log.info(KEEPER_EVENTS.oracleAlreadyPaused, { job: JOB, token });
    return;
  }
  if (quote.reason === 'Token frozen') {
    deps.log.info(KEEPER_EVENTS.oracleTokenAlreadyFrozen, { job: JOB, token });
    return;
  }
  const explanation = explainLiquidation(snapshot);
  const refusedBy = REFUSED_BY[quote.reason] ?? 'other';
  const detail =
    refusedBy === 'unsupported-token'
      ? 'the oracle has no feed registered for this token, yet the vault lists it as an active collateral'
      : explanation.outcome === 'refused'
        ? explanation.detail
        : 'the oracle refused although the rounds read here would price; a source may have moved between the reads';
  deps.log.error(KEEPER_EVENTS.oraclePriceRefused, {
    job: JOB,
    token,
    reason: quote.reason,
    refusedBy,
    detail,
    ...snapshotFields(snapshot),
    ...bandedFields(banded),
    guardianHint: GUARDIAN_HINT,
  });
};

const stoppedDetail = (symbol: 'C' | 'G', round: SourceRound): string =>
  `${symbol} has stopped (${round.status})${round.error !== undefined ? `: ${round.error}` : ''}`;

/** One line per tick while C or G is unhealthy, whatever the quote said. */
const reportInvalidFeeds = (deps: KeeperJobDeps, token: Address, snapshot: OracleSnapshot): void => {
  const stopped = stoppedSources(snapshot);
  if (stopped.length === 0) return;
  const details = [
    ...(stopped.includes('C') ? [stoppedDetail('C', snapshot.primary)] : []),
    ...(stopped.includes('G') && snapshot.gold !== undefined ? [stoppedDetail('G', snapshot.gold)] : []),
  ];
  deps.log.warn(KEEPER_EVENTS.oracleFeedInvalid, {
    job: JOB,
    token,
    ...snapshotFields(snapshot),
    detail: `${details.join('; ')}. Every priced path for the token is refused until both feeds answer again`,
  });
};

const offBandDetail = (side: 'below' | 'above', snapshot: OracleSnapshot, gap: unknown): string => {
  const head = `C sits ${String(gap)} ppm ${side} G, beyond the gold band of ${snapshot.goldBandPpm} ppm, so borrowing and reserve swaps are refused ("Off gold band")`;
  return side === 'below'
    ? `${head}; liquidation still prices and values the token at gold, so a depeg specific to the token is not liquidated while gold holds (GSUSD holders carry it, the accepted trade-off)`
    : `${head}; liquidation still prices, at min(C, G x (1 + m))`;
};

/** quoteTokenPrice answered: say so only when C is off the band, capped or borrowing is shut. */
const reportPriced = (
  deps: KeeperJobDeps,
  token: Address,
  price: bigint,
  banded: BandedQuotes,
  snapshot: OracleSnapshot
): void => {
  const explanation = explainLiquidation(snapshot);
  // A mirror that disagrees with the contract (a round moved between reads) stays quiet.
  if (explanation.outcome !== 'priced') return;
  const rule: LiquidationRule = explanation.rule;
  const snapshotLog = snapshotFields(snapshot);
  const fields = { job: JOB, token, rule, liquidationPrice: price, ...bandedFields(banded), ...snapshotLog };
  const side = explanation.band;
  if (side === 'below' || side === 'above') {
    deps.log.warn(KEEPER_EVENTS.oracleOffGoldBand, {
      ...fields,
      side,
      detail: offBandDetail(side, snapshot, snapshotLog['primaryGoldGapPpm']),
    });
  }
  if (rule === 'premium-capped') {
    deps.log.warn(KEEPER_EVENTS.oraclePremiumCapped, {
      ...fields,
      liquidationCap: liquidationCap(snapshot),
      detail: `C sits above G x (1 + m), so liquidation values the token at the cap of ${String(liquidationCap(snapshot))}, below its market price; a push of C up holds off a liquidation by at most m`,
    });
  }
  if (side === 'below' || side === 'above') return;
  if (banded.borrow.kind === 'revert' || banded.reserve.kind === 'revert') {
    deps.log.warn(KEEPER_EVENTS.oracleBorrowRefused, {
      ...fields,
      detail: 'liquidation prices with C inside the gold band, yet the borrow or reserve quote refuses; a feed may have moved between the reads',
    });
    return;
  }
  const failures = [
    ...(banded.borrow.kind === 'ok' ? [] : [`quoteBorrowPrice: ${banded.borrow.detail}`]),
    ...(banded.reserve.kind === 'ok' ? [] : [`quoteReservePrice: ${banded.reserve.detail}`]),
  ];
  for (const reason of failures) {
    deps.log.warn(KEEPER_EVENTS.jobError, { job: JOB, token, reason });
  }
};

const watchToken = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  token: Address,
  lateness: FeedLatenessTracker
): Promise<void> => {
  if (await readFlag(deps, config, 'paused')) {
    // The guardian's global pause: every normal read reverts while it lasts.
    deps.log.info(KEEPER_EVENTS.oracleAlreadyPaused, { job: JOB, token });
    return;
  }
  if (!(await isActiveCollateral(deps.read, config, token))) {
    // XAUT on a PAXG-first launch: a dormant feed nothing can use, so nothing to say.
    return;
  }
  if (await readFlag(deps, config, 'tokenFrozen', [token])) {
    // A freeze lapses at frozenUntil (14 days on) unless the guardian extends it.
    const frozenUntil = expectBigInt(
      await deps.read.readContract({
        address: config.goldOracleAddress,
        abi: goldOracleKeeperAbi,
        functionName: 'frozenUntil',
        args: [token],
      }),
      'frozenUntil'
    );
    deps.log.info(KEEPER_EVENTS.oracleTokenAlreadyFrozen, { job: JOB, token, frozenUntil });
    return;
  }
  const oracle = config.goldOracleAddress;
  const snapshot = await readOracleSnapshot(deps.read, oracle, token);
  const quote = await quoteOraclePrice(deps.read, oracle, 'quoteTokenPrice', token);
  const banded: BandedQuotes = {
    borrow: await quoteOraclePrice(deps.read, oracle, 'quoteBorrowPrice', token),
    reserve: await quoteOraclePrice(deps.read, oracle, 'quoteReservePrice', token),
  };
  lateness.report(deps, config, token, snapshot);
  reportInvalidFeeds(deps, token, snapshot);
  if (quote.kind === 'ok') {
    reportPriced(deps, token, quote.price, banded, snapshot);
  } else {
    reportRefused(deps, token, quote, banded, snapshot);
  }
};

export type OracleHealthWatch = (deps: KeeperJobDeps, config: KeeperConfig) => Promise<void>;

/**
 * An oracle health watch that remembers which feeds it has already called late, so
 * oracle.feed-late goes out when a feed turns late and then at most once per
 * KEEPER_FEED_LATE_REPEAT_SECONDS. Nothing else is carried from one tick to the next.
 */
export const createOracleHealthWatch = (): OracleHealthWatch => {
  const lateness = createFeedLatenessTracker();
  return async (deps, config) => {
    for (const token of configuredTokens(config)) {
      try {
        await watchToken(deps, config, token, lateness);
      } catch (error) {
        deps.log.error(KEEPER_EVENTS.jobError, { job: JOB, token, reason: describeError(error) });
      }
    }
  };
};

/** One tick with no memory of earlier ticks; the keeper itself runs a createOracleHealthWatch instance. */
export const runOracleHealthWatch: OracleHealthWatch = (deps, config) => createOracleHealthWatch()(deps, config);
