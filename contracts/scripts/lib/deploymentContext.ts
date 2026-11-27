/**
 * Shared wiring for the governance scripts: which deployment snapshot to load, whether
 * the connected chain matches it, which signer acts, and the on-chain cross-check that a
 * snapshot's timelock is the one the governance wrapper created. Fork rehearsals load the
 * forked network's snapshot and impersonate an address; both are refused on a real chain.
 */
import { ethers, network } from "hardhat";
import type { Signer } from "ethers";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const HARDHAT_CHAIN_ID = 31337;

// 100 ETH, the balance the other fork rehearsals give impersonated actors.
const FORK_GAS_BALANCE = "0x56BC75E2D63100000";

export interface Snapshot {
  chainId: number;
  deployer: string;
  addresses: {
    surplusBuffer: string;
    timelock: string;
    governance: string;
    stablecoin: string;
    /** GoldVault; optional so older snapshot fixtures still load. */
    vault?: string;
    /** GoldStabilityReserve; optional so older snapshot fixtures still load. */
    reserve?: string;
  };
  /** The governance Safes deploy.ts recorded in config, each where the snapshot carries it. */
  governanceSafes: GovernanceSafes;
}

/** config.proposers, config.executors and config.guardian of a snapshot; empty where absent or malformed. */
export interface GovernanceSafes {
  proposers: string[];
  executors: string[];
  guardian?: string;
}

export interface ForkEnv {
  /** Load this network's snapshot while connected to a Hardhat fork of it. */
  forkOf?: string;
  /** Act as this address, funded and impersonated on the fork. */
  impersonate?: string;
}

export interface DeploymentContext {
  snapName: string;
  snap: Snapshot;
  signer: Signer;
  fork: boolean;
}

export function formatGsusd(wei: bigint): string {
  return `${ethers.formatEther(wei)} GSUSD`;
}

export function parseAddress(name: string, raw: string | undefined): string {
  if (!raw || raw.trim().length === 0) throw new Error(`Set ${name}.`);
  try {
    return ethers.getAddress(raw.trim());
  } catch {
    throw new Error(`${name} is not a valid address: ${raw}`);
  }
}

export function parseGsusd(name: string, raw: string | undefined, allowZero = false): bigint {
  if (!raw || raw.trim().length === 0) {
    throw new Error(`Set ${name} (whole GSUSD, for example 2500 or 2500.50).`);
  }
  let amount: bigint;
  try {
    amount = ethers.parseEther(raw.trim());
  } catch {
    throw new Error(`${name} is not a decimal GSUSD amount: ${raw}`);
  }
  if (amount < 0n || (amount === 0n && !allowZero)) {
    throw new Error(`${name} must be ${allowZero ? "zero or more" : "positive"}.`);
  }
  return amount;
}

export function parseForkEnv(env: NodeJS.ProcessEnv): ForkEnv {
  const forkOf = env.FORK_OF?.trim() || undefined;
  const impersonate = env.IMPERSONATE ? parseAddress("IMPERSONATE", env.IMPERSONATE) : undefined;
  if (impersonate && !forkOf) {
    throw new Error("IMPERSONATE only works on a fork: set FORK_OF=<network> as well.");
  }
  return { forkOf, impersonate };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAddressString(value: unknown): value is string {
  return typeof value === "string" && ethers.isAddress(value);
}

export function loadSnapshot(path: string): Snapshot {
  if (!existsSync(path)) throw new Error(`No deployment snapshot at ${path}.`);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw) || !isRecord(raw.addresses)) {
    throw new Error(`Snapshot ${path} is malformed: expected an object with addresses.`);
  }
  const { chainId, deployer, addresses } = raw;
  const { surplusBuffer, timelock, governance, stablecoin, vault, reserve } = addresses;
  if (
    typeof chainId !== "number" ||
    !isAddressString(surplusBuffer) ||
    !isAddressString(timelock) ||
    !isAddressString(governance) ||
    !isAddressString(stablecoin)
  ) {
    throw new Error(
      `Snapshot ${path} lacks chainId or one of addresses.surplusBuffer, addresses.timelock, ` +
        `addresses.governance, addresses.stablecoin.`
    );
  }
  return {
    chainId,
    deployer: typeof deployer === "string" ? deployer : "",
    addresses: {
      surplusBuffer,
      timelock,
      governance,
      stablecoin,
      ...(isAddressString(vault) ? { vault } : {}),
      ...(isAddressString(reserve) ? { reserve } : {}),
    },
    governanceSafes: governanceSafesOf(raw.config),
  };
}

function governanceSafesOf(config: unknown): GovernanceSafes {
  if (!isRecord(config)) return { proposers: [], executors: [] };
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isAddressString) : []);
  return {
    proposers: list(config.proposers),
    executors: list(config.executors),
    ...(isAddressString(config.guardian) ? { guardian: config.guardian } : {}),
  };
}

/** Which snapshot to load: the connected network's, or the forked network's on a Hardhat fork. */
export function resolveSnapshotName(networkName: string, forkOf: string | undefined, connectedChainId: number): string {
  if (!forkOf) return networkName;
  if (connectedChainId !== HARDHAT_CHAIN_ID) {
    throw new Error(`FORK_OF=${forkOf} needs a Hardhat fork (chain ${HARDHAT_CHAIN_ID}); connected to ${connectedChainId}.`);
  }
  return forkOf;
}

/** A fork reports chain 31337 whatever it forks; otherwise the snapshot and the wire must agree. */
export function assertChainMatches(snapshotChainId: number, connectedChainId: number, forkOf: string | undefined): void {
  if (forkOf) return;
  if (snapshotChainId !== connectedChainId) {
    throw new Error(`Chain mismatch: snapshot ${snapshotChainId}, connected ${connectedChainId}.`);
  }
}

/** The configured signer, or on a fork the impersonated address, funded for gas. */
export async function resolveSigner(
  configured: readonly Signer[],
  impersonate: string | undefined,
  networkName: string
): Promise<Signer> {
  if (impersonate) {
    await network.provider.send("hardhat_setBalance", [impersonate, FORK_GAS_BALANCE]);
    return ethers.getImpersonatedSigner(impersonate);
  }
  const [signer] = configured;
  if (!signer) {
    throw new Error(`No signer for ${networkName}: set PRIVATE_KEY (any funded key; the roles decide what it may do).`);
  }
  return signer;
}

/** A hand-edited or stale snapshot must not point a governance action at the wrong timelock. */
export async function assertTimelockMatchesGovernance(governance: string, timelock: string): Promise<void> {
  const wrapper = await ethers.getContractAt("GoldGovernance", governance);
  const onChain = await wrapper.getTimelockAddress();
  if (onChain.toLowerCase() !== timelock.toLowerCase()) {
    throw new Error(
      `Snapshot timelock ${timelock} differs from GoldGovernance.timelock() ${onChain}. ` +
        `Refresh the snapshot before continuing.`
    );
  }
}

/** Everything a governance script needs before it touches a contract. */
export async function connectDeployment(fork: ForkEnv): Promise<DeploymentContext> {
  const connectedChainId = Number((await ethers.provider.getNetwork()).chainId);
  const snapName = resolveSnapshotName(network.name, fork.forkOf, connectedChainId);
  const snap = loadSnapshot(resolve(__dirname, "../../deployments", `${snapName}.json`));
  assertChainMatches(snap.chainId, connectedChainId, fork.forkOf);
  await assertTimelockMatchesGovernance(snap.addresses.governance, snap.addresses.timelock);
  const signer = await resolveSigner(await ethers.getSigners(), fork.impersonate, network.name);
  return { snapName, snap, signer, fork: Boolean(fork.forkOf) };
}
