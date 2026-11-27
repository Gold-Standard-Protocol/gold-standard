/**
 * The launch parameters verify-deployment.ts compares, by equality, with what deploy.ts recorded
 * in `deployments/<network>.json`. Before this, the stability fee was checked
 * only as an initialised accumulator, the reserve's daily cap as a range and the bad debt
 * threshold as non-zero; the penalty share, the aggregate daily cap, the reserve minimums, the
 * spread curve, the buffer's collateral floor, the silo cap and the runtime code hashes were not
 * compared at all, and a snapshot without minDebt, the underwater discount or the origination
 * fee skipped those checks in silence. A wiring call that passed the wrong value printed OK and
 * the handover put it behind the 48 hour timelock.
 *
 * Every comparison here fails when the snapshot does not record its value. A testnet snapshot
 * written before a field was recorded gains it from scripts/refresh-deployment-snapshot.ts,
 * which reads every governed value below back from the chain.
 *
 * readLaunchParameters reads the chain; launchParameterChecks is pure, so the rules are tested
 * against a ceremony on the Hardhat network (test/VerifyDeployment.test.ts).
 */
import { ethers } from "hardhat";

export interface ParameterCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface SpreadStep {
  coverageAtLeastPpm: bigint;
  spreadPpm: bigint;
}

/** What the chain reports for each launch parameter deploy.ts records. */
export interface LaunchParameterReading {
  paxgStabilityFeeRate: bigint;
  /** Read only while XAUT is an active collateral; a dormant XAUT has no stability fee. */
  xautStabilityFeeRate?: bigint;
  minDebt: bigint;
  underwaterDiscountPpm: bigint;
  originationFeeBps: bigint;
  reservePenaltyShareBps: bigint;
  badDebtPauseThreshold: bigint;
  perBlockMintCap: bigint;
  reserveDailyCapPpm: bigint;
  reserveMinReservePaxg: bigint;
  /** Read only while XAUT is an active collateral; a dormant XAUT is no reserve asset. */
  reserveMinReserveXaut?: bigint;
  reserveAggregateDailyCapUsd: bigint;
  reserveSpreadCurve: SpreadStep[];
  reserveRestrictedSpreadPpm: bigint;
  minGsusdReserve: bigint;
  minCollateralReserve: bigint;
  siloCap: bigint;
  lockSiloVaultRole: boolean;
  /** keccak256 of the runtime code at each snapshot address. */
  runtimeCodeHashes: Record<string, string>;
}

/** The parts of the snapshot the comparison reads. */
export interface RecordedDeployment {
  addresses: Record<string, string>;
  config: Record<string, unknown>;
  build?: { runtimeCodeHashes?: Record<string, string> };
}

const PRECISION = 10n ** 18n;
const SECONDS_PER_YEAR = 365n * 86_400n;

/** StabilityModule._annualToPerSecond: the per-second rate initCollateral and setStabilityFee store for `bps`. */
export function stabilityFeeRateOf(bps: bigint): bigint {
  return PRECISION + (bps * PRECISION) / (10_000n * SECONDS_PER_YEAR);
}

/** The whole basis point figure whose per-second rate is `rate`, or undefined when none maps to it exactly. */
export function stabilityFeeBpsOf(rate: bigint): bigint | undefined {
  if (rate < PRECISION) return undefined;
  const estimate = ((rate - PRECISION) * 10_000n * SECONDS_PER_YEAR) / PRECISION;
  return [estimate, estimate + 1n].find((bps) => stabilityFeeRateOf(bps) === rate);
}

const collateralId = (token: string): string => ethers.keccak256(ethers.solidityPacked(["address"], [token]));

/** Reads every value launchParameterChecks compares, at the latest block. */
export async function readLaunchParameters(recorded: RecordedDeployment): Promise<LaunchParameterReading> {
  const a = recorded.addresses;
  const paxgToken = String(recorded.config.paxgToken);
  const xautToken = String(recorded.config.xautToken);
  const xautActive = recorded.config.xautActive !== false;
  const vault = await ethers.getContractAt("GoldVault", a.vault);
  const stabilityModule = await ethers.getContractAt("StabilityModule", a.stabilityModule);
  const reserve = await ethers.getContractAt("GoldStabilityReserve", a.reserve);
  const surplusBuffer = await ethers.getContractAt("SurplusBuffer", a.surplusBuffer);
  const siloFactory = await ethers.getContractAt("SiloFactory", a.siloFactory);

  const steps = Number(await reserve.spreadCurveLength());
  const reserveSpreadCurve: SpreadStep[] = [];
  for (let i = 0; i < steps; i++) {
    const step = await reserve.spreadCurve(i);
    reserveSpreadCurve.push({ coverageAtLeastPpm: step.coverageAtLeastPpm, spreadPpm: step.spreadPpm });
  }
  const runtimeCodeHashes: Record<string, string> = {};
  for (const [name, address] of Object.entries(a)) {
    runtimeCodeHashes[name] = ethers.keccak256(await ethers.provider.getCode(address));
  }
  const paxgAsset = await reserve.assets(paxgToken);
  return {
    paxgStabilityFeeRate: await stabilityModule.stabilityFeeRate(collateralId(paxgToken)),
    xautStabilityFeeRate: xautActive ? await stabilityModule.stabilityFeeRate(collateralId(xautToken)) : undefined,
    minDebt: await vault.minDebt(),
    underwaterDiscountPpm: await vault.underwaterDiscountPpm(),
    originationFeeBps: await vault.originationFeeBps(),
    reservePenaltyShareBps: await vault.reservePenaltyShareBps(),
    badDebtPauseThreshold: await vault.badDebtPauseThreshold(),
    perBlockMintCap: await vault.perBlockMintCap(),
    reserveDailyCapPpm: paxgAsset.dailyCapPpm,
    reserveMinReservePaxg: paxgAsset.minReserve,
    reserveMinReserveXaut: xautActive ? (await reserve.assets(xautToken)).minReserve : undefined,
    reserveAggregateDailyCapUsd: await reserve.aggregateDailyCapUsd(),
    reserveSpreadCurve,
    reserveRestrictedSpreadPpm: await reserve.restrictedSpreadPpm(),
    minGsusdReserve: await surplusBuffer.minGsusdReserve(),
    minCollateralReserve: await surplusBuffer.minCollateralReserve(paxgToken),
    siloCap: await siloFactory.siloCap(),
    lockSiloVaultRole: await siloFactory.vaultRoleLocked(),
    runtimeCodeHashes,
  };
}

export const MISSING_HINT =
  "deploy.ts records it; on a testnet snapshot written before it was recorded, run scripts/refresh-deployment-snapshot.ts to record the chain's value, then verify again";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const spreadText = (steps: Array<{ coverageAtLeastPpm: unknown; spreadPpm: unknown }>): string =>
  steps.length === 0 ? "none" : steps.map((s) => `${String(s.coverageAtLeastPpm)}:${String(s.spreadPpm)}`).join(",");

/** One equality check; a value the snapshot does not record fails rather than passing unchecked. */
function equality(name: string, key: string, recorded: unknown, got: bigint | boolean): ParameterCheck {
  if (recorded === undefined || recorded === null) return { name, pass: false, detail: `the snapshot records no config.${key}; ${MISSING_HINT}` };
  const expected = String(recorded);
  return expected === got.toString() ? { name: `${name} (${expected})`, pass: true } : { name, pass: false, detail: `got ${got}, the snapshot records ${expected}` };
}

function stabilityFee(label: "paxg" | "xaut", collateral: unknown, rate: bigint): ParameterCheck {
  const name = `param:stabilityModule.${label}.stabilityFeeRate`;
  const bps = isRecord(collateral) ? collateral.stabilityFeeBps : undefined;
  if (bps === undefined || bps === null) return { name, pass: false, detail: `the snapshot records no config.${label}.stabilityFeeBps; ${MISSING_HINT}` };
  if (!/^\d+$/.test(String(bps))) return { name, pass: false, detail: `the snapshot's config.${label}.stabilityFeeBps is ${String(bps)}, not a whole number` };
  const expected = stabilityFeeRateOf(BigInt(String(bps)));
  if (rate === expected) return { name: `${name} (${String(bps)} bps)`, pass: true };
  const chainBps = stabilityFeeBpsOf(rate);
  return { name, pass: false, detail: `the chain charges ${chainBps === undefined ? `a per-second rate of ${rate}` : `${chainBps} bps`}, the snapshot records ${String(bps)} bps` };
}

function spreadCurve(recorded: unknown, chain: SpreadStep[]): ParameterCheck {
  const name = "param:reserve.spreadCurve";
  if (!Array.isArray(recorded)) return { name, pass: false, detail: `the snapshot records no config.reserveSpreadCurve; ${MISSING_HINT}` };
  const expected = spreadText(recorded.map((step) => (isRecord(step) ? { coverageAtLeastPpm: step.coverageAtLeastPpm, spreadPpm: step.spreadPpm } : { coverageAtLeastPpm: "?", spreadPpm: "?" })));
  const got = spreadText(chain);
  return expected === got ? { name: `${name} (${got})`, pass: true } : { name, pass: false, detail: `got ${got}, the snapshot records ${expected} (coverage ppm:spread ppm)` };
}

function codeHashes(recorded: RecordedDeployment, chain: Record<string, string>): ParameterCheck[] {
  const hashes = recorded.build?.runtimeCodeHashes;
  return Object.keys(recorded.addresses).map((name): ParameterCheck => {
    const check = `code:${name}.runtime-hash`;
    const expected = hashes?.[name];
    if (expected === undefined) return { name: check, pass: false, detail: `the snapshot records no build.runtimeCodeHashes.${name}; redeploy, or record keccak256 of the verified build's runtime code` };
    return expected.toLowerCase() === (chain[name] ?? "").toLowerCase()
      ? { name: check, pass: true }
      : { name: check, pass: false, detail: `the code at ${recorded.addresses[name]} hashes to ${chain[name] ?? "nothing"}, the snapshot records ${expected}` };
  });
}

/** Every recorded launch parameter compared with the chain by equality, then every runtime code hash. */
export function launchParameterChecks(recorded: RecordedDeployment, chain: LaunchParameterReading): ParameterCheck[] {
  const c = recorded.config;
  const xautActive = c.xautActive !== false;
  const checks: ParameterCheck[] = [
    stabilityFee("paxg", c.paxg, chain.paxgStabilityFeeRate),
    equality("param:vault.minDebt", "minDebt", c.minDebt, chain.minDebt),
    equality("param:vault.underwaterDiscountPpm", "underwaterDiscountPpm", c.underwaterDiscountPpm, chain.underwaterDiscountPpm),
    equality("param:vault.originationFeeBps", "originationFeeBps", c.originationFeeBps, chain.originationFeeBps),
    equality("param:vault.reservePenaltyShareBps", "reservePenaltyShareBps", c.reservePenaltyShareBps, chain.reservePenaltyShareBps),
    equality("param:vault.badDebtPauseThreshold", "badDebtPauseThreshold", c.badDebtPauseThreshold, chain.badDebtPauseThreshold),
    equality("param:vault.perBlockMintCap", "perBlockMintCap", c.perBlockMintCap, chain.perBlockMintCap),
    equality("param:reserve.paxg.dailyCapPpm", "reserveDailyCapPpm", c.reserveDailyCapPpm, chain.reserveDailyCapPpm),
    equality("param:reserve.paxg.minReserve", "reserveMinReservePaxg", c.reserveMinReservePaxg, chain.reserveMinReservePaxg),
    equality("param:reserve.aggregateDailyCapUsd", "reserveAggregateDailyCapUsd", c.reserveAggregateDailyCapUsd, chain.reserveAggregateDailyCapUsd),
    spreadCurve(c.reserveSpreadCurve, chain.reserveSpreadCurve),
    equality("param:reserve.restrictedSpreadPpm", "reserveRestrictedSpreadPpm", c.reserveRestrictedSpreadPpm, chain.reserveRestrictedSpreadPpm),
    equality("param:surplusBuffer.minGsusdReserve", "minGsusdReserve", c.minGsusdReserve, chain.minGsusdReserve),
    equality("param:surplusBuffer.paxg.minCollateralReserve", "minCollateralReserve", c.minCollateralReserve, chain.minCollateralReserve),
    equality("param:siloFactory.siloCap", "siloCap", c.siloCap, chain.siloCap),
    equality("param:siloFactory.vaultRoleLocked", "lockSiloVaultRole", c.lockSiloVaultRole, chain.lockSiloVaultRole),
  ];
  if (xautActive) {
    checks.push(stabilityFee("xaut", c.xaut, chain.xautStabilityFeeRate ?? 0n));
    checks.push(equality("param:reserve.xaut.minReserve", "reserveMinReserveXaut", c.reserveMinReserveXaut, chain.reserveMinReserveXaut ?? 0n));
  }
  return [...checks, ...codeHashes(recorded, chain.runtimeCodeHashes)];
}
