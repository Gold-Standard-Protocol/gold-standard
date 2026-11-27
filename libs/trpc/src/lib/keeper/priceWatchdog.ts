import type { Address } from 'viem';
import { KEEPER_EVENTS } from './alerts';
import { configuredTokens, isActiveCollateral } from './collateral';
import type { KeeperConfig } from './config';
import { describeError } from './decode';
import {
  describeQuoteFailure,
  quoteOraclePrice,
  readOracleSnapshot,
  snapshotFields,
} from './oracleReads';
import type { OracleSnapshot, PriceQuote, SourceRound } from './oracleReads';
import type { KeeperJobDeps, OffChainPriceRead } from './ports';

/**
 * Price watchdog. READ ONLY.
 *
 * Per active collateral token it reads what the oracle would price liquidation at now
 * (the view quoteTokenPrice), what borrowing would price at (quoteBorrowPrice) and the
 * token's market feed C straight from feeds(token).feed, then compares them with the
 * off-chain (CoinGecko backed) aggregator price the API already caches. G, the gold
 * reference, is not compared: it prices gold, not the token, and the oracle health watch
 * already holds C against it.
 *
 *   - A refused quote is the oracle health watch's alert (oracle.price-refused); here it
 *     only rides along as quoteRevertReason, so one refusal never pages twice.
 *   - The quoted price or the primary sitting at least
 *     PRICE_WATCHDOG_ALERT_BPS from the market raises oracle.price-divergence with both
 *     figures and `diverged` naming which source left.
 *   - A token without a fresh off-chain price is listed in one warn line when the gap
 *     appears or changes, and an info line says when it closes.
 *   - A token that is not an active vault collateral (XAUT on a PAXG-first launch) is
 *     skipped without a word.
 *
 * The job never sends a transaction and never calls a state-changing function. The
 * off-chain price goes into log lines only: an aggregator quote must never be able to
 * move anything on chain.
 */
const JOB = 'price-watchdog';

const BPS = 10_000n;

/** |other - reference| in basis points of the reference (the off-chain price). */
export const gapBps = (reference: bigint, other: bigint): bigint => {
  if (reference === 0n) return 0n;
  const delta = other > reference ? other - reference : reference - other;
  return (delta * BPS) / reference;
};

type ComparedSource = 'quoteTokenPrice' | 'primary';

interface Comparison {
  source: ComparedSource;
  price: bigint | undefined;
  gap: bigint | undefined;
}

const compare = (
  source: ComparedSource,
  price: bigint | undefined,
  reference: bigint
): Comparison => ({ source, price, gap: price === undefined ? undefined : gapBps(reference, price) });

const usableAnswer = (round: SourceRound | undefined): bigint | undefined =>
  round !== undefined && round.status === 'ok' ? round.answer : undefined;

const compareWithMarket = (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  token: Address,
  readings: { quote: PriceQuote; borrow: PriceQuote; sources: OracleSnapshot },
  market: Extract<OffChainPriceRead, { ok: true }>
): void => {
  const { quote, borrow, sources } = readings;
  const quoted = quote.kind === 'ok' ? quote.price : undefined;
  const comparisons = [
    compare('quoteTokenPrice', quoted, market.price),
    compare('primary', usableAnswer(sources.primary), market.price),
  ];
  const alertBps = BigInt(config.priceWatchdogAlertBps);
  const diverged = comparisons
    .filter((entry) => entry.gap !== undefined && entry.gap >= alertBps)
    .map((entry) => entry.source);
  if (diverged.length === 0) return;
  const gapOf = (source: ComparedSource): bigint | undefined =>
    comparisons.find((entry) => entry.source === source)?.gap;
  deps.log.warn(KEEPER_EVENTS.oraclePriceDivergence, {
    job: JOB,
    token,
    offChainPrice: market.price,
    offChainSource: market.source,
    offChainUpdatedAt: market.updatedAt,
    onChainPrice: quoted,
    ...(quote.kind !== 'ok' ? { quoteRevertReason: describeQuoteFailure(quote) } : {}),
    borrowPrice: borrow.kind === 'ok' ? borrow.price : undefined,
    alertBps: config.priceWatchdogAlertBps,
    diverged,
    quoteGapBps: gapOf('quoteTokenPrice'),
    primaryGapBps: gapOf('primary'),
    ...snapshotFields(sources),
    detail: `${diverged.join(' and ')} sit at least ${config.priceWatchdogAlertBps} basis points from the off-chain market price; nothing is sent, the off-chain figure is for comparison only`,
  });
};

/** Watches one token; answers the reason when there was no off-chain price to compare. */
const watchToken = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  token: Address
): Promise<string | undefined> => {
  if (!(await isActiveCollateral(deps.read, config, token))) return undefined;
  const oracle = config.goldOracleAddress;
  const quote = await quoteOraclePrice(deps.read, oracle, 'quoteTokenPrice', token);
  const borrow = await quoteOraclePrice(deps.read, oracle, 'quoteBorrowPrice', token);
  const sources = await readOracleSnapshot(deps.read, oracle, token);

  const market: OffChainPriceRead =
    deps.offChainPrices === undefined
      ? { ok: false, reason: 'no off-chain price source: REDIS_URL and REDIS_HOST are unset' }
      : await deps.offChainPrices.getUsdPrice(token);
  if (!market.ok) return market.reason;
  compareWithMarket(deps, config, token, { quote, borrow, sources }, market);
  return undefined;
};

type PriceWatchdog = (deps: KeeperJobDeps, config: KeeperConfig) => Promise<void>;

/** The same gap with a different age or back-off figure is the same state, not news. */
const missingSignature = (missing: { token: Address; reason: string }[]): string =>
  missing.map((entry) => `${entry.token}:${entry.reason.replace(/\d+/g, '#')}`).join('|');

/**
 * The watchdog with its memory of the missing-price state: one instance per keeper
 * process. A token without a market price is reported once, at warn, when the gap appears
 * or changes, and `oracle.offchain-price-restored` says when it closes; a line every tick
 * buried the one that mattered and still never paged.
 */
export const createPriceWatchdog = (): PriceWatchdog => {
  let reported: string | undefined;
  return async (deps, config) => {
    const tokens = configuredTokens(config);
    const missing: { token: Address; reason: string }[] = [];
    for (const token of tokens) {
      try {
        const reason = await watchToken(deps, config, token);
        if (reason !== undefined) missing.push({ token, reason });
      } catch (error) {
        deps.log.error(KEEPER_EVENTS.jobError, { job: JOB, token, reason: describeError(error) });
      }
    }
    if (missing.length > 0) {
      const signature = missingSignature(missing);
      if (signature !== reported) {
        deps.log.warn(KEEPER_EVENTS.oracleOffChainPriceMissing, { job: JOB, tokens: missing });
      }
      reported = signature;
    } else {
      if (reported !== undefined) deps.log.info(KEEPER_EVENTS.oracleOffChainPriceRestored, { job: JOB });
      reported = undefined;
    }
  };
};

/** One tick with no memory of earlier ticks; the keeper itself runs a createPriceWatchdog instance. */
export const runPriceWatchdog: PriceWatchdog = (deps, config) => createPriceWatchdog()(deps, config);
