import type { LooperLedger, LooperTag } from './loopers';
import type { SpreadCurve } from './mechanics';

export type Asset = 'PAXG' | 'XAUT';

export interface Vault {
	id: number;
	asset: Asset;
	collateral18: bigint;
	/** GoldVault.vault.debtAmount: principal, excluding accrued fees. */
	principal18: bigint;
	/** StabilityModule.normalisedDebt. currentDebt = normalised × accumulator / RAY. */
	normalised18: bigint;
	/** GSUSD the borrower kept rather than sold. Used to repay before buying. */
	heldGsusd18: bigint;
	/** USDC the borrower still has idle from selling GSUSD; bounds what they can buy back. */
	idleUsdc18: bigint;
	/** Set only on leverage loopers (loopers.ts); absent on every other vault. */
	looper?: LooperTag;
}

export interface AssetOracle {
	/** True market price of the asset, 8 decimals. */
	marketPrice8: bigint;
	/** What the on-chain oracle reports, 8 decimals. Lags the market by `lagDays`. */
	oraclePrice8: bigint;
	/** Oracle unavailable (impairment scenario): every price-dependent path pauses. */
	impaired: boolean;
}

export interface GsrAsset {
	gold18: bigint;
	minReserve18: bigint;
	outflowToday18: bigint;
	paused: boolean;
}

export interface GsrState {
	assets: Record<Asset, GsrAsset>;
	/** GSUSD received on the below-peg leg and held (not burned). */
	gsusdInventory18: bigint;
	/** Always zero: the reserve never mints (docs/PEG_ARCHITECTURE.md §4). Kept so a
	 *  future proposal to change that has a field to argue about. */
	issued18: bigint;
	issuanceCap18: bigint;
	/** Daily outflow cap per asset, as ppm of that asset's reserve at day start. */
	dailyCapPpm: bigint;
	aggregateOutflowToday18: bigint;
	aggregateDailyCap18: bigint;
	spreadCurve: SpreadCurve;
	/** GoldStablecoin.smoothedSupplyNow() at the model's one-day resolution: the supply as
	 *  the day opened, so a burn today buys no cheaper tier until tomorrow. On chain the
	 *  average drifts to the live supply over the day, so this damps a little longer than
	 *  the contract does, never shorter. */
	smoothedSupply18: bigint;
	/** Above-peg leg spread and haircut (Phase 2). */
	aboveSpreadPpm: bigint;
	haircutPpm: bigint;
	halted: boolean;
}

export interface InsuranceState {
	/** SurplusBuffer.gsusdBalance: fee revenue. Never swap proceeds. */
	gsusd18: bigint;
	gold18: Record<Asset, bigint>;
	totalFeesReceived18: bigint;
	totalBadDebtAbsorbed18: bigint;
}

/** A constant-product GSUSD/USDC pool. Price = usdc / gsusd. */
export interface Pool {
	gsusd18: bigint;
	usdc18: bigint;
}

export interface Ledgers {
	/** Aggregate GSUSD held by external (non-borrower) holders. */
	holdersGsusd18: bigint;
	/** Aggregate USDC held by external holders, available to buy GSUSD. */
	holdersUsdc18: bigint;
	arbProfitUsd: number;
	goldInToGsr18: Record<Asset, bigint>;
	goldOutOfGsr18: Record<Asset, bigint>;
	spreadRevenue18: bigint;
	repaid18: bigint;
	liquidatedDebt18: bigint;
	minted18: bigint;
	identityViolations: number;
	ledgerViolations: number;
}

export interface Params {
	minRatioPpm: bigint;
	liquidationRatioPpm: bigint;
	penaltyPpm: bigint;
	liquidatorSharePpm: bigint;
	/** GoldVault.underwaterDiscountPpm: what an underwater vault's gold sells below its value. */
	underwaterDiscountPpm: bigint;
	/** Share of the protocol's penalty cut routed to the GSR (rest to insurance). */
	gsrPenaltySharePpm: bigint;
	stabilityFeeBps: bigint;
	/** Fraction of freshly minted GSUSD a borrower sells immediately, ppm. */
	borrowerSellPpm: bigint;
	/** Daily base mint demand as a fraction of supply at $1, ppm. */
	mintDemandPpmPerDay: bigint;
	/** Below this pool price, new minting stops (the haircut is not worth it). */
	mintFloorPrice: number;
	/** Daily propensity of holders to sell at peg, ppm; rises as price falls. */
	holderSellPpmPerDay: bigint;
	/** How much holder selling intensifies per 1% below peg (multiplier). */
	holderPanicPerPct: number;
	/** Hard cap on the share of holdings sold in one day, however bad the price. */
	holderMaxSellPpmPerDay: bigint;
	/** Share of GSUSD-sale proceeds a borrower keeps idle (available to buy back). */
	borrowerIdleUsdcPpm: bigint;
	/** Daily external buy demand at peg, ppm of supply. Matches selling at equilibrium. */
	holderBuyPpmPerDay: bigint;
	/** How much buying intensifies per 1% below peg (a discount attracts buyers). */
	buyAttractionPerPct: number;
	/** Below this price the discount reads as distress and buy attraction collapses. */
	buyFearBelowPrice: number;
	/** Days over which dip-buying conviction halves while the discount persists. */
	buyConvictionHalfLifeDays: number;
	/** Arbitrageur round-trip cost (gas, slippage) as a fraction of notional. */
	arbCostFraction: number;
	/** Borrower repays when the discount exceeds this many days of carry. */
	repayCarryDays: number;
	/** Daily repay propensity once the discount test passes, ppm of principal. */
	repayPropensityPpm: bigint;
	/** Above this fraction of pool depth lost, LPs start withdrawing. */
	lpWithdrawBelowPrice: number;
	lpWithdrawPpmPerDay: bigint;
	phase2: boolean;
	/**
	 * When a liquidator can buy only part of the debt, seize collateral for the part
	 * actually repaid, as GoldVault does for a partial liquidation, and give up when the
	 * vault refuses the partial (underwater). Off by default so the committed grid keeps
	 * its original fill; the looper scenarios turn it on.
	 */
	proRataLiquidationFill?: boolean;
}

export interface World {
	day: number;
	/** Consecutive days the close has sat below 0.99. Buyer conviction decays with it. */
	daysBelowPeg: number;
	vaults: Vault[];
	nextVaultId: number;
	accumulator: bigint;
	perSecondRate: bigint;
	/** GoldStablecoin.totalSupply. */
	supply18: bigint;
	oracle: Record<Asset, AssetOracle>;
	gsr: GsrState;
	insurance: InsuranceState;
	pool: Pool;
	ledgers: Ledgers;
	params: Params;
	/** Leverage loopers' configuration and flows; present only in looper scenarios. */
	loopers?: LooperLedger;
}

/** Σ vault.principal across all vaults: the borrower-backed part of supply. */
export function totalPrincipal(world: World): bigint {
	return world.vaults.reduce((acc, v) => acc + v.principal18, 0n);
}

/** GSUSD retained by borrowers in aggregate. */
export function borrowersHeld(world: World): bigint {
	return world.vaults.reduce((acc, v) => acc + v.heldGsusd18, 0n);
}
