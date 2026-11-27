import { zeroAddress } from 'viem';
import type { Address } from 'viem';
import { aggregatorKeeperAbi, goldOracleKeeperAbi } from './abis';
import { classifyCallError } from './callErrors';
import type { CallFailure } from './callErrors';
import { describeError, expectAddress, expectBigInt, expectTuple } from './decode';
import type { KeeperReadClient } from './ports';

/**
 * Read-only views of GoldOracle shared by the liquidation watch, the oracle health watch
 * and the price watchdog. Nothing here sends a transaction or calls a state-changing
 * function: the quotes use the views quoteTokenPrice, quoteBorrowPrice and
 * quoteReservePrice, which apply getTokenPrice's, getBorrowPrice's and getReservePrice's
 * rules without writing.
 *
 * The sources follow docs/ORACLE_IMPLEMENTATION_PLAN.md sections 1 and 3 (variant C): C is
 * the token's market feed (feeds(token).feed, Chainlink PAXG/USD) and G the gold reference
 * (anchorFeed(), Chainlink XAU/USD). Nothing else prices the token.
 */

/** GoldOracle.PRECISION: the widths and the gaps are in parts per million. */
const PPM = 1_000_000n;

export type PriceQuote = { kind: 'ok'; price: bigint } | CallFailure;

export type QuoteFunction = 'quoteTokenPrice' | 'quoteBorrowPrice' | 'quoteReservePrice';

export const quoteOraclePrice = async (
  read: KeeperReadClient,
  oracle: Address,
  functionName: QuoteFunction,
  token: Address
): Promise<PriceQuote> => {
  let raw: unknown;
  try {
    raw = await read.readContract({
      address: oracle,
      abi: goldOracleKeeperAbi,
      functionName,
      args: [token],
    });
  } catch (error) {
    return classifyCallError(error);
  }
  try {
    return { kind: 'ok', price: expectBigInt(raw, functionName) };
  } catch (error) {
    // An answer that does not decode means the ABI and the deployment differ.
    return { kind: 'no-data', detail: describeError(error) };
  }
};

/** The text a log line carries for a quote that did not produce a price. */
export const describeQuoteFailure = (quote: CallFailure): string =>
  quote.kind === 'revert' ? quote.reason : quote.detail;

/**
 * Why a source counts as unhealthy, in GoldOracle._validatedRead's order: a non-positive
 * answer, an incomplete round, a stamp ahead of the block, a round at least
 * stalenessThreshold old or a failed call.
 */
export type SourceStatus = 'ok' | 'no-answer' | 'incomplete-round' | 'future-stamp' | 'stale' | 'unreadable';

export interface SourceRound {
  feed: Address;
  answer: bigint | undefined;
  updatedAt: bigint | undefined;
  status: SourceStatus;
  error?: string;
}

export interface OracleSnapshot {
  /** C, the token's market feed. */
  primary: SourceRound;
  /** G, the gold reference; undefined while anchorFeed is unset (local deployments). */
  gold: SourceRound | undefined;
  /** g: how far C may sit from G, in ppm of G, and still borrow or trade with the reserve. */
  goldBandPpm: bigint;
  /**
   * m: the liquidation price never exceeds G x (1 + m). Undefined on an oracle that
   * predates variant C, which the mirror then explains without a cap.
   */
  liquidationClampPpm: bigint | undefined;
  stalenessThreshold: bigint;
  /** The block timestamp ages were judged against; undefined when it could not be read. */
  now: bigint | undefined;
}

const judge = (
  round: readonly unknown[],
  now: bigint | undefined,
  stalenessThreshold: bigint
): Pick<SourceRound, 'answer' | 'updatedAt' | 'status'> => {
  const roundId = expectBigInt(round[0], 'latestRoundData.roundId');
  const answer = expectBigInt(round[1], 'latestRoundData.answer');
  const updatedAt = expectBigInt(round[3], 'latestRoundData.updatedAt');
  const answeredInRound = expectBigInt(round[4], 'latestRoundData.answeredInRound');
  const status: SourceStatus =
    answer <= 0n
      ? 'no-answer'
      : updatedAt === 0n || answeredInRound < roundId
        ? 'incomplete-round'
        : now !== undefined && updatedAt > now
          ? 'future-stamp'
          : now !== undefined && now - updatedAt >= stalenessThreshold
            ? 'stale'
            : 'ok';
  return { answer, updatedAt, status };
};

const readRound = async (
  read: KeeperReadClient,
  feed: Address,
  now: bigint | undefined,
  stalenessThreshold: bigint
): Promise<SourceRound> => {
  try {
    const round = expectTuple(
      await read.readContract({ address: feed, abi: aggregatorKeeperAbi, functionName: 'latestRoundData' }),
      5,
      'latestRoundData'
    );
    return { feed, ...judge(round, now, stalenessThreshold) };
  } catch (error) {
    return { feed, answer: undefined, updatedAt: undefined, status: 'unreadable', error: describeError(error) };
  }
};

const readOracle = async (
  read: KeeperReadClient,
  oracle: Address,
  functionName: string,
  args?: readonly unknown[]
): Promise<unknown> => read.readContract({ address: oracle, abi: goldOracleKeeperAbi, functionName, args });

/** liquidationClampPpm(token), or undefined on an oracle that predates variant C. */
const readClamp = async (read: KeeperReadClient, oracle: Address, token: Address): Promise<bigint | undefined> => {
  try {
    return expectBigInt(await readOracle(read, oracle, 'liquidationClampPpm', [token]), 'liquidationClampPpm');
  } catch {
    return undefined;
  }
};

const readNow = async (read: KeeperReadClient): Promise<bigint | undefined> => {
  if (read.getBlockTimestamp === undefined) return undefined;
  try {
    return await read.getBlockTimestamp();
  } catch {
    return undefined;
  }
};

/**
 * C and G for one token with both widths and the staleness limit. Throws when the oracle
 * cannot say which feeds those are; a failing feed read is carried on its round.
 */
export const readOracleSnapshot = async (
  read: KeeperReadClient,
  oracle: Address,
  token: Address
): Promise<OracleSnapshot> => {
  const feedTuple = expectTuple(await readOracle(read, oracle, 'feeds', [token]), 3, 'feeds');
  const primaryFeed = expectAddress(feedTuple[0], 'feeds.feed');
  const goldFeed = expectAddress(await readOracle(read, oracle, 'anchorFeed'), 'anchorFeed');
  const goldBandPpm = expectBigInt(await readOracle(read, oracle, 'goldBandPpm', [token]), 'goldBandPpm');
  const liquidationClampPpm = await readClamp(read, oracle, token);
  const stalenessThreshold = expectBigInt(await readOracle(read, oracle, 'stalenessThreshold'), 'stalenessThreshold');
  const now = await readNow(read);

  const primary = await readRound(read, primaryFeed, now, stalenessThreshold);
  const gold = goldFeed === zeroAddress ? undefined : await readRound(read, goldFeed, now, stalenessThreshold);
  return { primary, gold, goldBandPpm, liquidationClampPpm, stalenessThreshold, now };
};

/** The gap between two prices in ppm of the larger, floored as Math.mulDiv floors. */
export const gapPpm = (x: bigint, y: bigint): bigint => {
  const hi = x > y ? x : y;
  const lo = x > y ? y : x;
  return hi === 0n ? 0n : ((hi - lo) * PPM) / hi;
};

/** How far `x` sits from gold, in ppm of gold: the measure both oracle widths use. */
export const gapFromGoldPpm = (x: bigint, gold: bigint): bigint => {
  if (gold === 0n) return 0n;
  const distance = x > gold ? x - gold : gold - x;
  return (distance * PPM) / gold;
};

/** Mirrors GoldOracle._clamp's edges: ref x (1 - w) and ref x (1 + w), both rounded down. */
export const bandEdges = (ref: bigint, widthPpm: bigint): { low: bigint; high: bigint } => ({
  low: (ref * (PPM - widthPpm)) / PPM,
  high: (ref * (PPM + widthPpm)) / PPM,
});

/** The answer of a healthy source, or undefined. */
const validAnswer = (round: SourceRound | undefined): bigint | undefined =>
  round !== undefined && round.status === 'ok' ? round.answer : undefined;

/**
 * Where C sits against the gold band: inside (borrowing and reserve swaps open), below or
 * above (both refused "Off gold band"), no-reference with no anchor set, unknown while C
 * or G is unhealthy.
 */
export type BandPosition = 'inside' | 'below' | 'above' | 'no-reference' | 'unknown';

export const bandPosition = (snapshot: OracleSnapshot): BandPosition => {
  const c = validAnswer(snapshot.primary);
  if (c === undefined) return 'unknown';
  if (snapshot.gold === undefined) return 'no-reference';
  const g = validAnswer(snapshot.gold);
  if (g === undefined) return 'unknown';
  const { low, high } = bandEdges(g, snapshot.goldBandPpm);
  if (c < low) return 'below';
  return c > high ? 'above' : 'inside';
};

/** G x (1 + m), the most liquidation may value the token at; undefined when unknown. */
export const liquidationCap = (snapshot: OracleSnapshot): bigint | undefined => {
  const g = validAnswer(snapshot.gold);
  const m = snapshot.liquidationClampPpm;
  return g === undefined || m === undefined ? undefined : bandEdges(g, m).high;
};

/**
 * Which part of min(max(C, G), G x (1 + m)) set the liquidation price:
 *   - at-gold: C at or below G, so the token is valued at gold (a push of C down, or a
 *     PAXG-specific depeg, values it at gold at worst and is never liquidated below it);
 *   - market: C between G and the cap, the market price itself;
 *   - premium-capped: C above G x (1 + m), held at the cap below the market;
 *   - no-reference: no anchor set, C alone (local deployments only).
 */
export type LiquidationRule = 'at-gold' | 'market' | 'premium-capped' | 'no-reference';

export type RefusedBy = 'no-reliable-price';

export type LiquidationExplanation =
  | { outcome: 'priced'; rule: LiquidationRule; price: bigint; band: BandPosition }
  | { outcome: 'refused'; refusedBy: RefusedBy; detail: string };

const stoppedText = (symbol: 'C' | 'G', round: SourceRound): string => `${symbol} has stopped (${round.status})`;

/**
 * An off-chain mirror of GoldOracle._settlement, the one rule behind the liquidation
 * trigger and settlement, for explaining an outcome to an operator. The contract's own
 * quote stays the authority; this only says which part of the rule priced, or which feed
 * refused, from the same rounds.
 */
export const explainLiquidation = (snapshot: OracleSnapshot): LiquidationExplanation => {
  const { primary, gold } = snapshot;
  const c = validAnswer(primary);
  const goldStopped = gold !== undefined && gold.status !== 'ok';
  if (c === undefined || goldStopped) {
    const stopped = [
      ...(c === undefined ? [stoppedText('C', primary)] : []),
      ...(gold !== undefined && goldStopped ? [stoppedText('G', gold)] : []),
    ].join(' and ');
    return {
      outcome: 'refused',
      refusedBy: 'no-reliable-price',
      detail: `${stopped}: liquidation is refused, never priced on C or gold alone or on lastKnownPrice, and resumes by itself on the first healthy pair`,
    };
  }
  const band = bandPosition(snapshot);
  const g = validAnswer(gold);
  if (g === undefined) return { outcome: 'priced', rule: 'no-reference', price: c, band };
  if (c <= g) return { outcome: 'priced', rule: 'at-gold', price: g, band };
  const cap = liquidationCap(snapshot);
  if (cap !== undefined && c > cap) return { outcome: 'priced', rule: 'premium-capped', price: cap, band };
  return { outcome: 'priced', rule: 'market', price: c, band };
};

/** Every configured source that is unhealthy, by its plan symbol. */
export const stoppedSources = (snapshot: OracleSnapshot): ('C' | 'G')[] => [
  ...(snapshot.primary.status !== 'ok' ? (['C'] as const) : []),
  ...(snapshot.gold !== undefined && snapshot.gold.status !== 'ok' ? (['G'] as const) : []),
];

const positive = (value: bigint | undefined): bigint | undefined =>
  value !== undefined && value > 0n ? value : undefined;

const roundFields = (prefix: string, round: SourceRound | undefined): Record<string, unknown> =>
  round === undefined
    ? { [`${prefix}Feed`]: null }
    : {
        [`${prefix}Feed`]: round.feed,
        [`${prefix}Price`]: round.answer,
        [`${prefix}UpdatedAt`]: round.updatedAt,
        [`${prefix}Status`]: round.status,
        ...(round.error !== undefined ? { [`${prefix}Error`]: round.error } : {}),
      };

/** The log fields an operator needs to see C and G side by side. */
export const snapshotFields = (snapshot: OracleSnapshot): Record<string, unknown> => {
  const { primary, gold } = snapshot;
  const c = positive(primary.answer);
  const g = positive(gold?.answer);
  return {
    ...roundFields('primary', primary),
    ...roundFields('gold', gold),
    goldBandPpm: snapshot.goldBandPpm,
    liquidationClampPpm: snapshot.liquidationClampPpm ?? null,
    liquidationCap: liquidationCap(snapshot) ?? null,
    stalenessThreshold: snapshot.stalenessThreshold,
    blockTimestamp: snapshot.now ?? null,
    primaryGoldGapPpm: c !== undefined && g !== undefined ? gapFromGoldPpm(c, g) : undefined,
    bandPosition: bandPosition(snapshot),
    stoppedSources: stoppedSources(snapshot),
  };
};
