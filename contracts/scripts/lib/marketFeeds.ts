/**
 * Token market price sources built from Uniswap v3 pools: the first step of the launch
 * ceremony (scripts/deploy-market-feeds.ts) and the checks the preflight makes on them.
 *
 * Every adapter is described in the environment by a name listed in MARKET_FEEDS and a block
 * of variables under that name, so the exact pools and ids can be chosen late without touching
 * code. Two kinds exist: a UniswapV3TwapFeed block names a pool (<NAME>_POOL), a PythMarketFeed
 * block names the Pyth contract (<NAME>_PYTH). The PYTH kind is opt-in by that variable alone,
 * nothing defaults to it, and by the project decision of 2026-10-28 it is not a mainnet launch
 * component: deployMarketFeeds refuses it on chain 1 and the preflight fails a launch
 * environment that names one. The launch uses TWAP adapters only.
 *
 *   MARKET_FEEDS=PAXG_USDC_TWAP,XAUT_USDT_TWAP
 *   PAXG_USDC_TWAP_POOL=0x...            Uniswap v3 pool holding the base token
 *   PAXG_USDC_TWAP_BASE_TOKEN=0x...      the token priced (PAXG or XAUT)
 *   PAXG_USDC_TWAP_WINDOW=1800           averaging window in seconds, 600 to 7200
 *   PAXG_USDC_TWAP_MIN_LIQUIDITY=...     harmonic mean liquidity floor, a whole number
 *   PAXG_USDC_TWAP_QUOTE_USD_FEED=0x...  8 decimal USD feed for the quote; unset for USDC or USDT at 1 USD
 *   PAXG_USDC_TWAP_MAX_QUOTE_AGE=86400   required with a quote feed, unset without one
 *   PAXG_USDC_TWAP_MAX_OBSERVATION_AGE=21600  seconds since the pool's last swap before it stops pricing, 3600 to 86400
 *   PAXG_USDC_TWAP_DESCRIPTION=PAXG / USD (Uniswap v3 TWAP, USDC)
 *
 *   XAUT_PYTH_PYTH=0x...                 the Pyth contract on this chain
 *   XAUT_PYTH_PRICE_ID=0x...             32 byte Pyth price id (XAUT/USD)
 *   XAUT_PYTH_MAX_AGE=60                 seconds before a stored price reads as 0, 10 to 3600
 *   XAUT_PYTH_MAX_CONFIDENCE_PPM=5000    widest confidence interval accepted, ppm of the price, at most 50000
 *   XAUT_PYTH_DESCRIPTION=XAUT / USD (Pyth)
 *
 * The deploy is idempotent: deployments/<network>-feeds.json records every adapter with the
 * parameters it was built from, a rerun reuses a recorded adapter whose parameters match and
 * refuses one whose parameters changed and the pool cardinality is raised only when short.
 */
import { Contract, getAddress, isAddress, ZeroAddress } from "ethers";
import type { ContractFactory, Provider, Signer } from "ethers";
import { fail, Finding, hasFailures } from "./findings";
import { describeError } from "./redact";

/** Uniswap v3 writes at most one observation per block; Ethereum produces one every 12 s. */
export const BLOCK_SECONDS = 12;
/** Slots added above one per block, for missed slots and a window that starts mid block. */
export const CARDINALITY_MARGIN = 50;
/** UniswapV3TwapFeed.MIN_WINDOW and MAX_WINDOW. */
export const MIN_WINDOW = 600;
export const MAX_WINDOW = 7_200;
/** UniswapV3TwapFeed.MAX_QUOTE_AGE_CAP. */
export const MAX_QUOTE_AGE = 3 * 86_400;
/** UniswapV3TwapFeed.SUB_WINDOWS: the window must divide into this many equal sub-windows. */
export const SUB_WINDOWS = 6;
/** UniswapV3TwapFeed.MIN_OBSERVATION_AGE and MAX_OBSERVATION_AGE. */
export const MIN_OBSERVATION_AGE = 3_600;
export const MAX_OBSERVATION_AGE = 86_400;
/** PythMarketFeed.MIN_MAX_AGE, MAX_MAX_AGE and MAX_CONFIDENCE_PPM_CAP. */
export const PYTH_MIN_MAX_AGE = 10;
export const PYTH_MAX_MAX_AGE = 3_600;
export const PYTH_MAX_CONFIDENCE_PPM = 50_000;
const UINT128_MAX = (1n << 128n) - 1n;
/** Uniswap v3 stores the cardinality as a uint16. */
const UINT16_MAX = 65_535;

/** UniswapV3TwapFeed.Status, in declaration order. */
export const TWAP_STATUS = [
  "OK",
  "OBSERVE_FAILED",
  "BAD_OBSERVATION",
  "TICK_OUT_OF_RANGE",
  "THIN_LIQUIDITY",
  "QUOTE_FEED_FAILED",
  "QUOTE_INVALID",
  "QUOTE_STALE",
  "PRICE_OUT_OF_RANGE",
  "NO_RECENT_SWAPS",
] as const;

/** What each status means for an operator reading a failed check. */
const STATUS_MEANING: Record<string, string> = {
  OBSERVE_FAILED: "the pool reverted OLD: its observations do not reach back over the window (raise the cardinality and wait)",
  BAD_OBSERVATION: "the pool returned an unusable observation",
  TICK_OUT_OF_RANGE: "the mean tick is outside the Uniswap range",
  THIN_LIQUIDITY: "the pool's harmonic mean liquidity is below the floor, so its price is cheap to move",
  QUOTE_FEED_FAILED: "the quote token's USD feed reverted",
  QUOTE_INVALID: "the quote token's USD feed answered an invalid round",
  QUOTE_STALE: "the quote token's USD feed is older than the adapter's maximum quote age",
  PRICE_OUT_OF_RANGE: "the computed price is zero or absurd",
  NO_RECENT_SWAPS: "the pool's latest observation is older than the adapter's maximum observation age: no swap has happened, so its tick is not a market price",
};

export const twapStatusName = (status: number): string => TWAP_STATUS[status] ?? `UNKNOWN(${status})`;
export const twapStatusMeaning = (name: string): string => STATUS_MEANING[name] ?? "";

/** PythMarketFeed.Status, in declaration order. */
export const PYTH_STATUS = [
  "OK",
  "FEED_FAILED",
  "INVALID_PRICE",
  "STALE",
  "FUTURE_PUBLISH_TIME",
  "WIDE_CONFIDENCE",
  "EXPONENT_OUT_OF_RANGE",
  "PRICE_OUT_OF_RANGE",
] as const;

const PYTH_STATUS_MEANING: Record<string, string> = {
  FEED_FAILED: "the Pyth contract reverted on the read: the price id is unknown there or has never been relayed",
  INVALID_PRICE: "Pyth holds a price of zero or less for this id",
  STALE: "the stored Pyth price is older than the adapter's maximum age: relay a fresh update (scripts/deploy-market-feeds.ts prints the id)",
  FUTURE_PUBLISH_TIME: "the stored Pyth price is stamped in the future",
  WIDE_CONFIDENCE: "Pyth's confidence interval is wider than the adapter accepts",
  EXPONENT_OUT_OF_RANGE: "the Pyth price carries an exponent outside -18..0",
  PRICE_OUT_OF_RANGE: "the computed price is zero or absurd",
};

export const pythStatusName = (status: number): string => PYTH_STATUS[status] ?? `UNKNOWN(${status})`;
export const pythStatusMeaning = (name: string): string => PYTH_STATUS_MEANING[name] ?? "";

/** The cardinality a pool needs for a window: one slot per block over the window plus the margin. */
export function requiredCardinality(windowSeconds: number): number {
  return Math.ceil(windowSeconds / BLOCK_SECONDS) + CARDINALITY_MARGIN;
}

export type MarketFeedKind = "TWAP" | "PYTH";

export interface TwapFeedSpec {
  kind: "TWAP";
  name: string;
  pool: string;
  baseToken: string;
  windowSeconds: number;
  minHarmonicLiquidity: bigint;
  /** Empty when the quote is a 6 decimal USD stablecoin taken at exactly 1 USD. */
  quoteUsdFeed: string;
  maxQuoteAge: number;
  /** Seconds since the pool's last observation before the adapter answers 0 (NO_RECENT_SWAPS). */
  maxObservationAge: number;
  description: string;
}

export interface PythFeedSpec {
  kind: "PYTH";
  name: string;
  /** The Pyth contract on this chain. */
  pyth: string;
  /** The 32 byte Pyth price id. */
  priceId: string;
  maxAgeSeconds: number;
  maxConfidencePpm: number;
  description: string;
}

export type MarketFeedSpec = TwapFeedSpec | PythFeedSpec;

const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function readAddress(env: NodeJS.ProcessEnv, key: string, findings: Finding[]): string {
  const raw = env[key]?.trim();
  if (!raw) {
    findings.push(fail(`env:${key}`, "missing"));
    return ZeroAddress;
  }
  if (!isAddress(raw) || getAddress(raw) === ZeroAddress) {
    findings.push(fail(`env:${key}`, `"${raw}" is not a usable address`));
    return ZeroAddress;
  }
  return getAddress(raw);
}

function readWhole(env: NodeJS.ProcessEnv, key: string, min: bigint, max: bigint, findings: Finding[]): bigint {
  const raw = env[key]?.trim();
  if (!raw) {
    findings.push(fail(`env:${key}`, "missing"));
    return 0n;
  }
  if (!/^\d+$/.test(raw)) {
    findings.push(fail(`env:${key}`, `"${raw}" is not a whole number`));
    return 0n;
  }
  const value = BigInt(raw);
  if (value < min || value > max) findings.push(fail(`env:${key}`, `${raw} is outside ${min}..${max}, the range UniswapV3TwapFeed accepts`));
  return value;
}

function parsePyth(env: NodeJS.ProcessEnv, name: string, findings: Finding[]): PythFeedSpec {
  const key = (suffix: string): string => `${name}_${suffix}`;
  const description = env[key("DESCRIPTION")]?.trim() ?? "";
  if (description === "") findings.push(fail(`env:${key("DESCRIPTION")}`, "missing; the label is what an operator sees on Etherscan"));
  const idRaw = env[key("PRICE_ID")]?.trim() ?? "";
  let priceId = "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(idRaw)) findings.push(fail(`env:${key("PRICE_ID")}`, idRaw === "" ? "missing" : `"${idRaw}" is not a 32 byte hex id`));
  else if (/^0x0{64}$/.test(idRaw)) findings.push(fail(`env:${key("PRICE_ID")}`, "the zero id; PythMarketFeed refuses it"));
  else priceId = idRaw.toLowerCase();
  return {
    kind: "PYTH",
    name,
    pyth: readAddress(env, key("PYTH"), findings),
    priceId,
    maxAgeSeconds: Number(readWhole(env, key("MAX_AGE"), BigInt(PYTH_MIN_MAX_AGE), BigInt(PYTH_MAX_MAX_AGE), findings)),
    maxConfidencePpm: Number(readWhole(env, key("MAX_CONFIDENCE_PPM"), 1n, BigInt(PYTH_MAX_CONFIDENCE_PPM), findings)),
    description,
  };
}

function parseOne(env: NodeJS.ProcessEnv, name: string, findings: Finding[]): MarketFeedSpec {
  const key = (suffix: string): string => `${name}_${suffix}`;
  const hasPool = (env[key("POOL")]?.trim() ?? "") !== "";
  const hasPyth = (env[key("PYTH")]?.trim() ?? "") !== "";
  if (hasPyth && hasPool) {
    findings.push(fail(`env:${name}`, `names both ${key("POOL")} and ${key("PYTH")}; an adapter is one kind or the other`));
  }
  if (hasPyth) return parsePyth(env, name, findings);
  if (!hasPool) findings.push(fail(`env:${key("POOL")}`, `missing (set ${key("POOL")} for a Uniswap v3 TWAP adapter or ${key("PYTH")} for a Pyth adapter)`));
  const quoteRaw = env[key("QUOTE_USD_FEED")]?.trim() ?? "";
  const quoteUsdFeed = quoteRaw === "" ? "" : readAddress(env, key("QUOTE_USD_FEED"), findings);
  const ageRaw = env[key("MAX_QUOTE_AGE")]?.trim() ?? "";
  let maxQuoteAge = 0;
  if (quoteUsdFeed === "") {
    if (ageRaw !== "" && ageRaw !== "0") {
      findings.push(fail(`env:${key("MAX_QUOTE_AGE")}`, "set without a quote feed; the adapter takes the quote at exactly 1 USD and refuses an age"));
    }
  } else {
    maxQuoteAge = Number(readWhole(env, key("MAX_QUOTE_AGE"), 1n, BigInt(MAX_QUOTE_AGE), findings));
  }
  const description = env[key("DESCRIPTION")]?.trim() ?? "";
  if (description === "") findings.push(fail(`env:${key("DESCRIPTION")}`, "missing; the label is what an operator sees on Etherscan"));
  const windowSeconds = Number(readWhole(env, key("WINDOW"), BigInt(MIN_WINDOW), BigInt(MAX_WINDOW), findings));
  if (windowSeconds >= MIN_WINDOW && windowSeconds <= MAX_WINDOW && windowSeconds % SUB_WINDOWS !== 0) {
    findings.push(fail(`env:${key("WINDOW")}`, `${windowSeconds} is not a multiple of ${SUB_WINDOWS}; the adapter splits the window into ${SUB_WINDOWS} equal sub-windows`));
  }
  return {
    kind: "TWAP",
    name,
    pool: readAddress(env, key("POOL"), findings),
    baseToken: readAddress(env, key("BASE_TOKEN"), findings),
    windowSeconds,
    minHarmonicLiquidity: readWhole(env, key("MIN_LIQUIDITY"), 1n, UINT128_MAX, findings),
    quoteUsdFeed,
    maxQuoteAge,
    maxObservationAge: Number(readWhole(env, key("MAX_OBSERVATION_AGE"), BigInt(MIN_OBSERVATION_AGE), BigInt(MAX_OBSERVATION_AGE), findings)),
    description,
  };
}

/** Reads every adapter named in MARKET_FEEDS. Returns no specs when any value is unusable. */
export function parseMarketFeedSpecs(env: NodeJS.ProcessEnv): { specs?: MarketFeedSpec[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const names = (env.MARKET_FEEDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (names.length === 0) {
    findings.push(fail("env:MARKET_FEEDS", "missing; list the adapter names, for example MARKET_FEEDS=PAXG_USDC_TWAP,XAUT_USDT_TWAP"));
    return { findings };
  }
  const seen = new Set<string>();
  const specs: MarketFeedSpec[] = [];
  for (const name of names) {
    if (!NAME_PATTERN.test(name)) {
      findings.push(fail("env:MARKET_FEEDS", `"${name}" is not a name of capitals, digits and underscores`));
      continue;
    }
    if (seen.has(name)) {
      findings.push(fail("env:MARKET_FEEDS", `"${name}" is listed twice`));
      continue;
    }
    seen.add(name);
    specs.push(parseOne(env, name, findings));
  }
  if (hasFailures(findings)) return { findings };
  return { specs, findings };
}

export const FEEDS_SNAPSHOT_SCHEMA = "goldstandard-market-feeds/1";

export interface RecordedFeed {
  address: string;
  /** Absent in snapshots written before the Pyth kind existed, which were all TWAP. */
  kind?: MarketFeedKind;
  pool?: string;
  baseToken?: string;
  windowSeconds?: number;
  minHarmonicLiquidity?: string;
  quoteUsdFeed?: string;
  maxQuoteAge?: number;
  maxObservationAge?: number;
  pyth?: string;
  priceId?: string;
  maxAgeSeconds?: number;
  maxConfidencePpm?: number;
  description: string;
  deployedAt: string;
  /** The pool's observationCardinalityNext after this run and what the window needs. */
  cardinalityNext?: number;
  requiredCardinality?: number;
}

export interface MarketFeedsSnapshot {
  schema: typeof FEEDS_SNAPSHOT_SCHEMA;
  chainId: number;
  network: string;
  updatedAt: string;
  feeds: Record<string, RecordedFeed>;
}

/** deployments/<network>-feeds.json, next to the main snapshot the ceremony writes. */
export const feedsSnapshotName = (network: string): string => `${network}-feeds.json`;

export function parseFeedsSnapshot(text: string): MarketFeedsSnapshot {
  const parsed = JSON.parse(text) as Partial<MarketFeedsSnapshot>;
  if (parsed.schema !== FEEDS_SNAPSHOT_SCHEMA) throw new Error(`feeds snapshot has schema ${String(parsed.schema)}, expected ${FEEDS_SNAPSHOT_SCHEMA}`);
  if (typeof parsed.feeds !== "object" || parsed.feeds === null) throw new Error("feeds snapshot lacks its feeds");
  return parsed as MarketFeedsSnapshot;
}

/** The parameters that differ between an adapter's environment block and its recorded deployment. */
export function specDifferences(spec: MarketFeedSpec, recorded: RecordedFeed): string[] {
  const recordedKind: MarketFeedKind = recorded.kind ?? "TWAP";
  if (recordedKind !== spec.kind) return [`${spec.name} kind (${recordedKind} recorded, ${spec.kind} now)`];
  const text = (value: string | number | undefined): string => (value === undefined ? "" : String(value));
  const pairs: Array<[string, string, string]> =
    spec.kind === "TWAP"
      ? [
          ["POOL", spec.pool, text(recorded.pool)],
          ["BASE_TOKEN", spec.baseToken, text(recorded.baseToken)],
          ["WINDOW", String(spec.windowSeconds), text(recorded.windowSeconds)],
          ["MIN_LIQUIDITY", spec.minHarmonicLiquidity.toString(), text(recorded.minHarmonicLiquidity)],
          ["QUOTE_USD_FEED", spec.quoteUsdFeed, text(recorded.quoteUsdFeed)],
          ["MAX_QUOTE_AGE", String(spec.maxQuoteAge), text(recorded.maxQuoteAge)],
          ["MAX_OBSERVATION_AGE", String(spec.maxObservationAge), text(recorded.maxObservationAge)],
          ["DESCRIPTION", spec.description, recorded.description],
        ]
      : [
          ["PYTH", spec.pyth, text(recorded.pyth)],
          ["PRICE_ID", spec.priceId, text(recorded.priceId)],
          ["MAX_AGE", String(spec.maxAgeSeconds), text(recorded.maxAgeSeconds)],
          ["MAX_CONFIDENCE_PPM", String(spec.maxConfidencePpm), text(recorded.maxConfidencePpm)],
          ["DESCRIPTION", spec.description, recorded.description],
        ];
  return pairs.filter(([, a, b]) => a.toLowerCase() !== b.toLowerCase()).map(([key]) => `${spec.name}_${key}`);
}

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)",
  "function increaseObservationCardinalityNext(uint16)",
];
const FEED_DECIMALS_ABI = ["function decimals() view returns (uint8)"];
const TWAP_ABI = [
  "function pool() view returns (address)",
  "function windowSeconds() view returns (uint32)",
  "function readPrice() view returns (uint256, uint8)",
];
const PYTH_FEED_ABI = [
  "function pyth() view returns (address)",
  "function priceId() view returns (bytes32)",
  "function readPrice() view returns (uint256, uint8)",
];
const PYTH_ABI = ["function getUpdateFee(bytes[]) view returns (uint256)"];

export interface PoolCardinality {
  cardinality: number;
  cardinalityNext: number;
}

export async function readPoolCardinality(provider: Provider, pool: string): Promise<PoolCardinality> {
  const slot0 = (await new Contract(pool, POOL_ABI, provider).slot0()) as [bigint, bigint, bigint, bigint, bigint, bigint, boolean];
  return { cardinality: Number(slot0[3]), cardinalityNext: Number(slot0[4]) };
}

export interface TwapReading {
  pool: string;
  windowSeconds: number;
  answer: bigint;
  status: string;
  cardinality?: PoolCardinality;
}

/**
 * Reads an address as a UniswapV3TwapFeed: undefined when it does not answer pool(),
 * windowSeconds() and readPrice(), which is how a Chainlink aggregator is told apart.
 */
export async function readTwapFeed(provider: Provider, address: string): Promise<TwapReading | undefined> {
  const feed = new Contract(address, TWAP_ABI, provider);
  let pool: string;
  let windowSeconds: number;
  let answer: bigint;
  let status: string;
  try {
    pool = (await feed.pool()) as string;
    windowSeconds = Number(await feed.windowSeconds());
    const [price, code] = (await feed.readPrice()) as [bigint, bigint];
    answer = price;
    status = twapStatusName(Number(code));
  } catch {
    return undefined;
  }
  const cardinality = await readPoolCardinality(provider, pool).catch(() => undefined);
  return { pool, windowSeconds, answer, status, cardinality };
}

export interface PythReading {
  pyth: string;
  priceId: string;
  answer: bigint;
  status: string;
}

const INACTIVE_ABI = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
];

/**
 * True when the address answers as an InactiveFeed: 8 decimals, the description "Inactive" and an
 * all-zero round, which every validated read treats as a stopped source. A dormant token's oracle
 * entry sits on one.
 */
export async function isInactiveFeed(provider: Provider, address: string): Promise<boolean> {
  if ((await provider.getCode(address)) === "0x") return false;
  const feed = new Contract(address, INACTIVE_ABI, provider);
  try {
    const [decimals, description, round] = (await Promise.all([feed.decimals(), feed.description(), feed.latestRoundData()])) as [bigint, string, bigint[]];
    return Number(decimals) === 8 && description === "Inactive" && round.every((field) => BigInt(field) === 0n);
  } catch {
    return false;
  }
}

/** Reads an address as a PythMarketFeed: undefined when it does not answer pyth(), priceId() and readPrice(). */
export async function readPythFeed(provider: Provider, address: string): Promise<PythReading | undefined> {
  const feed = new Contract(address, PYTH_FEED_ABI, provider);
  try {
    const pyth = (await feed.pyth()) as string;
    const priceId = (await feed.priceId()) as string;
    const [answer, code] = (await feed.readPrice()) as [bigint, bigint];
    return { pyth, priceId, answer, status: pythStatusName(Number(code)) };
  } catch {
    return undefined;
  }
}

async function hasCode(provider: Provider, address: string): Promise<boolean> {
  return (await provider.getCode(address)) !== "0x";
}

async function checkPythSpec(provider: Provider, spec: PythFeedSpec): Promise<string[]> {
  if (!(await hasCode(provider, spec.pyth))) return [`${spec.name}_PYTH ${spec.pyth} has no code`];
  try {
    await new Contract(spec.pyth, PYTH_ABI, provider).getUpdateFee([]);
    return [];
  } catch (error) {
    return [`${spec.name}_PYTH ${spec.pyth} does not answer getUpdateFee as the Pyth contract does: ${describeError(error).slice(0, 80)}`];
  }
}

/** Read-only checks on the pools, quote feeds and Pyth contracts, so a bad block fails before any transaction. */
export async function checkSpecsOnChain(provider: Provider, specs: MarketFeedSpec[]): Promise<string[]> {
  const problems: string[] = [];
  for (const spec of specs) {
    if (spec.kind === "PYTH") {
      problems.push(...(await checkPythSpec(provider, spec)));
      continue;
    }
    if (!(await hasCode(provider, spec.pool))) {
      problems.push(`${spec.name}_POOL ${spec.pool} has no code`);
      continue;
    }
    const pool = new Contract(spec.pool, POOL_ABI, provider);
    try {
      const [token0, token1] = (await Promise.all([pool.token0(), pool.token1()])) as [string, string];
      if (getAddress(token0) !== spec.baseToken && getAddress(token1) !== spec.baseToken) {
        problems.push(`${spec.name}_BASE_TOKEN ${spec.baseToken} is neither token of pool ${spec.pool} (${token0}, ${token1})`);
      }
      await readPoolCardinality(provider, spec.pool);
    } catch (error) {
      problems.push(`${spec.name}_POOL ${spec.pool} does not answer as a Uniswap v3 pool: ${describeError(error).slice(0, 80)}`);
    }
    if (spec.quoteUsdFeed !== "") {
      if (!(await hasCode(provider, spec.quoteUsdFeed))) {
        problems.push(`${spec.name}_QUOTE_USD_FEED ${spec.quoteUsdFeed} has no code`);
      } else {
        const decimals = await new Contract(spec.quoteUsdFeed, FEED_DECIMALS_ABI, provider).decimals().catch(() => undefined);
        if (decimals === undefined || Number(decimals) !== 8) problems.push(`${spec.name}_QUOTE_USD_FEED ${spec.quoteUsdFeed} is not an 8 decimal feed`);
      }
    }
  }
  return problems;
}

export interface DeployMarketFeedsInput {
  specs: MarketFeedSpec[];
  signer: Signer;
  /** The UniswapV3TwapFeed and PythMarketFeed factories, connected to `signer`. */
  factories: { twap: ContractFactory; pyth: ContractFactory };
  chainId: number;
  network: string;
  /** The snapshot from an earlier run, if any. */
  existing?: MarketFeedsSnapshot;
  /** Persists the snapshot; called after every deployment so a crash loses nothing. */
  save: (snapshot: MarketFeedsSnapshot) => void;
  log?: (line: string) => void;
  now?: () => string;
}

export interface DeployMarketFeedsResult {
  snapshot: MarketFeedsSnapshot;
  deployed: string[];
  reused: string[];
  raised: Array<{ pool: string; from: number; to: number }>;
}

/**
 * Deploys every adapter not yet recorded, reuses every recorded one whose parameters and
 * code still match and raises each pool's observationCardinalityNext to what its longest
 * window needs. Every refusal is raised before the first transaction.
 */
export async function deployMarketFeeds(input: DeployMarketFeedsInput): Promise<DeployMarketFeedsResult> {
  const log = input.log ?? (() => undefined);
  const now = input.now ?? (() => new Date().toISOString());
  const provider = input.signer.provider;
  if (!provider) throw new Error("the signer has no provider");
  if (input.existing && input.existing.chainId !== input.chainId) {
    throw new Error(`the feeds snapshot is for chain ${input.existing.chainId}, this run is on chain ${input.chainId}; move it aside`);
  }

  const problems = await checkSpecsOnChain(provider, input.specs);
  // Pyth stays in the repository outside the production path (docs/ORACLE_IMPLEMENTATION_PLAN.md):
  // the PYTH kind may be deployed on test networks for later work, never on mainnet.
  if (input.chainId === 1) {
    for (const spec of input.specs) {
      if (spec.kind === "PYTH") problems.push(`${spec.name} is a PythMarketFeed block; Pyth is outside the production path and is not deployed on mainnet`);
    }
  }
  const recorded = input.existing?.feeds ?? {};
  for (const spec of input.specs) {
    const prior = recorded[spec.name];
    if (!prior) continue;
    const changed = specDifferences(spec, prior);
    if (changed.length > 0) {
      problems.push(`${spec.name} is recorded at ${prior.address} with other parameters (${changed.join(", ")}); give the new adapter a new name or move the snapshot aside`);
    } else if (!(await hasCode(provider, prior.address))) {
      problems.push(`${spec.name} is recorded at ${prior.address}, which has no code on this chain; move the snapshot aside`);
    }
  }
  if (problems.length > 0) throw new Error(`Refusing to deploy market feeds:\n  - ${problems.join("\n  - ")}`);

  const snapshot: MarketFeedsSnapshot = {
    schema: FEEDS_SNAPSHOT_SCHEMA,
    chainId: input.chainId,
    network: input.network,
    updatedAt: now(),
    feeds: { ...recorded },
  };
  const result: DeployMarketFeedsResult = { snapshot, deployed: [], reused: [], raised: [] };

  for (const spec of input.specs) {
    if (recorded[spec.name]) {
      result.reused.push(spec.name);
      log(`${spec.name}: reusing ${recorded[spec.name].address}`);
      continue;
    }
    const contract =
      spec.kind === "PYTH"
        ? await input.factories.pyth.deploy(spec.pyth, spec.priceId, spec.maxAgeSeconds, spec.maxConfidencePpm, spec.description)
        : await input.factories.twap.deploy(
            spec.pool,
            spec.baseToken,
            spec.windowSeconds,
            spec.minHarmonicLiquidity,
            spec.quoteUsdFeed === "" ? ZeroAddress : spec.quoteUsdFeed,
            spec.maxQuoteAge,
            spec.maxObservationAge,
            spec.description,
          );
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    const recordedFeed: RecordedFeed =
      spec.kind === "PYTH"
        ? {
            address,
            kind: "PYTH",
            pyth: spec.pyth,
            priceId: spec.priceId,
            maxAgeSeconds: spec.maxAgeSeconds,
            maxConfidencePpm: spec.maxConfidencePpm,
            description: spec.description,
            deployedAt: now(),
          }
        : {
            address,
            kind: "TWAP",
            pool: spec.pool,
            baseToken: spec.baseToken,
            windowSeconds: spec.windowSeconds,
            minHarmonicLiquidity: spec.minHarmonicLiquidity.toString(),
            quoteUsdFeed: spec.quoteUsdFeed,
            maxQuoteAge: spec.maxQuoteAge,
            maxObservationAge: spec.maxObservationAge,
            description: spec.description,
            deployedAt: now(),
          };
    snapshot.feeds = { ...snapshot.feeds, [spec.name]: recordedFeed };
    snapshot.updatedAt = now();
    input.save(snapshot);
    result.deployed.push(spec.name);
    log(`${spec.name}: deployed ${spec.kind === "PYTH" ? "PythMarketFeed" : "UniswapV3TwapFeed"} at ${address}`);
  }

  // One pass per pool, sized for the longest window any TWAP adapter on it uses.
  const twapSpecs = input.specs.filter((spec): spec is TwapFeedSpec => spec.kind === "TWAP");
  const needByPool = new Map<string, number>();
  for (const spec of twapSpecs) {
    needByPool.set(spec.pool, Math.max(needByPool.get(spec.pool) ?? 0, requiredCardinality(spec.windowSeconds)));
  }
  for (const [poolAddress, needed] of needByPool) {
    if (needed > UINT16_MAX) throw new Error(`pool ${poolAddress} would need ${needed} observation slots, above the uint16 limit`);
    const before = await readPoolCardinality(provider, poolAddress);
    if (before.cardinalityNext < needed) {
      const pool = new Contract(poolAddress, POOL_ABI, input.signer);
      await (await pool.increaseObservationCardinalityNext(needed)).wait();
      result.raised.push({ pool: poolAddress, from: before.cardinalityNext, to: needed });
      log(`pool ${poolAddress}: observationCardinalityNext raised from ${before.cardinalityNext} to ${needed}`);
    } else {
      log(`pool ${poolAddress}: observationCardinalityNext ${before.cardinalityNext} already covers ${needed}`);
    }
  }
  for (const spec of twapSpecs) {
    const after = await readPoolCardinality(provider, spec.pool);
    snapshot.feeds = {
      ...snapshot.feeds,
      [spec.name]: { ...snapshot.feeds[spec.name], cardinalityNext: after.cardinalityNext, requiredCardinality: requiredCardinality(spec.windowSeconds) },
    };
  }
  snapshot.updatedAt = now();
  input.save(snapshot);
  return result;
}
