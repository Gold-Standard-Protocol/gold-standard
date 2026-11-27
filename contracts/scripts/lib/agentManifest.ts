/**
 * The machine-readable manifest an autonomous agent reads before it touches the protocol:
 * every address, token, ratio and convention of each deployment, built from
 * deployments/<network>.json so nothing is retyped, and published by the dapp at
 * /agents.json next to /llms.txt and the ABIs under /abi/ (docs/AGENTS.md and the
 * /docs/agents page are the prose counterparts). Pure: the printer in
 * scripts/print-agent-manifest.ts does the reading and writing.
 *
 * Nothing here points at a code host. Every link is built from the site the dapp is served
 * from, so the manifest stays valid while the repository is private, and a repository link
 * appears only when the operator supplies one.
 */

import { HDNodeWallet, Interface, id, zeroPadValue } from "ethers";
import { LAUNCH_SITE_ORIGINS, parseSiteOrigins } from "./serviceEnv";

export const AGENT_MANIFEST_SCHEMA = "goldstandard-agents/1";
/**
 * Where the dapp, the manifest, the ABIs and the guide are served from unless SITE_URL says
 * otherwise: the canonical launch origin, the first entry of the list print-service-env.ts
 * prints for the API's CORS origins, so the two printers cannot disagree.
 */
export const DEFAULT_SITE_URL: string = LAUNCH_SITE_ORIGINS[0];

/**
 * The one origin the manifest's links are built from. SITE_URL may be a comma-separated list,
 * since print-service-env.ts reads the same variable for the API's CORS origins; the manifest
 * stays on a single canonical origin and takes the first entry, reduced to its origin exactly as
 * print-service-env.ts reduces it. Unset yields DEFAULT_SITE_URL, which is also the first origin
 * print-service-env.ts prints when SITE_URL is unset.
 */
export function manifestSiteUrl(raw: string | undefined): string {
  return raw === undefined ? DEFAULT_SITE_URL : parseSiteOrigins(raw)[0];
}
/** The ABIs the printer publishes under /abi/<Contract>.json, from the Hardhat artifacts. */
export const ABI_CONTRACTS = [
  "GoldVault",
  "VaultRegistry",
  "GoldStablecoin",
  "GoldOracle",
  "GoldStabilityReserve",
  "StabilityPool",
  "StabilityModule",
  "SurplusBuffer",
  "SiloFactory",
  "GoldGovernance",
] as const;

export interface CollateralConfig {
  minRatio: number;
  liqRatio: number;
  liqPenalty: number;
  debtCeiling: string;
  stabilityFeeBps: number;
}

export interface AgentManifestAddresses {
  oracle: string;
  stablecoin: string;
  stabilityModule: string;
  vault: string;
  surplusBuffer: string;
  stabilityPool: string;
  reserve: string;
  siloFactory: string;
  vaultRegistry?: string;
  governance?: string;
  timelock?: string;
}

export interface AgentManifestSnapshot {
  chainId: number;
  network: string;
  deployer?: string;
  deployBlock: number;
  deployedAt?: string;
  governanceTransferred?: boolean;
  /** True only once governance has called lockMinters(vault) (lockMinters() before 2026-11-06); absent or false means the minter set can still change. */
  mintersLocked?: boolean;
  addresses: AgentManifestAddresses;
  config: {
    paxgToken: string;
    xautToken: string;
    paxgFeed?: string;
    xautFeed?: string;
    minDebt?: string;
    underwaterDiscountPpm?: string;
    originationFeeBps?: string;
    stalenessThreshold?: number;
    reserveDailyCapPpm?: string;
    paxg?: CollateralConfig;
    xaut?: CollateralConfig;
    /** False on a PAXG-first deployment (LAUNCH_CAPS=open, or backstop on a fork): XAUT has its oracle entry and nothing else. Absent means active. */
    xautActive?: boolean;
  };
}

export interface ManifestCollateral {
  symbol: "PAXG" | "XAUT";
  token: string;
  /** The live token's decimals; read decimals() from the token before trusting it. */
  decimals: number;
  minRatioPpm: number;
  liquidationRatioPpm: number;
  liquidationPenaltyPpm: number;
  debtCeiling: string;
  stabilityFeeBps: number;
  /**
   * Present, and false, only for a token the oracle registers but the vault does not accept: its
   * ratios and ceiling read 0, as VaultRegistry.collateralTypeOf does, and deposits revert.
   */
  active?: false;
  note?: string;
}

/** What a registered but inactive token is, in the words the manifest and llms.txt both use. */
export const INACTIVE_COLLATERAL_NOTE =
  "registered in the oracle only: not a vault collateral type, reserve asset or stability pool token, so deposits revert; activation is a governance batch through the timelock";

/**
 * One eth_call an agent can replay with no ABI: send `data` to `to` and compare the raw
 * return word with `result`. `address` names the entry of `addresses` the call targets, so
 * a reader can prove that every listed address is exercised and that no check quietly
 * points elsewhere. Together the checks prove the address set is self-consistent.
 */
export interface ManifestVerification {
  check: string;
  address: keyof AgentManifestAddresses;
  to: string;
  data: string;
  result: string;
}

export interface ManifestMinting {
  /** The contract that holds MINTER_ROLE on this network. */
  minter: "GoldVault";
  /** Present only when the snapshot records the minter lock as done; otherwise read mintersLocked() yourself. */
  locked?: true;
  note: string;
}

export interface ManifestNetwork {
  chainId: number;
  name: string;
  status: "mainnet" | "testnet" | "not deployed";
  explorer: string;
  deployBlock?: number;
  deployedAt?: string;
  governanceTransferred?: boolean;
  addresses?: AgentManifestAddresses;
  collateral?: ManifestCollateral[];
  parameters?: {
    minDebt?: string;
    underwaterDiscountPpm?: number;
    originationFeeBps?: number;
    oracleStalenessSeconds?: number;
    reserveDailyCapPpm?: number;
  };
  minting?: ManifestMinting;
  verification?: ManifestVerification[];
}

export interface AgentManifestSource {
  /** The origin every other link is built from; the drift test rebuilds the manifest from it. */
  site: string;
  guide: string;
  abis: Record<string, string>;
  /** Only when the operator supplied SOURCE_URL; the published site is the reference otherwise. */
  repository?: string;
}

export interface AgentManifest {
  schema: typeof AGENT_MANIFEST_SCHEMA;
  generatedAt: string;
  source: AgentManifestSource;
  token: { symbol: string; name: string; decimals: number; permit: boolean; minter: string };
  conventions: Record<string, string | number | boolean>;
  reads: Record<string, string>;
  actions: Record<string, string>;
  maintenance: { call: string; when: string }[];
  networks: Record<string, ManifestNetwork>;
}

const MAINNET_CHAIN_ID = 1;
const SEPOLIA_CHAIN_ID = 11155111;

/**
 * The first twenty accounts of Hardhat's public development mnemonic. Their keys are published,
 * so a snapshot one of them deployed is a fork or local rehearsal, never a real deployment.
 */
const DEVELOPMENT_MNEMONIC = "test test test test test test test test test test test junk";
export const DEVELOPMENT_ACCOUNTS: ReadonlySet<string> = new Set(
  Array.from({ length: 20 }, (_, i) => HDNodeWallet.fromPhrase(DEVELOPMENT_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).address.toLowerCase())
);

/**
 * The snapshots fit to publish: a chain 1 snapshot deployed by a development account is a mainnet
 * fork rehearsal (written as deployments/mainnet.json by a run named mainnet) and is left out,
 * so the dapp never announces fork addresses as the live deployment.
 */
export function publishableSnapshots(snapshots: AgentManifestSnapshot[]): { publish: AgentManifestSnapshot[]; rehearsals: AgentManifestSnapshot[] } {
  const rehearsal = (snap: AgentManifestSnapshot): boolean =>
    snap.chainId === MAINNET_CHAIN_ID && snap.deployer !== undefined && DEVELOPMENT_ACCOUNTS.has(snap.deployer.toLowerCase());
  return { publish: snapshots.filter((snap) => !rehearsal(snap)), rehearsals: snapshots.filter(rehearsal) };
}
const EXPLORERS: Record<number, string> = {
  [MAINNET_CHAIN_ID]: "https://etherscan.io",
  [SEPOLIA_CHAIN_ID]: "https://sepolia.etherscan.io",
};
const NETWORK_NAMES: Record<number, string> = { [MAINNET_CHAIN_ID]: "mainnet", [SEPOLIA_CHAIN_ID]: "sepolia" };
const TOKEN_DECIMALS = { PAXG: 18, XAUT: 6 } as const;
const GOVERNANCE_DELAY_SECONDS = 48 * 3600;

const statusFor = (chainId: number): ManifestNetwork["status"] => (chainId === MAINNET_CHAIN_ID ? "mainnet" : "testnet");

const inactiveCollateral = (symbol: "PAXG" | "XAUT", token: string): ManifestCollateral => ({
  symbol,
  token,
  decimals: TOKEN_DECIMALS[symbol],
  minRatioPpm: 0,
  liquidationRatioPpm: 0,
  liquidationPenaltyPpm: 0,
  debtCeiling: "0",
  stabilityFeeBps: 0,
  active: false,
  note: INACTIVE_COLLATERAL_NOTE,
});

const collateralOf = (symbol: "PAXG" | "XAUT", token: string, cfg: CollateralConfig | undefined, active = true): ManifestCollateral[] =>
  cfg === undefined
    ? []
    : !active
      ? [inactiveCollateral(symbol, token)]
      : [
        {
          symbol,
          token,
          decimals: TOKEN_DECIMALS[symbol],
          minRatioPpm: cfg.minRatio,
          liquidationRatioPpm: cfg.liqRatio,
          liquidationPenaltyPpm: cfg.liqPenalty,
          debtCeiling: cfg.debtCeiling,
          stabilityFeeBps: cfg.stabilityFeeBps,
        },
      ];

const toNumber = (value: string | undefined): number | undefined => (value === undefined ? undefined : Number(value));

const ROLE_IFACE = new Interface(["function hasRole(bytes32 role, address account) view returns (bool)"]);
const POINTER_IFACE = new Interface([
  "function vaultRegistry() view returns (address)",
  "function stabilityPool() view returns (address)",
  "function stablecoin() view returns (address)",
  "function oracle() view returns (address)",
  "function vault() view returns (address)",
  "function surplusBuffer() view returns (address)",
  "function stabilityReserve() view returns (address)",
  "function stabilityModule() view returns (address)",
  "function siloFactory() view returns (address)",
  "function gsusd() view returns (address)",
  "function paxgToken() view returns (address)",
  "function xautToken() view returns (address)",
  "function paxgUsdFeed() view returns (address)",
  "function getTimelockAddress() view returns (address)",
]);
const WORD_IFACE = new Interface([
  "function decimals() view returns (uint8)",
  "function stalenessThreshold() view returns (uint256)",
  "function getMinDelay() view returns (uint256)",
  "function mintersLocked() view returns (bool)",
  "function vaultRoleLocked() view returns (bool)",
  "function absorptionBurns() view returns (bool)",
]);
const MINTER_ROLE = id("MINTER_ROLE");
const VAULT_ROLE = id("VAULT_ROLE");
const PROPOSER_ROLE = id("PROPOSER_ROLE");
const DEFAULT_ADMIN_ROLE = `0x${"0".repeat(64)}`;

const wordOf = (value: boolean | string | number | bigint): string => {
  if (typeof value === "boolean") return zeroPadValue(value ? "0x01" : "0x00", 32);
  if (typeof value === "string") return zeroPadValue(value.toLowerCase(), 32);
  const hex = BigInt(value).toString(16);
  return zeroPadValue(`0x${hex.length % 2 === 0 ? hex : `0${hex}`}`, 32);
};

type Check = ManifestVerification;
type AddressKey = keyof AgentManifestAddresses;

const roleCheck = (check: string, address: AddressKey, to: string, role: string, account: string, held: boolean): Check => ({
  check,
  address,
  to,
  data: ROLE_IFACE.encodeFunctionData("hasRole", [role, account]),
  result: wordOf(held),
});
const pointerCheck = (check: string, address: AddressKey, to: string, fn: string, expected: string): Check => ({
  check,
  address,
  to,
  data: POINTER_IFACE.encodeFunctionData(fn, []),
  result: wordOf(expected),
});
const wordCheck = (check: string, address: AddressKey, to: string, fn: string, expected: boolean | number | bigint): Check => ({
  check,
  address,
  to,
  data: WORD_IFACE.encodeFunctionData(fn, []),
  result: wordOf(expected),
});

/**
 * The eth_calls that prove a snapshot's addresses belong together. Every address in the
 * set is the target of at least one call, and every expected word is derived from the
 * snapshot, so the list cannot be satisfied by a look-alike set that merely points at the
 * real contracts.
 */
export function verificationOf(snap: AgentManifestSnapshot): ManifestVerification[] {
  const a = snap.addresses;
  const c = snap.config;
  const checks: Check[] = [
    roleCheck("GoldStablecoin: the vault holds MINTER_ROLE", "stablecoin", a.stablecoin, MINTER_ROLE, a.vault, true),
    wordCheck("GoldStablecoin.decimals() is 18", "stablecoin", a.stablecoin, "decimals", 18),
    pointerCheck("GoldVault.stablecoin() is the GSUSD token", "vault", a.vault, "stablecoin", a.stablecoin),
    pointerCheck("GoldVault.oracle() is the oracle", "vault", a.vault, "oracle", a.oracle),
    pointerCheck("GoldVault.stabilityModule() is the stability module", "vault", a.vault, "stabilityModule", a.stabilityModule),
    pointerCheck("GoldVault.stabilityPool() is the pool", "vault", a.vault, "stabilityPool", a.stabilityPool),
    pointerCheck("GoldVault.surplusBuffer() is the surplus buffer", "vault", a.vault, "surplusBuffer", a.surplusBuffer),
    pointerCheck("GoldVault.stabilityReserve() is the reserve", "vault", a.vault, "stabilityReserve", a.reserve),
    pointerCheck("GoldVault.siloFactory() is the silo factory", "vault", a.vault, "siloFactory", a.siloFactory),
    pointerCheck("GoldOracle.paxgToken() is PAXG", "oracle", a.oracle, "paxgToken", c.paxgToken),
    pointerCheck("GoldOracle.xautToken() is XAUT", "oracle", a.oracle, "xautToken", c.xautToken),
    roleCheck("StabilityModule: the vault holds VAULT_ROLE", "stabilityModule", a.stabilityModule, VAULT_ROLE, a.vault, true),
    roleCheck("SurplusBuffer: the vault holds VAULT_ROLE", "surplusBuffer", a.surplusBuffer, VAULT_ROLE, a.vault, true),
    roleCheck("StabilityPool: the vault holds VAULT_ROLE", "stabilityPool", a.stabilityPool, VAULT_ROLE, a.vault, true),
    pointerCheck("GoldStabilityReserve.gsusd() is the GSUSD token", "reserve", a.reserve, "gsusd", a.stablecoin),
    pointerCheck("GoldStabilityReserve.oracle() is the oracle", "reserve", a.reserve, "oracle", a.oracle),
    roleCheck("GoldStabilityReserve: the reserve holds no MINTER_ROLE", "stablecoin", a.stablecoin, MINTER_ROLE, a.reserve, false),
    roleCheck("SiloFactory: the vault holds VAULT_ROLE", "siloFactory", a.siloFactory, VAULT_ROLE, a.vault, true),
    wordCheck("SiloFactory.vaultRoleLocked() is true", "siloFactory", a.siloFactory, "vaultRoleLocked", true),
    // Answered only by the buffer that burns what it absorbs, so a set still running the
    // code this guide no longer describes fails the list instead of passing on wiring alone.
    wordCheck("SurplusBuffer.absorptionBurns() is true (the current contract generation)", "surplusBuffer", a.surplusBuffer, "absorptionBurns", true),
  ];
  if (c.paxgFeed !== undefined) checks.push(pointerCheck("GoldOracle.paxgUsdFeed() is the PAXG/USD feed", "oracle", a.oracle, "paxgUsdFeed", c.paxgFeed));
  if (c.stalenessThreshold !== undefined) checks.push(wordCheck(`GoldOracle.stalenessThreshold() is ${c.stalenessThreshold}`, "oracle", a.oracle, "stalenessThreshold", c.stalenessThreshold));
  if (a.vaultRegistry !== undefined) {
    checks.push(
      pointerCheck("GoldVault.vaultRegistry() is the registry", "vault", a.vault, "vaultRegistry", a.vaultRegistry),
      pointerCheck("VaultRegistry.vault() is the vault", "vaultRegistry", a.vaultRegistry, "vault", a.vault)
    );
  }
  if (a.governance !== undefined) {
    checks.push(pointerCheck("GoldGovernance.vault() is the vault", "governance", a.governance, "vault", a.vault));
    if (a.timelock !== undefined) checks.push(pointerCheck("GoldGovernance.getTimelockAddress() is the timelock", "governance", a.governance, "getTimelockAddress", a.timelock));
  }
  if (a.timelock !== undefined) {
    // The delay is a governed value, not wiring: governance may lengthen it after launch and
    // a manifest that then failed on 172800 would read as a tampered deployment. The live read
    // is `TimelockController.getMinDelay()`; the launch figure stays in `parameters`.
    if (a.governance !== undefined) checks.push(roleCheck("TimelockController: the governance wrapper holds PROPOSER_ROLE", "timelock", a.timelock, PROPOSER_ROLE, a.governance, true));
    if (snap.governanceTransferred === true) {
      checks.push(roleCheck("GoldStablecoin: the timelock holds DEFAULT_ADMIN_ROLE", "stablecoin", a.stablecoin, DEFAULT_ADMIN_ROLE, a.timelock, true));
      checks.push(roleCheck("GoldVault: the timelock holds DEFAULT_ADMIN_ROLE", "vault", a.vault, DEFAULT_ADMIN_ROLE, a.timelock, true));
      if (snap.deployer !== undefined) {
        checks.push(roleCheck("GoldStablecoin: the deployer no longer holds DEFAULT_ADMIN_ROLE", "stablecoin", a.stablecoin, DEFAULT_ADMIN_ROLE, snap.deployer, false));
      }
    }
  }
  if (snap.mintersLocked === true) checks.push(wordCheck("GoldStablecoin.mintersLocked() is true", "stablecoin", a.stablecoin, "mintersLocked", true));
  return checks;
}

/** The entries of `addresses` that no verification call targets; empty for a well-formed network. */
export function uncoveredAddresses(network: Pick<ManifestNetwork, "addresses" | "verification">): string[] {
  const covered = new Set((network.verification ?? []).map((check) => check.address));
  return Object.keys(network.addresses ?? {}).filter((key) => !covered.has(key as AddressKey));
}

/** Checks whose `to` is not the address they claim to call; empty for an honest manifest. */
export function misdirectedChecks(network: Pick<ManifestNetwork, "addresses" | "verification">): ManifestVerification[] {
  const addresses: Record<string, string | undefined> = { ...(network.addresses ?? {}) };
  return (network.verification ?? []).filter((check) => addresses[check.address]?.toLowerCase() !== check.to.toLowerCase());
}

export function mintingOf(snap: AgentManifestSnapshot): ManifestMinting {
  if (snap.mintersLocked === true) {
    return {
      minter: "GoldVault",
      locked: true,
      note: "GSUSD is minted only by the GoldVault listed here, which holds MINTER_ROLE, and the minter set is locked for good: GoldStablecoin.mintersLocked() is true, so no address can ever be added.",
    };
  }
  return {
    minter: "GoldVault",
    note: "GSUSD is minted only by the GoldVault listed here, which holds MINTER_ROLE. The minter set stays changeable by governance through the 48 hour timelock until lockMinters(vault) is called (lockMinters() on deployments before 2026-11-06); read GoldStablecoin.mintersLocked() to check whether it has been.",
  };
}

export function networkEntry(snap: AgentManifestSnapshot): ManifestNetwork {
  const entry: ManifestNetwork = {
    chainId: snap.chainId,
    name: NETWORK_NAMES[snap.chainId] ?? snap.network,
    status: statusFor(snap.chainId),
    explorer: EXPLORERS[snap.chainId] ?? "",
    deployBlock: snap.deployBlock,
    deployedAt: snap.deployedAt,
    governanceTransferred: snap.governanceTransferred,
    addresses: snap.addresses,
    collateral: [
      ...collateralOf("PAXG", snap.config.paxgToken, snap.config.paxg),
      ...collateralOf("XAUT", snap.config.xautToken, snap.config.xaut, snap.config.xautActive !== false),
    ],
    parameters: {
      minDebt: snap.config.minDebt,
      underwaterDiscountPpm: toNumber(snap.config.underwaterDiscountPpm),
      originationFeeBps: toNumber(snap.config.originationFeeBps),
      oracleStalenessSeconds: snap.config.stalenessThreshold,
      reserveDailyCapPpm: toNumber(snap.config.reserveDailyCapPpm),
    },
    minting: mintingOf(snap),
    verification: verificationOf(snap),
  };
  const uncovered = uncoveredAddresses(entry);
  if (uncovered.length > 0) throw new Error(`No verification call targets ${uncovered.join(", ")} on chain ${snap.chainId}; the manifest would publish an unproven address`);
  return entry;
}

export interface ManifestOptions {
  generatedAt: string;
  /** Where the dapp is served; the guide, manifest and ABI links are built from it. */
  siteUrl: string;
  /** A public repository, when there is one; omitted from the manifest otherwise. */
  repository?: string;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

export function buildAgentManifest(snapshots: AgentManifestSnapshot[], options: ManifestOptions): AgentManifest {
  const site = trimSlash(options.siteUrl);
  const networks: Record<string, ManifestNetwork> = {};
  for (const snap of snapshots) networks[String(snap.chainId)] = networkEntry(snap);
  if (networks[String(MAINNET_CHAIN_ID)] === undefined) {
    networks[String(MAINNET_CHAIN_ID)] = {
      chainId: MAINNET_CHAIN_ID,
      name: "mainnet",
      status: "not deployed",
      explorer: EXPLORERS[MAINNET_CHAIN_ID],
    };
  }
  const repository = options.repository?.trim();
  return {
    schema: AGENT_MANIFEST_SCHEMA,
    generatedAt: options.generatedAt,
    source: {
      site,
      guide: `${site}/docs/agents`,
      abis: Object.fromEntries(ABI_CONTRACTS.map((name) => [name, `${site}/abi/${name}.json`])),
      ...(repository ? { repository: trimSlash(repository).replace(/\.git$/, "") } : {}),
    },
    token: {
      symbol: "GSUSD",
      name: "Gold Standard Dollar",
      decimals: 18,
      permit: true,
      minter: "GoldVault holds MINTER_ROLE on every network; networks.<chainId>.minting says whether the minter set is locked, and GoldStablecoin.mintersLocked() is the live answer",
    },
    conventions: {
      ratioUnit: "parts per million; 1000000 is 100%",
      priceDecimals: 8,
      priceQuote: "USD per whole token",
      gsusdDecimals: 18,
      collateralAmounts: "in the token's own decimals; read decimals() from the token",
      debtIncludesAccruedFee: true,
      repayCapsAtCurrentDebt: true,
      liquidateWithZeroRepaysInFull: true,
      underwaterLiquidatesInFull: true,
      registryHookGasFloor: 375000,
      pauseExpiresAfterSeconds: 14 * 24 * 3600,
      governanceDelaySeconds: GOVERNANCE_DELAY_SECONDS,
    },
    reads: {
      openVaults: "VaultRegistry.vaultOwnerCount() and vaultOwners(offset, limit)",
      vault: "VaultRegistry.vaultSummary(owner): token, collateral, debt, ratio (ppm, max uint when debt-free), liquidationPrice, liquidatable",
      liquidatable: "VaultRegistry.isLiquidatable(owner) and liquidatableVaults(offset, limit) are hints at the last known price and can miss a vault in a quiet falling market. The liquidation test itself: collateral * 10^(18 - token decimals) * GoldOracle.quoteTokenPrice(token) / 1e8 * 1e6 / GoldVault.getVaultCurrentDebt(owner) < liquidationRatio",
      currentDebt: "GoldVault.getVaultCurrentDebt(owner), fee included",
      price: "GoldOracle.quoteTokenPrice(token) (liquidation: the higher of the Chainlink market price and Chainlink XAU/USD, at most the liquidation cap above gold), quoteBorrowPrice(token) (minting and indebted withdrawals: the lower of the two, only inside the gold band) and quoteReservePrice(token) (reserve swaps: the higher of the two, only inside the gold band) are the prices the protocol acts on; each reverts when its rule gives none, and all of them revert while either Chainlink feed is stale. getValidatedPrice(token) returns the Chainlink market feed's own read as (price, ok)",
      frozen: "GoldOracle.tokenFrozen(token): true while the token is frozen. The guardian or governance freezes it (freezeToken) and lifts it (guardianUnfreezeToken(token, freezeEpoch(token)), only once a normal read succeeds; the number names the freeze and every freezeToken call takes a new one, a re-freeze of a frozen token included, so an unfreeze approved before the latest freezeToken cannot lift it); nobody else can. The freeze lapses at frozenUntil(token), at most 14 days after it was last set. While frozen every price the protocol acts on refuses the token, and so does every liquidation, during a pause as well",
      collateralType: "VaultRegistry.collateralTypeOf(token): minRatio, liquidationRatio, liquidationPenalty, debtCeiling, totalDebt, active",
      swapQuote: "GoldStabilityReserve.quoteGoldOut(token, gsusdIn) returns (goldOut, spreadPpm) at the spread tier the swap itself pays; (0, 0) means the swap would be refused (asset unsupported or paused, or no reserve price from the oracle). It does not apply the floor or the daily caps: bound the size with remainingDailyCapacity(token), which is 0 whenever a swap would be refused, and redeemableCollateral(token)",
      stabilityFee: "StabilityModule.stabilityFeeRate(VaultRegistry.collateralIdOf(token)): the per-second rate as an 18 decimal multiplier (1e18 is zero); debt grows by it every second",
      originationFee: "GoldVault.originationFeeBps(): taken from what a mint delivers unless originationFeeExempt(account); debt rises by the full amount minted",
      mintCapacity: "the most a mint may add: collateral value at GoldOracle.quoteBorrowPrice(token) * 1e6 / minRatio, less GoldVault.getVaultCurrentDebt(owner), and within debtCeiling - totalDebt where a ceiling is set",
      pool: "StabilityPool.getEffectiveDeposit(user), getCollateralGain(user, token), getTotalDeposits()",
      paused: "paused() and pauseExpiresAt() on GoldVault, GoldOracle, StabilityPool; GoldStabilityReserve.assetPaused(token) for one reserve asset, which lapses by itself at assets(token).pausedUntil, at most 14 days after the guardian last paused it",
      mintersLocked: "GoldStablecoin.mintersLocked(): true once the minter set can never change again",
      governanceDelay: "TimelockController.getMinDelay(): the delay in force in seconds. conventions.governanceDelaySeconds is the launch value; the delay changes only through a timelock call to updateDelay that first waits out the delay in force; CallScheduled announces it in advance and MinDelayChange records it when it executes",
    },
    actions: {
      openVault: "token.approve(vault, amount); GoldVault.deposit(token, amount); GoldVault.mint(gsusd)",
      repay: "GSUSD.approve(vault, amount); GoldVault.repay(amount), which caps at the current debt. The fee accrues every second, so for a full repayment approve and pass the debt plus a small margin (the vault takes only the debt at execution), then reset the allowance to zero. Paying the accrued fee needs GSUSD beyond what was minted",
      withdraw: "GoldVault.withdraw(amount) in the collateral token's decimals; a withdrawal to zero closes the vault only once the debt is repaid in full",
      liquidate: "GSUSD.approve(vault, debt plus a small margin for the fee accruing until inclusion); GoldVault.liquidate(owner, 0) repays in full, or pass a partial amount. Between 100% and 100% plus the penalty a partial is taken pro rata; an underwater vault (below 100%) accepts only a full liquidation",
      liquidateViaPool: "GoldVault.liquidateViaPool(owner, 0); the StabilityPool pays, the caller receives 30% of the penalty in the collateral token. Runs while the vault is paused, priced by the emergency rule; never for a frozen token",
      emergencyLiquidate: "GoldVault.emergencyLiquidate(owner, debtToRepay); runs only while the vault or the oracle is paused, and never for a frozen token",
      poolDeposit: "GSUSD.approve(pool, amount); StabilityPool.deposit(amount); withdraw(amount) and claimCollateral(token) in a later block than the caller's latest deposit",
      swapForGold: "GSUSD.approve(reserve, gsusdIn); GoldStabilityReserve.swapGsusdForGold(token, gsusdIn, minGoldOut)",
    },
    maintenance: [
      { call: "VaultRegistry.sync(owner) or syncMany(owners)", when: "a VaultRegistrySyncFailed event shows a listing drifted" },
      { call: "GoldOracle.getTokenPrice(token)", when: "permissionless: re-anchors the token's last known price, which the ratio views and the registry's hints read (it never prices a seizure); call it when that price is older than the views should rely on" },
      { call: "unpauseExpired() on a paused contract", when: "pauseExpiresAt() has passed" },
      { call: "GoldVault.retryBadDebtAbsorption()", when: "GoldVault.totalBadDebt() is above zero and SurplusBuffer.gsusdBalance() is above zero again; the buffer counts only the fees the vault banks, never a plain GSUSD transfer" },
      { call: "SiloFactory.createSilos(token, count)", when: "SiloFactory.missingSilos(token) is above zero, which happens only after governance moved the deposit cursor: creates the silos the next deposit would otherwise create itself, at most 16 a call. Read missingSilos(token) before every call and stop at 0: the call reverts when nothing is missing, and for an address the factory does not know" },
      { call: "StabilityModule.accrueInterest(collateralId)", when: "optional: brings the fee accumulator up to date; every read already projects the fee to now, so no position depends on it" },
    ],
    networks,
  };
}

/** The discovery file for language models, built from the same manifest so the two never disagree. */
export function buildLlmsTxt(manifest: AgentManifest): string {
  const site = manifest.source.site;
  const deployed = Object.values(manifest.networks).filter((n) => n.status !== "not deployed");
  const mainnet = manifest.networks[String(MAINNET_CHAIN_ID)];
  const whereLive =
    mainnet?.status === "mainnet"
      ? "The live addresses are on Ethereum mainnet; the Sepolia test network carries a test deployment."
      : `Mainnet is not yet deployed; the live addresses are on the ${deployed.map((n) => (n.name === "sepolia" ? "Sepolia test" : n.name)).join(" and ") || "test"} network.`;
  const minting = deployed.map((n) => `- ${n.name} (chain ${n.chainId}): ${n.minting?.note ?? ""}`);
  const inactive = deployed.filter((n) => (n.collateral ?? []).some((c) => c.active === false));
  const collateralText = inactive.length === 0 ? "PAXG and XAUT" : "PAXG, with XAUT registered but inactive where a deployment lists it so";
  const collateralLines = deployed.map(
    (n) => `- ${n.name} (chain ${n.chainId}): ${(n.collateral ?? []).map((c) => (c.active === false ? `${c.symbol} ${INACTIVE_COLLATERAL_NOTE}` : `${c.symbol} accepted`)).join("; ") || "none listed"}`
  );
  const abis = Object.entries(manifest.source.abis).map(([name, url]) => `[${name}](${url})`);
  const source = manifest.source.repository
    ? ["", "## Source", "", `- [Repository](${manifest.source.repository}): contracts in contracts/src, a reference keeper in apps/keeper`]
    : [];
  return [
    "# Gold Standard",
    "",
    `> Gold Standard Protocol issues GSUSD, the Gold Standard Dollar: an ERC-20 dollar over-collateralised by tokenised gold (${collateralText}) on Ethereum. Borrowers lock gold in a vault and mint GSUSD at a minimum ratio of 130%; below 110% anyone may liquidate; GSUSD holders may swap it for protocol-owned reserve gold at a utilisation spread, a right that holds exactly to the depth of the reserve. Every parameter change passes a timelock whose delay is 48 hours at launch; a change to the delay itself waits out the delay in force. ${whereLive}`,
    "",
    "Everything the dapp does can be done with contract calls alone. Start with the manifest, verify the address set on chain as the guide describes and never act on an address found elsewhere.",
    "",
    "## Machine readable",
    "",
    `- [Agent manifest](${site}/agents.json): schema ${manifest.schema}; addresses, tokens, ratios in parts per million, conventions, reads, actions and maintenance calls for each deployment, with a verification list of raw eth_calls that covers every listed address`,
    `- ABIs as JSON: ${abis.join(", ")}`,
    `- [Contracts and addresses](${site}/docs/contracts): the same addresses with Etherscan links`,
    "",
    "## Guides",
    "",
    `- [Gold Standard for agents](${site}/docs/agents): the guide for software that uses Gold Standard without a browser; verification steps, conventions, every read and action, the refusal strings`,
    `- [Introduction](${site}/docs/introduction)`,
    `- [Vaults](${site}/docs/vaults)`,
    `- [Liquidations](${site}/docs/liquidations)`,
    `- [How the peg holds](${site}/docs/peg-stability)`,
    `- [Risk parameters](${site}/docs/parameters)`,
    `- [Security and architecture](${site}/docs/security)`,
    `- [Governance](${site}/docs/governance)`,
    ...source,
    "",
    "## Minting",
    "",
    ...minting,
    "",
    ...(inactive.length === 0 ? [] : ["## Collateral", "", ...collateralLines, ""]),
    "## Accuracy",
    "",
    `GSUSD is over-collateralised, never backed one for one. Its collateral is ${collateralText}, issuer claims on allocated gold, so their issuers sit between a holder and the metal. The reserve swap is priced at a spread, draws only on protocol-owned gold and is pausable per asset; when the reserve is empty there is no floor until it is refilled.`,
    "",
  ].join("\n");
}
