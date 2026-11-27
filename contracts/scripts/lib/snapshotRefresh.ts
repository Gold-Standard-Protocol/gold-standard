/**
 * What refresh-deployment-snapshot.ts writes back into `deployments/<net>.json`: the governed
 * risk parameters verify-deployment.ts and the agent manifest compare against, read from the
 * chain. Pure, so the rules are tested without a network.
 *
 * Refreshed: both collateral types' ratios, penalty and ceiling, the SurplusBuffer's governed
 * minimum, GoldVault's minDebt, underwaterDiscountPpm and originationFeeBps, PAXG's gold band
 * and liquidation clamp on the oracle, the oracle's staleness threshold and the reserve's daily
 * cap for PAXG. Once only the first two were, so a governed change
 * to any of the others failed verify-deployment for good; the last two were added because
 * the same fate awaited a governed threshold or cap change. Since
 * verify-deployment compares every launch parameter by equality, the rest are
 * refreshed too: each stability fee, the penalty share, the bad debt threshold, the per-block
 * mint cap, the reserve's minimums, aggregate cap and spread curve, the buffer's PAXG floor, the
 * silo cap and the silo role lock. A snapshot written before one of them was recorded gains it.
 *
 * Never refreshed: addresses, roles, the guardian, the runtime code hashes and the constructor
 * arguments governance cannot change (the silo cap it can), so the refresh cannot paper over a
 * wiring, handover or bytecode fault. A dormant XAUT (no collateral type on chain and
 * `xautActive` false in the snapshot) keeps the configuration deploy.ts recorded: the zeros the
 * vault answers for an unregistered type are not a configuration.
 *
 * XAUT activation (GitHub issue 75). When the snapshot records XAUT dormant and the vault shows
 * an active XAUT collateral type, governance has run the activation batch. That is a transition,
 * not drift, and it is recorded only when the operator says so (`xautActivated`, XAUT_ACTIVATED=1
 * on the script): `xautActive` becomes true, `xautActivatedAt` is stamped and `xautMarketFeed`
 * takes the feed the oracle now prices XAUT on. `xautFeed` is left alone: it is the oracle's
 * constructor argument, which Etherscan verification rebuilds. Without the flag the refresh
 * refuses and writes nothing, so an XAUT activated by mistake cannot slip into the snapshot.
 */

import type { LaunchParameterReading } from "./launchParameterChecks";
import { stabilityFeeBpsOf } from "./launchParameterChecks";

export interface CollateralReading {
  active: boolean;
  minRatio: bigint;
  liquidationRatio: bigint;
  liquidationPenalty: bigint;
  debtCeiling: bigint;
}

/** readLaunchParameters' reading, less the code hashes (never refreshed), plus the collateral types and the oracle's settings. */
export interface ChainParameters extends Omit<LaunchParameterReading, "runtimeCodeHashes"> {
  paxg: CollateralReading;
  xaut: CollateralReading;
  paxgGoldBandPpm: bigint;
  paxgLiquidationClampPpm: bigint;
  /** GoldOracle.stalenessThreshold(), seconds. */
  stalenessThreshold: bigint;
  /** GoldOracle.feeds(xautToken).feed: the feed XAUT is priced on now. Needed only to record an activation. */
  xautFeed?: string;
}

export interface RefreshOptions {
  /** XAUT_ACTIVATED=1: the operator confirms governance activated XAUT, so the transition may be recorded. */
  xautActivated?: boolean;
  /** The activation stamp, ISO 8601; the current time when absent. */
  now?: string;
}

/** True when the snapshot records XAUT dormant while the vault shows an active XAUT collateral type. */
export function xautActivationPending(recorded: Pick<RefreshableConfig, "xautActive">, chain: Pick<ChainParameters, "xaut">): boolean {
  return recorded.xautActive === false && chain.xaut.active;
}

export type XautStatus = "dormant" | "active-since-deploy" | "activated";

/**
 * How a snapshot records XAUT: dormant (the launch), active since the deploy (the guarded testnet
 * profile, or a snapshot from before the flag existed), or activated afterwards by governance,
 * which only a refresh with XAUT_ACTIVATED=1 writes. verify-deployment.ts accepts the last on
 * mainnet and refuses the second.
 */
export function xautStatusOf(config: { xautActive?: unknown; xautActivatedAt?: unknown }): XautStatus {
  if (config.xautActive === false) return "dormant";
  return typeof config.xautActivatedAt === "string" && config.xautActivatedAt !== "" ? "activated" : "active-since-deploy";
}

export interface SnapshotCollateral {
  minRatio: number;
  liqRatio: number;
  liqPenalty: number;
  debtCeiling: string;
  [key: string]: unknown;
}

export interface RefreshableConfig {
  xautActive?: boolean;
  /** When a refresh recorded XAUT's activation by governance; absent on a snapshot that never had one. */
  xautActivatedAt?: string;
  /** The feed the oracle prices XAUT on since its activation; `xautFeed` stays the constructor's. */
  xautMarketFeed?: string;
  paxg: SnapshotCollateral;
  xaut: SnapshotCollateral;
  minGsusdReserve?: string;
  minDebt?: string;
  underwaterDiscountPpm?: string;
  originationFeeBps?: string;
  paxgGoldBandPpm?: string;
  paxgLiquidationClampPpm?: string;
  /** A number, not a string: verify-deployment and the manifest read it as one. */
  stalenessThreshold?: number;
  reserveDailyCapPpm?: string;
  reserveMinReserveXaut?: string;
  reserveSpreadCurve?: Array<{ coverageAtLeastPpm: string; spreadPpm: string }>;
  lockSiloVaultRole?: boolean;
  [key: string]: unknown;
}

export interface RefreshResult<T extends RefreshableConfig> {
  /** A new config object; the input is never modified. */
  config: T;
  /** Dotted keys whose recorded value differs from the chain's. */
  changed: string[];
  /** What was deliberately left as recorded, and why. */
  kept: string[];
}

const SCALARS = [
  "minGsusdReserve",
  "minDebt",
  "underwaterDiscountPpm",
  "originationFeeBps",
  "paxgGoldBandPpm",
  "paxgLiquidationClampPpm",
  "reserveDailyCapPpm",
  "reservePenaltyShareBps",
  "badDebtPauseThreshold",
  "perBlockMintCap",
  "reserveMinReservePaxg",
  "reserveAggregateDailyCapUsd",
  "reserveRestrictedSpreadPpm",
  "minCollateralReserve",
  "siloCap",
] as const;

/**
 * The collateral type as the chain reports it. The stability fee is stored on chain as a
 * per-second rate; it is written back in basis points, as deploy.ts records it, when a whole
 * basis point figure maps to that rate exactly, and kept as recorded otherwise.
 */
function collateralFrom(recorded: SnapshotCollateral, reading: CollateralReading, feeRate: bigint | undefined): SnapshotCollateral {
  const feeBps = feeRate === undefined ? undefined : stabilityFeeBpsOf(feeRate);
  return {
    ...recorded,
    minRatio: Number(reading.minRatio),
    liqRatio: Number(reading.liquidationRatio),
    liqPenalty: Number(reading.liquidationPenalty),
    debtCeiling: reading.debtCeiling.toString(),
    ...(feeBps === undefined ? {} : { stabilityFeeBps: Number(feeBps) }),
  };
}

function collateralChanges(key: string, before: SnapshotCollateral, after: SnapshotCollateral): string[] {
  return (["minRatio", "liqRatio", "liqPenalty", "debtCeiling", "stabilityFeeBps"] as const)
    .filter((field) => String(before[field]) !== String(after[field]))
    .map((field) => `${key}.${field}`);
}

const spreadCurveOf = (steps: ChainParameters["reserveSpreadCurve"]): Array<{ coverageAtLeastPpm: string; spreadPpm: string }> =>
  steps.map((step) => ({ coverageAtLeastPpm: step.coverageAtLeastPpm.toString(), spreadPpm: step.spreadPpm.toString() }));

/**
 * What an activation adds to the config, or a refusal: the transition is recorded only with the
 * operator's word and only when everything it needs was read from the chain.
 */
function xautActivation(recorded: RefreshableConfig, chain: ChainParameters, options: RefreshOptions): { xautActive?: true; xautActivatedAt?: string; xautMarketFeed?: string } {
  const pending = xautActivationPending(recorded, chain);
  if (!pending) {
    if (options.xautActivated && recorded.xautActive === false) {
      throw new Error("XAUT_ACTIVATED=1 is set, but the vault shows no active XAUT collateral type: the activation batch has not executed. Nothing was written; unset XAUT_ACTIVATED or run again once it has.");
    }
    return {};
  }
  if (!options.xautActivated) {
    throw new Error(
      "The vault shows an active XAUT collateral type while the snapshot records XAUT as dormant: governance has activated it. " +
        "Nothing was written. If that is the activation batch, run again with XAUT_ACTIVATED=1 to record it (xautActive, the activation time and XAUT's live feed); if it is not, stop and investigate."
    );
  }
  if (chain.xautFeed === undefined || chain.xautStabilityFeeRate === undefined) {
    throw new Error("Recording XAUT's activation needs its live oracle feed and its stability fee rate read from the chain; neither may be skipped. Nothing was written.");
  }
  return { xautActive: true, xautActivatedAt: options.now ?? new Date().toISOString(), xautMarketFeed: chain.xautFeed };
}

/** The recorded config with the governed parameters replaced by what the chain reports. */
export function refreshSnapshotConfig<T extends RefreshableConfig>(recorded: T, chain: ChainParameters, options: RefreshOptions = {}): RefreshResult<T> {
  const changed: string[] = [];
  const kept: string[] = [];
  const activation = xautActivation(recorded, chain, options);
  if (activation.xautActive) changed.push("xautActive", "xautActivatedAt", "xautMarketFeed");
  else if (options.xautActivated) kept.push("xautActive (XAUT_ACTIVATED=1 has no effect: the snapshot already records XAUT as active)");

  const paxg = collateralFrom(recorded.paxg, chain.paxg, chain.paxgStabilityFeeRate);
  changed.push(...collateralChanges("paxg", recorded.paxg, paxg));
  if (stabilityFeeBpsOf(chain.paxgStabilityFeeRate) === undefined) {
    kept.push(`paxg.stabilityFeeBps (the chain's per-second rate ${chain.paxgStabilityFeeRate} is no whole basis point figure)`);
  }

  let xaut = recorded.xaut;
  let reserveMinReserveXaut: { reserveMinReserveXaut?: string } = {};
  if (recorded.xautActive === false && !chain.xaut.active) {
    kept.push("xaut (dormant: no collateral type on chain, so the recorded configuration stands)");
  } else {
    xaut = collateralFrom(recorded.xaut, chain.xaut, chain.xautStabilityFeeRate);
    changed.push(...collateralChanges("xaut", recorded.xaut, xaut));
    if (chain.reserveMinReserveXaut !== undefined) {
      reserveMinReserveXaut = { reserveMinReserveXaut: chain.reserveMinReserveXaut.toString() };
      if (recorded.reserveMinReserveXaut !== reserveMinReserveXaut.reserveMinReserveXaut) changed.push("reserveMinReserveXaut");
    }
  }

  const reserveSpreadCurve = spreadCurveOf(chain.reserveSpreadCurve);
  if (JSON.stringify(recorded.reserveSpreadCurve) !== JSON.stringify(reserveSpreadCurve)) changed.push("reserveSpreadCurve");
  if (recorded.lockSiloVaultRole !== chain.lockSiloVaultRole) changed.push("lockSiloVaultRole");

  const scalars: Partial<Record<(typeof SCALARS)[number], string>> = {};
  for (const key of SCALARS) {
    const value = chain[key].toString();
    scalars[key] = value;
    if (recorded[key] === undefined || String(recorded[key]) !== value) changed.push(key);
  }

  // deploy.ts records the threshold as a number and verify-deployment compares it with ===,
  // so it is written back as one rather than through the string scalars above.
  const stalenessThreshold = Number(chain.stalenessThreshold);
  if (recorded.stalenessThreshold === undefined || Number(recorded.stalenessThreshold) !== stalenessThreshold) {
    changed.push("stalenessThreshold");
  }

  return {
    config: { ...recorded, ...activation, paxg, xaut, ...reserveMinReserveXaut, ...scalars, reserveSpreadCurve, lockSiloVaultRole: chain.lockSiloVaultRole, stalenessThreshold },
    changed,
    kept,
  };
}
