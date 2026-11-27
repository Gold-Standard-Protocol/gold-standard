import { currentBelowSpread, gsrCapacity, repay, swapGsusdForGold } from './agents';
import {
	MIN_DEBT,
	PPM,
	PRICE_DECIMALS,
	collateralRatio,
	collateralValueUsd,
	currentDebt,
	mulDiv,
	normaliseDebtCeil,
	toNumber18,
} from './mechanics';
import { gsusdToReachPrice, poolPrice, sellGsusd } from './market';
import type { DayRecord } from './metrics';
import { totalPrincipal, type Pool, type Vault, type World } from './state';

/**
 * Leverage loopers.
 *
 * A looper deposits PAXG, mints GSUSD up to a target ratio, sells the GSUSD for PAXG
 * and deposits that, round after round (GoldVault.sol:409-443 checks each mint against
 * collateral already deposited). The swap leg uses the venues the model has: the
 * reserve's below-peg leg (PAXG at the oracle price plus the spread) and the
 * GSUSD/USDC pool followed by an off-model PAXG purchase at a fixed cost. A looper
 * routes each round to whichever venue gives more PAXG at the margin, and never
 * mints GSUSD it cannot swap within its cost limit; GSUSD minted for a venue that then
 * refuses it is repaid.
 *
 * A looper never sells into a pool that pays more than par for GSUSD: one GSUSD there
 * would buy more than a dollar of PAXG. The base model's repay buy-backs print such
 * highs (up to six figures per GSUSD in loop-30pct-buildup) because nothing mints into
 * them, and a looper selling into them booked a windfall the protocol does not offer.
 *
 * Behaviour is deliberately simple: loopers top up when gold has lifted their ratio
 * above the target band and do nothing when it falls. They never repay, never add
 * collateral and never deleverage, so a fall ends in liquidation. A looper liquidated
 * in full walks away with whatever collateral is left; it does not re-lever it.
 */

const BPS = 10_000n;
/** Swap cost assumed when sizing an unlevered looper's equity: the reserve's 0.5% tier. */
const SIZING_SWAP_COST_PPM = 5_000n;

export interface LooperConfig {
	/** Looped debt as a share of the scenario's initial supply. */
	shareOfSupply: number;
	/** Target collateral ratios, ppm, each at least the PAXG minimum; looped debt is split equally. */
	targetRatiosPpm: readonly bigint[];
	/**
	 * 'levered': the loops were built before day 0 and their GSUSD sits with holders,
	 * exactly as the base borrowers' sold share does. Supply stays at the scenario's
	 * size and the base book shrinks by the looped share.
	 * 'unlevered': loopers hold PAXG equity only and build the loop from day 1 through
	 * the modelled reserve and pool, on top of the full base book.
	 */
	start: 'levered' | 'unlevered';
	/** Top up only when the ratio is above target by more than this, ppm of the target. */
	topUpBandPpm: bigint;
	/** GoldVault.originationFeeBps (live: 5). */
	originationFeeBps: bigint;
	/** Cost of turning pool USDC into PAXG off-model, ppm (0.30%: a deep-market fee tier). */
	marketGoldCostPpm: bigint;
	/** Worst marginal execution a looper accepts, ppm below the oracle value of the PAXG received. */
	maxExecutionCostPpm: bigint;
	/** Mint, swap and deposit rounds per vault per day. A flash-swap contract does them all at once. */
	maxRoundsPerDay: number;
	/** A round smaller than this share of the vault's debt is not worth the gas. */
	minRoundPpmOfDebt: bigint;
}

export type LooperSpec = Partial<LooperConfig> & { shareOfSupply: number };

export const DEFAULT_LOOPER: Omit<LooperConfig, 'shareOfSupply'> = {
	targetRatiosPpm: [1_300_000n, 1_400_000n, 1_500_000n],
	start: 'levered',
	topUpBandPpm: 50_000n,
	originationFeeBps: 5n,
	marketGoldCostPpm: 3_000n,
	// Matches the base borrowers' mint floor (DEFAULT_PARAMS.mintFloorPrice 0.985).
	maxExecutionCostPpm: 15_000n,
	maxRoundsPerDay: 10,
	minRoundPpmOfDebt: 5_000n,
};

/** Marker on a looper's vault. `borrowed` is set once the vault has carried debt. */
export interface LooperTag {
	targetRatioPpm: bigint;
	borrowed: boolean;
}

/** Looper flows, kept apart from the base ledgers so the committed grid's books are untouched. */
export interface LooperLedger {
	config: LooperConfig;
	vaults: number;
	equityStart18: bigint;
	debtStart18: bigint;
	startGoldPrice8: bigint;
	minted18: bigint;
	originationFees18: bigint;
	soldToReserve18: bigint;
	soldToMarket18: bigint;
	goldFromReserve18: bigint;
	goldFromMarket18: bigint;
	rounds: number;
	topUpDays: number;
	venueLimitedRounds: number;
	/** GSUSD minted for a venue that then refused it, repaid at once. */
	repaidUnsold18: bigint;
	liquidatedDebt18: bigint;
	badDebt18: bigint;
	liquidatedVaultIds: Set<number>;
}

export function resolveLooperConfig(spec: LooperSpec, minRatioPpm: bigint): LooperConfig {
	const config: LooperConfig = { ...DEFAULT_LOOPER, ...spec };
	if (!(config.shareOfSupply >= 0 && config.shareOfSupply < 1)) {
		throw new Error(`loopers: shareOfSupply must be in [0, 1), got ${config.shareOfSupply}`);
	}
	if (config.targetRatiosPpm.length === 0) throw new Error('loopers: at least one target ratio is required');
	for (const r of config.targetRatiosPpm) {
		if (r < minRatioPpm) throw new Error(`loopers: target ratio ${r} is below the minimum ${minRatioPpm}`);
	}
	if (config.originationFeeBps < 0n || config.originationFeeBps >= BPS) throw new Error('loopers: origination fee out of range');
	if (config.maxRoundsPerDay < 1) throw new Error('loopers: maxRoundsPerDay must be at least 1');
	return config;
}

/** Looped debt the scenario asks for, from its initial supply. */
export function looperDebtTarget(config: LooperConfig, targetSupply18: bigint): bigint {
	return mulDiv(targetSupply18, BigInt(Math.round(config.shareOfSupply * 1e6)), PPM);
}

/**
 * Opens the looper vaults. `sizeRef18` is the base book's vault size, so a looper vault
 * is no larger than an ordinary one and the liquidation model treats both alike.
 */
export function seedLoopers(world: World, config: LooperConfig, loopDebt18: bigint, sizeRef18: bigint, gold8: bigint): void {
	const tiers = config.targetRatiosPpm.length;
	const perTier = Math.max(1, Math.round(toNumber18(loopDebt18) / tiers / Math.max(1, toNumber18(sizeRef18))));
	const perVault = loopDebt18 / BigInt(tiers) / BigInt(perTier);
	const keepPpm = mulDiv(PPM, BPS - config.originationFeeBps, BPS) - SIZING_SWAP_COST_PPM;
	const book: LooperLedger = {
		config,
		vaults: 0,
		equityStart18: 0n,
		debtStart18: 0n,
		startGoldPrice8: gold8,
		minted18: 0n,
		originationFees18: 0n,
		soldToReserve18: 0n,
		soldToMarket18: 0n,
		goldFromReserve18: 0n,
		goldFromMarket18: 0n,
		rounds: 0,
		topUpDays: 0,
		venueLimitedRounds: 0,
		repaidUnsold18: 0n,
		liquidatedDebt18: 0n,
		badDebt18: 0n,
		liquidatedVaultIds: new Set<number>(),
	};
	if (perVault === 0n) {
		world.loopers = book;
		return;
	}
	const levered = config.start === 'levered';
	for (const ratio of config.targetRatiosPpm) {
		for (let i = 0; i < perTier; i++) {
			// Levered: collateral at exactly the target. Unlevered: the equity that the
			// closed form E = D (r - k) says reaches this debt at the reserve's 0.5% tier.
			const usd = levered ? mulDiv(perVault, ratio, PPM) : mulDiv(perVault, ratio - keepPpm, PPM);
			const collateral = mulDiv(usd, PRICE_DECIMALS, gold8);
			const principal = levered ? perVault : 0n;
			world.vaults.push({
				id: world.nextVaultId++,
				asset: 'PAXG',
				collateral18: collateral,
				principal18: principal,
				normalised18: principal === 0n ? 0n : normaliseDebtCeil(principal, world.accumulator),
				heldGsusd18: 0n,
				idleUsdc18: 0n,
				looper: { targetRatioPpm: ratio, borrowed: levered },
			});
			world.supply18 += principal;
			// The loop's GSUSD was sold before day 0; whoever bought it now holds it.
			world.ledgers.holdersGsusd18 += principal;
			book.vaults += 1;
			book.debtStart18 += principal;
			book.equityStart18 += collateralValueUsd(collateral, gold8) - principal;
		}
	}
	world.loopers = book;
}

// ---------------------------------------------------------------------------
// Daily behaviour
// ---------------------------------------------------------------------------

interface SwapPlan {
	/** Sold into the pool first, while its marginal PAXG beats the reserve's. */
	marketFirst18: bigint;
	reserve18: bigint;
	/** Sold into the pool after the reserve, down to the looper's cost limit. */
	marketAfter18: bigint;
}

type RoundOutcome = 'none' | 'more' | 'last';

/**
 * The pool price at which PAXG bought through the pool costs `edgePpm` below its
 * oracle value: value per GSUSD = price × oracle / (market × (1 + cost)).
 */
function poolPriceAtEdge(world: World, edgePpm: bigint, costPpm: bigint): number {
	const o = world.oracle.PAXG;
	return (1 - Number(edgePpm) / 1e6) * (1 + Number(costPpm) / 1e6) * (Number(o.marketPrice8) / Number(o.oraclePrice8));
}

function minBig(a: bigint, b: bigint): bigint {
	return a < b ? a : b;
}

/** True while the pool pays at most par for GSUSD: a GSUSD sold buys at most a dollar of PAXG. */
function poolAtOrBelowPar(world: World, pool: Pool, config: LooperConfig): boolean {
	return poolPrice(pool) <= poolPriceAtEdge(world, 0n, config.marketGoldCostPpm);
}

/** GSUSD `pool` takes now before a looper's marginal PAXG falls below its cost limit; none above par. */
function marketCapacity(world: World, pool: Pool, config: LooperConfig): bigint {
	if (!poolAtOrBelowPar(world, pool, config)) return 0n;
	return gsusdToReachPrice(pool, poolPriceAtEdge(world, config.maxExecutionCostPpm, config.marketGoldCostPpm));
}

/** Splits `gsusd18` across the venues so the marginal PAXG per GSUSD is equal, within limits. */
function planSwap(world: World, gsusd18: bigint, config: LooperConfig): SwapPlan {
	const pool: Pool = { ...world.pool };
	const spread = currentBelowSpread(world);
	const reserveOpen = spread <= config.maxExecutionCostPpm;
	const marketOpen = poolAtOrBelowPar(world, pool, config);
	let left = gsusd18;
	let marketFirst = 0n;
	let reserve = 0n;
	if (reserveOpen) {
		if (marketOpen) marketFirst = minBig(left, gsusdToReachPrice(pool, poolPriceAtEdge(world, spread, config.marketGoldCostPpm)));
		sellGsusd(pool, marketFirst);
		left -= marketFirst;
		const capGold = gsrCapacity(world, 'PAXG');
		const capIn = mulDiv(mulDiv(capGold, world.oracle.PAXG.oraclePrice8, PRICE_DECIMALS), PPM, PPM - spread);
		reserve = minBig(left, capIn);
		left -= reserve;
	}
	const marketAfter = minBig(left, marketCapacity(world, pool, config));
	return { marketFirst18: marketFirst, reserve18: reserve, marketAfter18: marketAfter };
}

/** Sells GSUSD into the pool and buys PAXG off-model with the USDC. */
function buyGoldViaMarket(world: World, v: Vault, gsusd18: bigint, book: LooperLedger): bigint {
	const usdc = sellGsusd(world.pool, gsusd18);
	const gold = mulDiv(usdc, PRICE_DECIMALS * PPM, world.oracle.PAXG.marketPrice8 * (PPM + book.config.marketGoldCostPpm));
	v.heldGsusd18 -= gsusd18;
	book.soldToMarket18 += gsusd18;
	book.goldFromMarket18 += gold;
	return gold;
}

/** GoldVault.mint for a looper: debt rises by the full amount, the fee is banked in the buffer. */
function mintForLooper(world: World, v: Vault, amount18: bigint, fee18: bigint, book: LooperLedger): void {
	v.principal18 += amount18;
	v.normalised18 += normaliseDebtCeil(amount18, world.accumulator);
	v.heldGsusd18 += amount18 - fee18;
	world.supply18 += amount18;
	world.ledgers.minted18 += amount18;
	world.insurance.gsusd18 += fee18;
	world.insurance.totalFeesReceived18 += fee18;
	book.minted18 += amount18;
	book.originationFees18 += fee18;
	if (v.looper) v.looper.borrowed = true;
}

function loopRound(world: World, v: Vault, tag: LooperTag, book: LooperLedger): RoundOutcome {
	const config = book.config;
	const owed = currentDebt(v.normalised18, world.accumulator);
	// GoldVault.mint: value × PPM / (owed + amount) >= ratio, at the borrowing price.
	const ceiling = mulDiv(collateralValueUsd(v.collateral18, world.oracle.PAXG.oraclePrice8), PPM, tag.targetRatioPpm);
	if (ceiling <= owed) return 'none';
	const room = ceiling - owed;
	const minRoundByDebt = mulDiv(owed, config.minRoundPpmOfDebt, PPM);
	const minRound = minRoundByDebt > MIN_DEBT ? minRoundByDebt : MIN_DEBT;
	if (room < minRound) return 'none';

	const proceeds = room - mulDiv(room, config.originationFeeBps, BPS);
	const plan = planSwap(world, proceeds, config);
	const fillable = plan.marketFirst18 + plan.reserve18 + plan.marketAfter18;
	const limited = fillable < proceeds;
	const amount = limited ? minBig(room, mulDiv(fillable, BPS, BPS - config.originationFeeBps)) : room;
	if (amount < minRound || v.principal18 + amount < MIN_DEBT) {
		if (limited) book.venueLimitedRounds += 1;
		return 'none';
	}
	const fee = mulDiv(amount, config.originationFeeBps, BPS);
	const net = amount - fee;
	mintForLooper(world, v, amount, fee, book);

	const first = minBig(plan.marketFirst18, net);
	const viaReserve = minBig(plan.reserve18, net - first);
	const after = net - first - viaReserve;
	let gold = 0n;
	let unsold = 0n;
	// Every pool sale is held to the cost limit and to par, as the plan was; what the pool
	// will not take is repaid below.
	const sellToMarket = (amount18: bigint): void => {
		const sold = minBig(amount18, marketCapacity(world, world.pool, config));
		if (sold > 0n) gold += buyGoldViaMarket(world, v, sold, book);
		unsold += amount18 - sold;
	};
	if (first > 0n) sellToMarket(first);
	if (viaReserve > 0n) {
		const got = swapGsusdForGold(world, 'PAXG', viaReserve);
		if (got > 0n) {
			v.heldGsusd18 -= viaReserve;
			book.soldToReserve18 += viaReserve;
			book.goldFromReserve18 += got;
			gold += got;
		} else {
			// The plan sized this within capacity, so a refusal means the reserve changed
			// after the mint; the GSUSD is already minted, so it goes to the pool if the pool
			// takes it within the limits.
			sellToMarket(viaReserve);
		}
	}
	if (after > 0n) sellToMarket(after);
	// Minted but unsellable: repay it (GoldVault.repay; the origination fee stays paid).
	if (unsold > 0n) {
		const held = v.heldGsusd18;
		repay(world, v, unsold);
		book.repaidUnsold18 += held - v.heldGsusd18;
	}
	v.collateral18 += gold;
	book.rounds += 1;
	if (limited) book.venueLimitedRounds += 1;
	return limited ? 'last' : 'more';
}

/**
 * Once a day, after liquidations: each looper whose ratio sits above its target band
 * loops back down to the target, as many rounds as the venues and its cost limit allow.
 */
export function loopersAct(world: World): void {
	const book = world.loopers;
	if (!book || world.oracle.PAXG.impaired) return;
	const price8 = world.oracle.PAXG.oraclePrice8;
	let acted = false;
	for (const v of world.vaults) {
		const tag = v.looper;
		if (!tag || v.collateral18 === 0n) continue;
		if (tag.borrowed && v.principal18 === 0n) continue;
		const ratio = collateralRatio(v.collateral18, price8, currentDebt(v.normalised18, world.accumulator));
		if (ratio <= mulDiv(tag.targetRatioPpm, PPM + book.config.topUpBandPpm, PPM)) continue;
		for (let i = 0; i < book.config.maxRoundsPerDay; i++) {
			const outcome = loopRound(world, v, tag, book);
			if (outcome === 'none') break;
			acted = true;
			if (outcome === 'last') break;
		}
	}
	if (acted) book.topUpDays += 1;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Credit and buffer outcomes the committed Metrics do not carry. Computed for every run. */
export interface SystemMetrics {
	/** Bad debt the buffer burned (SurplusBuffer.absorbBadDebt). */
	badDebtAbsorbedUsd: number;
	/** Bad debt left unbacked: supply minus Σ principal at the end. */
	badDebtUnbackedUsd: number;
	insuranceEndUsd: number;
	feesReceivedUsd: number;
	gsrRedeemableEndUsd: number;
	minCoverage: number;
	maxSpreadPpm: number;
	/** The most fee-inclusive debt below the liquidation ratio at any close: the backlog liquidators had not cleared. */
	peakDebtBelowLiquidationUsd: number;
	/** At the final close: debt below the liquidation ratio, and the part with collateral worth less than the debt. */
	debtBelowLiquidationEndUsd: number;
	debtUnderwaterEndUsd: number;
}

export interface DebtAtRisk {
	belowLiquidation18: bigint;
	underwater18: bigint;
}

/** Fee-inclusive debt in vaults below the liquidation ratio, and below 100%, at the oracle price. */
export function debtAtRisk(world: World): DebtAtRisk {
	let belowLiquidation = 0n;
	let underwater = 0n;
	for (const v of world.vaults) {
		if (v.principal18 === 0n) continue;
		const owed = currentDebt(v.normalised18, world.accumulator);
		const ratio = collateralRatio(v.collateral18, world.oracle[v.asset].oraclePrice8, owed);
		if (ratio < world.params.liquidationRatioPpm) belowLiquidation += owed;
		if (ratio < PPM) underwater += owed;
	}
	return { belowLiquidation18: belowLiquidation, underwater18: underwater };
}

export function systemMetrics(series: DayRecord[], world: World, peakDebtBelowLiquidation18: bigint): SystemMetrics {
	const unbacked = world.supply18 - totalPrincipal(world);
	const last = series[series.length - 1];
	const risk = debtAtRisk(world);
	return {
		badDebtAbsorbedUsd: toNumber18(world.insurance.totalBadDebtAbsorbed18),
		badDebtUnbackedUsd: unbacked > 0n ? toNumber18(unbacked) : 0,
		insuranceEndUsd: toNumber18(world.insurance.gsusd18),
		feesReceivedUsd: toNumber18(world.insurance.totalFeesReceived18),
		gsrRedeemableEndUsd: last?.gsrRedeemableUsd ?? 0,
		minCoverage: Math.min(...series.map((d) => d.coverage)),
		maxSpreadPpm: Math.max(...series.map((d) => d.spreadPpm)),
		peakDebtBelowLiquidationUsd: toNumber18(peakDebtBelowLiquidation18),
		debtBelowLiquidationEndUsd: toNumber18(risk.belowLiquidation18),
		debtUnderwaterEndUsd: toNumber18(risk.underwater18),
	};
}

export interface LooperMetrics {
	vaults: number;
	vaultsLiquidated: number;
	debtStartUsd: number;
	debtEndUsd: number;
	/** Looped debt at the end as a share of supply at the end. */
	shareOfSupplyEnd: number;
	mintedUsd: number;
	originationFeesUsd: number;
	soldToReserveUsd: number;
	soldToMarketUsd: number;
	/** Reserve PAXG the loopers took, valued at the run's average gold price. */
	goldFromReserveUsd: number;
	goldFromMarketUsd: number;
	liquidatedDebtUsd: number;
	badDebtUsd: number;
	equityStartUsd: number;
	/** Σ max(0, collateral at market − debt) over looper vaults: what they could walk away with. */
	equityEndUsd: number;
	/** The same starting equity simply held as PAXG. */
	holdEquityEndUsd: number;
	topUpDays: number;
	rounds: number;
	venueLimitedRounds: number;
	/** GSUSD minted for a venue that then refused it, repaid at once. */
	repaidUnsoldUsd: number;
}

export function looperMetrics(world: World, goldPriceAvg: number): LooperMetrics | undefined {
	const book = world.loopers;
	if (!book) return undefined;
	const market8 = world.oracle.PAXG.marketPrice8;
	let debtEnd = 0n;
	let equityEnd = 0n;
	for (const v of world.vaults) {
		if (!v.looper) continue;
		const owed = currentDebt(v.normalised18, world.accumulator);
		const value = collateralValueUsd(v.collateral18, market8);
		debtEnd += owed;
		if (value > owed) equityEnd += value - owed;
	}
	const equityStart = toNumber18(book.equityStart18);
	return {
		vaults: book.vaults,
		vaultsLiquidated: book.liquidatedVaultIds.size,
		debtStartUsd: toNumber18(book.debtStart18),
		debtEndUsd: toNumber18(debtEnd),
		shareOfSupplyEnd: world.supply18 > 0n ? toNumber18(debtEnd) / toNumber18(world.supply18) : 0,
		mintedUsd: toNumber18(book.minted18),
		originationFeesUsd: toNumber18(book.originationFees18),
		soldToReserveUsd: toNumber18(book.soldToReserve18),
		soldToMarketUsd: toNumber18(book.soldToMarket18),
		goldFromReserveUsd: toNumber18(book.goldFromReserve18) * goldPriceAvg,
		goldFromMarketUsd: toNumber18(book.goldFromMarket18) * goldPriceAvg,
		liquidatedDebtUsd: toNumber18(book.liquidatedDebt18),
		badDebtUsd: toNumber18(book.badDebt18),
		equityStartUsd: equityStart,
		equityEndUsd: toNumber18(equityEnd),
		holdEquityEndUsd: equityStart * (Number(market8) / Number(book.startGoldPrice8)),
		topUpDays: book.topUpDays,
		rounds: book.rounds,
		venueLimitedRounds: book.venueLimitedRounds,
		repaidUnsoldUsd: toNumber18(book.repaidUnsold18),
	};
}
