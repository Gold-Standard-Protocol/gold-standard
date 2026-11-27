// Public surface of the keeper library, consumed ONLY by apps/keeper via the
// "@goldstandard/trpc/keeper" path alias in tsconfig.base.json.
//
// HARD RULES:
// - Nothing here may import ../../index.ts, ../bullmq or ../routers. The
//   package entry of @goldstandard/trpc starts the price worker and opens an
//   IORedis connection at module load, and the api bundle must never contain
//   keeper code (KEEPER_PRIVATE_KEY isolation; verified pre-merge with
//   `grep -c KEEPER_PRIVATE_KEY dist/apps/api/main.js` returning 0).
// - Relative imports from ../config and ../indexer are allowed (same
//   project) so the keeper reads the exact owner set the indexer writes, and
//   ../jobs/priceCacheKeys (constants only, no imports) so the price watchdog
//   reads the exact price entry the API writes. Never ../jobs/fetchPrices,
//   which pulls axios and @goldstandard/constants.
export {
  DEFAULT_KEEPER_CHAIN_ID,
  DEFAULT_KEEPER_INTERVAL_SECONDS,
  DEFAULT_MAX_FEE_GWEI,
  DEFAULT_MAX_PRIORITY_FEE_GWEI,
  DEFAULT_PRICE_WATCHDOG_ALERT_BPS,
  DEFAULT_STUCK_TX_REPLACE_SECONDS,
  MAX_KEEPER_INTERVAL_SECONDS,
  MAX_PRICE_WATCHDOG_ALERT_BPS,
  MAX_STUCK_TX_REPLACE_SECONDS,
  MIN_KEEPER_INTERVAL_SECONDS,
  MIN_STUCK_TX_REPLACE_SECONDS,
  parseKeeperConfig,
  RETIRED_KEEPER_ENV,
} from './config';
export { describeError, redactUrls } from './decode';
export type { KeeperConfig, KeeperConfigResult, ReadRpcUrl } from './config';
export { KEEPER_SHUTDOWN_GRACE_MS, startKeeper } from './scheduler';
export {
  createHeartbeatPinger,
  createTallyingLogger,
  HEAD_AHEAD_SECONDS,
  HEAD_STALE_SECONDS,
  HEARTBEAT_PING_TIMEOUT_MS,
} from './heartbeat';
export type { HeartbeatFetch, HeartbeatPinger, HeartbeatPingOptions, TallyingLogger, TickTally } from './heartbeat';
export type { KeeperHandle, KeeperJobs, KeeperSchedulerOptions } from './scheduler';
export { createLiquidationWatch, runLiquidationWatch } from './liquidationWatch';
export { LIQUIDATE_VIA_POOL_GAS_FLOOR } from './liquidationConstants';
export { runSignerBalanceWatch, SIGNER_BALANCE_WARN_LIQUIDATIONS } from './signerBalance';
export { DIRECT_LIQUIDATION_FUNCTIONS } from './directLiquidation';
export type { DirectLiquidationFunction } from './directLiquidation';
export { createOracleHealthWatch, runOracleHealthWatch } from './oracleHealthWatch';
export {
  bandEdges,
  bandPosition,
  explainLiquidation,
  gapFromGoldPpm,
  gapPpm,
  liquidationCap,
  quoteOraclePrice,
  readOracleSnapshot,
  snapshotFields,
} from './oracleReads';
export type {
  BandPosition,
  LiquidationExplanation,
  LiquidationRule,
  OracleSnapshot,
  PriceQuote,
  SourceRound,
} from './oracleReads';
export {
  POKE_THRESHOLD_DIVISOR,
  runPriceFreshness,
} from './priceFreshness';
export { createPriceWatchdog, gapBps, runPriceWatchdog } from './priceWatchdog';
export {
  createHttpOffChainPriceSource,
  HTTP_PRICE_MAX_AGE_MS,
  HTTP_PRICE_MIN_INTERVAL_MS,
  HTTP_PRICE_TIMEOUT_MS,
} from './httpOffChainPrices';
export type { HttpOffChainPriceOptions, PriceFetch } from './httpOffChainPrices';
export { DEFAULT_PRICE_API_URL } from './config';
export { classifyCallError } from './callErrors';
export { createTickReadCache, TICK_READ_CACHE_MAX_PREFETCH } from './tickReadCache';
export type { TickReadCache, TickReadCacheOptions, TickReadCacheStats } from './tickReadCache';
export { DEFAULT_READ_CACHE_MS, MAX_READ_CACHE_MS } from './config';
export type { CallFailure } from './callErrors';
export {
  createCachedOffChainPriceSource,
  OFF_CHAIN_PRICE_MAX_AGE_MS,
  parseUsdPrice,
  PRICE_API_IDS,
} from './offChainPrices';
export type { PriceCacheStore } from './offChainPrices';
export { createJsonLogger, KEEPER_EVENTS } from './alerts';
export type { KeeperEventName } from './alerts';
export { collateralIdForToken, configuredTokens, isActiveCollateral } from './collateral';
export {
  aggregatorKeeperAbi,
  erc20KeeperAbi,
  goldOracleKeeperAbi,
  goldVaultKeeperAbi,
  stabilityModuleKeeperAbi,
  stabilityPoolKeeperAbi,
  vaultRegistryKeeperAbi,
} from './abis';
export { createRedisVaultOwnerSource } from './ownerSource';
export type { OwnerSetStore } from './ownerSource';
export {
  combineVaultOwnerSources,
  createRegistryVaultOwnerSource,
  MAX_REGISTRY_OWNERS,
  REGISTRY_OWNER_PAGE,
} from './registryOwnerSource';
export type { OwnerSourceReading, ReportingVaultOwnerSource } from './registryOwnerSource';
export type {
  KeeperJobDeps,
  KeeperLogger,
  KeeperReadClient,
  KeeperTxResult,
  KeeperTxSender,
  VaultOwnerSource,
  KeeperBatchResult,
  KeeperContractCall,
  OffChainPriceRead,
  OffChainPriceSource,
} from './ports';
