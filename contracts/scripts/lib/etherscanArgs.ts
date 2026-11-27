/**
 * The constructor arguments of every contract deploy.ts creates, rebuilt from the deployment
 * snapshot so Etherscan source verification needs no hand-typed values. Mirrors the deploy
 * order in scripts/deploy.ts and the ExpiringTimelockController that GoldGovernance's
 * constructor creates (src/governance/Governance.sol): 48 hours, no admin and the configured
 * proposers and executors, each with the wrapper appended. The CollateralSilo implementation
 * that SiloFactory's constructor creates is not in the snapshot: its address is read from the
 * factory (`siloImplementation()`) and passed in.
 */
import { ZeroAddress, isAddress } from "ethers";

export interface VerificationJob {
  label: string;
  address: string;
  /** Fully qualified name, so Etherscan verifies the right source when names collide. */
  contract: string;
  constructorArguments: Array<string | number | string[]>;
}

export interface VerificationSnapshot {
  addresses: Record<string, string | undefined>;
  /** The contract that created the token with CREATE2; absent from deployments made before it. */
  stablecoinDeployer?: { address: string; salt: string };
  config: {
    paxgToken: string;
    xautToken: string;
    paxgFeed: string;
    xautFeed: string;
    /** True when deploy.ts created XAUT's InactiveFeed (open or backstop with XAUT_FEED unset). */
    xautFeedDeployed?: boolean;
    stalenessThreshold: number;
    siloCap: string;
    proposers: string[];
    executors: string[];
  };
}

export const TIMELOCK_MIN_DELAY_SECONDS = 48 * 60 * 60;

const ADDRESS_KEYS = [
  "oracle",
  "stablecoin",
  "stabilityModule",
  "vault",
  "surplusBuffer",
  "stabilityPool",
  "reserve",
  "siloFactory",
  "governance",
  "timelock",
] as const;

type AddressBook = Record<(typeof ADDRESS_KEYS)[number], string>;

function addressBook(snap: VerificationSnapshot): AddressBook {
  const missing = ADDRESS_KEYS.filter((k) => !snap.addresses[k]);
  if (missing.length > 0) throw new Error(`Snapshot lacks addresses: ${missing.join(", ")}`);
  return Object.fromEntries(ADDRESS_KEYS.map((k) => [k, snap.addresses[k] as string])) as AddressBook;
}

/** The implementation every silo is cloned from: created by SiloFactory's constructor, with no arguments of its own. */
export function siloImplementationJob(address: string): VerificationJob {
  if (!isAddress(address) || address === ZeroAddress) throw new Error(`SiloFactory.siloImplementation() returned "${address}", which is not a contract address`);
  return { label: "CollateralSilo", address, contract: "src/core/CollateralSilo.sol:CollateralSilo", constructorArguments: [] };
}

/**
 * Every contract of the deployment, in deploy order. `siloImplementation` is the address the
 * factory reports; given it, the CollateralSilo implementation follows the factory in the list.
 */
export function verificationJobs(snap: VerificationSnapshot, siloImplementation?: string): VerificationJob[] {
  const a = addressBook(snap);
  const c = snap.config;
  for (const key of ["paxgToken", "xautToken", "paxgFeed", "xautFeed", "siloCap"] as const) {
    if (!c[key]) throw new Error(`Snapshot config lacks ${key}`);
  }
  if (!Number.isInteger(c.stalenessThreshold)) throw new Error("Snapshot config lacks stalenessThreshold");
  if (!Array.isArray(c.proposers) || !Array.isArray(c.executors)) throw new Error("Snapshot config lacks proposers or executors");
  return [
    { label: "GoldOracle", address: a.oracle, contract: "src/core/GoldOracle.sol:GoldOracle", constructorArguments: [c.paxgFeed, c.xautFeed, c.paxgToken, c.xautToken, c.stalenessThreshold] },
    // The contract that created the token with CREATE2 (no constructor arguments); absent from deployments made before it.
    ...(snap.stablecoinDeployer
      ? [{ label: "GoldStablecoinDeployer", address: snap.stablecoinDeployer.address, contract: "src/deploy/GoldStablecoinDeployer.sol:GoldStablecoinDeployer", constructorArguments: [] }]
      : []),
    { label: "GoldStablecoin", address: a.stablecoin, contract: "src/core/GoldStablecoin.sol:GoldStablecoin", constructorArguments: [] },
    { label: "StabilityModule", address: a.stabilityModule, contract: "src/core/StabilityModule.sol:StabilityModule", constructorArguments: [] },
    { label: "GoldVault", address: a.vault, contract: "src/core/GoldVault.sol:GoldVault", constructorArguments: [a.oracle, a.stablecoin, a.stabilityModule] },
    { label: "SurplusBuffer", address: a.surplusBuffer, contract: "src/core/SurplusBuffer.sol:SurplusBuffer", constructorArguments: [a.stablecoin] },
    { label: "StabilityPool", address: a.stabilityPool, contract: "src/core/StabilityPool.sol:StabilityPool", constructorArguments: [a.stablecoin] },
    { label: "GoldStabilityReserve", address: a.reserve, contract: "src/core/GoldStabilityReserve.sol:GoldStabilityReserve", constructorArguments: [a.stablecoin, a.oracle] },
    { label: "SiloFactory", address: a.siloFactory, contract: "src/core/CollateralSilo.sol:SiloFactory", constructorArguments: [c.siloCap] },
    ...(siloImplementation === undefined ? [] : [siloImplementationJob(siloImplementation)]),
    // The PAXG-first deployment creates XAUT's InactiveFeed (no constructor arguments).
    ...(c.xautFeedDeployed === true
      ? [{ label: "InactiveFeed", address: c.xautFeed, contract: "src/oracle/InactiveFeed.sol:InactiveFeed", constructorArguments: [] }]
      : []),
    // Added 2026-10-22; snapshots from earlier deployments have no registry.
    ...(snap.addresses.vaultRegistry
      ? [{ label: "VaultRegistry", address: snap.addresses.vaultRegistry, contract: "src/core/VaultRegistry.sol:VaultRegistry", constructorArguments: [a.vault] }]
      : []),
    { label: "GoldGovernance", address: a.governance, contract: "src/governance/Governance.sol:GoldGovernance", constructorArguments: [c.proposers, c.executors, a.vault, a.oracle, a.stabilityModule] },
    {
      label: "TimelockController",
      address: a.timelock,
      contract: "src/governance/ExpiringTimelockController.sol:ExpiringTimelockController",
      constructorArguments: [TIMELOCK_MIN_DELAY_SECONDS, [...c.proposers, a.governance], [...c.executors, a.governance], ZeroAddress],
    },
  ];
}
