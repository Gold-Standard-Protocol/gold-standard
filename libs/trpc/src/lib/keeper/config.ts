import { z } from 'zod';
import { getAddress, parseGwei, zeroAddress } from 'viem';
import type { Address } from 'viem';

// Mirrors lib/indexer/config.ts in shape, but this parser is PURE: it never
// reads process.env and never loads dotenv, so specs pass explicit
// environment objects. The keeper entrypoint (apps/keeper/src/main.ts) is the
// only place process.env is read for the keeper and, together with this file,
// the only file that ever references KEEPER_PRIVATE_KEY. Reason strings never
// echo the private key value.

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export const DEFAULT_KEEPER_CHAIN_ID = 11155111;
export const DEFAULT_KEEPER_INTERVAL_SECONDS = 60;
/** Below this the tick would overlap itself on a slow RPC; above a day the keeper is not keeping. */
export const MIN_KEEPER_INTERVAL_SECONDS = 5;
export const MAX_KEEPER_INTERVAL_SECONDS = 24 * 60 * 60;
/** Fee ceilings in gwei: a compromised or spiking RPC cannot make the keeper pay more. */
export const DEFAULT_MAX_FEE_GWEI = '150';
export const DEFAULT_MAX_PRIORITY_FEE_GWEI = '3';

const GWEI_PATTERN = /^\d+(\.\d{1,9})?$/;

/**
 * Environment variables of retired keeper duties. The variant C oracle
 * (docs/ORACLE_IMPLEMENTATION_PLAN.md section 3) needs no call from the keeper, so the
 * depth observation cadence is gone; a value left set is refused, never ignored, so an
 * operator does not believe a duty still runs.
 */
export const RETIRED_KEEPER_ENV = ['KEEPER_DEPTH_OBSERVE_SECONDS'] as const;

/** Gap between the oracle and the off-chain market price that raises a watchdog alert. */
export const DEFAULT_PRICE_WATCHDOG_ALERT_BPS = 100;
/** Half the price is no longer a useful alarm; at that point every gap is an incident. */
export const MAX_PRICE_WATCHDOG_ALERT_BPS = 5_000;

/**
 * How long the keeper's lowest unmined nonce may stay outstanding
 * before the keeper replaces it with a zero-value transfer to itself at higher fees. Five
 * minutes is about 25 blocks, longer than viem's three-minute receipt wait, so a transaction
 * that is merely slow is left alone. Below a minute a busy block would trigger it; above a
 * day the keeper would sit blocked for longer than any incident should last.
 */
export const DEFAULT_STUCK_TX_REPLACE_SECONDS = 300;
/**
 * How long one tick may reuse an answer it has already read, in milliseconds
 * (tickReadCache.ts). Under one block: a reused answer is never older than the chain state a
 * read a moment earlier would have seen. Zero reads everything from the chain every time.
 */
export const DEFAULT_READ_CACHE_MS = 4_000;
export const MAX_READ_CACHE_MS = 10_000;
export const MIN_STUCK_TX_REPLACE_SECONDS = 60;
export const MAX_STUCK_TX_REPLACE_SECONDS = 24 * 60 * 60;

/**
 * The early warning for a late feed. Both launch feeds,
 * Chainlink PAXG/USD and XAU/USD, write at least once every 24 hours, and GoldOracle refuses
 * every priced path once a round is stalenessThreshold old (90,000 s at most), which leaves
 * about an hour. The keeper warns oracle.feed-late once a feed that still prices is older
 * than the heartbeat plus the margin, so the on-call knows the cause before the refusal.
 */
export const DEFAULT_FEED_HEARTBEAT_SECONDS = 86_400;
export const MIN_FEED_HEARTBEAT_SECONDS = 60;
export const MAX_FEED_HEARTBEAT_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_FEED_LATE_MARGIN_SECONDS = 900;
export const MAX_FEED_LATE_MARGIN_SECONDS = 24 * 60 * 60;
/** While a feed stays late the warning repeats at most this often. */
export const DEFAULT_FEED_LATE_REPEAT_SECONDS = 3_600;
export const MIN_FEED_LATE_REPEAT_SECONDS = 60;
export const MAX_FEED_LATE_REPEAT_SECONDS = 24 * 60 * 60;

const boundedSeconds = (min: number, max: number) =>
  z.coerce
    .number()
    .int({ message: 'must be a whole number of seconds' })
    .min(min, { message: `must be at least ${min} seconds` })
    .max(max, { message: `must be at most ${max} seconds` })
    .optional();

const keeperEnvSchema = z.object({
  KEEPER_RPC_URL: z.string().url().optional(),
  KEEPER_CHAIN_ID: z.coerce
    .number()
    .pipe(z.union([z.literal(1), z.literal(11155111)]))
    .optional(),
  KEEPER_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(MIN_KEEPER_INTERVAL_SECONDS, {
      message: `must be at least ${MIN_KEEPER_INTERVAL_SECONDS} seconds`,
    })
    .max(MAX_KEEPER_INTERVAL_SECONDS, {
      message: `must be at most ${MAX_KEEPER_INTERVAL_SECONDS} seconds (one day); larger values overflow the timer and fire continuously`,
    })
    .optional(),
  KEEPER_MAX_FEE_GWEI: z
    .string()
    .regex(GWEI_PATTERN, { message: 'must be a decimal gwei amount' })
    .optional(),
  KEEPER_MAX_PRIORITY_FEE_GWEI: z
    .string()
    .regex(GWEI_PATTERN, { message: 'must be a decimal gwei amount' })
    .optional(),
  GOLD_VAULT_ADDRESS: z.string().regex(EVM_ADDRESS_PATTERN).optional(),
  GOLD_ORACLE_ADDRESS: z.string().regex(EVM_ADDRESS_PATTERN).optional(),
  STABILITY_MODULE_ADDRESS: z.string().regex(EVM_ADDRESS_PATTERN).optional(),
  GSUSD_ADDRESS: z.string().regex(EVM_ADDRESS_PATTERN).optional(),
  STABILITY_POOL_ADDRESS: z.string().regex(EVM_ADDRESS_PATTERN).optional(),
  PAXG_TOKEN: z.string().regex(EVM_ADDRESS_PATTERN).optional(),
  XAUT_TOKEN: z.string().regex(EVM_ADDRESS_PATTERN).optional(),
  VAULT_REGISTRY_ADDRESS: z.string().regex(EVM_ADDRESS_PATTERN).optional(),
  PRICE_WATCHDOG_ALERT_BPS: z.coerce
    .number()
    .int({ message: 'must be a whole number of basis points' })
    .min(1, { message: 'must be at least 1 basis point' })
    .max(MAX_PRICE_WATCHDOG_ALERT_BPS, {
      message: `must be at most ${MAX_PRICE_WATCHDOG_ALERT_BPS} basis points`,
    })
    .optional(),
  KEEPER_READ_CACHE_MS: z.coerce
    .number()
    .int({ message: 'must be a whole number of milliseconds' })
    .min(0, { message: 'must be 0 (off) or more' })
    .max(MAX_READ_CACHE_MS, {
      message: `must be at most ${MAX_READ_CACHE_MS} milliseconds, under one block`,
    })
    .optional(),
  KEEPER_STUCK_TX_REPLACE_SECONDS: z.coerce
    .number()
    .int({ message: 'must be a whole number of seconds' })
    .min(MIN_STUCK_TX_REPLACE_SECONDS, {
      message: `must be at least ${MIN_STUCK_TX_REPLACE_SECONDS} seconds`,
    })
    .max(MAX_STUCK_TX_REPLACE_SECONDS, {
      message: `must be at most ${MAX_STUCK_TX_REPLACE_SECONDS} seconds (one day)`,
    })
    .optional(),
  KEEPER_FEED_HEARTBEAT_SECONDS: boundedSeconds(MIN_FEED_HEARTBEAT_SECONDS, MAX_FEED_HEARTBEAT_SECONDS),
  KEEPER_FEED_LATE_MARGIN_SECONDS: boundedSeconds(0, MAX_FEED_LATE_MARGIN_SECONDS),
  KEEPER_FEED_LATE_REPEAT_SECONDS: boundedSeconds(MIN_FEED_LATE_REPEAT_SECONDS, MAX_FEED_LATE_REPEAT_SECONDS),
});

export interface KeeperConfig {
  chainId: 1 | 11155111;
  /**
   * KEEPER_RPC_URL: the endpoint that signs and sends, and the only one the keeper asks for
   * nonces, fee estimates, gas estimates, simulations and receipts, so the pending
   * transaction guard reads the same mempool its sends go to.
   */
  rpcUrl: string;
  /**
   * KEEPER_READ_RPC_URLS: optional endpoints for every other read (owner lists, vault and
   * oracle state, balances), tried in order with KEEPER_RPC_URL as the last resort, so a
   * rate limit or an outage at the send endpoint, often a private relay, no longer blinds
   * the keeper. Absent or empty means
   * KEEPER_RPC_URL alone. Each URL carries a provider key and is never logged, so each
   * keeps its 1-based position in the variable for the messages that name it.
   */
  readRpcUrls?: readonly ReadRpcUrl[];
  /** True unless KEEPER_DRY_RUN is explicitly the literal "false". */
  dryRun: boolean;
  /**
   * Direct GoldVault.liquidate burns the keeper wallet's own GSUSD, so it is
   * doubly opt-in: KEEPER_ENABLE_DIRECT must be "true" AND the wallet must
   * hold at least the vault debt in GSUSD. The pool path needs neither.
   */
  enableDirect: boolean;
  intervalSeconds: number;
  /** Hard ceiling on maxFeePerGas in wei; a transaction whose estimate exceeds it is not sent. */
  maxFeePerGasWei: bigint;
  /** Ceiling on maxPriorityFeePerGas in wei; the estimate is clamped to it. */
  maxPriorityFeePerGasWei: bigint;
  /**
   * True when REDIS_URL or REDIS_HOST is set. Only then does the keeper build the
   * Redis-backed owner source; otherwise it reads the on-chain registry alone and
   * never opens a Redis client, so a keeper host without Redis is a supported shape.
   */
  redisConfigured: boolean;
  privateKey?: `0x${string}`;
  goldVaultAddress: Address;
  goldOracleAddress: Address;
  stabilityModuleAddress: Address;
  /**
   * Transaction targets are operator-pinned, never learned from the RPC: a
   * compromised RPC answering GoldVault.stablecoin()/stabilityPool() with an
   * attacker address must not be able to redirect keeper approvals or calls.
   */
  gsusdAddress: Address;
  stabilityPoolAddress: Address;
  paxgToken: Address;
  /**
   * Undefined while XAUT_TOKEN is unset or the zero address (PAXG-only
   * launch): all XAUT keeper tasks are skipped and the runner logs this once.
   */
  xautToken: Address | undefined;
  /**
   * The on-chain VaultRegistry, when deployed. With it set the keeper reads the
   * open-vault owner set straight from the chain and unions it with the
   * indexer's Redis set, so a stalled or re-pointed API can never hide a vault
   * from the liquidation walk. Undefined while unset or the zero address: the
   * keeper then relies on the Redis set alone.
   */
  vaultRegistryAddress: Address | undefined;
  /**
   * PRICE_WATCHDOG_ALERT_BPS: the read-only price watchdog alerts once the oracle's
   * quoted price or one of its sources sits this many basis points from the off-chain
   * market price. Default 100 (1%).
   */
  priceWatchdogAlertBps: number;
  /**
   * KEEPER_STUCK_TX_REPLACE_SECONDS: once the keeper's lowest unmined nonce has been
   * outstanding this long, the keeper replaces it with a zero-value transfer to itself at
   * bumped fees, within the fee ceilings. Default 300.
   */
  stuckTxReplaceSeconds: number;
  /**
   * KEEPER_READ_CACHE_MS: how long one tick may reuse an answer it has already read.
   * Default 4000; 0 turns the reuse off. A send switches it off for the rest of the tick
   * whatever this says (tickReadCache.ts).
   */
  readCacheMs: number;
  /**
   * KEEPER_OFFCHAIN_PRICES: where the read-only price watchdog gets the market price it
   * compares the oracle with. `redis` reads the API's cached quote (needs REDIS_URL or
   * REDIS_HOST), `http` fetches the aggregator itself and `none` switches the comparison
   * off. Unset, it is `redis` when Redis is configured and `http` otherwise, so the
   * recommended Redis-free keeper host keeps the one check that is independent of Chainlink.
   */
  offChainPriceSource: 'redis' | 'http' | 'none';
  /** KEEPER_PRICE_API_URL: the simple price endpoint the `http` source asks; CoinGecko's by default. */
  priceApiUrl: string;
  /**
   * KEEPER_FEED_HEARTBEAT_SECONDS: the longest a launch feed normally goes between writes.
   * Default 86,400 (24 hours), the heartbeat of Chainlink PAXG/USD and XAU/USD.
   */
  feedHeartbeatSeconds: number;
  /**
   * KEEPER_FEED_LATE_MARGIN_SECONDS: how far past the heartbeat a feed that still prices may
   * be before the keeper warns oracle.feed-late. Default 900 (15 minutes). The heartbeat plus
   * this margin must stay below GoldOracle.stalenessThreshold, or the warning cannot fire
   * before the refusal; the keeper then says so and warns at the heartbeat alone, or at half
   * the threshold when the heartbeat is not below it either (see feedLateness.ts).
   */
  feedLateMarginSeconds: number;
  /**
   * KEEPER_FEED_LATE_REPEAT_SECONDS: while a feed stays late, oracle.feed-late repeats at
   * most this often. Default 3,600.
   */
  feedLateRepeatSeconds: number;
  /**
   * KEEPER_HEARTBEAT_URL: optional https URL of a hosted dead-man check. The keeper GETs it
   * after every tick that completed without a job error, and never after one that did not,
   * so the service pages when the pings stop. It may carry a secret path, so only its host
   * is ever logged. Undefined sends nothing.
   */
  heartbeatUrl?: string;
}

/** CoinGecko's simple price endpoint, the same one the API's price job uses. */
export const DEFAULT_PRICE_API_URL = 'https://api.coingecko.com/api/v3/simple/price';
const OFF_CHAIN_PRICE_SOURCES = ['redis', 'http', 'none'] as const;

export type KeeperConfigResult =
  | { ok: true; config: KeeperConfig }
  | { ok: false; reason: string };

const emptyToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;

const HTTP_URL_PATTERN = /^https?:\/\/\S+$/;

const isHttpUrl = (value: string): boolean => {
  if (!HTTP_URL_PATTERN.test(value)) return false;
  try {
    return new URL(value).hostname !== '';
  } catch {
    return false;
  }
};

type HeartbeatUrlParse = { ok: true; url: string | undefined } | { ok: false; reason: string };

/**
 * KEEPER_HEARTBEAT_URL: https only, with a host and no embedded credentials. The value is a
 * capability (whoever holds it can keep the dead-man check quiet), so it is never echoed.
 */
const parseHeartbeatUrl = (raw: string | undefined): HeartbeatUrlParse => {
  const value = emptyToUndefined(raw)?.trim();
  if (value === undefined) return { ok: true, url: undefined };
  const refused: HeartbeatUrlParse = {
    ok: false,
    reason:
      'KEEPER_HEARTBEAT_URL must be an https URL with a host and no user name or password; the value has not been logged.',
  };
  if (/\s/.test(value)) return refused;
  try {
    const url = new URL(value);
    const valid = url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
    return valid ? { ok: true, url: url.toString() } : refused;
  } catch {
    return refused;
  }
};

/** A KEEPER_READ_RPC_URLS endpoint and its 1-based position in the variable as written. */
export interface ReadRpcUrl {
  url: string;
  entry: number;
}

type ReadRpcUrlsParse = { ok: true; urls: readonly ReadRpcUrl[] } | { ok: false; reason: string };

/**
 * KEEPER_READ_RPC_URLS, comma separated. A malformed entry is named by its position only:
 * the value carries a provider key, so it is never echoed. Blanks, repeats and KEEPER_RPC_URL
 * are dropped, and each URL kept carries its position as written, so a later message names
 * the entry the operator sees in the variable.
 */
const parseReadRpcUrls = (raw: string | undefined, sendUrl: string): ReadRpcUrlsParse => {
  const entries = (raw ?? '').split(',').map((entry) => entry.trim());
  const urls: ReadRpcUrl[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry === '') continue;
    if (!isHttpUrl(entry)) {
      return {
        ok: false,
        reason: `KEEPER_READ_RPC_URLS entry ${index + 1} is not an http or https URL; the value has not been logged.`,
      };
    }
    if (entry !== sendUrl && !urls.some((kept) => kept.url === entry)) {
      urls.push({ url: entry, entry: index + 1 });
    }
  }
  return { ok: true, urls };
};

const isPrivateKey = (value: string): value is `0x${string}` =>
  PRIVATE_KEY_PATTERN.test(value);

type PrivateKeyParse =
  | { valid: true; key: `0x${string}` | undefined }
  | { valid: false };

const parsePrivateKey = (raw: string | undefined): PrivateKeyParse => {
  const value = emptyToUndefined(raw);
  if (value === undefined) {
    return { valid: true, key: undefined };
  }
  return isPrivateKey(value) ? { valid: true, key: value } : { valid: false };
};

/**
 * Pure parser so tests can pass explicit environment objects without touching
 * process.env. Returns a reason string instead of logging so the caller
 * decides how loudly to report a keeper that cannot start.
 */
export const parseKeeperConfig = (
  env: Record<string, string | undefined>
): KeeperConfigResult => {
  const retired = RETIRED_KEEPER_ENV.filter((name) => emptyToUndefined(env[name]) !== undefined);
  if (retired.length > 0) {
    return {
      ok: false,
      reason: `${retired.join(', ')} is retired: the oracle needs no observation from the keeper, so remove it from the keeper environment.`,
    };
  }
  const candidate = {
    KEEPER_RPC_URL: emptyToUndefined(env['KEEPER_RPC_URL']),
    KEEPER_CHAIN_ID: emptyToUndefined(env['KEEPER_CHAIN_ID']),
    KEEPER_INTERVAL_SECONDS: emptyToUndefined(env['KEEPER_INTERVAL_SECONDS']),
    KEEPER_MAX_FEE_GWEI: emptyToUndefined(env['KEEPER_MAX_FEE_GWEI']),
    KEEPER_MAX_PRIORITY_FEE_GWEI: emptyToUndefined(env['KEEPER_MAX_PRIORITY_FEE_GWEI']),
    GOLD_VAULT_ADDRESS: emptyToUndefined(env['GOLD_VAULT_ADDRESS']),
    GOLD_ORACLE_ADDRESS: emptyToUndefined(env['GOLD_ORACLE_ADDRESS']),
    STABILITY_MODULE_ADDRESS: emptyToUndefined(env['STABILITY_MODULE_ADDRESS']),
    GSUSD_ADDRESS: emptyToUndefined(env['GSUSD_ADDRESS']),
    STABILITY_POOL_ADDRESS: emptyToUndefined(env['STABILITY_POOL_ADDRESS']),
    PAXG_TOKEN: emptyToUndefined(env['PAXG_TOKEN']),
    XAUT_TOKEN: emptyToUndefined(env['XAUT_TOKEN']),
    VAULT_REGISTRY_ADDRESS: emptyToUndefined(env['VAULT_REGISTRY_ADDRESS']),
    PRICE_WATCHDOG_ALERT_BPS: emptyToUndefined(env['PRICE_WATCHDOG_ALERT_BPS']),
    KEEPER_STUCK_TX_REPLACE_SECONDS: emptyToUndefined(env['KEEPER_STUCK_TX_REPLACE_SECONDS']),
    KEEPER_READ_CACHE_MS: emptyToUndefined(env['KEEPER_READ_CACHE_MS']),
    KEEPER_FEED_HEARTBEAT_SECONDS: emptyToUndefined(env['KEEPER_FEED_HEARTBEAT_SECONDS']),
    KEEPER_FEED_LATE_MARGIN_SECONDS: emptyToUndefined(env['KEEPER_FEED_LATE_MARGIN_SECONDS']),
    KEEPER_FEED_LATE_REPEAT_SECONDS: emptyToUndefined(env['KEEPER_FEED_LATE_REPEAT_SECONDS']),
  };

  const parsed = keeperEnvSchema.safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason: `Invalid keeper environment: ${detail}` };
  }

  const data = parsed.data;
  if (
    data.KEEPER_RPC_URL === undefined ||
    data.GOLD_VAULT_ADDRESS === undefined ||
    data.GOLD_ORACLE_ADDRESS === undefined ||
    data.STABILITY_MODULE_ADDRESS === undefined ||
    data.GSUSD_ADDRESS === undefined ||
    data.STABILITY_POOL_ADDRESS === undefined ||
    data.PAXG_TOKEN === undefined
  ) {
    return {
      ok: false,
      reason:
        'Keeper environment incomplete: KEEPER_RPC_URL, GOLD_VAULT_ADDRESS, GOLD_ORACLE_ADDRESS, STABILITY_MODULE_ADDRESS, GSUSD_ADDRESS, STABILITY_POOL_ADDRESS and PAXG_TOKEN are all required.',
    };
  }

  // The regex above guarantees getAddress cannot throw here; it only
  // normalises each address to its checksummed form.
  const goldVaultAddress = getAddress(data.GOLD_VAULT_ADDRESS);
  const goldOracleAddress = getAddress(data.GOLD_ORACLE_ADDRESS);
  const stabilityModuleAddress = getAddress(data.STABILITY_MODULE_ADDRESS);
  const gsusdAddress = getAddress(data.GSUSD_ADDRESS);
  const stabilityPoolAddress = getAddress(data.STABILITY_POOL_ADDRESS);
  const paxgToken = getAddress(data.PAXG_TOKEN);

  const requiredAddresses: ReadonlyArray<readonly [string, Address]> = [
    ['GOLD_VAULT_ADDRESS', goldVaultAddress],
    ['GOLD_ORACLE_ADDRESS', goldOracleAddress],
    ['STABILITY_MODULE_ADDRESS', stabilityModuleAddress],
    ['GSUSD_ADDRESS', gsusdAddress],
    ['STABILITY_POOL_ADDRESS', stabilityPoolAddress],
    ['PAXG_TOKEN', paxgToken],
  ];
  const zeroed = requiredAddresses.find(
    ([, address]) => address === zeroAddress
  );
  if (zeroed !== undefined) {
    return {
      ok: false,
      reason: `${zeroed[0]} is the zero address; no contract deployed.`,
    };
  }

  // XAUT at the zero address (or unset) is valid: PAXG-only launch.
  const xautChecksummed =
    data.XAUT_TOKEN === undefined ? undefined : getAddress(data.XAUT_TOKEN);
  const xautToken =
    xautChecksummed === undefined || xautChecksummed === zeroAddress
      ? undefined
      : xautChecksummed;

  // The registry is optional for the same reason: an older deployment has none.
  const registryChecksummed =
    data.VAULT_REGISTRY_ADDRESS === undefined
      ? undefined
      : getAddress(data.VAULT_REGISTRY_ADDRESS);
  const vaultRegistryAddress =
    registryChecksummed === undefined || registryChecksummed === zeroAddress
      ? undefined
      : registryChecksummed;

  const redisConfigured =
    emptyToUndefined(env['REDIS_URL']) !== undefined ||
    emptyToUndefined(env['REDIS_HOST']) !== undefined;
  if (!redisConfigured && vaultRegistryAddress === undefined) {
    return {
      ok: false,
      reason:
        'No vault owner source: set VAULT_REGISTRY_ADDRESS to read owners from the chain, or REDIS_URL (or REDIS_HOST) to read the indexer set; without either the keeper has nothing to watch.',
    };
  }

  const offChainRaw = emptyToUndefined(env['KEEPER_OFFCHAIN_PRICES'])?.trim().toLowerCase();
  if (offChainRaw !== undefined && !(OFF_CHAIN_PRICE_SOURCES as readonly string[]).includes(offChainRaw)) {
    return { ok: false, reason: 'KEEPER_OFFCHAIN_PRICES must be redis, http or none.' };
  }
  if (offChainRaw === 'redis' && !redisConfigured) {
    return {
      ok: false,
      reason: 'KEEPER_OFFCHAIN_PRICES=redis reads the API cache, so it needs REDIS_URL or REDIS_HOST; leave it unset for the keeper to fetch the price itself.',
    };
  }
  const offChainPriceSource: KeeperConfig['offChainPriceSource'] =
    offChainRaw === undefined ? (redisConfigured ? 'redis' : 'http') : (offChainRaw as KeeperConfig['offChainPriceSource']);
  const priceApiUrl = emptyToUndefined(env['KEEPER_PRICE_API_URL'])?.trim() ?? DEFAULT_PRICE_API_URL;
  if (!HTTP_URL_PATTERN.test(priceApiUrl)) {
    return { ok: false, reason: 'KEEPER_PRICE_API_URL must be an http or https URL.' };
  }

  const readRpcUrls = parseReadRpcUrls(env['KEEPER_READ_RPC_URLS'], data.KEEPER_RPC_URL);
  if (!readRpcUrls.ok) {
    return { ok: false, reason: readRpcUrls.reason };
  }

  const heartbeatUrl = parseHeartbeatUrl(env['KEEPER_HEARTBEAT_URL']);
  if (!heartbeatUrl.ok) {
    return { ok: false, reason: heartbeatUrl.reason };
  }

  const intervalSeconds = data.KEEPER_INTERVAL_SECONDS ?? DEFAULT_KEEPER_INTERVAL_SECONDS;

  const maxFeePerGasWei = parseGwei(data.KEEPER_MAX_FEE_GWEI ?? DEFAULT_MAX_FEE_GWEI);
  const maxPriorityFeePerGasWei = parseGwei(
    data.KEEPER_MAX_PRIORITY_FEE_GWEI ?? DEFAULT_MAX_PRIORITY_FEE_GWEI
  );
  if (maxFeePerGasWei === 0n || maxPriorityFeePerGasWei > maxFeePerGasWei) {
    return {
      ok: false,
      reason:
        'KEEPER_MAX_FEE_GWEI must be positive and at least KEEPER_MAX_PRIORITY_FEE_GWEI.',
    };
  }

  // Dry run defaults to TRUE: no transaction is ever sent unless the operator
  // explicitly sets the trimmed, lowercased value to "false".
  const dryRunRaw = emptyToUndefined(env['KEEPER_DRY_RUN']);
  const dryRun =
    dryRunRaw === undefined ? true : dryRunRaw.trim().toLowerCase() !== 'false';

  const enableDirectRaw = emptyToUndefined(env['KEEPER_ENABLE_DIRECT']);
  const enableDirect =
    enableDirectRaw !== undefined &&
    enableDirectRaw.trim().toLowerCase() === 'true';

  const privateKeyParse = parsePrivateKey(env['KEEPER_PRIVATE_KEY']);
  if (!privateKeyParse.valid) {
    // Deliberately never echoes the supplied value.
    return {
      ok: false,
      reason:
        'KEEPER_PRIVATE_KEY is malformed: expected a 0x-prefixed 64 character hex string. The supplied value has not been logged.',
    };
  }
  if (!dryRun && privateKeyParse.key === undefined) {
    return {
      ok: false,
      reason:
        'KEEPER_DRY_RUN is "false" but KEEPER_PRIVATE_KEY is not set; a live keeper must be able to sign transactions.',
    };
  }

  return {
    ok: true,
    config: {
      chainId: data.KEEPER_CHAIN_ID ?? DEFAULT_KEEPER_CHAIN_ID,
      rpcUrl: data.KEEPER_RPC_URL,
      readRpcUrls: readRpcUrls.urls,
      dryRun,
      enableDirect,
      intervalSeconds,
      maxFeePerGasWei,
      maxPriorityFeePerGasWei,
      redisConfigured,
      privateKey: privateKeyParse.key,
      goldVaultAddress,
      goldOracleAddress,
      stabilityModuleAddress,
      gsusdAddress,
      stabilityPoolAddress,
      paxgToken,
      xautToken,
      vaultRegistryAddress,
      priceWatchdogAlertBps:
        data.PRICE_WATCHDOG_ALERT_BPS ?? DEFAULT_PRICE_WATCHDOG_ALERT_BPS,
      stuckTxReplaceSeconds:
        data.KEEPER_STUCK_TX_REPLACE_SECONDS ?? DEFAULT_STUCK_TX_REPLACE_SECONDS,
      readCacheMs: data.KEEPER_READ_CACHE_MS ?? DEFAULT_READ_CACHE_MS,
      offChainPriceSource,
      priceApiUrl,
      feedHeartbeatSeconds: data.KEEPER_FEED_HEARTBEAT_SECONDS ?? DEFAULT_FEED_HEARTBEAT_SECONDS,
      feedLateMarginSeconds: data.KEEPER_FEED_LATE_MARGIN_SECONDS ?? DEFAULT_FEED_LATE_MARGIN_SECONDS,
      feedLateRepeatSeconds: data.KEEPER_FEED_LATE_REPEAT_SECONDS ?? DEFAULT_FEED_LATE_REPEAT_SECONDS,
      ...(heartbeatUrl.url === undefined ? {} : { heartbeatUrl: heartbeatUrl.url }),
    },
  };
};
