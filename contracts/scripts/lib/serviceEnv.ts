/**
 * The environment blocks of the three services, generated from a deployment snapshot so the
 * addresses are never retyped: the dapp's build-time VITE_* set, the API's indexer set and
 * the keeper's set (docs/LAUNCH.md steps 2.4 and 3.6). Secrets and endpoints are left as
 * `<fill in>` placeholders; the printer never writes a file. The dapp is served from its
 * own origins (the ENS gateway and the DNS mirror), so the dapp block carries the API's absolute
 * endpoint and the API block admits every launch origin on CORS; DAPP_DIST stays available for
 * a single host. A keeper with a VaultRegistry reads vault owners from the chain and needs no
 * Redis; an older deployment's keeper shares the API's Redis and namespace.
 *
 * On mainnet the dapp block leaves the Uniswap variables out unless `dexMarket` is set: both
 * addresses being present is the dapp's switch for the market tab, which quotes GSUSD against
 * PAXG in one hop, and no launch step seeds that pool. Sepolia, where seed-testnet-dex.ts
 * creates it, always carries them.
 */
import { isAddress } from "ethers";
import { CHAIN_NAMES, MAINNET_CHAIN_ID, UNISWAP } from "./mainnetAddresses";

/**
 * The origins the dapp is served from at launch, the canonical address first: the ENS gateway,
 * then the DNS mirror. The API answers a browser only from an origin on its CORS list, matched
 * exactly, so both are printed.
 */
export const LAUNCH_SITE_ORIGINS: readonly string[] = ["https://goldstandardfinance.eth.limo", "https://goldstandard.finance"];

/** The Uniswap v3 fee tier the dapp's market tab quotes, in hundredths of a basis point: 0.30%. */
const DEX_POOL_FEE = "3000";

/**
 * SITE_URL as typed: one origin or a comma-separated list, each reduced to its origin, in the
 * order given and without repeats. Unset yields the launch origins. An entry that is no http(s)
 * URL is refused, as is a list with nothing in it.
 */
export function parseSiteOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [...LAUNCH_SITE_ORIGINS];
  const origins = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "").map(originOf);
  if (origins.length === 0) throw new Error("SITE_URL is empty; give one origin or a comma-separated list, or unset it for the launch origins.");
  return [...new Set(origins)];
}

function originOf(entry: string): string {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new Error(`SITE_URL entry "${entry}" is not a URL; give each origin in full, for example https://goldstandardfinance.eth.limo`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`SITE_URL entry "${entry}" is not an http(s) origin`);
  return url.origin;
}

export interface ServiceEnvSnapshot {
  chainId: number;
  deployBlock: number;
  addresses: {
    oracle: string;
    stablecoin: string;
    stabilityModule: string;
    vault: string;
    surplusBuffer: string;
    stabilityPool: string;
    reserve: string;
    siloFactory: string;
    vaultRegistry?: string;
  };
  config: { paxgToken: string; xautToken: string };
}

export interface ServiceEnv {
  dapp: string;
  api: string;
  keeper: string;
}

export interface ServiceEnvOptions {
  /** Every origin the dapp is served from; the API's CORS allow list is exactly these. LAUNCH_SITE_ORIGINS when absent. */
  siteOrigins?: readonly string[];
  /**
   * Mainnet only: print the Uniswap router, quoter and fee tier, which turns the dapp's market
   * tab on. Set it (DEX_MARKET=1) only once a GSUSD/PAXG 0.30% pool is seeded. Ignored on
   * Sepolia, which always prints them.
   */
  dexMarket?: boolean;
  /**
   * Unix seconds of the deployment block, which is where the Usage Ledger starts recording
   * (docs/TOKEN_POLICY.md section 2: from the first block). The printer reads it from the
   * chain; without it the line is printed as a placeholder to fill in.
   */
  deployTimestamp?: number;
}

export const FILL = (what: string): string => `<fill in: ${what}>`;
/** The local Redis both the API and an older keeper read; the keeper's namespace must equal the API's. */
const LOCAL_REDIS_URL = "redis://127.0.0.1:6379";
const KEEPER_MAX_FEE_GWEI = "150";
const KEEPER_MAX_PRIORITY_FEE_GWEI = "3";
/** The age at which the keeper replaces its own stuck transaction. */
const KEEPER_STUCK_TX_REPLACE_SECONDS = "300";
/** The launch feeds' heartbeat, the margin past it at which the keeper warns oracle.feed-late, and how often the warning repeats. */
const KEEPER_FEED_HEARTBEAT_SECONDS = "86400";
const KEEPER_FEED_LATE_MARGIN_SECONDS = "900";
const KEEPER_FEED_LATE_REPEAT_SECONDS = "3600";

const lines = (entries: Array<[string, string]>): string => entries.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
/** One entry when the value is present, none otherwise, so optional contracts never print an empty line. */
const optional = (key: string, value: string | undefined): Array<[string, string]> => (value ? [[key, value]] : []);

/** A `#` line the env file loaders skip; never contains `=` at the start of a key, so it is not read as a variable. */
const comment = (text: string): string => `# ${text}\n`;

/**
 * The market tab's variables, or on mainnet without `dexMarket` the comment that says why they
 * are left out. The dapp cannot route through a GSUSD/USDC pool: the tab quotes GSUSD against the
 * gold token in one hop.
 */
function dexBlock(snap: ServiceEnvSnapshot, dexMarket: boolean): string {
  const uniswap = UNISWAP[snap.chainId];
  const variables = lines([
    ["VITE_UNISWAP_ROUTER", uniswap.router],
    ["VITE_UNISWAP_QUOTER", uniswap.quoter],
    ["VITE_DEX_POOL_FEE", DEX_POOL_FEE],
  ]);
  if (snap.chainId !== MAINNET_CHAIN_ID) return variables;
  if (dexMarket) {
    return comment("Market tab on (DEX_MARKET set to 1): the swap page opens on it. Build with these only once the GSUSD/PAXG 0.30% Uniswap v3 pool is seeded at a fair price.") + variables;
  }
  return (
    comment("Market tab off: VITE_UNISWAP_ROUTER, VITE_UNISWAP_QUOTER and VITE_DEX_POOL_FEE are left out, so the swap page shows the reserve alone.") +
    comment("The market tab needs a seeded GSUSD/PAXG 0.30% Uniswap v3 pool, and no launch step creates one (the GSUSD/USDC position does not serve it).") +
    comment("Once that pool is seeded, print this block again with DEX_MARKET set to 1 and rebuild the dapp.")
  );
}

/** The documented default of LEDGER_CONFIRMATIONS (docs/USAGE_LEDGER.md section 2), written out so the file states it. */
const LEDGER_CONFIRMATIONS = "12";

/**
 * The Usage Ledger's part of the API block. The ledger runs from launch, so its three
 * variables are printed; the liquidity dimension needs a pool that does not exist yet, so its
 * two variables are printed as comments to uncomment once it does.
 */
function ledgerBlock(snap: ServiceEnvSnapshot, deployTimestamp: number | undefined): string {
  const start =
    deployTimestamp === undefined
      ? FILL(`unix seconds of block ${snap.deployBlock}, the deployment block, or any earlier time`)
      : String(deployTimestamp);
  return (
    comment("Usage Ledger (docs/USAGE_LEDGER.md): records vault debt and stability pool deposits per address from the deployment block on.") +
    lines([
      ["LEDGER_START_TIMESTAMP", start],
      ["LEDGER_STABILITY_POOL_ADDRESS", snap.addresses.stabilityPool],
      ["LEDGER_CONFIRMATIONS", LEDGER_CONFIRMATIONS],
    ]) +
    comment("The two liquidity variables are set once the official GSUSD/USDC pool exists: uncomment both, fill in the pool and restart the API.") +
    comment(`LEDGER_LIQUIDITY_POOL_ADDRESS=${FILL("the official GSUSD/USDC Uniswap v3 pool")}`) +
    comment(`LEDGER_LIQUIDITY_POSITION_MANAGER=${UNISWAP[snap.chainId].positionManager}`)
  );
}

function dappEnv(snap: ServiceEnvSnapshot, chainName: string, dexMarket: boolean): string {
  const onMainnet = snap.chainId === MAINNET_CHAIN_ID;
  const rpcVar = onMainnet ? "VITE_MAINNET_RPC_URL" : "VITE_SEPOLIA_RPC_URL";
  // The dapp reads a comma-separated list in the mainnet variable and falls back from the first endpoint to the second.
  const rpcHint = onMainnet
    ? "one or two comma-separated https mainnet RPC endpoints the browser may call, the second at another provider as the fallback; every visitor can read these keys, so use keys made for the browser, never the keeper's or the API's"
    : `${chainName} RPC URL the browser may call`;
  const variables = lines([
    ["VITE_TARGET_CHAIN_ID", String(snap.chainId)],
    [rpcVar, FILL(rpcHint)],
    // The dapp build refuses any value still holding a placeholder, so the two optional lines say they may be deleted.
    ["VITE_API_URL", FILL("the API's public tRPC endpoint, for example https://api.goldstandard.finance/trpc")],
    ["VITE_SOURCE_URL", FILL("the public repository URL the footer's build link points at, or delete this line")],
    ["VITE_WALLETCONNECT_PROJECT_ID", FILL("WalletConnect Cloud project id, or delete this line")],
    ["VITE_DEPLOY_BLOCK", String(snap.deployBlock)],
    ["VITE_GOLD_VAULT_ADDRESS", snap.addresses.vault],
    ["VITE_GOLD_ORACLE_ADDRESS", snap.addresses.oracle],
    ["VITE_GUSD_ADDRESS", snap.addresses.stablecoin],
    ["VITE_STABILITY_MODULE_ADDRESS", snap.addresses.stabilityModule],
    ["VITE_STABILITY_POOL_ADDRESS", snap.addresses.stabilityPool],
    ["VITE_STABILITY_RESERVE_ADDRESS", snap.addresses.reserve],
    ["VITE_SURPLUS_BUFFER_ADDRESS", snap.addresses.surplusBuffer],
    ["VITE_SILO_FACTORY_ADDRESS", snap.addresses.siloFactory],
    // Deployments from 2026-10-22 on carry a VaultRegistry; older snapshots print no line for it.
    ...optional("VITE_VAULT_REGISTRY_ADDRESS", snap.addresses.vaultRegistry),
    ["VITE_PAXG_ADDRESS", snap.config.paxgToken],
    ["VITE_XAUT_ADDRESS", snap.config.xautToken],
    // The Usage Ledger page, with its disclaimer, is part of the launch build.
    ["VITE_LEDGER_ENABLED", "true"],
  ]);
  return variables + dexBlock(snap, dexMarket);
}

function apiEnv(snap: ServiceEnvSnapshot, chainName: string, siteOrigins: readonly string[], deployTimestamp: number | undefined): string {
  const variables = lines([
    ["NODE_ENV", "production"],
    ["PORT", "3333"],
    // Loopback only: Caddy on the same host is the one hop TRUST_PROXY_HOPS counts, so nothing else may reach the port.
    ["API_HOST", "127.0.0.1"],
    ["TRUST_PROXY_HOPS", "1"],
    // Every origin the dapp is served from, comma separated and matched exactly: the ENS gateway and the DNS mirror at launch.
    ["CORS_ORIGINS", siteOrigins.join(",")],
    ["SEPOLIA_RPC_URL", FILL(`${chainName} RPC URL (the variable keeps its historical name)`)],
    ["INDEXER_CHAIN_ID", String(snap.chainId)],
    ["INDEXER_CONFIRMATIONS", "6"],
    ["GOLD_VAULT_ADDRESS", snap.addresses.vault],
    ["GOLD_VAULT_DEPLOY_BLOCK", String(snap.deployBlock)],
    ["REDIS_URL", LOCAL_REDIS_URL],
    ["REDIS_NAMESPACE", `gsusd-${chainName}`],
  ]);
  return variables + ledgerBlock(snap, deployTimestamp);
}

function keeperEnv(snap: ServiceEnvSnapshot, chainName: string): string {
  const registry = snap.addresses.vaultRegistry;
  // Without a registry the keeper reads the indexer's owner set, so it needs the API's exact Redis coordinates and namespace.
  const ownerSource: Array<[string, string]> = registry
    ? [["VAULT_REGISTRY_ADDRESS", registry]]
    : [
        ["REDIS_URL", LOCAL_REDIS_URL],
        ["REDIS_NAMESPACE", `gsusd-${chainName}`],
      ];
  return lines([
    ["KEEPER_PRIVATE_KEY", FILL("the dedicated keeper key; this file only, never the API's")],
    ["KEEPER_RPC_URL", FILL(`${chainName} RPC URL`)],
    // Optional read endpoints at other providers; the keeper refuses the placeholder, so fill it or delete the line.
    ["KEEPER_READ_RPC_URLS", FILL(`comma-separated ${chainName} RPC URLs at other providers for reads, or delete this line`)],
    ["KEEPER_CHAIN_ID", String(snap.chainId)],
    ["KEEPER_DRY_RUN", "true"],
    ["KEEPER_ENABLE_DIRECT", "true"],
    ["KEEPER_INTERVAL_SECONDS", "60"],
    ["KEEPER_MAX_FEE_GWEI", KEEPER_MAX_FEE_GWEI],
    ["KEEPER_MAX_PRIORITY_FEE_GWEI", KEEPER_MAX_PRIORITY_FEE_GWEI],
    ["KEEPER_STUCK_TX_REPLACE_SECONDS", KEEPER_STUCK_TX_REPLACE_SECONDS],
    ["KEEPER_FEED_HEARTBEAT_SECONDS", KEEPER_FEED_HEARTBEAT_SECONDS],
    ["KEEPER_FEED_LATE_MARGIN_SECONDS", KEEPER_FEED_LATE_MARGIN_SECONDS],
    ["KEEPER_FEED_LATE_REPEAT_SECONDS", KEEPER_FEED_LATE_REPEAT_SECONDS],
    // Optional dead-man ping; the keeper refuses anything but an https URL at start, so fill it or delete the line.
    ["KEEPER_HEARTBEAT_URL", FILL("https URL of a hosted dead-man check that pages when the pings stop, or delete this line")],
    ["GOLD_VAULT_ADDRESS", snap.addresses.vault],
    ["GOLD_ORACLE_ADDRESS", snap.addresses.oracle],
    ["STABILITY_MODULE_ADDRESS", snap.addresses.stabilityModule],
    ["GSUSD_ADDRESS", snap.addresses.stablecoin],
    ["STABILITY_POOL_ADDRESS", snap.addresses.stabilityPool],
    ["PAXG_TOKEN", snap.config.paxgToken],
    ["XAUT_TOKEN", snap.config.xautToken],
    ...ownerSource,
  ]);
}

function assertAddresses(snap: ServiceEnvSnapshot): void {
  const required = ["oracle", "stablecoin", "stabilityModule", "vault", "surplusBuffer", "stabilityPool", "reserve", "siloFactory"] as const;
  for (const key of required) {
    if (!snap.addresses[key]) throw new Error(`Snapshot lacks addresses.${key}`);
  }
  for (const [key, value] of Object.entries(snap.addresses)) {
    if (value !== undefined && !isAddress(value)) throw new Error(`Snapshot addresses.${key} is not an address: ${value}`);
  }
  for (const key of ["paxgToken", "xautToken"] as const) {
    if (!isAddress(snap.config[key])) throw new Error(`Snapshot config.${key} is not an address: ${snap.config[key]}`);
  }
}

/** A deployment timestamp is whole unix seconds in a sane range, or it is not used at all. */
function deployTimestamp(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1_600_000_000 || value > 4_102_444_800) {
    throw new Error(`The deployment block's timestamp is ${String(value)}; expected unix seconds between 1600000000 and 4102444800.`);
  }
  return value;
}

export function serviceEnv(snap: ServiceEnvSnapshot, options: ServiceEnvOptions = {}): ServiceEnv {
  const chainName = CHAIN_NAMES[snap.chainId];
  if (!chainName || !UNISWAP[snap.chainId]) throw new Error(`No service configuration for chain ${snap.chainId}; expected 1 or 11155111.`);
  assertAddresses(snap);
  if (!Number.isInteger(snap.deployBlock) || snap.deployBlock < 0) throw new Error("Snapshot lacks deployBlock");
  // Through the same reading as SITE_URL, so a caller's list is reduced to origins and refused when it is not one.
  const siteOrigins = parseSiteOrigins(options.siteOrigins === undefined ? undefined : options.siteOrigins.join(","));
  return { dapp: dappEnv(snap, chainName, options.dexMarket === true), api: apiEnv(snap, chainName, siteOrigins, deployTimestamp(options.deployTimestamp)), keeper: keeperEnv(snap, chainName) };
}
