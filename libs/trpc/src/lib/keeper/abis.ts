import { parseAbi } from 'viem';

// Keeper-local minimal ABIs. The shared ABIs in @goldstandard/constants lack some keeper
// surfaces (accrueInterest, the oracle's quote views), and importing
// @goldstandard/constants drags import.meta into a node bundle (see the workaround
// comment in apps/api/tsconfig.app.json), so the keeper defines exactly the
// surfaces it needs. Every signature below was diffed against
// contracts/src/core/GoldVault.sol, GoldOracle.sol, StabilityModule.sol and
// StabilityPool.sol; the Sepolia dry-run soak is the integration test that
// proves the surfaces match before any real transaction is enabled.

export const goldVaultKeeperAbi = parseAbi([
  'function liquidate(address vaultOwner, uint256 debtToRepay)',
  'function liquidateViaPool(address vaultOwner, uint256 debtToRepay)',
  // Callable only while the vault or the oracle is paused, when the two above revert.
  // Prices at the higher of getLastKnownPrice and the validated live feed.
  'function emergencyLiquidate(address vaultOwner, uint256 debtToRepay)',
  // An underwater full liquidation repays the gold's value less this discount.
  'function underwaterDiscountPpm() view returns (uint256)',
  'function getVaultCurrentDebt(address user) view returns (uint256)',
  // Governed since 2026-10-22; the keeper reads it rather than assuming the deploy default.
  'function minDebt() view returns (uint256)',
  'function getCollateralisationRatio(address user) view returns (uint256)',
  // Oracle-FREE threshold: the gold price at which a vault becomes liquidatable,
  // derived from getCurrentDebt and the collateral type's liquidationRatio. Compared
  // against oracle.quoteTokenPrice this is an exact LIVE liquidatability test,
  // whereas getCollateralisationRatio prices off the stale lastKnownPrice.
  'function getLiquidationPrice(address user) view returns (uint256)',
  'function vaults(address) view returns (address collateralToken, uint256 collateralAmount, uint256 debtAmount)',
  // Tuple copied from libs/constants/src/lib/abis/GoldVault.ts so
  // liquidationRatio decodes at index 2.
  'function collateralTypes(bytes32) view returns (address token, uint256 minRatio, uint256 liquidationRatio, uint256 liquidationPenalty, uint256 debtCeiling, uint256 totalDebt, bool active)',
  'function stabilityPool() view returns (address)',
  'function stablecoin() view returns (address)',
  'function paused() view returns (bool)',
]);

export const goldOracleKeeperAbi = parseAbi([
  // The guardian's or governance's manual per-token stop (freezeToken); nobody else can
  // freeze, and the keeper never tries. A frozen token's normal reads revert, and so does
  // getEmergencyPrice, during a pause as well. True until
  // frozenUntil(token).
  'function tokenFrozen(address token) view returns (bool)',
  // Exactly what GoldVault.emergencyLiquidate (and liquidateViaPool while the vault is
  // paused) prices at: "Token frozen" for a frozen token in every case, a pause included;
  // otherwise "Not in emergency" outside a vault or oracle
  // pause and, in a pause, the liquidation rule, or "No price" whenever C or G is
  // unhealthy. lastKnownPrice never prices a seizure.
  'function getEmergencyPrice(address token, bool vaultPaused) view returns (uint256)',
  // STATE-CHANGING and permissionless: records the liquidation price as lastKnownPrice,
  // which the vault's views, the registry's hints and the dapp read. The price-freshness
  // job pokes it so those views stay close to the market. Nothing in the oracle needs it.
  'function getTokenPrice(address token) returns (uint256)',
  // STATE-CHANGING too: the borrow price. Listed for parity; the keeper reads its view twin.
  'function getBorrowPrice(address token) returns (uint256)',
  // The views every keeper decision reads: the same rules and revert reasons as the
  // state-changing reads, nothing written (docs/ORACLE_IMPLEMENTATION_PLAN.md section 3).
  //   quoteTokenPrice, liquidation trigger and settlement: min(max(C, G), G x (1 + m))
  //     with C and G healthy, else "No reliable price"; never refused for being off band.
  //   quoteBorrowPrice: min(C, G) with C inside the gold band, else "Off gold band".
  //   quoteReservePrice: max(C, G) with C inside the gold band, else "Off gold band".
  // Also "Token frozen", "Unsupported token" and EnforcedPause.
  'function quoteTokenPrice(address token) view returns (uint256)',
  'function quoteBorrowPrice(address token) view returns (uint256)',
  'function quoteReservePrice(address token) view returns (uint256)',
  // Reserve coverage: min(C, G) with both healthy, 0 otherwise. Works paused and frozen.
  'function quoteValuationPrice(address token) view returns (uint256)',
  // The two sources: C is feeds(token).feed and G is anchorFeed() (the zero address counts
  // every price as inside the gold band and prices liquidation at C, local only).
  'function feeds(address token) view returns (address feed, uint256 lastKnownPrice, bool supported)',
  'function anchorFeed() view returns (address)',
  // Per-token widths in parts per million of G: g gates borrowing and reserve swaps, m
  // caps the liquidation price at G x (1 + m). Both change only through the timelock.
  'function goldBandPpm(address token) view returns (uint256)',
  'function liquidationClampPpm(address token) view returns (uint256)',
  // Maximum age of C and G alike; an older round is an unhealthy source.
  'function stalenessThreshold() view returns (uint256)',
  // When a manual freeze lapses (14 days after freezeToken unless the guardian extends it).
  'function frozenUntil(address token) view returns (uint256)',
  'function getValidatedPrice(address token) view returns (uint256 price, bool ok)',
  'function getLastKnownPrice(address token) view returns (uint256)',
  'function paused() view returns (bool)',
  // OpenZeppelin 5 Pausable: whenNotPaused reads revert with this while the oracle is
  // paused. Listed so viem decodes it by name in a revert reason.
  'error EnforcedPause()',
]);

// Chainlink AggregatorV3 shape, which C and G both answer.
export const aggregatorKeeperAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

export const stabilityModuleKeeperAbi = parseAbi([
  'function accrueInterest(bytes32 collateralId)',
]);

export const stabilityPoolKeeperAbi = parseAbi([
  'function totalDeposits() view returns (uint256)',
]);

export const erc20KeeperAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  // The vault normalises collateral to 18 decimals with this; the keeper must too.
  'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

// Diffed against contracts/src/core/VaultRegistry.sol: the owner walk needs only
// the count and one bounded page at a time.
export const vaultRegistryKeeperAbi = parseAbi([
  'function vaultOwnerCount() view returns (uint256)',
  'function vaultOwners(uint256 offset, uint256 limit) view returns (address[])',
]);
