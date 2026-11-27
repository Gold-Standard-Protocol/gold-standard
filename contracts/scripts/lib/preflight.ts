/**
 * The mainnet launch preflight: every check that can be made before the first transaction
 * of the ceremony, made read-only against the live chain so a bad value is found at a desk
 * and not mid-deploy. scripts/preflight-mainnet.ts wires it to Hardhat; this file holds the
 * rules so they can be exercised against mocks on the Hardhat network.
 *
 * The environment is read through lib/launchEnv.ts, the same parser deploy.ts uses, so a
 * value that passes here is the value that gets deployed; the launch policy (ceilings at
 * zero or unlimited, the reserve floor at zero, the staleness grace) is layered on top.
 */
import { Contract, formatEther, formatUnits, getAddress, isAddress, Wallet, ZeroAddress } from "ethers";
import type { Provider, TransactionRequest } from "ethers";
import { fail, Finding, hasFailures, pass, warn } from "./findings";
import {
  BACKSTOP_REFUSED,
  hasOpenExecutor,
  LaunchParameters,
  LIMITS,
  MAINNET_MIN_DEBT,
  OPEN_EXECUTOR_REFUSED,
  parameterRecord,
  parseLaunchParameters,
} from "./launchEnv";
import type { SafeRecord } from "./launchEnv";
import type { KnownAddresses } from "./mainnetAddresses";
import { isInactiveFeed, readPythFeed, readTwapFeed } from "./marketFeeds";
import { describeError } from "./redact";

export type { Verdict, Finding } from "./findings";
export { pass, warn, fail, hasFailures, formatFindings } from "./findings";

/**
 * Everything deploy.ts will apply, plus the deployer derived from PRIVATE_KEY (the key itself
 * never leaves the parser) and the operations Safe when OPERATIONS_SAFE names one. The operations
 * Safe is wired into no contract and is not part of the parameters hash: it is checked here so
 * the address surplus is later withdrawn to is a working Safe, apart from governance.
 */
export type LaunchEnv = LaunchParameters & { deployer: string; operationsSafe?: string };

export interface PreflightInput {
  provider: Provider;
  env: LaunchEnv;
  expectedChainId: number;
  /** The published inventory; every env address must match it when given. */
  known?: KnownAddresses;
  /** The contract-creation transactions of the ceremony, for the gas estimate. */
  creations: TransactionRequest[];
  snapshotExists: boolean;
  allowExistingSnapshot: boolean;
}

/** The oracle constructor's ceiling for the staleness threshold; docs/ORACLES.md section 2. */
export const STALENESS_MAX = LIMITS.stalenessMax;
export const FEED_HEARTBEAT = 86_400;
/**
 * deploy.ts sends at most this many role-wiring and configuration transactions after the
 * creations under a PAXG-first profile (XAUT dormant, PAXG's gold band and liquidation cap
 * wired). An upper bound for the gas estimate: a setter whose value the contract already holds
 * is skipped, so the open launch at the default values sends fewer (29 on the Hardhat network,
 * test/DeployCeremony.test.ts). With the eleven creations that is at most 46 transactions; the call
 * that has the GoldStablecoinDeployer create the token is one of the thirty-five.
 */
export const WIRING_TRANSACTIONS = 35n;
const WIRING_GAS_EACH = 120_000n;
const FALLBACK_CREATION_GAS = 4_000_000n;
const GAS_MARGIN_PERCENT = 125n;
const MAINNET_CHAIN_ID = 1;

/**
 * The minimum Safe for each role, docs/MAINNET.md and docs/THREAT_MODEL.md trust assumption 4.
 * The owner set the proposer at 2-of-3 on 2026-11-11 (it was 3-of-5): every proposal still waits
 * out the 48 hour timelock, and the executor, a separate Safe, lands only what was scheduled.
 * The owner set the executor at 2-of-3 on 2026-11-16 (it was 1-of-1), so all three role Safes
 * are held to the same minimum.
 */
interface SafePolicy {
  threshold: bigint;
  owners: number;
}
export const SAFE_POLICY: Record<Role, SafePolicy> = {
  proposer: { threshold: 2n, owners: 3 },
  executor: { threshold: 2n, owners: 3 },
  guardian: { threshold: 2n, owners: 3 },
};

const REQUIRED = [
  "PAXG_TOKEN",
  "XAUT_TOKEN",
  "PAXG_FEED",
  // XAUT_FEED is absent on purpose: under open or backstop deploy.ts creates XAUT's InactiveFeed.
  "XAU_USD_ANCHOR_FEED",
  "TIMELOCK_PROPOSER",
  "TIMELOCK_EXECUTOR",
  "TIMELOCK_GUARDIAN",
  "RPC_URL",
  "PRIVATE_KEY",
] as const;

const ERC20_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
];
const SAFE_ABI = ["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"];

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function policyCaps(params: LaunchParameters, env: NodeJS.ProcessEnv, findings: Finding[]): void {
  if (params.launchCaps === "open") {
    findings.push(pass("policy:LAUNCH_CAPS", "open: the mainnet launch profile; no debt ceiling and no per-block mint cap, PAXG the only active collateral, XAUT registered in the oracle and otherwise dormant"));
    findings.push(pass("policy:PAXG_DEBT_CEILING", "unlimited: the open launch has no PAXG debt ceiling"));
    findings.push(pass("policy:PER_BLOCK_MINT_CAP", "0: the per-block mint cap is off under the open launch"));
  } else if (params.launchCaps === "backstop") {
    findings.push(fail("policy:LAUNCH_CAPS", BACKSTOP_REFUSED));
    findings.push(pass("policy:PER_BLOCK_MINT_CAP", `${formatEther(params.perBlockMintCap)} GSUSD per block`));
  } else {
    findings.push(
      fail(
        "policy:LAUNCH_CAPS",
        `${params.launchCaps}: the mainnet launch profile is open (no debt ceiling, no per-block mint cap, PAXG only, XAUT dormant), the only mainnet profile; guarded is for testnets and the end-to-end harness`
      )
    );
    findings.push(pass("policy:PER_BLOCK_MINT_CAP", `${formatEther(params.perBlockMintCap)} GSUSD per block`));
  }
  if (params.minGsusdReserve === 0n) {
    findings.push(pass("policy:MIN_GSUSD_RESERVE", "0 at deploy: the 2% reserve floor is automatic in SurplusBuffer"));
  } else {
    findings.push(
      fail(
        "policy:MIN_GSUSD_RESERVE",
        `must be 0 at deploy (got ${params.minGsusdReserve}): SurplusBuffer keeps 2% of supply by itself, and a higher governed minimum is set later through the timelock if ever wanted`
      )
    );
  }
  if (params.minDebt === MAINNET_MIN_DEBT) {
    findings.push(pass("policy:MIN_DEBT_GSUSD", `${formatEther(params.minDebt)} GSUSD: the figure the mainnet launch opens at`));
  } else {
    findings.push(
      fail(
        "policy:MIN_DEBT_GSUSD",
        `must be ${formatEther(MAINNET_MIN_DEBT)} at the mainnet launch (got ${formatEther(params.minDebt)} GSUSD; docs/LAUNCH.md); the 100 default is for Sepolia and the rehearsal harness`
      )
    );
  }
  if (env.ALLOW_NONZERO_CEILING) findings.push(fail("policy:ALLOW_NONZERO_CEILING", "must be unset for the launch deploy"));
  if (!params.lockSiloVaultRole) findings.push(fail("policy:SILO_LOCK_VAULT_ROLE", "an unlocked VAULT_ROLE is a drain key; deploy.ts refuses it on mainnet"));
  // MARKET_FEEDS (scripts/deploy-market-feeds.ts) has left the ceremony: the launch parser refuses
  // it with the other retired oracle variables, so a stale environment fails before this point.
}

/**
 * The executor policy (docs/LAUNCH.md): a restricted executor Safe by default. The zero address
 * lets anyone choose when a matured operation runs within the timelock's grace period, so it
 * is refused unless ALLOW_OPEN_EXECUTOR=1 accepts it, and an acceptance is printed with what it
 * costs.
 */
function policyExecutor(params: LaunchParameters, findings: Finding[]): void {
  const open = hasOpenExecutor(params.executors);
  if (open && !params.allowOpenExecutor) {
    findings.push(fail("policy:TIMELOCK_EXECUTOR", OPEN_EXECUTOR_REFUSED));
  } else if (open) {
    findings.push(
      warn(
        "policy:TIMELOCK_EXECUTOR",
        "the zero address, accepted with ALLOW_OPEN_EXECUTOR=1: anyone may execute a matured operation at a moment of their choosing within its 7 day grace period, so the proposer Safe must cancel every operation that is superseded, reverted or no longer wanted (docs/LAUNCH.md)"
      )
    );
  } else if (params.allowOpenExecutor) {
    findings.push(warn("policy:TIMELOCK_EXECUTOR", "restricted to the executor Safe; ALLOW_OPEN_EXECUTOR=1 has no effect without the zero address, so remove the line"));
  } else {
    findings.push(pass("policy:TIMELOCK_EXECUTOR", "restricted: only the executor Safe and the GoldGovernance wrapper execute matured operations"));
  }
}

function policyStaleness(staleness: number, findings: Finding[]): void {
  if (staleness < FEED_HEARTBEAT) {
    findings.push(fail("policy:STALENESS_THRESHOLD", `${staleness} is below the feeds' ${FEED_HEARTBEAT} s heartbeat; every quiet day would read as stale (the oracle caps the threshold at ${STALENESS_MAX})`));
  } else if (staleness < STALENESS_MAX) {
    findings.push(warn("policy:STALENESS_THRESHOLD", `${staleness} s leaves ${staleness - FEED_HEARTBEAT} s of grace over the 24 h heartbeat; 90000 is the documented value`));
  } else {
    findings.push(pass("policy:STALENESS_THRESHOLD", "90000 s (25 h)"));
  }
}

/** Reads and validates the ceremony environment. Returns no `env` when a value is unusable. */
export function parseLaunchEnv(env: NodeJS.ProcessEnv): { env?: LaunchEnv; findings: Finding[] } {
  const findings: Finding[] = [];
  for (const key of REQUIRED) {
    if (!env[key]?.trim()) findings.push(fail(`env:${key}`, "missing"));
  }
  if (hasFailures(findings)) return { findings };

  const parsed = parseLaunchParameters(env);
  findings.push(...parsed.findings);

  let deployer = ZeroAddress;
  try {
    deployer = new Wallet(env.PRIVATE_KEY ?? "").address;
    findings.push(pass("env:PRIVATE_KEY", `deployer ${deployer}`));
  } catch {
    findings.push(fail("env:PRIVATE_KEY", "not a valid 32-byte private key"));
  }
  if (!/^https?:\/\//.test(env.RPC_URL ?? "")) findings.push(fail("env:RPC_URL", "must be an http(s) URL"));
  if (!env.ETHERSCAN_API_KEY?.trim()) findings.push(warn("env:ETHERSCAN_API_KEY", "missing; scripts/verify-etherscan.ts needs it after the deploy"));
  const operations = parseOperationsSafe(env);
  findings.push(...operations.findings);

  if (parsed.params === undefined || hasFailures(findings)) return { findings };
  policyCaps(parsed.params, env, findings);
  policyExecutor(parsed.params, findings);
  policyStaleness(parsed.params.stalenessThreshold, findings);
  if (hasFailures(findings)) return { findings };
  // The effective value of every knob, defaults included, so the printout is the ceremony record.
  for (const [key, value] of Object.entries(parameterRecord(parsed.params))) findings.push(pass(`param:${key}`, value));
  return { findings, env: { ...parsed.params, deployer, ...(operations.address === undefined ? {} : { operationsSafe: operations.address }) } };
}

/**
 * OPERATIONS_SAFE, the Safe surplus is withdrawn to (docs/MAINNET.md section 1). Optional: unset
 * yields no address and the on-chain pass warns on mainnet. A line that is present must hold an
 * address, so an unfilled placeholder or an empty value is refused, never read as "none".
 */
export function parseOperationsSafe(env: NodeJS.ProcessEnv): { address?: string; findings: Finding[] } {
  const raw = env.OPERATIONS_SAFE;
  if (raw === undefined) return { findings: [] };
  const value = raw.trim();
  if (value === "") return { findings: [fail("env:OPERATIONS_SAFE", "empty; set the operations Safe's address or remove the line")] };
  if (!isAddress(value)) return { findings: [fail("env:OPERATIONS_SAFE", "not an address; set the operations Safe's address or remove the line")] };
  if (getAddress(value) === ZeroAddress) return { findings: [fail("env:OPERATIONS_SAFE", "the zero address is not a Safe; set the operations Safe's address or remove the line")] };
  return { address: getAddress(value), findings: [pass("env:OPERATIONS_SAFE", getAddress(value))] };
}

async function hasCode(provider: Provider, address: string): Promise<boolean> {
  return (await provider.getCode(address)) !== "0x";
}

function checkInventory(env: LaunchEnv, known: KnownAddresses | undefined): Finding[] {
  if (!known) return [];
  // C is the published Chainlink PAXG/USD feed and G the published Chainlink XAU/USD feed.
  const pairs: [string, string, string][] = [
    ["PAXG_TOKEN", env.paxgToken, known.paxgToken],
    ["XAUT_TOKEN", env.xautToken, known.xautToken],
    ["PAXG_FEED", env.paxgFeed, known.paxgUsdFeed],
    ["XAU_USD_ANCHOR_FEED", env.anchorFeed, known.anchorFeed],
  ];
  return pairs.map(([name, actual, expected]) =>
    same(actual, expected)
      ? pass(`inventory:${name}`, actual)
      : fail(`inventory:${name}`, `${actual} is not the published ${expected} (docs/ORACLES.md section 1)`)
  );
}

async function checkToken(provider: Provider, label: string, address: string, decimals: number, symbol: string): Promise<Finding> {
  const name = `token:${label}`;
  if (!(await hasCode(provider, address))) return fail(name, `${address} has no code`);
  const token = new Contract(address, ERC20_ABI, provider);
  try {
    const [actualDecimals, actualSymbol] = await Promise.all([token.decimals() as Promise<bigint>, token.symbol() as Promise<string>]);
    if (Number(actualDecimals) !== decimals) return fail(name, `${actualSymbol} has ${actualDecimals} decimals, expected ${decimals}`);
    if (!same(actualSymbol, symbol)) return fail(name, `symbol ${actualSymbol}, expected ${symbol}`);
    return pass(name, `${actualSymbol}, ${decimals} decimals, ${address}`);
  } catch (error) {
    return fail(name, `not an ERC-20: ${describeError(error).slice(0, 80)}`);
  }
}

interface FeedReading {
  finding: Finding;
  answer?: bigint;
}

/** A Chainlink style feed with a fixed description: the XAU/USD anchor and Chainlink PAXG/USD. */
async function checkFeed(provider: Provider, label: string, address: string, description: string, staleness: number, now: number): Promise<FeedReading> {
  const name = `feed:${label}`;
  if (!(await hasCode(provider, address))) return { finding: fail(name, `${address} has no code`) };
  const feed = new Contract(address, FEED_ABI, provider);
  try {
    const decimals = Number(await feed.decimals());
    if (decimals !== 8) return { finding: fail(name, `${decimals} decimals; the oracle requires 8`) };
    const actualDescription = await (feed.description() as Promise<string>).catch(() => undefined);
    if (actualDescription !== undefined && actualDescription.replace(/\s+/g, "") !== description.replace(/\s+/g, "")) {
      return { finding: fail(name, `describes itself as "${actualDescription}", expected "${description}"`) };
    }
    const [roundId, answer, , updatedAt, answeredInRound] = (await feed.latestRoundData()) as [bigint, bigint, bigint, bigint, bigint];
    if (answer <= 0n) return { finding: fail(name, `answer ${answer} is not positive`) };
    if (updatedAt === 0n) return { finding: fail(name, "round has no update timestamp") };
    if (updatedAt > BigInt(now)) return { finding: fail(name, "round update timestamp is in the future") };
    if (answeredInRound < roundId) return { finding: fail(name, "answer belongs to an earlier round") };
    const age = now - Number(updatedAt);
    if (age >= staleness) return { finding: fail(name, `last update ${age} s ago reaches the ${staleness} s staleness threshold`), answer };
    const described = actualDescription === undefined ? "no description()" : `"${actualDescription}"`;
    return { finding: pass(name, `${described} $${formatUnits(answer, 8)} updated ${age} s ago`), answer };
  } catch (error) {
    return { finding: fail(name, `not an AggregatorV3: ${describeError(error).slice(0, 80)}`) };
  }
}

/** The gap between a price and its reference in ppm of the reference, as GoldOracle measures the band and the clamp. */
export function gapPpm(price: bigint, reference: bigint): bigint {
  const gap = price > reference ? price - reference : reference - price;
  return (gap * 1_000_000n) / reference;
}

const percent = (ppm: bigint): string => (Number(ppm) / 10_000).toFixed(3);

function bandFinding(name: string, what: string, a: bigint, b: bigint, bandPpm: bigint, consequence: string): Finding {
  const gap = gapPpm(a, b);
  return gap <= bandPpm
    ? pass(name, `${what} sit ${percent(gap)}% apart; the band is ${percent(bandPpm)}%`)
    : fail(name, `${what} sit ${percent(gap)}% apart, outside the ${percent(bandPpm)}% band; ${consequence}`);
}

/**
 * XAUT at launch: the oracle constructor registers it on XAUT_FEED and nothing else is wired.
 * The feed must still be an 8 decimal aggregator with code, or the constructor reverts.
 */
async function checkDormantXaut(provider: Provider, env: LaunchEnv): Promise<Finding> {
  const name = "xaut:dormant";
  if (env.xautActive) return fail(name, "XAUT is configured beyond its oracle entry; at launch it is registered and inactive");
  const tail = "and nothing else: no collateral type, stability fee, reserve asset or stability pool token, so it prices nothing and deposits revert. Activation is a later governance batch (docs/LAUNCH.md, XAUT activation)";
  if (env.xautFeed === "") return pass(name, `XAUT will be registered in the oracle on an InactiveFeed that deploy.ts creates, ${tail}`);
  if (same(env.xautFeed, env.anchorFeed)) return fail(name, "XAUT_FEED is the XAU/USD anchor, which GoldOracle.setAnchorFeed refuses; leave XAUT_FEED unset");
  if (!(await isInactiveFeed(provider, env.xautFeed))) {
    return fail(name, `XAUT_FEED ${env.xautFeed} is not an InactiveFeed (8 decimals, description "Inactive", an all-zero round); leave it unset and deploy.ts creates one`);
  }
  return pass(name, `XAUT will be registered in the oracle on the InactiveFeed ${env.xautFeed}, ${tail}`);
}

/**
 * No configured feed address may be a PythMarketFeed or a UniswapV3TwapFeed: the oracle prices on
 * Chainlink PAXG/USD and XAU/USD alone, and both adapters stay in the repository outside the
 * production path.
 */
async function checkNoAdapters(provider: Provider, env: LaunchEnv): Promise<Finding[]> {
  const configured: Array<[string, string]> = [
    ["PAXG_FEED", env.paxgFeed],
    ["XAUT_FEED", env.xautFeed],
    ["XAU_USD_ANCHOR_FEED", env.anchorFeed],
  ];
  const pyth: string[] = [];
  const twap: string[] = [];
  for (const [key, address] of configured) {
    if (address === "") continue;
    if (await readPythFeed(provider, address)) pyth.push(key);
    if (await readTwapFeed(provider, address)) twap.push(key);
  }
  return [
    pyth.length === 0
      ? pass("pyth:excluded", "no configured feed is a PythMarketFeed")
      : fail("pyth:excluded", `${pyth.join(", ")} ${pyth.length === 1 ? "is a PythMarketFeed" : "are PythMarketFeeds"}; Pyth is outside the production path`),
    twap.length === 0
      ? pass("twap:excluded", "no configured feed is a UniswapV3TwapFeed")
      : fail("twap:excluded", `${twap.join(", ")} ${twap.length === 1 ? "is a UniswapV3TwapFeed" : "are UniswapV3TwapFeeds"}; pool prices are outside the production path`),
  ];
}

/**
 * The PAXG-first oracle configuration (docs/ORACLE_IMPLEMENTATION_PLAN.md): G the XAU/USD gold
 * reference and C the published Chainlink PAXG/USD, C within the gold band of G, a guardian for
 * the manual freeze, XAUT dormant and no Pyth or pool adapter anywhere. Every miss fails the launch.
 */
async function checkFeeds(provider: Provider, env: LaunchEnv): Promise<Finding[]> {
  // Age is measured the way the oracle measures it, against the chain's clock.
  const now = (await provider.getBlock("latest"))?.timestamp ?? Math.floor(Date.now() / 1000);
  const gold = await checkFeed(provider, "XAU_USD_ANCHOR_FEED", env.anchorFeed, "XAU / USD", env.stalenessThreshold, now);
  const chainlink = await checkFeed(provider, "PAXG_FEED", env.paxgFeed, "PAXG / USD", env.stalenessThreshold, now);
  const findings: Finding[] = [gold.finding, chainlink.finding];
  findings.push(
    same(env.paxgFeed, env.anchorFeed)
      ? fail("market:PAXG", "PAXG_FEED is the XAU/USD feed: gold spot is the reference only, never PAXG's market price")
      : pass("market:PAXG", "PAXG_FEED is a PAXG market source, not the XAU/USD reference")
  );

  if (chainlink.answer !== undefined && gold.answer !== undefined && chainlink.answer > 0n && gold.answer > 0n) {
    findings.push(bandFinding("gold-band:PAXG", "Chainlink PAXG/USD and XAU/USD", chainlink.answer, gold.answer, env.paxgGoldBandPpm, "borrowing and reserve swaps would stop, and liquidation would value PAXG at gold (at most the cap above it)"));
  }

  findings.push(
    env.guardian !== ZeroAddress
      ? pass(
          "recovery:PAXG",
          `guardian ${env.guardian} may freeze PAXG and unfreeze it once a normal read succeeds (Chainlink PAXG/USD and XAU/USD both healthy); while either is unhealthy nothing prices, and liquidation resumes by itself once both answer`
        )
      : fail("recovery:PAXG", "no guardian: nobody could freeze PAXG in an incident")
  );
  findings.push(await checkDormantXaut(provider, env));
  findings.push(...(await checkNoAdapters(provider, env)));
  return findings;
}

interface SafeReading {
  finding: Finding;
  /** Present only when the contract answered getOwners(); a non-Safe contract yields none. */
  owners?: string[];
}

/** A threshold and owner set no real Safe could hold; undefined when the shape is sound. */
function inconsistency(threshold: bigint, owners: string[]): string | undefined {
  if (owners.length === 0) return "it reports no owners";
  if (threshold === 0n) return "it reports a threshold of zero";
  if (threshold > BigInt(owners.length)) return `its threshold ${threshold} exceeds its ${owners.length} owners`;
  if (owners.some((owner) => owner === ZeroAddress)) return "it lists the zero address as an owner";
  if (new Set(owners.map((owner) => owner.toLowerCase())).size !== owners.length) return "it lists the same owner twice";
  return undefined;
}

async function checkSafe(provider: Provider, label: Role, address: string, chainId: number): Promise<SafeReading> {
  const name = `safe:${label}`;
  if (address === ZeroAddress) {
    return label === "executor"
      ? { finding: pass(name, "zero address: anyone may execute a matured operation within the timelock's 7 day grace period (policy:TIMELOCK_EXECUTOR)") }
      : { finding: fail(name, `the ${label} cannot be the zero address`) };
  }
  if (!(await hasCode(provider, address))) return { finding: fail(name, `${address} has no code; an EOA cannot be a Safe`) };
  const safe = new Contract(address, SAFE_ABI, provider);
  let threshold: bigint;
  let owners: string[];
  try {
    [threshold, owners] = await Promise.all([safe.getThreshold() as Promise<bigint>, safe.getOwners() as Promise<string[]>]);
  } catch {
    // On mainnet a Safe whose policy cannot be read is not evidence of the policy, so it stops the ceremony.
    const detail = `${address} is a contract but does not answer getThreshold() and getOwners()`;
    return chainId === MAINNET_CHAIN_ID
      ? { finding: fail(name, `${detail}; the launch policy cannot be confirmed`) }
      : { finding: warn(name, `${detail}; confirm it is the intended Safe (a failure on mainnet)`) };
  }
  const shape = `${threshold}-of-${owners.length} at ${address}`;
  const broken = inconsistency(threshold, owners);
  if (broken) return { finding: fail(name, `${shape}: ${broken}, so it is not a working Safe`) };
  const policy = SAFE_POLICY[label];
  if (threshold < policy.threshold || owners.length < policy.owners) {
    return { finding: fail(name, `${shape}; the launch policy needs at least ${policy.threshold}-of-${policy.owners}`), owners };
  }
  return { finding: pass(name, shape), owners };
}

export type Role = "proposer" | "executor" | "guardian";

/** The same address under two of the three roles: a fault on mainnet, a warning on a rehearsal or a testnet. */
export function roleSplit(roles: Array<[Role, string]>, chainId: number): Finding {
  const seen = new Map<string, Role>();
  const clashes: string[] = [];
  for (const [role, address] of roles) {
    const prior = seen.get(address.toLowerCase());
    if (prior && prior !== role) clashes.push(`${role} is the same address as ${prior} (${address})`);
    else if (!prior) seen.set(address.toLowerCase(), role);
  }
  if (clashes.length === 0) return pass("safe:role-split", "proposer, executor and guardian are different addresses");
  const detail = `${clashes.join("; ")}; the guardian pauses outside the timelock and the executor lands what the proposer scheduled, so one Safe in two roles collapses the separation`;
  return chainId === MAINNET_CHAIN_ID ? fail("safe:role-split", detail) : warn("safe:role-split", `${detail} (a failure on mainnet)`);
}

/** The deployer under any role: always a fault, since the key is retired after the ceremony. */
function deployerDistinct(roles: Array<[Role, string]>, deployer: string): Finding {
  const clashes = roles.filter(([, address]) => same(address, deployer)).map(([role, address]) => `${role} is the same address as the deployer (${address})`);
  return clashes.length === 0
    ? pass("safe:distinct", "proposer, executor, guardian and deployer are all different addresses")
    : fail("safe:distinct", clashes.join("; "));
}

/**
 * The deployer among a Safe's owners: always a fault. The key sat in a plaintext environment file
 * and is retired after the ceremony, so it must hold no governance signature; and retiring it
 * would leave the executor Safe a signer short, with no timelock admin to repair it.
 */
function deployerNotOwner(readings: Array<[string, string, SafeReading]>, deployer: string): Finding {
  const seats = readings
    .filter(([, , reading]) => (reading.owners ?? []).some((owner) => same(owner, deployer)))
    .map(([label, address]) => `the ${label} Safe ${address}`);
  return seats.length === 0
    ? pass("safe:deployer-not-owner", "the deployer is not an owner of any Safe")
    : fail(
        "safe:deployer-not-owner",
        `the deployer ${deployer} is an owner of ${seats.join(" and ")}; the deployer key is single-use and retired after the ceremony, so it must not hold a Safe signature. Replace that owner, then run the preflight again`
      );
}

/**
 * The operations Safe (OPERATIONS_SAFE): has code, answers the Safe views with a sound threshold
 * and owner set, and is none of the three governance Safes nor the deployer. No minimum policy is
 * set for it here; it holds no role in any contract. Unset, it is a warning on mainnet that names
 * the variable and nothing elsewhere.
 */
async function checkOperationsSafe(provider: Provider, env: LaunchEnv, roles: Array<[Role, string]>, chainId: number): Promise<{ findings: Finding[]; reading?: SafeReading }> {
  const name = "safe:operations";
  const address = env.operationsSafe;
  if (address === undefined) {
    return chainId === MAINNET_CHAIN_ID
      ? { findings: [warn(name, "OPERATIONS_SAFE is unset, so the operations Safe was not checked; set OPERATIONS_SAFE to the Safe surplus will be withdrawn to (a fourth Safe, distinct from the proposer, executor and guardian Safes and from the deployer) and run the preflight again")] }
      : { findings: [] };
  }
  const reading = await readOperationsSafe(provider, address, chainId);
  const clashes = [
    ...roles.filter(([, other]) => same(other, address)).map(([role]) => `the ${role} Safe`),
    ...(same(env.deployer, address) ? ["the deployer"] : []),
  ];
  const distinct =
    clashes.length === 0
      ? pass("safe:operations-distinct", "the operations Safe is none of the proposer, executor and guardian Safes, nor the deployer")
      : fail("safe:operations-distinct", `OPERATIONS_SAFE ${address} is ${clashes.join(" and ")}; protocol revenue must not sit in a governance Safe or with the deployer key`);
  return { findings: [reading.finding, distinct], reading };
}

async function readOperationsSafe(provider: Provider, address: string, chainId: number): Promise<SafeReading> {
  const name = "safe:operations";
  if (!(await hasCode(provider, address))) return { finding: fail(name, `OPERATIONS_SAFE ${address} has no code; an EOA cannot be a Safe`) };
  const safe = new Contract(address, SAFE_ABI, provider);
  let threshold: bigint;
  let owners: string[];
  try {
    [threshold, owners] = await Promise.all([safe.getThreshold() as Promise<bigint>, safe.getOwners() as Promise<string[]>]);
  } catch {
    const detail = `OPERATIONS_SAFE ${address} is a contract but does not answer getThreshold() and getOwners()`;
    return chainId === MAINNET_CHAIN_ID
      ? { finding: fail(name, `${detail}; it cannot be confirmed to be a Safe`) }
      : { finding: warn(name, `${detail}; confirm it is the intended Safe (a failure on mainnet)`) };
  }
  const shape = `${threshold}-of-${owners.length} at ${address}`;
  const broken = inconsistency(threshold, owners);
  return broken ? { finding: fail(name, `${shape}: ${broken}, so it is not a working Safe`) } : { finding: pass(name, shape), owners };
}

/**
 * Signers shared between two Safes: the role split holds on paper but not in practice. Covers
 * every Safe read, the operations Safe among them (docs/MAINNET.md 1.1: each signer on one Safe).
 */
function signerOverlap(readings: Array<[string, string, SafeReading]>): Finding | undefined {
  const withOwners = readings.filter(([, , reading]) => reading.owners !== undefined);
  if (withOwners.length < 2) return undefined;
  const overlaps: string[] = [];
  for (let i = 0; i < withOwners.length; i++) {
    for (let j = i + 1; j < withOwners.length; j++) {
      const [roleA, addressA, a] = withOwners[i];
      const [roleB, addressB, b] = withOwners[j];
      if (same(addressA, addressB)) continue;
      const ownersB = new Set((b.owners ?? []).map((o) => o.toLowerCase()));
      const shared = (a.owners ?? []).filter((o) => ownersB.has(o.toLowerCase()));
      if (shared.length > 0) overlaps.push(`${roleA} and ${roleB} share ${shared.length} signer(s): ${shared.join(", ")}`);
    }
  }
  return overlaps.length === 0
    ? pass("safe:signer-overlap", "no signer sits on two of the Safes")
    : warn("safe:signer-overlap", `${overlaps.join("; ")}; a shared signer weakens the split between the roles`);
}

async function checkSafes(provider: Provider, env: LaunchEnv, chainId: number): Promise<Finding[]> {
  const roles: Array<[Role, string]> = [
    ...env.proposers.map((a): [Role, string] => ["proposer", a]),
    ...env.executors.map((a): [Role, string] => ["executor", a]),
    ["guardian", env.guardian],
  ];
  const readings = await Promise.all(
    roles.map(async ([role, address]): Promise<[Role, string, SafeReading]> => [role, address, await checkSafe(provider, role, address, chainId)])
  );
  const findings = readings.map(([, , reading]) => reading.finding);
  const nonZero = roles.filter(([, address]) => address !== ZeroAddress);
  findings.push(roleSplit(nonZero, chainId));
  findings.push(deployerDistinct(nonZero, env.deployer));
  const operations = await checkOperationsSafe(provider, env, nonZero, chainId);
  findings.push(...operations.findings);
  const seats: Array<[string, string, SafeReading]> = [
    ...readings,
    ...(operations.reading && env.operationsSafe !== undefined ? [["operations", env.operationsSafe, operations.reading] as [string, string, SafeReading]] : []),
  ];
  findings.push(deployerNotOwner(seats, env.deployer));
  const overlap = signerOverlap(seats);
  if (overlap) findings.push(overlap);
  return findings;
}

/** The three governance roles and their addresses, in the order the record lists them. */
const governanceRoles = (params: Pick<LaunchParameters, "proposers" | "executors" | "guardian">): Array<[Role, string]> => [
  ...params.proposers.map((a): [Role, string] => ["proposer", a]),
  ...params.executors.map((a): [Role, string] => ["executor", a]),
  ["guardian", params.guardian],
];

/**
 * The governance Safes as the chain shows them now: threshold and owners for each one that
 * answers the Safe views, the address alone for the zero address (an accepted open executor) or
 * a contract that does not answer (a warning off mainnet). The preflight writes these into its
 * record; deploy.ts reads them again before its first transaction and compares.
 */
export async function readSafeRecords(provider: Provider, params: Pick<LaunchParameters, "proposers" | "executors" | "guardian">): Promise<SafeRecord[]> {
  return Promise.all(
    governanceRoles(params).map(async ([role, address]): Promise<SafeRecord> => {
      if (address === ZeroAddress || !(await hasCode(provider, address))) return { role, address };
      const safe = new Contract(address, SAFE_ABI, provider);
      try {
        const [threshold, owners] = await Promise.all([safe.getThreshold() as Promise<bigint>, safe.getOwners() as Promise<string[]>]);
        return { role, address, threshold: threshold.toString(), owners: [...owners] };
      } catch (error) {
        // Not a Safe, or a read that failed: recorded without a policy, which never equals a Safe that has one.
        return { role, address, unreadable: describeError(error).slice(0, 80) };
      }
    })
  );
}

/**
 * The deployer's balance against the transactions still owed, at the fee the node quotes now.
 * The preflight checks the whole ceremony; deploy.ts checks again before its first transaction,
 * with only what a resumed run still owes, because the fee may have moved since the preflight.
 */
export async function ceremonyFundsFindings(
  provider: Provider,
  deployer: string,
  creations: TransactionRequest[],
  wiringTransactions: bigint
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let gas = wiringTransactions * WIRING_GAS_EACH;
  let fallbacks = 0;
  for (const tx of creations) {
    try {
      gas += await provider.estimateGas({ ...tx, from: deployer });
    } catch {
      gas += FALLBACK_CREATION_GAS;
      fallbacks++;
    }
  }
  if (fallbacks > 0) findings.push(warn("deployer:gas-estimate", `${fallbacks} of ${creations.length} creations could not be estimated; ${FALLBACK_CREATION_GAS} gas assumed for each`));
  const [balance, feeData] = await Promise.all([provider.getBalance(deployer), provider.getFeeData()]);
  const fee = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const cost = (gas * fee * GAS_MARGIN_PERCENT) / 100n;
  const summary = `balance ${formatEther(balance)} ETH; ceremony about ${gas} gas at ${formatUnits(fee, "gwei")} gwei, ${formatEther(cost)} ETH with a 25% margin`;
  findings.push(fee === 0n ? warn("deployer:balance", `${summary}; the node reported no fee data`) : balance >= cost ? pass("deployer:balance", summary) : fail("deployer:balance", `${summary}: short by ${formatEther(cost - balance)} ETH`));
  return findings;
}

async function checkDeployer(provider: Provider, env: LaunchEnv, creations: TransactionRequest[]): Promise<Finding[]> {
  const nonce = await provider.getTransactionCount(env.deployer);
  const fresh = nonce === 0 ? pass("deployer:fresh", `${env.deployer} has never sent a transaction`) : warn("deployer:fresh", `${env.deployer} has sent ${nonce} transactions; the runbook asks for a single-use key`);
  return [fresh, ...(await ceremonyFundsFindings(provider, env.deployer, creations, WIRING_TRANSACTIONS))];
}

/** Every on-chain check, read-only. The caller prints the findings and stops on any failure. */
export async function runPreflight(input: PreflightInput): Promise<Finding[]> {
  const { provider, env } = input;
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== input.expectedChainId) {
    return [fail("chain", `connected to chain ${chainId}, expected ${input.expectedChainId}; check RPC_URL`)];
  }
  const findings: Finding[] = [pass("chain", `chain ${chainId}`)];
  findings.push(...checkInventory(env, input.known));
  findings.push(
    ...(await Promise.all([
      checkToken(provider, "PAXG", env.paxgToken, 18, "PAXG"),
      checkToken(provider, "XAUT", env.xautToken, 6, "XAUt"),
    ]))
  );
  findings.push(...(await checkFeeds(provider, env)));
  if (env.backstopRehearsal) {
    findings.push(
      chainId === MAINNET_CHAIN_ID
        ? fail("policy:PAXG_BACKSTOP_REHEARSAL_MAX", "a rehearsal stand-in for the modelled backstop maximum can never reach mainnet; remove it")
        : warn("policy:PAXG_BACKSTOP_REHEARSAL_MAX", `rehearsal stand-in of ${formatEther(env.paxgBackstopMax)} GSUSD in place of the modelled maximum; refused on mainnet`)
    );
  }
  findings.push(...(await checkSafes(provider, env, chainId)));
  findings.push(...(await checkDeployer(provider, env, input.creations)));
  if (input.snapshotExists) {
    findings.push(
      input.allowExistingSnapshot
        ? warn("snapshot", "deployments/<network>.json exists and will be overwritten (PREFLIGHT_ALLOW_EXISTING_SNAPSHOT=1)")
        : fail("snapshot", "deployments/<network>.json already exists; a second deploy would overwrite the address book. Move it aside, or set PREFLIGHT_ALLOW_EXISTING_SNAPSHOT=1 to acknowledge")
    );
  } else {
    findings.push(pass("snapshot", "no deployment snapshot yet"));
  }
  return findings;
}
