/**
 * The role census: every privileged role on every governed contract, rebuilt as its whole
 * holder set and compared with the set the ceremony intends. scripts/verify-deployment.ts and
 * the verification step of scripts/transfer-governance.ts both run it.
 *
 * Roles planted before the governance handover used to survive transfer-governance,
 * verify-deployment and lockMinters without detection: both scripts asked
 * only whether named keys (the deployer, the timelock, the vault, the reserve, the guardian) held
 * named roles. transferGovernance revokes the caller alone, so a second minter, a second governor
 * on the oracle or a grant the deployer made itself on the wrapper survived the handover and
 * passed every check. Membership cannot be asked of a plain AccessControl contract, so the census
 * replays its RoleGranted and RoleRevoked logs from the first contract's creation block; where
 * the contract is AccessControlEnumerable (GoldStablecoin and SiloFactory) it also lists every
 * member with getRoleMember. Every candidate is then confirmed with hasRole at one block, so the
 * answer is the chain's and not the replay's.
 */
import { Contract, getAddress, id, ZeroAddress, ZeroHash } from "ethers";
import type { Log, Provider } from "ethers";
import { readGracePeriod } from "./gracePeriod";
import { describeError } from "./redact";

export const ROLE_GRANTED_TOPIC = id("RoleGranted(bytes32,address,address)");
export const ROLE_REVOKED_TOPIC = id("RoleRevoked(bytes32,address,address)");

/** The roles the governed contracts define. */
export const ROLE_NAMES = [
  "DEFAULT_ADMIN_ROLE",
  "GOVERNANCE_ROLE",
  "GUARDIAN_ROLE",
  "MINTER_ROLE",
  "VAULT_ROLE",
  "LOCKED_ROLE",
  "PROPOSER_ROLE",
  "EXECUTOR_ROLE",
  "CANCELLER_ROLE",
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** Each role's identifier: keccak256 of its name, DEFAULT_ADMIN_ROLE (zero) excepted. */
export const ROLE_IDS: Readonly<Record<RoleName, string>> = {
  DEFAULT_ADMIN_ROLE: ZeroHash,
  GOVERNANCE_ROLE: id("GOVERNANCE_ROLE"),
  GUARDIAN_ROLE: id("GUARDIAN_ROLE"),
  MINTER_ROLE: id("MINTER_ROLE"),
  VAULT_ROLE: id("VAULT_ROLE"),
  LOCKED_ROLE: id("LOCKED_ROLE"),
  PROPOSER_ROLE: id("PROPOSER_ROLE"),
  EXECUTOR_ROLE: id("EXECUTOR_ROLE"),
  CANCELLER_ROLE: id("CANCELLER_ROLE"),
};
const ROLE_BY_ID = new Map<string, RoleName>(ROLE_NAMES.map((roleName) => [ROLE_IDS[roleName].toLowerCase(), roleName]));

/** ExpiringTimelockController.GRACE_PERIOD: a matured operation can be executed for 7 days, then never. */
export const GRACE_PERIOD_SECONDS = 7n * 24n * 3600n;

/** type(IAccessControlEnumerable).interfaceId, which AccessControlEnumerable reports through ERC-165. */
const ENUMERABLE_INTERFACE_ID = "0x5a05180f";
const DEFAULT_CHUNK = 50_000;
const MIN_CHUNK = 500;

const ACCESS_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleMemberCount(bytes32 role) view returns (uint256)",
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
];

/** The governed contracts by their snapshot labels, the timelock included. */
export interface CensusAddresses {
  stablecoin: string;
  oracle: string;
  vault: string;
  stabilityModule: string;
  surplusBuffer: string;
  stabilityPool: string;
  reserve: string;
  siloFactory: string;
  governance: string;
  timelock: string;
}

const CENSUS_LABELS: ReadonlyArray<keyof CensusAddresses> = [
  "stablecoin",
  "oracle",
  "vault",
  "stabilityModule",
  "surplusBuffer",
  "stabilityPool",
  "reserve",
  "siloFactory",
  "governance",
  "timelock",
];

/** The census addresses out of a snapshot's address book; throws naming the first that is missing. */
export function censusAddresses(addresses: Record<string, string | undefined>): CensusAddresses {
  const pick = (label: keyof CensusAddresses): string => {
    const value = addresses[label];
    if (value === undefined || value === "") throw new Error(`the snapshot has no ${label} address`);
    return value;
  };
  return {
    stablecoin: pick("stablecoin"),
    oracle: pick("oracle"),
    vault: pick("vault"),
    stabilityModule: pick("stabilityModule"),
    surplusBuffer: pick("surplusBuffer"),
    stabilityPool: pick("stabilityPool"),
    reserve: pick("reserve"),
    siloFactory: pick("siloFactory"),
    governance: pick("governance"),
    timelock: pick("timelock"),
  };
}

/**
 * Where one governed contract stands in the handover: the deployer's still ("pending"), the
 * timelock's already ("done"), or both at once ("granted": the SiloFactory alone, between its
 * grantRole and its renounceRole).
 */
export type HandoverState = "pending" | "granted" | "done";

/** The contracts the handover moves: every census label but the timelock, which administers itself. */
export type HandoverLabel = Exclude<keyof CensusAddresses, "timelock">;

/** What the ceremony intends: the Safes it configured and whether the handover has run. */
export interface CensusPolicy {
  addresses: CensusAddresses;
  deployer: string;
  proposers: string[];
  executors: string[];
  guardian: string;
  /** After transfer-governance.ts the timelock holds every admin and governance role; before it the deployer does. */
  transferred: boolean;
  /**
   * A handover that stopped part way: where each contract stands as the chain shows it
   * (scripts/lib/governanceHandover.ts). A contract left out follows `transferred`.
   */
  handover?: Partial<Record<HandoverLabel, HandoverState>>;
}

/** One contract and the exact holder set of every role it defines. */
export interface CensusTarget {
  label: string;
  address: string;
  expected: Partial<Record<RoleName, string[]>>;
}

/** One line of the census; `detail` names the role and, on a failure, each holder that is out of place. */
export interface CensusCheck {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * The holder sets deploy.ts and transfer-governance.ts leave (docs/LAUNCH.md, the handover
 * checklist). DEFAULT_ADMIN_ROLE and GOVERNANCE_ROLE belong to the timelock alone after the
 * handover and to the deployer alone before it; MINTER_ROLE to the vault; VAULT_ROLE to the
 * vault, with the reserve beside it on the SurplusBuffer; GUARDIAN_ROLE to the guardian Safe;
 * the wrapper's PROPOSER_ROLE and EXECUTOR_ROLE to the configured Safes; LOCKED_ROLE to nobody.
 * The timelock administers itself, and its proposer, canceller and executor sets are the Safes
 * plus the wrapper, which GoldGovernance registers in both. While a handover stands part way
 * (`policy.handover`) the authority is decided contract by contract: the timelock where the
 * transfer landed, the deployer where it did not, and both on a SiloFactory whose grant landed
 * without its renounce.
 */
export function censusTargets(policy: CensusPolicy): CensusTarget[] {
  const a = policy.addresses;
  const authority = (label: HandoverLabel): string[] => {
    const state: HandoverState = policy.handover?.[label] ?? (policy.transferred ? "done" : "pending");
    if (state === "done") return [a.timelock];
    return state === "granted" ? [policy.deployer, a.timelock] : [policy.deployer];
  };
  const governed = (label: HandoverLabel) => ({ DEFAULT_ADMIN_ROLE: authority(label), GOVERNANCE_ROLE: authority(label) });
  const guardian = [policy.guardian];
  return [
    { label: "stablecoin", address: a.stablecoin, expected: { DEFAULT_ADMIN_ROLE: authority("stablecoin"), MINTER_ROLE: [a.vault] } },
    { label: "oracle", address: a.oracle, expected: { ...governed("oracle"), GUARDIAN_ROLE: guardian } },
    { label: "vault", address: a.vault, expected: { ...governed("vault"), GUARDIAN_ROLE: guardian } },
    { label: "stabilityModule", address: a.stabilityModule, expected: { ...governed("stabilityModule"), VAULT_ROLE: [a.vault] } },
    { label: "surplusBuffer", address: a.surplusBuffer, expected: { ...governed("surplusBuffer"), VAULT_ROLE: [a.vault, a.reserve] } },
    { label: "stabilityPool", address: a.stabilityPool, expected: { ...governed("stabilityPool"), VAULT_ROLE: [a.vault], GUARDIAN_ROLE: guardian } },
    { label: "reserve", address: a.reserve, expected: { ...governed("reserve"), VAULT_ROLE: [a.vault], GUARDIAN_ROLE: guardian } },
    { label: "siloFactory", address: a.siloFactory, expected: { DEFAULT_ADMIN_ROLE: authority("siloFactory"), VAULT_ROLE: [a.vault], LOCKED_ROLE: [] } },
    {
      label: "governance",
      address: a.governance,
      expected: { DEFAULT_ADMIN_ROLE: authority("governance"), PROPOSER_ROLE: policy.proposers, EXECUTOR_ROLE: policy.executors },
    },
    {
      label: "timelock",
      address: a.timelock,
      expected: {
        DEFAULT_ADMIN_ROLE: [a.timelock],
        PROPOSER_ROLE: [...policy.proposers, a.governance],
        CANCELLER_ROLE: [...policy.proposers, a.governance],
        EXECUTOR_ROLE: [...policy.executors, a.governance],
      },
    },
  ];
}

/** Report names for the configured Safes, for CensusOptions.names. */
export function censusNames(policy: Pick<CensusPolicy, "proposers" | "executors" | "guardian">): Record<string, string> {
  const names: Record<string, string> = {};
  for (const proposer of policy.proposers) names[proposer] = "proposer Safe";
  for (const executor of policy.executors) names[executor] = "executor Safe";
  names[policy.guardian] = "guardian Safe";
  return names;
}

export interface CensusOptions {
  /** The first block replayed: at or before the creation of the earliest contract (censusFromBlock). */
  fromBlock: number;
  /** The block everything is read at; the head when omitted. */
  toBlock?: number;
  /** Blocks per getLogs request; halved down to 500 when a node refuses the range. */
  chunkSize?: number;
  /** Reported on its own line: after the handover it should hold nothing the configuration does not name it for. */
  deployer?: string;
  /** Names for the addresses in the report; the census addresses, the deployer and the Safes are named anyway. */
  names?: Record<string, string>;
}

const key = (address: string): string => address.toLowerCase();

/** Every RoleGranted and RoleRevoked of the given contracts, oldest first, fetched in chunks. */
export async function roleLogs(provider: Provider, addresses: string[], fromBlock: number, toBlock: number, chunkSize = DEFAULT_CHUNK): Promise<Log[]> {
  const logs: Log[] = [];
  let chunk = Math.max(1, chunkSize);
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + chunk - 1, toBlock);
    try {
      logs.push(...(await provider.getLogs({ address: addresses, topics: [[ROLE_GRANTED_TOPIC, ROLE_REVOKED_TOPIC]], fromBlock: from, toBlock: to })));
      from = to + 1;
    } catch (error) {
      if (chunk <= MIN_CHUNK) throw error;
      chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2)); // the node refused the range; narrow it and retry
    }
  }
  return logs.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
}

/** contract -> role -> accounts holding it once every log is applied in order. */
type Replayed = Map<string, Map<string, Set<string>>>;

function replay(logs: Log[]): Replayed {
  const byContract: Replayed = new Map();
  for (const log of logs) {
    if (log.topics.length < 3) continue;
    const role = log.topics[1].toLowerCase();
    const account = getAddress(`0x${log.topics[2].slice(26)}`);
    const roles = byContract.get(key(log.address)) ?? new Map<string, Set<string>>();
    const holders = roles.get(role) ?? new Set<string>();
    if (log.topics[0] === ROLE_GRANTED_TOPIC) holders.add(account);
    else holders.delete(account);
    roles.set(role, holders);
    byContract.set(key(log.address), roles);
  }
  return byContract;
}

async function isEnumerable(contract: Contract, blockTag: number): Promise<boolean> {
  try {
    return (await contract.supportsInterface(ENUMERABLE_INTERFACE_ID, { blockTag })) as boolean;
  } catch {
    return false;
  }
}

async function members(contract: Contract, role: string, blockTag: number): Promise<string[]> {
  const count = (await contract.getRoleMemberCount(role, { blockTag })) as bigint;
  const out: string[] = [];
  for (let i = 0n; i < count; i++) out.push(getAddress((await contract.getRoleMember(role, i, { blockTag })) as string));
  return out;
}

/** The accounts among `candidates` that hold `role` at `blockTag`, each once, in checksum form. */
async function confirmed(contract: Contract, role: string, candidates: Iterable<string>, blockTag: number): Promise<string[]> {
  const unique = [...new Set([...candidates].map((c) => getAddress(c)))];
  const held = await Promise.all(unique.map(async (account) => ((await contract.hasRole(role, account, { blockTag })) as boolean) ? account : undefined));
  return held.filter((account): account is string => account !== undefined);
}

function namer(targets: CensusTarget[], options: CensusOptions): (address: string) => string {
  const names = new Map<string, string>();
  for (const target of targets) names.set(key(target.address), target.label);
  for (const [address, name] of Object.entries(options.names ?? {})) names.set(key(address), name);
  if (options.deployer) names.set(key(options.deployer), "deployer");
  names.set(key(ZeroAddress), "the zero address, an open role");
  return (address) => `${address} (${names.get(key(address)) ?? "not a configured address"})`;
}

/** One contract's census lines, and where the deployer turned up in it. */
interface TargetCensus {
  checks: CensusCheck[];
  /** `<contract>.<role>` the deployer holds and the configuration does not name it for. */
  deployerHolds: string[];
  /** `<contract>.<role>` the deployer holds because the configuration names it (a testnet stand-in). */
  deployerConfigured: string[];
  /** Every holder the census confirmed, by role name, for the roles the target defines. */
  holders: Map<RoleName, string[]>;
}

interface CensusContext {
  provider: Provider;
  toBlock: number;
  deployer?: string;
  name: (address: string) => string;
}

async function censusOfTarget(context: CensusContext, target: CensusTarget, logged: Map<string, Set<string>>): Promise<TargetCensus> {
  const { deployer, name, toBlock } = context;
  const contract = new Contract(target.address, ACCESS_ABI, context.provider);
  const enumerable = await isEnumerable(contract, toBlock);
  const source = enumerable ? "getRoleMember and the role logs" : "the role logs";
  const defined = ROLE_NAMES.filter((roleName) => target.expected[roleName] !== undefined).map((roleName) => ROLE_IDS[roleName].toLowerCase());
  const result: TargetCensus = { checks: [], deployerHolds: [], deployerConfigured: [], holders: new Map<RoleName, string[]>() };
  const unknown: string[] = [];

  for (const role of new Set<string>([...defined, ...logged.keys()])) {
    const roleName = ROLE_BY_ID.get(role);
    const expected = roleName === undefined ? undefined : target.expected[roleName];
    const candidates = [...(logged.get(role) ?? []), ...(expected ?? [])];
    if (deployer) candidates.push(deployer);
    if (enumerable) candidates.push(...(await members(contract, role, toBlock)));
    const holders = await confirmed(contract, role, candidates, toBlock);
    const label = `${target.label}.${roleName ?? role}`;
    if (roleName !== undefined) result.holders.set(roleName, holders);
    const want = new Set((expected ?? []).map(key));
    if (deployer && holders.some((h) => key(h) === key(deployer))) {
      (want.has(key(deployer)) ? result.deployerConfigured : result.deployerHolds).push(label);
    }

    if (expected === undefined) {
      // A role outside the target's definition: harmless only while nobody holds it.
      if (holders.length > 0) unknown.push(`${roleName ?? role}: ${holders.map(name).join(", ")}`);
      continue;
    }
    const extra = holders.filter((h) => !want.has(key(h)));
    const missing = [...new Set(expected.map((e) => getAddress(e)))].filter((e) => !holders.some((h) => key(h) === key(e)));
    if (extra.length === 0 && missing.length === 0) {
      result.checks.push({ name: `census:${label}`, pass: true, detail: `${roleName} held by ${holders.length === 0 ? "nobody" : holders.map(name).join(", ")} (from ${source})` });
    } else {
      const problems = [...extra.map((h) => `unexpected holder ${name(h)}`), ...missing.map((m) => `missing ${name(m)}`)];
      result.checks.push({ name: `census:${label}`, pass: false, detail: `${roleName} on ${target.label}: ${problems.join("; ")}` });
    }
  }
  if (unknown.length > 0) {
    result.checks.push({ name: `census:${target.label}.unknown-roles`, pass: false, detail: `roles ${target.label} never defines are held: ${unknown.join("; ")}` });
  }
  return result;
}

function deployerCheck(holds: string[], configured: string[]): CensusCheck {
  if (holds.length > 0) return { name: "census:deployer", pass: false, detail: `the deployer still holds ${holds.join(", ")}` };
  return {
    name: "census:deployer",
    pass: true,
    detail:
      configured.length === 0
        ? "the deployer holds no role on any governed contract"
        : `the deployer holds no role beyond those the configuration names it for (${configured.join(", ")})`,
  };
}

/** The two roles GoldGovernance keeps a list of its own for, beside the timelock's. */
export const WRAPPER_ROLES = ["PROPOSER_ROLE", "EXECUTOR_ROLE"] as const;
export type WrapperRole = (typeof WRAPPER_ROLES)[number];
export const WRAPPER_AGREEMENT_CHECK = "gov:wrapper-roles-match-timelock";

/**
 * GoldGovernance and its timelock each keep a PROPOSER_ROLE and an EXECUTOR_ROLE, and the wrapper
 * is a permanent member of the timelock's. A Safe revoked on one list alone keeps its power
 * through the other: revoked on the timelock it still schedules and executes through the
 * wrapper's helpers, revoked on the wrapper it still acts on the timelock directly. The two
 * must therefore hold exactly the same addresses, the wrapper itself aside, whatever the
 * snapshot says: a snapshot refreshed after a one-sided change would otherwise hide it.
 */
export function wrapperAgreementCheck(
  wrapper: Readonly<Record<WrapperRole, readonly string[]>>,
  timelock: Readonly<Record<WrapperRole, readonly string[]>>,
  wrapperAddress: string,
  name: (address: string) => string = (address) => address,
): CensusCheck {
  const problems: string[] = [];
  for (const role of WRAPPER_ROLES) {
    const onTimelock = timelock[role].filter((holder) => key(holder) !== key(wrapperAddress));
    const onWrapper = wrapper[role];
    for (const holder of onWrapper) {
      if (!onTimelock.some((other) => key(other) === key(holder))) {
        problems.push(`${name(holder)} still holds ${role} on the wrapper but not on the timelock: it can still ${role === "PROPOSER_ROLE" ? "schedule through the propose helpers" : "execute through executeProposal"}`);
      }
    }
    for (const holder of onTimelock) {
      if (!onWrapper.some((other) => key(other) === key(holder))) {
        problems.push(`${name(holder)} still holds ${role} on the timelock but not on the wrapper`);
      }
    }
  }
  return problems.length === 0
    ? { name: WRAPPER_AGREEMENT_CHECK, pass: true, detail: "the wrapper's proposers and executors are exactly the timelock's, the wrapper itself aside" }
    : { name: WRAPPER_AGREEMENT_CHECK, pass: false, detail: `the wrapper's and the timelock's role lists differ: ${problems.join("; ")}. Revoke the stale holder on both in one proposal (docs/LAUNCH.md, Governance signer key compromised)` };
}

/**
 * Takes the census and returns one check per (contract, role) the targets define and one per
 * contract on which anybody holds a role the contracts never define, plus one for the deployer
 * and, when both the wrapper and the timelock are among the targets, one that their proposer
 * and executor lists agree.
 */
export async function takeRoleCensus(provider: Provider, targets: CensusTarget[], options: CensusOptions): Promise<CensusCheck[]> {
  const toBlock = options.toBlock ?? (await provider.getBlockNumber());
  const context: CensusContext = { provider, toBlock, deployer: options.deployer, name: namer(targets, options) };
  const replayed = replay(await roleLogs(provider, targets.map((t) => t.address), options.fromBlock, toBlock, options.chunkSize));
  const checks: CensusCheck[] = [];
  const deployerHolds: string[] = [];
  const deployerConfigured: string[] = [];
  const held = new Map<string, Map<RoleName, string[]>>();
  for (const target of targets) {
    const census = await censusOfTarget(context, target, replayed.get(key(target.address)) ?? new Map<string, Set<string>>());
    held.set(target.label, census.holders);
    checks.push(...census.checks);
    deployerHolds.push(...census.deployerHolds);
    deployerConfigured.push(...census.deployerConfigured);
  }
  if (options.deployer) checks.push(deployerCheck(deployerHolds, deployerConfigured));
  const wrapper = targets.find((target) => target.label === "governance");
  const wrapperHeld = held.get("governance");
  const timelockHeld = held.get("timelock");
  if (wrapper && wrapperHeld && timelockHeld) {
    const of = (source: Map<RoleName, string[]>): Record<WrapperRole, string[]> => ({
      PROPOSER_ROLE: source.get("PROPOSER_ROLE") ?? [],
      EXECUTOR_ROLE: source.get("EXECUTOR_ROLE") ?? [],
    });
    checks.push(wrapperAgreementCheck(of(wrapperHeld), of(timelockHeld), wrapper.address, context.name));
  }
  return checks;
}

/** How timelockGracePeriodCheck's detail starts when the read failed rather than answered. */
export const GRACE_PERIOD_READ_FAILED = "could not read GRACE_PERIOD(); retry on another endpoint";

/**
 * Reads ExpiringTimelockController.GRACE_PERIOD; a stock TimelockController has none and fails.
 * A read that failed for any other reason (a rate limit, a lagging node, a dropped request)
 * fails too, but says so and asks for a retry instead of calling the timelock old.
 */
export async function timelockGracePeriodCheck(provider: Provider, timelock: string): Promise<CensusCheck> {
  const name = "timelock:grace-period-7d";
  const contract = new Contract(
    timelock,
    ["function getMinDelay() view returns (uint256)", "function GRACE_PERIOD() view returns (uint256)"],
    provider
  );
  try {
    // readGracePeriod's precondition: the address has just answered another timelock read, so
    // a revert with no data from GRACE_PERIOD() can only mean the function is missing.
    await contract.getMinDelay();
  } catch (error: unknown) {
    return {
      name,
      pass: false,
      detail: `could not read getMinDelay() at ${timelock}: check that it is the timelock, then retry (${describeError(error)})`,
    };
  }
  let grace: bigint | undefined;
  try {
    grace = await readGracePeriod(async () => BigInt(await contract.GRACE_PERIOD()));
  } catch (error: unknown) {
    return { name, pass: false, detail: `${GRACE_PERIOD_READ_FAILED} (${describeError(error)})` };
  }
  if (grace === undefined) {
    return { name, pass: false, detail: "the timelock has no GRACE_PERIOD(): it predates ExpiringTimelockController, so a matured operation never expires" };
  }
  return grace === GRACE_PERIOD_SECONDS
    ? { name, pass: true, detail: `a matured operation expires ${grace} s after it becomes ready` }
    : { name, pass: false, detail: `GRACE_PERIOD is ${grace} s, expected ${GRACE_PERIOD_SECONDS}` };
}

/**
 * The earliest block at which any of `addresses` has code: the creation of the first of them.
 * Bisects on historical getCode, so the node must serve state at old blocks.
 */
export async function earliestCreationBlock(provider: Provider, addresses: string[], latest: number): Promise<number> {
  const deployedBy = async (block: number): Promise<boolean> =>
    (await Promise.all(addresses.map((address) => provider.getCode(address, block)))).some((code) => code !== "0x");
  if (!(await deployedBy(latest))) throw new Error(`none of the census contracts has code at block ${latest}`);
  let low = 0;
  let high = latest;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (await deployedBy(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

export interface CensusSnapshot {
  addresses: CensusAddresses;
  /** The vault's creation block; later than the oracle's and the stablecoin's. */
  deployBlock?: number;
  /** Every contract's creation block, recorded by deploy.ts from 2026-11-06. */
  creationBlocks?: Record<string, number>;
}

export interface CensusStart {
  fromBlock: number;
  source: "recorded by deploy.ts" | "located on chain" | "the snapshot's deploy block";
  /** Set when grants made before `fromBlock` could not be replayed. */
  warning?: string;
}

/**
 * Where the replay starts. The snapshot's deployBlock is the vault's, created after the oracle,
 * the stablecoin and the stability module, so a grant in between would be missed: the creation
 * blocks deploy.ts records are used when they cover every census contract, and otherwise the
 * first creation is located on chain. Only a node without historical state falls back to the
 * deploy block, with a warning.
 */
export async function censusFromBlock(provider: Provider, snapshot: CensusSnapshot, latest: number): Promise<CensusStart> {
  const recorded = CENSUS_LABELS.map((label) => snapshot.creationBlocks?.[label]);
  if (recorded.every((block): block is number => typeof block === "number" && Number.isInteger(block) && block >= 0)) {
    return { fromBlock: Math.min(...recorded), source: "recorded by deploy.ts" };
  }
  try {
    return { fromBlock: await earliestCreationBlock(provider, CENSUS_LABELS.map((label) => snapshot.addresses[label]), latest), source: "located on chain" };
  } catch (error) {
    const fromBlock = snapshot.deployBlock ?? 0;
    return {
      fromBlock,
      source: "the snapshot's deploy block",
      warning: `the snapshot records no creation blocks and the node could not locate them (${describeError(error).slice(0, 120)}); a grant made before block ${fromBlock} is not replayed`,
    };
  }
}
