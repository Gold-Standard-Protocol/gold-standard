/**
 * The one reading of the launch environment. scripts/preflight-mainnet.ts and
 * scripts/deploy.ts both parse their knobs through here, so a value the preflight accepted
 * is the value the deploy applies: lists are trimmed, an empty string is refused rather
 * than silently read as zero, every numeric knob is bounded by the limit the contract
 * itself enforces (the setter would revert mid-ceremony otherwise) and the effective
 * parameters are echoed as a record whose hash ties the two scripts together: the
 * preflight writes deployments/<network>.preflight.json and deploy.ts refuses to run on
 * mainnet unless that record exists and hashes to what it parsed itself.
 */
import { formatEther, getAddress, isAddress, keccak256, MaxUint256, parseEther, toUtf8Bytes, ZeroAddress } from "ethers";
import { fail, Finding, hasFailures } from "./findings";

/**
 * The cap profiles. `open` is the mainnet launch and the only mainnet profile (the project
 * decision of 29 October 2026): no debt ceiling and no per-block mint cap, PAXG the only active
 * collateral, priced by variant C on Chainlink PAXG/USD and XAU/USD alone, and XAUT registered in
 * the oracle and otherwise dormant. `backstop` keeps the same PAXG-first shape with PAXG under one
 * debt ceiling and the per-block cap armed, for forks and local rehearsals only: its maximum was
 * derived under the retired pool design, so deploy.ts, the preflight and verify-deployment refuse
 * it on mainnet. `guarded` is the testnet profile, the default when LAUNCH_CAPS is unset, with
 * both tokens active for testnets, rehearsals and the end-to-end harness; it is refused on mainnet
 * too.
 */
export type LaunchCaps = "guarded" | "open" | "backstop";

/** The profiles a mainnet deploy accepts: open alone. */
export const MAINNET_PROFILES: readonly LaunchCaps[] = ["open"];

/** True for a profile mainnet accepts. */
export const isMainnetProfile = (launchCaps: LaunchCaps | string | undefined): boolean =>
  MAINNET_PROFILES.some((profile) => profile === launchCaps);

/** The PAXG-first profiles: XAUT registered in the oracle and otherwise dormant. */
export const PAXG_FIRST_PROFILES: readonly LaunchCaps[] = ["open", "backstop"];

/**
 * True when the profile keeps XAUT dormant: registered in the oracle (on an InactiveFeed deploy.ts
 * creates when XAUT_FEED is unset) and nothing else. open and backstop do; guarded does not.
 */
export const xautDormant = (launchCaps: LaunchCaps): boolean =>
  PAXG_FIRST_PROFILES.some((profile) => profile === launchCaps);

/** Why mainnet refuses the backstop profile; the preflight and deploy.ts give the same reason. */
export const BACKSTOP_REFUSED =
  "LAUNCH_CAPS=backstop is refused on mainnet: PAXG_BACKSTOP_MAX was derived under the retired pool design and has not been re-derived for variant C; open is the only mainnet profile (docs/ORACLE_IMPLEMENTATION_PLAN.md section 4)";

/**
 * The largest PAXG debt ceiling the backstop profile accepts, in GSUSD wei: 5,000,000 GSUSD.
 * Derived under the retired pool design (docs/ORACLE_MANIPULATION_MODEL.md section 14, 14.1 item
 * 6: the lowest D* with the pool at its liquidity floor, $6.6M on path (c), divided by a margin
 * of 1.3) and never re-derived for variant C, so it bounds fork and local rehearsals only:
 * mainnet refuses the backstop profile outright (BACKSTOP_REFUSED).
 */
export const PAXG_BACKSTOP_MAX = 5_000_000n * 10n ** 18n;

/**
 * The minimum debt the mainnet launch opens at (docs/LAUNCH.md, mainnet table): at mainnet gas
 * the liquidator's share of the penalty on a smaller vault does not pay for the transaction.
 * DEFAULTS keeps 100 for Sepolia and the rehearsal harness, so the mainnet gate in deploy.ts,
 * the preflight and verify-deployment assert this figure instead of trusting the default.
 */
export const MAINNET_MIN_DEBT = parseEther("1000");

/**
 * Why mainnet refuses an open executor unless ALLOW_OPEN_EXECUTOR=1 accepts it; the preflight and
 * deploy.ts give the same reason. With the zero address holding EXECUTOR_ROLE anyone may execute a
 * matured operation, at the moment of their choosing within ExpiringTimelockController's 7 day
 * grace period, so an approval made for one incident can land in the next.
 */
export const OPEN_EXECUTOR_REFUSED =
  "TIMELOCK_EXECUTOR includes the zero address: anyone could execute every matured timelock operation, at a moment of their choosing within its 7 day grace period. Name the executor Safe, or set ALLOW_OPEN_EXECUTOR=1 to accept an open executor deliberately (docs/LAUNCH.md, executor policy)";

/** True when the zero address is among the executors, which opens execution to everyone. */
export const hasOpenExecutor = (executors: readonly string[]): boolean => executors.some((executor) => executor === ZeroAddress);

export interface CollateralParameters {
  minRatio: number;
  liqRatio: number;
  liqPenalty: number;
  debtCeiling: bigint;
  stabilityFeeBps: number;
}

export interface LaunchParameters {
  launchCaps: LaunchCaps;
  paxgToken: string;
  xautToken: string;
  paxgFeed: string;
  /** Empty under open or backstop when unset: deploy.ts then deploys an InactiveFeed for XAUT's oracle entry. */
  xautFeed: string;
  /** Empty when unset: the anchor check is then disabled, which deploy.ts refuses on mainnet. */
  anchorFeed: string;
  /**
   * False under open and backstop (xautDormant): XAUT keeps its oracle entry (the constructor
   * registers it on XAUT_FEED, a dormant feed) and nothing else; no collateral type, stability
   * fee, reserve asset or stability pool token. True under guarded.
   */
  xautActive: boolean;
  /** PAXG's gold band (GoldOracle.setGoldBand): the largest Chainlink PAXG/USD to XAU/USD gap that still borrows and trades with the reserve. */
  paxgGoldBandPpm: bigint;
  /** PAXG's liquidation cap (GoldOracle.setLiquidationClamp): the liquidation price is min(max(C, G), G x (1 + cap)). */
  paxgLiquidationClampPpm: bigint;
  /** The maximum PAXG_DEBT_CEILING may take under backstop: PAXG_BACKSTOP_MAX, or a rehearsal stand-in. */
  paxgBackstopMax: bigint;
  /** True when PAXG_BACKSTOP_REHEARSAL_MAX supplied the maximum; deploy.ts and the preflight refuse it on mainnet. */
  backstopRehearsal: boolean;
  proposers: string[];
  executors: string[];
  /** ALLOW_OPEN_EXECUTOR=1: the operator accepts the zero address among the executors, which mainnet otherwise refuses. */
  allowOpenExecutor: boolean;
  guardian: string;
  stalenessThreshold: number;
  siloCap: bigint;
  paxg: CollateralParameters;
  xaut: CollateralParameters;
  minGsusdReserve: bigint;
  minCollateralReserve: bigint;
  reservePenaltyShareBps: bigint;
  originationFeeBps: bigint;
  minDebt: bigint;
  underwaterDiscountPpm: bigint;
  reserveDailyCapPpm: bigint;
  reserveMinReservePaxg: bigint;
  reserveMinReserveXaut: bigint;
  reserveAggregateDailyCapUsd: bigint;
  badDebtPauseThreshold: bigint;
  perBlockMintCap: bigint;
  lockSiloVaultRole: boolean;
}

/** The limits the contracts enforce; a value outside them reverts in the ceremony. */
export const LIMITS = {
  /** GoldOracle constructor: `_stalenessThreshold > 0 && <= 90000`. */
  stalenessMax: 90_000,
  /** SiloFactory constructor: `_siloCap >= MIN_SILO_CAP && <= MAX_SILO_CAP` (1e16 to 1000e18, 0.01 to 1000 oz). */
  siloCapMin: 10n ** 16n,
  siloCapMax: 1000n * 10n ** 18n,
  /** GoldVault.addCollateralType: `minRatio <= MAX_MIN_RATIO`. */
  minRatioMax: 10_000_000,
  /** GoldVault.addCollateralType: `liquidationRatio >= PRECISION + 50_000` (105%). */
  liqRatioMin: 1_050_000,
  /** GoldVault.addCollateralType: `liquidationPenalty <= 200000`. */
  liqPenaltyMax: 200_000,
  /** StabilityModule.initCollateral: `annualRateBps <= MAX_ANNUAL_RATE_BPS`. */
  stabilityFeeBpsMax: 5_000,
  /** GoldVault.setMinDebt: `value >= 100e18 && value <= 10_000e18`. */
  minDebtMin: parseEther("100"),
  minDebtMax: parseEther("10000"),
  /** GoldVault.setUnderwaterDiscount: `ppm <= 50_000`. */
  underwaterDiscountPpmMax: 50_000n,
  /** GoldVault.setReservePenaltyShare: `bps <= 10000`. */
  reservePenaltyShareBpsMax: 10_000n,
  /** GoldVault.setOriginationFeeBps: `bps <= MAX_ORIGINATION_FEE_BPS` (100). */
  originationFeeBpsMax: 100n,
  /** GoldStabilityReserve.setAssetConfig: `dailyCapPpm <= PPM`; verify-deployment requires it armed. */
  reserveDailyCapPpmMax: 1_000_000n,
  /** GoldOracle.setGoldBand: `ppm >= 5000 && ppm <= 100000`. */
  goldBandPpmMin: 5_000n,
  goldBandPpmMax: 100_000n,
  /** GoldOracle.setLiquidationClamp: `ppm >= 5000 && ppm <= 50000`. */
  liquidationClampPpmMin: 5_000n,
  liquidationClampPpmMax: 50_000n,
  uint256Max: MaxUint256,
} as const;

export const DEFAULTS = {
  stalenessThreshold: 90_000,
  siloCap: 100n * 10n ** 18n,
  minRatio: 1_300_000,
  liqRatio: 1_100_000,
  liqPenalty: 50_000,
  stabilityFeeBps: 200,
  minGsusdReserve: 0n,
  minCollateralReserve: 0n,
  reservePenaltyShareBps: 4_000n,
  /** Project decision 2026-11-02: 5 bps on every mint, governance-set within 0 to 100 bps. */
  originationFeeBps: 5n,
  minDebtGsusd: "100",
  underwaterDiscountPpm: 20_000n,
  reserveDailyCapPpm: 200_000n,
  reserveMinReserve: 0n,
  reserveAggregateDailyCapUsd: 0n,
  badDebtPauseThreshold: 25_000n * 10n ** 18n,
  guardedPerBlockMintCap: 50_000n * 10n ** 18n,
  /** Plan section 3: the gold band g = 2% and the liquidation cap m = 2%; the oracle's own defaults. */
  paxgGoldBandPpm: 20_000n,
  paxgLiquidationClampPpm: 20_000n,
} as const;

/**
 * Variables of the retired oracle design (a pool confirmation feed, its agreement band and the
 * market feed deployment step). The oracle has no such setting any more, so each is refused
 * rather than ignored: a stale environment file must not look as though it configured anything.
 */
export const RETIRED_KEYS = [
  "PAXG_CONFIRM_FEED",
  "XAUT_CONFIRM_FEED",
  "PAXG_AGREEMENT_BAND_PPM",
  "MARKET_FEEDS",
] as const;

/** Every variable that would configure XAUT beyond its oracle entry; open and backstop refuse each. */
export const XAUT_ACTIVATION_KEYS = [
  "XAUT_DEBT_CEILING",
  "XAUT_MIN_RATIO",
  "XAUT_LIQ_RATIO",
  "XAUT_LIQ_PENALTY",
  "XAUT_STABILITY_FEE_BPS",
  "RESERVE_MIN_RESERVE_XAUT",
] as const;

const UNLIMITED = new Set(["max", "unlimited"]);
// XAUT_FEED is required only while XAUT is active; under open or backstop deploy.ts creates an InactiveFeed.
const REQUIRED_ADDRESSES = ["PAXG_TOKEN", "XAUT_TOKEN", "PAXG_FEED", "TIMELOCK_GUARDIAN"] as const;

/** What the ceremony record says when deploy.ts will create XAUT's InactiveFeed itself. */
export const XAUT_INACTIVE_FEED_TEXT = "an InactiveFeed deployed by deploy.ts";

type Reading = { state: "unset" } | { state: "empty" } | { state: "set"; value: string };

const read = (env: NodeJS.ProcessEnv, key: string): Reading => {
  const raw = env[key];
  if (raw === undefined) return { state: "unset" };
  const value = raw.trim();
  return value === "" ? { state: "empty" } : { state: "set", value };
};

/** A knob's trimmed value, or undefined when unset; an empty string is a failure, never a silent zero. */
function optional(env: NodeJS.ProcessEnv, key: string, findings: Finding[]): string | undefined {
  const reading = read(env, key);
  if (reading.state === "empty") {
    findings.push(fail(`env:${key}`, "set to an empty string, which would read as zero; remove the line or give it a value"));
    return undefined;
  }
  return reading.state === "set" ? reading.value : undefined;
}

function uint(env: NodeJS.ProcessEnv, key: string, fallback: bigint, findings: Finding[], min = 0n, max = MaxUint256): bigint {
  const raw = optional(env, key, findings);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    findings.push(fail(`env:${key}`, `"${raw}" is not a whole number`));
    return fallback;
  }
  const value = BigInt(raw);
  if (value < min || value > max) {
    findings.push(fail(`env:${key}`, `${raw} is outside ${min}..${max}, the range the contract accepts`));
    return fallback;
  }
  return value;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, findings: Finding[], min: number, max: number): number {
  const value = uint(env, key, BigInt(fallback), findings, BigInt(min), BigInt(max));
  return Number(value);
}

function address(env: NodeJS.ProcessEnv, key: string, findings: Finding[]): string {
  const reading = read(env, key);
  if (reading.state !== "set") {
    findings.push(fail(`env:${key}`, reading.state === "empty" ? "set to an empty string; remove the line or give it a value" : "missing"));
    return ZeroAddress;
  }
  if (!isAddress(reading.value)) {
    findings.push(fail(`env:${key}`, `"${reading.value}" is not an address`));
    return ZeroAddress;
  }
  return getAddress(reading.value);
}

export function parseAddressList(key: string, raw: string | undefined, allowZero: boolean, findings: Finding[]): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const out: string[] = [];
  for (const entry of entries) {
    if (entry === "0x0" || entry === "0") {
      findings.push(fail(`env:${key}`, `"${entry}" is not an address; for permissionless execution write the full zero address ${ZeroAddress}`));
      continue;
    }
    if (!isAddress(entry)) {
      findings.push(fail(`env:${key}`, `"${entry}" is not an address`));
      continue;
    }
    const checksummed = getAddress(entry);
    if (checksummed === ZeroAddress && !allowZero) {
      findings.push(fail(`env:${key}`, "the zero address is not a Safe"));
      continue;
    }
    out.push(checksummed);
  }
  return out;
}

export function parseLaunchCaps(raw: string | undefined, findings: Finding[]): LaunchCaps {
  const value = (raw ?? "guarded").trim().toLowerCase();
  if (value === "guarded" || value === "open" || value === "backstop") return value;
  findings.push(fail("policy:LAUNCH_CAPS", `"${raw}" is not a profile; use open (the mainnet launch), backstop (fork and local rehearsals only) or guarded (testnets)`));
  return "guarded";
}

/** A debt ceiling: a whole number of wei, "max" or "unlimited"; unset means the profile's default. The open profile accepts nothing but unlimited. */
function ceiling(env: NodeJS.ProcessEnv, key: string, launchCaps: LaunchCaps, findings: Finding[]): bigint {
  // The backstop ceiling has its own rules (backstopCeiling) and is read there, once.
  if (launchCaps === "backstop") return 0n;
  const raw = optional(env, key, findings);
  if (raw === undefined) return launchCaps === "open" ? MaxUint256 : 0n;
  if (UNLIMITED.has(raw.toLowerCase())) return MaxUint256;
  const value = uint(env, key, 0n, findings);
  if (launchCaps === "open" && value !== MaxUint256) {
    findings.push(fail(`policy:${key}`, `the open profile removes the ceiling; leave ${key} unset or unlimited (got ${raw})`));
  }
  return value;
}

/** The PAXG ceiling under backstop: required, a whole number of wei, above zero and at most the modelled maximum. */
function backstopCeiling(env: NodeJS.ProcessEnv, max: bigint, rehearsal: boolean, findings: Finding[]): bigint {
  const key = "PAXG_DEBT_CEILING";
  const raw = optional(env, key, findings);
  if (raw === undefined) {
    findings.push(fail(`policy:${key}`, `required under the backstop profile: the modelled PAXG debt ceiling, at most ${max} wei (docs/ORACLE_MANIPULATION_MODEL.md section 14)`));
    return 0n;
  }
  if (UNLIMITED.has(raw.toLowerCase())) {
    findings.push(fail(`policy:${key}`, `"${raw}": the backstop profile keeps a finite ceiling; give the modelled number in wei`));
    return 0n;
  }
  const value = uint(env, key, 0n, findings);
  if (value === 0n) findings.push(fail(`policy:${key}`, "0 would leave PAXG unable to mint; the backstop is a ceiling above zero"));
  else if (value > max) findings.push(fail(`policy:${key}`, `${value} is above the ${rehearsal ? "rehearsal" : "modelled"} backstop maximum ${max}`));
  return value;
}

/** Under open and backstop every XAUT knob is refused: the token keeps its oracle entry and nothing else. */
function refuseXautActivation(env: NodeJS.ProcessEnv, launchCaps: LaunchCaps, findings: Finding[]): void {
  for (const key of XAUT_ACTIVATION_KEYS) {
    if (read(env, key).state !== "unset") {
      findings.push(fail(`policy:${key}`, `XAUT is dormant under the ${launchCaps} profile: it keeps its oracle entry and nothing else, so this variable must be unset (activation is a later governance batch)`));
    }
  }
}

/** The maximum the backstop applies: the modelled constant, or a stand-in for a fork or local rehearsal. */
function backstopMax(env: NodeJS.ProcessEnv, launchCaps: LaunchCaps, findings: Finding[]): { max: bigint; rehearsal: boolean } {
  const reading = read(env, "PAXG_BACKSTOP_REHEARSAL_MAX");
  if (reading.state === "unset") return { max: PAXG_BACKSTOP_MAX, rehearsal: false };
  if (launchCaps !== "backstop") {
    findings.push(fail("env:PAXG_BACKSTOP_REHEARSAL_MAX", "only applies to the backstop profile"));
    return { max: PAXG_BACKSTOP_MAX, rehearsal: false };
  }
  const max = uint(env, "PAXG_BACKSTOP_REHEARSAL_MAX", 0n, findings, 1n);
  return { max, rehearsal: true };
}


function collateral(env: NodeJS.ProcessEnv, prefix: "PAXG" | "XAUT", launchCaps: LaunchCaps, findings: Finding[]): CollateralParameters {
  const minRatio = integer(env, `${prefix}_MIN_RATIO`, DEFAULTS.minRatio, findings, 0, LIMITS.minRatioMax);
  const liqRatio = integer(env, `${prefix}_LIQ_RATIO`, DEFAULTS.liqRatio, findings, LIMITS.liqRatioMin, LIMITS.minRatioMax);
  if (minRatio <= liqRatio) findings.push(fail(`env:${prefix}_MIN_RATIO`, `${minRatio} must exceed ${prefix}_LIQ_RATIO ${liqRatio}; GoldVault.addCollateralType reverts otherwise`));
  return {
    minRatio,
    liqRatio,
    liqPenalty: integer(env, `${prefix}_LIQ_PENALTY`, DEFAULTS.liqPenalty, findings, 0, LIMITS.liqPenaltyMax),
    debtCeiling: ceiling(env, `${prefix}_DEBT_CEILING`, launchCaps, findings),
    stabilityFeeBps: integer(env, `${prefix}_STABILITY_FEE_BPS`, DEFAULTS.stabilityFeeBps, findings, 0, LIMITS.stabilityFeeBpsMax),
  };
}

function minDebt(env: NodeJS.ProcessEnv, findings: Finding[]): bigint {
  const raw = optional(env, "MIN_DEBT_GSUSD", findings) ?? DEFAULTS.minDebtGsusd;
  if (!/^\d+(\.\d{1,18})?$/.test(raw)) {
    findings.push(fail("env:MIN_DEBT_GSUSD", `"${raw}" is not an amount of GSUSD`));
    return parseEther(DEFAULTS.minDebtGsusd);
  }
  const value = parseEther(raw);
  if (value < LIMITS.minDebtMin || value > LIMITS.minDebtMax) {
    findings.push(fail("env:MIN_DEBT_GSUSD", `${raw} is outside 100..10000 GSUSD, the range GoldVault.setMinDebt accepts`));
  }
  return value;
}

function perBlockMintCap(env: NodeJS.ProcessEnv, launchCaps: LaunchCaps, findings: Finding[]): bigint {
  const fallback = launchCaps === "open" ? 0n : DEFAULTS.guardedPerBlockMintCap;
  const value = uint(env, "PER_BLOCK_MINT_CAP", fallback, findings);
  if (launchCaps === "open" && value !== 0n) {
    findings.push(fail("policy:PER_BLOCK_MINT_CAP", `the open profile turns the cap off; leave PER_BLOCK_MINT_CAP unset or 0 (got ${value})`));
  }
  if (launchCaps !== "open" && value === 0n) {
    findings.push(fail("policy:PER_BLOCK_MINT_CAP", `0 disables the per-block mint cap, which the ${launchCaps} profile arms; verify-deployment would fail`));
  }
  return value;
}

function lockSiloVaultRole(env: NodeJS.ProcessEnv, findings: Finding[]): boolean {
  const raw = optional(env, "SILO_LOCK_VAULT_ROLE", findings) ?? "true";
  if (raw !== "true" && raw !== "false") {
    findings.push(fail("env:SILO_LOCK_VAULT_ROLE", `"${raw}" is neither true nor false`));
    return true;
  }
  return raw === "true";
}

/** ALLOW_OPEN_EXECUTOR is 1 or unset: an acceptance must be written out, never inferred from "true" or "yes". */
function allowOpenExecutor(env: NodeJS.ProcessEnv, findings: Finding[]): boolean {
  const raw = optional(env, "ALLOW_OPEN_EXECUTOR", findings);
  if (raw === undefined) return false;
  if (raw !== "1") {
    findings.push(fail("env:ALLOW_OPEN_EXECUTOR", `"${raw}" is not 1; set ALLOW_OPEN_EXECUTOR=1 to accept an open executor, or remove the line`));
    return false;
  }
  return true;
}

/**
 * The liquidation cap must sit below the headroom the liquidation ratio leaves above par,
 * liqRatio - 100% (10% at 110%): with a cap that wide, a market feed pushed up to the cap could
 * keep a vault that is under water at gold from ever being liquidated.
 */
function clampWithinHeadroom(clamp: bigint, liqRatio: number, findings: Finding[]): void {
  const headroom = BigInt(liqRatio) - 1_000_000n;
  if (clamp >= headroom) {
    findings.push(fail("env:PAXG_LIQUIDATION_CLAMP_PPM", `${clamp} ppm is not below the ${headroom} ppm headroom PAXG_LIQ_RATIO ${liqRatio} leaves above par`));
  }
}

/**
 * The PAXG-first mainnet launch (docs/ORACLE_IMPLEMENTATION_PLAN.md), as checks deploy.ts makes
 * before its first transaction on chain 1: the open profile alone (no PAXG ceiling, no per-block
 * cap; backstop is refused), the XAU/USD anchor set, PAXG on Chainlink PAXG/USD, XAUT dormant and
 * no open executor unless ALLOW_OPEN_EXECUTOR=1 accepts one. An empty list means the
 * configuration may deploy.
 */
export function mainnetLaunchProblems(p: LaunchParameters): string[] {
  const problems: string[] = [];
  const same = (a: string, b: string): boolean => a !== "" && b !== "" && a.toLowerCase() === b.toLowerCase();
  if (p.launchCaps === "backstop") problems.push(BACKSTOP_REFUSED);
  else if (!isMainnetProfile(p.launchCaps)) problems.push(`LAUNCH_CAPS=${p.launchCaps}: mainnet launches under the open profile alone; guarded is for testnets and the end-to-end harness`);
  if (p.launchCaps === "open" && p.paxg.debtCeiling !== MaxUint256) problems.push(`PAXG_DEBT_CEILING is ${p.paxg.debtCeiling}: the open launch has no PAXG debt ceiling`);
  if (p.launchCaps === "open" && p.perBlockMintCap !== 0n) problems.push(`PER_BLOCK_MINT_CAP is ${p.perBlockMintCap}: the open launch has no per-block mint cap`);
  if (p.minDebt !== MAINNET_MIN_DEBT) problems.push(`MIN_DEBT_GSUSD is ${formatEther(p.minDebt)}: the mainnet launch opens at 1000 GSUSD (docs/LAUNCH.md); set MIN_DEBT_GSUSD=1000`);
  if (p.backstopRehearsal) problems.push("PAXG_BACKSTOP_REHEARSAL_MAX is set: a rehearsal stand-in for the modelled backstop maximum can never reach mainnet");
  if (p.anchorFeed === "") problems.push("XAU_USD_ANCHOR_FEED is unset; the gold reference is mandatory on mainnet");
  if (same(p.paxgFeed, p.anchorFeed)) problems.push("PAXG_FEED is the XAU/USD anchor; gold spot is the reference, never PAXG's market price");
  if (p.xautActive) problems.push("XAUT is active; at launch it keeps its oracle entry and nothing else");
  if (hasOpenExecutor(p.executors) && !p.allowOpenExecutor) problems.push(OPEN_EXECUTOR_REFUSED);
  if (same(p.xautFeed, p.anchorFeed)) problems.push("XAUT_FEED is the XAU/USD anchor; leave it unset so deploy.ts registers XAUT on an InactiveFeed");
  return problems;
}

/**
 * Reads every knob deploy.ts applies. Returns no `params` when a value is unusable; the
 * findings name each problem by variable so the whole file can be fixed in one pass.
 */
export function parseLaunchParameters(env: NodeJS.ProcessEnv): { params?: LaunchParameters; findings: Finding[] } {
  const findings: Finding[] = [];
  const launchCaps = parseLaunchCaps(env.LAUNCH_CAPS, findings);
  for (const key of RETIRED_KEYS) {
    if (read(env, key).state !== "unset") {
      findings.push(fail(`env:${key}`, "retired: the oracle prices on Chainlink PAXG/USD and XAU/USD alone and has no confirmation feed, agreement band or market feed step; remove the line"));
    }
  }
  for (const key of REQUIRED_ADDRESSES) if (read(env, key).state === "unset") findings.push(fail(`env:${key}`, "missing"));
  const dormant = xautDormant(launchCaps);
  if (!dormant && read(env, "XAUT_FEED").state === "unset") {
    findings.push(fail("env:XAUT_FEED", "missing; XAUT is active under this profile and needs its market feed (under open or backstop deploy.ts creates an InactiveFeed instead)"));
  }
  for (const key of ["TIMELOCK_PROPOSER", "TIMELOCK_EXECUTOR"]) if (read(env, key).state !== "set") findings.push(fail(`env:${key}`, "missing"));
  if (hasFailures(findings)) return { findings };

  const paxgToken = address(env, "PAXG_TOKEN", findings);
  const xautToken = address(env, "XAUT_TOKEN", findings);
  const paxgFeed = address(env, "PAXG_FEED", findings);
  // Under open or backstop an unset XAUT_FEED means deploy.ts deploys an InactiveFeed for XAUT's entry.
  const xautFeed = dormant && read(env, "XAUT_FEED").state === "unset" ? "" : address(env, "XAUT_FEED", findings);
  const anchorRaw = optional(env, "XAU_USD_ANCHOR_FEED", findings);
  const anchorFeed = anchorRaw === undefined ? "" : address(env, "XAU_USD_ANCHOR_FEED", findings);
  if (anchorFeed === ZeroAddress && anchorRaw !== undefined && isAddress(anchorRaw)) {
    findings.push(fail("env:XAU_USD_ANCHOR_FEED", "the zero address would pass for a configured anchor while checking nothing; remove the line to deploy without one (refused on mainnet)"));
  }
  // GoldOracle.setAnchorFeed refuses an address any token already uses as its market feed
  // ("Feed not independent"), so a shared address would revert mid-ceremony.
  if (anchorFeed !== "" && anchorFeed !== ZeroAddress) {
    for (const [key, feed] of [["PAXG_FEED", paxgFeed], ["XAUT_FEED", xautFeed]] as const) {
      if (feed === anchorFeed) {
        findings.push(fail(`env:${key}`, `is the XAU/USD anchor; GoldOracle.setAnchorFeed refuses an anchor that a token uses as its feed. ${key === "XAUT_FEED" ? "Leave XAUT_FEED unset under open or backstop (deploy.ts creates an InactiveFeed) or give" : "Give"} each token its own feed; test mocks must be distinct contracts`));
      }
    }
  }
  const backstop = launchCaps === "backstop";
  if (dormant) refuseXautActivation(env, launchCaps, findings);
  const { max: paxgBackstopMax, rehearsal: backstopRehearsal } = backstopMax(env, launchCaps, findings);
  const guardian = address(env, "TIMELOCK_GUARDIAN", findings);
  if (guardian === ZeroAddress && read(env, "TIMELOCK_GUARDIAN").state === "set") {
    findings.push(fail("env:TIMELOCK_GUARDIAN", "the guardian cannot be the zero address: GoldVault.grantGuardianRole reverts with \"Zero address\" after every contract has been created. Only TIMELOCK_EXECUTOR may be zero (permissionless execution, accepted on mainnet only with ALLOW_OPEN_EXECUTOR=1)"));
  }
  for (const [key, token] of [["PAXG_TOKEN", paxgToken], ["XAUT_TOKEN", xautToken], ["PAXG_FEED", paxgFeed], ["XAUT_FEED", xautFeed]] as const) {
    if (token === ZeroAddress) findings.push(fail(`env:${key}`, "the zero address; GoldOracle's constructor refuses it"));
  }
  if (paxgToken !== ZeroAddress && paxgToken === xautToken) findings.push(fail("env:XAUT_TOKEN", "equals PAXG_TOKEN; GoldOracle's constructor refuses a duplicate token"));
  const proposers = parseAddressList("TIMELOCK_PROPOSER", env.TIMELOCK_PROPOSER, false, findings);
  const executors = parseAddressList("TIMELOCK_EXECUTOR", env.TIMELOCK_EXECUTOR, true, findings);
  if (proposers.length === 0) findings.push(fail("env:TIMELOCK_PROPOSER", "no usable proposer"));
  if (executors.length === 0) findings.push(fail("env:TIMELOCK_EXECUTOR", "no usable executor"));

  const params: LaunchParameters = {
    launchCaps,
    paxgToken,
    xautToken,
    paxgFeed,
    xautFeed,
    anchorFeed,
    xautActive: !dormant,
    paxgGoldBandPpm: uint(env, "PAXG_GOLD_BAND_PPM", DEFAULTS.paxgGoldBandPpm, findings, LIMITS.goldBandPpmMin, LIMITS.goldBandPpmMax),
    paxgLiquidationClampPpm: uint(env, "PAXG_LIQUIDATION_CLAMP_PPM", DEFAULTS.paxgLiquidationClampPpm, findings, LIMITS.liquidationClampPpmMin, LIMITS.liquidationClampPpmMax),
    paxgBackstopMax,
    backstopRehearsal,
    proposers,
    executors,
    allowOpenExecutor: allowOpenExecutor(env, findings),
    guardian,
    stalenessThreshold: integer(env, "STALENESS_THRESHOLD", DEFAULTS.stalenessThreshold, findings, 1, LIMITS.stalenessMax),
    siloCap: uint(env, "SILO_CAP", DEFAULTS.siloCap, findings, LIMITS.siloCapMin, LIMITS.siloCapMax),
    paxg: backstop
      ? { ...collateral(env, "PAXG", launchCaps, findings), debtCeiling: backstopCeiling(env, paxgBackstopMax, backstopRehearsal, findings) }
      : collateral(env, "PAXG", launchCaps, findings),
    // Under open or backstop the XAUT knobs were refused above; the defaults stand in and are never applied.
    xaut: dormant ? { minRatio: DEFAULTS.minRatio, liqRatio: DEFAULTS.liqRatio, liqPenalty: DEFAULTS.liqPenalty, debtCeiling: 0n, stabilityFeeBps: DEFAULTS.stabilityFeeBps } : collateral(env, "XAUT", launchCaps, findings),
    minGsusdReserve: uint(env, "MIN_GSUSD_RESERVE", DEFAULTS.minGsusdReserve, findings),
    minCollateralReserve: uint(env, "MIN_COLLATERAL_RESERVE", DEFAULTS.minCollateralReserve, findings),
    reservePenaltyShareBps: uint(env, "RESERVE_PENALTY_SHARE_BPS", DEFAULTS.reservePenaltyShareBps, findings, 0n, LIMITS.reservePenaltyShareBpsMax),
    originationFeeBps: uint(env, "ORIGINATION_FEE_BPS", DEFAULTS.originationFeeBps, findings, 0n, LIMITS.originationFeeBpsMax),
    minDebt: minDebt(env, findings),
    underwaterDiscountPpm: uint(env, "UNDERWATER_DISCOUNT_PPM", DEFAULTS.underwaterDiscountPpm, findings, 0n, LIMITS.underwaterDiscountPpmMax),
    reserveDailyCapPpm: uint(env, "RESERVE_DAILY_CAP_PPM", DEFAULTS.reserveDailyCapPpm, findings, 1n, LIMITS.reserveDailyCapPpmMax),
    reserveMinReservePaxg: uint(env, "RESERVE_MIN_RESERVE_PAXG", DEFAULTS.reserveMinReserve, findings),
    reserveMinReserveXaut: dormant ? 0n : uint(env, "RESERVE_MIN_RESERVE_XAUT", DEFAULTS.reserveMinReserve, findings),
    reserveAggregateDailyCapUsd: uint(env, "RESERVE_AGGREGATE_DAILY_CAP_USD", DEFAULTS.reserveAggregateDailyCapUsd, findings),
    badDebtPauseThreshold: uint(env, "BAD_DEBT_PAUSE_THRESHOLD", DEFAULTS.badDebtPauseThreshold, findings, 1n),
    perBlockMintCap: perBlockMintCap(env, launchCaps, findings),
    lockSiloVaultRole: lockSiloVaultRole(env, findings),
  };
  clampWithinHeadroom(params.paxgLiquidationClampPpm, params.paxg.liqRatio, findings);
  if (hasFailures(findings)) return { findings };
  return { params, findings };
}

/** Every effective parameter as a flat, sorted record of strings: the ceremony record and the input to the hash. */
export type ParameterRecord = Record<string, string>;

const ceilingText = (value: bigint): string => (value === MaxUint256 ? "unlimited" : value.toString());
export const XAUT_DORMANT_TEXT = "not applied (XAUT dormant)";
const xautText = (active: boolean, value: string): string => (active ? value : XAUT_DORMANT_TEXT);
const backstopText = (p: LaunchParameters): string =>
  p.launchCaps !== "backstop" ? "not applicable" : p.backstopRehearsal ? `${p.paxgBackstopMax} (rehearsal stand-in)` : p.paxgBackstopMax.toString();

export function parameterRecord(p: LaunchParameters): ParameterRecord {
  const entries: Array<[string, string]> = [
    ["LAUNCH_CAPS", p.launchCaps],
    ["PAXG_TOKEN", p.paxgToken],
    ["XAUT_TOKEN", p.xautToken],
    ["PAXG_FEED", p.paxgFeed],
    ["XAUT_FEED", p.xautFeed === "" ? XAUT_INACTIVE_FEED_TEXT : p.xautFeed],
    ["XAU_USD_ANCHOR_FEED", p.anchorFeed === "" ? "unset (anchor check disabled)" : p.anchorFeed],
    ["XAUT_STATUS", p.xautActive ? "active" : "dormant (oracle entry only)"],
    ["PAXG_GOLD_BAND_PPM", p.paxgGoldBandPpm.toString()],
    ["PAXG_LIQUIDATION_CLAMP_PPM", p.paxgLiquidationClampPpm.toString()],
    ["PAXG_BACKSTOP_MAX", backstopText(p)],
    ["TIMELOCK_PROPOSER", p.proposers.join(",")],
    ["TIMELOCK_EXECUTOR", p.executors.join(",")],
    ["TIMELOCK_GUARDIAN", p.guardian],
    ["STALENESS_THRESHOLD", String(p.stalenessThreshold)],
    ["SILO_CAP", p.siloCap.toString()],
    ["PAXG_MIN_RATIO", String(p.paxg.minRatio)],
    ["PAXG_LIQ_RATIO", String(p.paxg.liqRatio)],
    ["PAXG_LIQ_PENALTY", String(p.paxg.liqPenalty)],
    ["PAXG_DEBT_CEILING", ceilingText(p.paxg.debtCeiling)],
    ["PAXG_STABILITY_FEE_BPS", String(p.paxg.stabilityFeeBps)],
    ["XAUT_MIN_RATIO", xautText(p.xautActive, String(p.xaut.minRatio))],
    ["XAUT_LIQ_RATIO", xautText(p.xautActive, String(p.xaut.liqRatio))],
    ["XAUT_LIQ_PENALTY", xautText(p.xautActive, String(p.xaut.liqPenalty))],
    ["XAUT_DEBT_CEILING", xautText(p.xautActive, ceilingText(p.xaut.debtCeiling))],
    ["XAUT_STABILITY_FEE_BPS", xautText(p.xautActive, String(p.xaut.stabilityFeeBps))],
    ["MIN_GSUSD_RESERVE", p.minGsusdReserve.toString()],
    ["MIN_COLLATERAL_RESERVE", p.minCollateralReserve.toString()],
    ["RESERVE_PENALTY_SHARE_BPS", p.reservePenaltyShareBps.toString()],
    ["ORIGINATION_FEE_BPS", p.originationFeeBps.toString()],
    ["MIN_DEBT_WEI", p.minDebt.toString()],
    ["UNDERWATER_DISCOUNT_PPM", p.underwaterDiscountPpm.toString()],
    ["RESERVE_DAILY_CAP_PPM", p.reserveDailyCapPpm.toString()],
    ["RESERVE_MIN_RESERVE_PAXG", p.reserveMinReservePaxg.toString()],
    ["RESERVE_MIN_RESERVE_XAUT", xautText(p.xautActive, p.reserveMinReserveXaut.toString())],
    ["RESERVE_AGGREGATE_DAILY_CAP_USD", p.reserveAggregateDailyCapUsd.toString()],
    ["BAD_DEBT_PAUSE_THRESHOLD", p.badDebtPauseThreshold.toString()],
    ["PER_BLOCK_MINT_CAP", p.perBlockMintCap.toString()],
    ["SILO_LOCK_VAULT_ROLE", String(p.lockSiloVaultRole)],
  ];
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** keccak256 of the record's canonical JSON (sorted keys); what deploy.ts compares against the preflight record. */
export function parameterHash(record: ParameterRecord): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
  return keccak256(toUtf8Bytes(canonical));
}

export const PREFLIGHT_RECORD_SCHEMA = "goldstandard-preflight/1";

/** How long a preflight record opens the deploy gate, in minutes of chain time; PREFLIGHT_MAX_AGE_MINUTES overrides it. */
export const PREFLIGHT_MAX_AGE_MINUTES = 60;

/**
 * PREFLIGHT_MAX_AGE_MINUTES as typed: a whole number of minutes above zero, or the default when
 * unset. Anything else is refused, never read as "no limit".
 */
export function parsePreflightMaxAgeMinutes(raw: string | undefined): number {
  if (raw === undefined) return PREFLIGHT_MAX_AGE_MINUTES;
  const value = raw.trim();
  if (!/^[1-9]\d{0,5}$/.test(value)) throw new Error(`PREFLIGHT_MAX_AGE_MINUTES must be a whole number of minutes from 1 to 999999, got "${raw}"; remove the line for the ${PREFLIGHT_MAX_AGE_MINUTES} minute default`);
  return Number(value);
}

/**
 * One governance Safe as the preflight read it. `threshold` and `owners` are absent for the zero
 * address (an accepted open executor) and for an address that did not answer the Safe views.
 */
export interface SafeRecord {
  role: "proposer" | "executor" | "guardian";
  address: string;
  threshold?: string;
  owners?: string[];
  /** Why the Safe views could not be read; never present on a mainnet record, where that fails the preflight. */
  unreadable?: string;
}

const safeKey = (safe: SafeRecord): string => `${safe.role}:${safe.address.toLowerCase()}`;
const ownerSet = (owners: readonly string[] | undefined): string => (owners === undefined ? "unread" : [...owners].map((o) => o.toLowerCase()).sort().join(","));
const safeShape = (safe: SafeRecord): string => (safe.threshold === undefined || safe.owners === undefined ? "no readable Safe policy" : `${safe.threshold}-of-${safe.owners.length}`);

/**
 * How the Safes read now differ from the Safes the preflight recorded: an empty list means every
 * role still names the same address with the same threshold and the same owners (in any order).
 * A Safe whose owners or threshold changed after the preflight would otherwise be wired into a
 * timelock that has no admin to repair it.
 */
export function safeRecordProblems(recorded: readonly SafeRecord[], live: readonly SafeRecord[]): string[] {
  const problems: string[] = [];
  const liveByKey = new Map(live.map((safe) => [safeKey(safe), safe]));
  for (const before of recorded) {
    const now = liveByKey.get(safeKey(before));
    if (!now) {
      problems.push(`the ${before.role} ${before.address} the preflight recorded is not among the Safes this deploy would wire`);
      continue;
    }
    if (before.threshold !== now.threshold) problems.push(`the ${before.role} Safe ${before.address} was ${safeShape(before)} at the preflight and is ${safeShape(now)} now`);
    if (ownerSet(before.owners) !== ownerSet(now.owners)) {
      const was = new Set((before.owners ?? []).map((o) => o.toLowerCase()));
      const is = new Set((now.owners ?? []).map((o) => o.toLowerCase()));
      const added = [...is].filter((o) => !was.has(o));
      const removed = [...was].filter((o) => !is.has(o));
      const detail = [added.length > 0 ? `added ${added.join(", ")}` : "", removed.length > 0 ? `removed ${removed.join(", ")}` : ""].filter((part) => part !== "").join("; ");
      problems.push(`the owners of the ${before.role} Safe ${before.address} changed since the preflight (${detail || "the owner set can no longer be read"})`);
    }
  }
  const recordedKeys = new Set(recorded.map(safeKey));
  for (const now of live) {
    if (!recordedKeys.has(safeKey(now))) problems.push(`the ${now.role} ${now.address} is not in the preflight record`);
  }
  return problems;
}

export interface PreflightRecord {
  schema: typeof PREFLIGHT_RECORD_SCHEMA;
  network: string;
  chainId: number;
  deployer: string;
  /**
   * The deployer's transaction count when the preflight passed. deploy.ts starts a ceremony only
   * at this nonce, so the record cannot be replayed after a deploy has spent from the key.
   * Absent from records written before 2026-11-11, which a mandatory gate refuses.
   */
  deployerNonce?: number;
  createdAt: string;
  /**
   * The timestamp of the chain's latest block when the preflight passed, in Unix seconds. The
   * record opens the deploy gate for PREFLIGHT_MAX_AGE_MINUTES of chain time after it. Absent
   * from records written before the age limit, which a mandatory gate refuses.
   */
  chainTime?: number;
  /** The governance Safes as the preflight read them; deploy.ts reads them again and compares. Absent from older records, which a mandatory gate refuses. */
  safes?: SafeRecord[];
  /** OPERATIONS_SAFE when the preflight checked one. Informational: it is wired into no contract. */
  operationsSafe?: string;
  parametersHash: string;
  parameters: ParameterRecord;
  findings: Finding[];
}

export function buildPreflightRecord(input: {
  network: string;
  chainId: number;
  deployer: string;
  deployerNonce: number;
  createdAt: string;
  chainTime: number;
  safes: SafeRecord[];
  operationsSafe?: string;
  params: LaunchParameters;
  findings: Finding[];
}): PreflightRecord {
  const parameters = parameterRecord(input.params);
  return {
    schema: PREFLIGHT_RECORD_SCHEMA,
    network: input.network,
    chainId: input.chainId,
    deployer: input.deployer,
    deployerNonce: input.deployerNonce,
    createdAt: input.createdAt,
    chainTime: input.chainTime,
    safes: input.safes,
    ...(input.operationsSafe === undefined ? {} : { operationsSafe: input.operationsSafe }),
    parametersHash: parameterHash(parameters),
    parameters,
    findings: input.findings,
  };
}

/** The file name deploy.ts and verify-deployment.ts look for next to deployments/<network>.json. */
export const preflightRecordName = (network: string): string => `${network}.preflight.json`;

export function parsePreflightRecord(text: string): PreflightRecord {
  const record = JSON.parse(text) as Partial<PreflightRecord>;
  if (record.schema !== PREFLIGHT_RECORD_SCHEMA) throw new Error(`preflight record has schema ${String(record.schema)}, expected ${PREFLIGHT_RECORD_SCHEMA}`);
  if (typeof record.parametersHash !== "string" || typeof record.parameters !== "object" || record.parameters === null) {
    throw new Error("preflight record lacks parameters or their hash");
  }
  return record as PreflightRecord;
}

export interface PreflightGateInput {
  /** The record read from disk, or undefined when the file does not exist. */
  record?: PreflightRecord;
  params: LaunchParameters;
  chainId: number;
  deployer: string;
  /** Mainnet, or REQUIRE_PREFLIGHT_RECORD=1: a missing record is itself a refusal. */
  mandatory: boolean;
  /** The deployer's transaction count now. */
  deployerNonce: number;
  /** A stopped ceremony is being resumed from its journal: the nonce has moved by design. */
  resuming: boolean;
  /** The timestamp of the chain's latest block now, in Unix seconds. */
  chainTime: number;
  /** How old the record may be, in minutes of chain time (parsePreflightMaxAgeMinutes). */
  maxAgeMinutes: number;
  /** The governance Safes as the chain shows them now (lib/preflight.ts readSafeRecords). */
  safes: readonly SafeRecord[];
}

/**
 * Why the record is too old to start a ceremony from; empty when it is fresh, or carries no
 * chain time and the gate is not mandatory. Age is measured against the chain's clock on both
 * sides, so a wrong desk clock cannot stretch it. A resume is not held to it: its record was
 * fresh when the ceremony started, and the Safes are compared on every run instead.
 */
function recordAgeProblems(record: PreflightRecord, input: PreflightGateInput): string[] {
  if (input.resuming) return [];
  if (record.chainTime === undefined) {
    return input.mandatory ? ["the preflight record carries no chain time (written before the age limit); run the preflight again"] : [];
  }
  const ageSeconds = input.chainTime - record.chainTime;
  if (ageSeconds < 0) return [`the preflight record is stamped ${-ageSeconds} s after the chain's latest block; this endpoint is behind the one the preflight used, or the record belongs to another chain. Run the preflight again on this endpoint`];
  if (ageSeconds <= input.maxAgeMinutes * 60) return [];
  return [
    `the preflight record is ${Math.floor(ageSeconds / 60)} minutes old by the chain's clock; the limit is ${input.maxAgeMinutes} minutes. ` +
      "Run the preflight again and deploy in the same sitting (PREFLIGHT_MAX_AGE_MINUTES changes the limit)",
  ];
}

/** Why the Safes no longer match the record; a record without them is refused where the gate is mandatory. */
function recordSafeProblems(record: PreflightRecord, input: PreflightGateInput): string[] {
  if (record.safes === undefined) {
    return input.mandatory ? ["the preflight record carries no Safe thresholds and owners (written before the Safe re-check); run the preflight again"] : [];
  }
  const problems = safeRecordProblems(record.safes, input.safes);
  return problems.length === 0 ? [] : [...problems, "a Safe changed after the preflight checked it: confirm the change is intended, then run the preflight again so the record matches what will be wired into the timelock"];
}

/**
 * Why deploy.ts must not proceed: an empty list means the record exists (where required),
 * was written for this chain and this deployer, hashes to exactly the parameters deploy.ts has
 * just parsed, is no older than the age limit by the chain's clock, and names Safes whose
 * thresholds and owners are still what the preflight read. A record is checked whenever it exists, mandatory or not, so
 * a rehearsal that ran the preflight is held to it too.
 */
export function preflightGateProblems(input: PreflightGateInput): string[] {
  const { record } = input;
  if (record === undefined) {
    return input.mandatory ? ["no preflight record: run scripts/preflight-mainnet.ts with this environment first; it writes deployments/<network>.preflight.json"] : [];
  }
  const problems: string[] = [];
  const expected = parameterHash(parameterRecord(input.params));
  if (parameterHash(record.parameters) !== record.parametersHash) problems.push("the preflight record's hash does not match its own parameters; the file was edited");
  if (record.parametersHash !== expected) {
    const mine = parameterRecord(input.params);
    const changed = Object.keys({ ...mine, ...record.parameters }).filter((key) => mine[key] !== record.parameters[key]);
    problems.push(`the environment differs from what the preflight saw (${changed.join(", ") || "hash mismatch"}); run the preflight again`);
  }
  if (record.chainId !== input.chainId) problems.push(`the preflight record is for chain ${record.chainId}, this deploy is on chain ${input.chainId}`);
  if (record.deployer.toLowerCase() !== input.deployer.toLowerCase()) problems.push(`the preflight checked deployer ${record.deployer}, this deploy signs as ${input.deployer}`);
  // A record says nothing about a key that has sent since it was written: a completed deploy, a
  // stopped one whose journal is gone, or anything else. Only a resume moves on from its nonce.
  if (!input.resuming) {
    if (record.deployerNonce === undefined) {
      if (input.mandatory) problems.push("the preflight record carries no deployer nonce (written before the replay check); run the preflight again");
    } else if (record.deployerNonce !== input.deployerNonce) {
      problems.push(
        `the deployer's nonce is ${input.deployerNonce}, the preflight saw ${record.deployerNonce}: ` +
          "a deploy may already have run from this record. Check deployments/ and the explorer, then run the preflight again; resume a stopped ceremony with DEPLOY_RESUME=1"
      );
    }
  }
  problems.push(...recordAgeProblems(record, input), ...recordSafeProblems(record, input));
  return problems;
}

/** The snapshot fields deploy.ts writes, compared with the record the preflight wrote; empty when they agree. */
export function snapshotRecordMismatches(config: Record<string, unknown>, record: ParameterRecord): string[] {
  const collateralOf = (key: "paxg" | "xaut"): Record<string, unknown> => (typeof config[key] === "object" && config[key] !== null ? (config[key] as Record<string, unknown>) : {});
  const asText = (value: unknown): string => (Array.isArray(value) ? value.join(",") : value === undefined || value === null ? "" : String(value));
  const ceilingOf = (value: unknown): string => (asText(value) === MaxUint256.toString() ? "unlimited" : asText(value));
  // Snapshots written before the backstop profile carry no xautActive and had XAUT active.
  const xautActive = config.xautActive !== false;
  const xautOf = (value: string): string => xautText(xautActive, value);
  const pairs: Array<[string, string]> = [
    ["LAUNCH_CAPS", asText(config.launchCaps ?? "guarded")],
    ["PAXG_TOKEN", asText(config.paxgToken)],
    ["XAUT_TOKEN", asText(config.xautToken)],
    ["PAXG_FEED", asText(config.paxgFeed)],
    ["XAUT_FEED", config.xautFeedDeployed === true ? XAUT_INACTIVE_FEED_TEXT : asText(config.xautFeed)],
    ["XAU_USD_ANCHOR_FEED", asText(config.anchorFeed) === "" ? "unset (anchor check disabled)" : asText(config.anchorFeed)],
    ["XAUT_STATUS", xautActive ? "active" : "dormant (oracle entry only)"],
    ["PAXG_GOLD_BAND_PPM", asText(config.paxgGoldBandPpm)],
    ["PAXG_LIQUIDATION_CLAMP_PPM", asText(config.paxgLiquidationClampPpm)],
    ["TIMELOCK_PROPOSER", asText(config.proposers)],
    ["TIMELOCK_EXECUTOR", asText(config.executors)],
    ["TIMELOCK_GUARDIAN", asText(config.guardian)],
    ["STALENESS_THRESHOLD", asText(config.stalenessThreshold)],
    ["SILO_CAP", asText(config.siloCap)],
    ["MIN_GSUSD_RESERVE", asText(config.minGsusdReserve)],
    ["RESERVE_PENALTY_SHARE_BPS", asText(config.reservePenaltyShareBps)],
    // Snapshots written before the fee was a launch parameter shipped it at 0.
    ["ORIGINATION_FEE_BPS", asText(config.originationFeeBps ?? "0")],
    ["MIN_DEBT_WEI", asText(config.minDebt)],
    ["UNDERWATER_DISCOUNT_PPM", asText(config.underwaterDiscountPpm)],
    ["RESERVE_DAILY_CAP_PPM", asText(config.reserveDailyCapPpm)],
    ["RESERVE_AGGREGATE_DAILY_CAP_USD", asText(config.reserveAggregateDailyCapUsd)],
    // Recorded by deploy.ts from 2026-11-11; a snapshot without them disagrees.
    ["MIN_COLLATERAL_RESERVE", asText(config.minCollateralReserve)],
    ["RESERVE_MIN_RESERVE_PAXG", asText(config.reserveMinReservePaxg)],
    ["RESERVE_MIN_RESERVE_XAUT", xautOf(asText(config.reserveMinReserveXaut))],
    ["BAD_DEBT_PAUSE_THRESHOLD", asText(config.badDebtPauseThreshold)],
    ["PER_BLOCK_MINT_CAP", asText(config.perBlockMintCap)],
    ["SILO_LOCK_VAULT_ROLE", asText(config.lockSiloVaultRole)],
    ["PAXG_MIN_RATIO", asText(collateralOf("paxg").minRatio)],
    ["PAXG_LIQ_RATIO", asText(collateralOf("paxg").liqRatio)],
    ["PAXG_LIQ_PENALTY", asText(collateralOf("paxg").liqPenalty)],
    ["PAXG_DEBT_CEILING", ceilingOf(collateralOf("paxg").debtCeiling)],
    ["PAXG_STABILITY_FEE_BPS", asText(collateralOf("paxg").stabilityFeeBps)],
    ["XAUT_MIN_RATIO", xautOf(asText(collateralOf("xaut").minRatio))],
    ["XAUT_LIQ_RATIO", xautOf(asText(collateralOf("xaut").liqRatio))],
    ["XAUT_LIQ_PENALTY", xautOf(asText(collateralOf("xaut").liqPenalty))],
    ["XAUT_DEBT_CEILING", xautOf(ceilingOf(collateralOf("xaut").debtCeiling))],
    ["XAUT_STABILITY_FEE_BPS", xautOf(asText(collateralOf("xaut").stabilityFeeBps))],
  ];
  return pairs
    .filter(([key, value]) => record[key] !== undefined && record[key].toLowerCase() !== value.toLowerCase())
    .map(([key, value]) => `${key}: snapshot ${value}, preflight ${record[key]}`);
}
