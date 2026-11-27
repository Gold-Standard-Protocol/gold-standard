import { gaussian, mulberry32, type Rng } from './rng';
import {
	DEFAULT_UNDERWATER_DISCOUNT_PPM,
	PPM,
	WAD,
	collateralValueUsd,
	fromNumber18,
	mulDiv,
	normaliseDebtCeil,
	perSecondRate,
	spreadCurveRefusal,
	toNumber18,
	toPrice8,
	type SpreadCurve,
} from './mechanics';
import { poolPrice, buyGsusd, sellGsusd, gsusdToReachPrice, usdcToReachPrice } from './market';
import { identityHolds, ledgerBalances, checkInvariants } from './identity';
import { accrueDay, arbitrageursAct, borrowersMint, borrowersRepay, currentBelowSpread, holdersAct, liquidatorsAct, lpsAct, reserveCoveragePpm, startDay } from './agents';
import { computeMetrics, snapshot, type DayRecord, type Metrics } from './metrics';
import {
	debtAtRisk,
	looperDebtTarget,
	looperMetrics,
	loopersAct,
	resolveLooperConfig,
	seedLoopers,
	systemMetrics,
	type LooperMetrics,
	type SystemMetrics,
} from './loopers';
import type { Scenario } from './scenarios';
import type { Asset, Params, World } from './state';

const ASSETS: Asset[] = ['PAXG', 'XAUT'];

/**
 * Parameters under test. These are the knobs the model exists to size; the values
 * here are the starting point, not a recommendation. See docs/PEG_ARCHITECTURE.md §13.
 */
export const DEFAULT_PARAMS: Params = {
	minRatioPpm: 1_300_000n,
	liquidationRatioPpm: 1_100_000n,
	penaltyPpm: 50_000n,
	liquidatorSharePpm: 600_000n,
	underwaterDiscountPpm: DEFAULT_UNDERWATER_DISCOUNT_PPM,
	gsrPenaltySharePpm: 400_000n, // 40% of the protocol's cut → GSR
	stabilityFeeBps: 200n,
	borrowerSellPpm: 700_000n,
	mintDemandPpmPerDay: 3_000n, // 0.3% of supply per day at peg
	mintFloorPrice: 0.985,
	holderSellPpmPerDay: 5_000n, // 0.5%/day at peg
	holderPanicPerPct: 0.4,
	holderMaxSellPpmPerDay: 80_000n, // no more than 8% of holdings leaves in a day
	borrowerIdleUsdcPpm: 200_000n, // a fifth of sale proceeds stays idle
	// A market at equilibrium has matched flow: at peg, buyers absorb what sellers
	// bring. Without this the model had structural net selling and drained the reserve
	// $1.8m in a calm 120 days, which was an artefact.
	holderBuyPpmPerDay: 5_000n,
	// Speculative dip-buying is real but small: GHO sat 3% under peg for seven months
	// and SAI for five, so at a few percent below there is NOT a wall of buyers. A 1%
	// discount draws 15% more baseline buying, halving every five days it persists.
	// With 0.6 and a 10-day half-life the model absorbed a 20-day run with no reserve
	// at all, which history says is wrong; these are calibrated to the record.
	buyAttractionPerPct: 0.15,
	buyFearBelowPrice: 0.95,
	buyConvictionHalfLifeDays: 5,
	arbCostFraction: 0.002,
	repayCarryDays: 90,
	repayPropensityPpm: 150_000n,
	lpWithdrawBelowPrice: 0.985,
	lpWithdrawPpmPerDay: 100_000n,
	phase2: false,
};

/**
 * The curve every deployment sets (contracts/scripts/lib/deployCeremony.ts). The brief's
 * illustrative 0.30% top tier sat below MIN_SPREAD_PPM, so setSpreadCurve refuses it and
 * runs on it made arbitrage look cheaper than the reserve allows.
 */
export const DEFAULT_SPREAD_CURVE: SpreadCurve = {
	steps: [
		[150_000n, 5_000n], // ≥15% coverage → 0.50%, the MIN_SPREAD_PPM floor
		[100_000n, 5_000n], // ≥10% → 0.50%
		[50_000n, 7_500n], // ≥5% → 0.75%
		[20_000n, 12_500n], // ≥2% → 1.25%
	],
	restrictedSpreadPpm: 20_000n, // <2% → 2%
};

export interface RunOptions {
	params?: Partial<Params>;
	spreadCurve?: SpreadCurve;
	dailyCapPpm?: bigint;
	minReservePpmOfInitial?: bigint;
	issuanceCapFractionOfSupply?: number;
	haircutPpm?: bigint;
	aboveSpreadPpm?: bigint;
}

export interface RunResult {
	scenario: string;
	seed: number;
	series: DayRecord[];
	metrics: Metrics;
	/** Bad debt, buffer and coverage outcomes; not part of the committed grid's table. */
	system: SystemMetrics;
	/** Present only when the scenario has loopers. */
	loopers?: LooperMetrics;
}

const GOLD_START_USD = 4000;

/** Seed for the gold path's own stream when `scenario.independentGoldPath` is set. */
const GOLD_STREAM_SALT = 0x6a09e667;

export function buildWorld(scenario: Scenario, params: Params, opts: RunOptions, rng: Rng): World {
	const spreadCurve = opts.spreadCurve ?? DEFAULT_SPREAD_CURVE;
	const refusal = spreadCurveRefusal(spreadCurve);
	if (refusal) throw new Error(`GoldStabilityReserve.setSpreadCurve would refuse this curve: ${refusal}`);
	const gold8 = toPrice8(GOLD_START_USD);
	const world: World = {
		day: 0,
		daysBelowPeg: 0,
		vaults: [],
		nextVaultId: 1,
		accumulator: 10n ** 18n,
		perSecondRate: perSecondRate(params.stabilityFeeBps),
		supply18: 0n,
		oracle: {
			PAXG: { marketPrice8: gold8, oraclePrice8: gold8, impaired: false },
			XAUT: { marketPrice8: gold8, oraclePrice8: gold8, impaired: false },
		},
		gsr: {
			assets: {
				PAXG: { gold18: 0n, minReserve18: 0n, outflowToday18: 0n, paused: false },
				XAUT: { gold18: 0n, minReserve18: 0n, outflowToday18: 0n, paused: false },
			},
			gsusdInventory18: 0n,
			issued18: 0n,
			issuanceCap18: 0n,
			dailyCapPpm: opts.dailyCapPpm ?? 200_000n, // 20% of reserve per day
			aggregateOutflowToday18: 0n,
			aggregateDailyCap18: 0n,
			spreadCurve,
			smoothedSupply18: 0n,
			aboveSpreadPpm: opts.aboveSpreadPpm ?? 2_000n,
			haircutPpm: opts.haircutPpm ?? 5_000n,
			halted: false,
		},
		insurance: { gsusd18: 0n, gold18: { PAXG: 0n, XAUT: 0n }, totalFeesReceived18: 0n, totalBadDebtAbsorbed18: 0n },
		pool: { gsusd18: 0n, usdc18: 0n },
		ledgers: {
			holdersGsusd18: 0n,
			holdersUsdc18: 0n,
			arbProfitUsd: 0,
			goldInToGsr18: { PAXG: 0n, XAUT: 0n },
			goldOutOfGsr18: { PAXG: 0n, XAUT: 0n },
			spreadRevenue18: 0n,
			repaid18: 0n,
			liquidatedDebt18: 0n,
			minted18: 0n,
			identityViolations: 0,
			ledgerViolations: 0,
		},
		params: { ...params, phase2: scenario.phase2, proRataLiquidationFill: scenario.proRataLiquidationFill ?? params.proRataLiquidationFill },
	};

	// Seed borrowers so the supply target is met, at a spread of ratios, all retaining
	// their GSUSD; the market then decides who sells.
	const targetSupply = fromNumber18(scenario.supplyUsd);
	const vaultCount = Math.max(20, Math.min(400, Math.floor(scenario.supplyUsd / 250_000)));
	// Levered loopers take their share out of the base book so supply stays the same;
	// with no loopers this is the target supply exactly, as before.
	const looper = scenario.loopers ? resolveLooperConfig(scenario.loopers, params.minRatioPpm) : undefined;
	const loopDebt = looper ? looperDebtTarget(looper, targetSupply) : 0n;
	const baseSupply = looper?.start === 'levered' ? targetSupply - loopDebt : targetSupply;
	const perVault = baseSupply / BigInt(vaultCount);
	for (let i = 0; i < vaultCount; i++) {
		const asset: Asset = rng() < scenario.xautShare ? 'XAUT' : 'PAXG';
		const ratioPpm = params.minRatioPpm + BigInt(Math.floor(rng() * 1_500_000)); // 130%..280%
		const collateral = mulDiv(mulDiv(perVault, ratioPpm, PPM), 100_000_000n, gold8);
		world.vaults.push({
			id: world.nextVaultId++,
			asset,
			collateral18: collateral,
			principal18: perVault,
			normalised18: normaliseDebtCeil(perVault, world.accumulator),
			heldGsusd18: perVault,
			idleUsdc18: 0n,
		});
		world.supply18 += perVault;
	}

	// Most of that minted GSUSD is in circulation: move the sell share to holders
	// (they bought it from borrowers off-model) and seed the pool from the rest.
	// Sum the per-vault shares rather than flooring once on the total: the two differ
	// by up to one wei per vault, and the ledger check is exact.
	let sold = 0n;
	for (const v of world.vaults) {
		const share = mulDiv(v.heldGsusd18, params.borrowerSellPpm, PPM);
		v.heldGsusd18 -= share;
		v.idleUsdc18 = mulDiv(share, params.borrowerIdleUsdcPpm, PPM); // sold at $1.00
		sold += share;
	}
	const poolGsusd = fromNumber18(scenario.dexDepthUsd);
	world.pool.gsusd18 = poolGsusd < sold ? poolGsusd : sold;
	world.pool.usdc18 = world.pool.gsusd18; // at $1.00
	world.ledgers.holdersGsusd18 = sold - world.pool.gsusd18;
	world.ledgers.holdersUsdc18 = 0n;
	if (looper) seedLoopers(world, looper, loopDebt, targetSupply / BigInt(vaultCount), gold8);

	// The GSR: redeemable gold worth `coverage` of supply, split PAXG/XAUT like the vaults.
	const reserveUsd = scenario.supplyUsd * scenario.gsrCoverage;
	const minReservePpm = opts.minReservePpmOfInitial ?? 100_000n; // 10% of initial never leaves
	for (const a of ASSETS) {
		const shareUsd = reserveUsd * (a === 'XAUT' ? scenario.xautShare : 1 - scenario.xautShare);
		const gold = mulDiv(fromNumber18(shareUsd), 100_000_000n, gold8);
		const g = world.gsr.assets[a];
		// Hold the floor on top of the redeemable amount so "coverage" means redeemable.
		g.minReserve18 = mulDiv(gold, minReservePpm, PPM);
		g.gold18 = gold + g.minReserve18;
	}
	world.gsr.aggregateDailyCap18 = fromNumber18(reserveUsd * 0.5); // 50% of reserve value per day
	// Phase 2 is inventory recycling only; the reserve never mints, so the cap stays 0.
	void opts.issuanceCapFractionOfSupply;
	return world;
}

function applyGoldPath(world: World, scenario: Scenario, rng: Rng, history: bigint[]): void {
	// One shared gold price; both tokens track it (basis between them is out of scope).
	const shock = scenario.goldShocks.find((s) => s.day === world.day);
	const drift = Math.exp(gaussian(rng) * scenario.goldDailyVol + (shock?.pct ? Math.log(1 + shock.pct) : 0));
	const prev = world.oracle.PAXG.marketPrice8;
	const next = BigInt(Math.max(1, Math.round(Number(prev) * drift)));
	history.push(next);
	const lagged = scenario.oracleLagDays > 0 && history.length > scenario.oracleLagDays ? history[history.length - 1 - scenario.oracleLagDays] : next;
	for (const a of ASSETS) {
		world.oracle[a].marketPrice8 = next;
		world.oracle[a].oraclePrice8 = lagged;
		const imp = scenario.impairment;
		world.oracle[a].impaired = Boolean(imp && imp.asset === a && world.day >= imp.from && world.day <= imp.to);
	}
}

function applyDemandShock(world: World, scenario: Scenario): void {
	const shock = scenario.demandShocks.find((s) => s.day === world.day);
	if (!shock) return;
	const price = poolPrice(world.pool);
	if (shock.targetPrice < price) {
		// Sellers push down to the target and stop, bounded by what holders hold.
		const want = gsusdToReachPrice(world.pool, shock.targetPrice);
		const amt = want < world.ledgers.holdersGsusd18 ? want : world.ledgers.holdersGsusd18;
		if (amt <= 0n) return;
		world.ledgers.holdersGsusd18 -= amt;
		world.ledgers.holdersUsdc18 += sellGsusd(world.pool, amt);
	} else if (shock.targetPrice > price) {
		// Buyers push up to the target; external USDC, so not bounded by holdersUsdc.
		const usdc = usdcToReachPrice(world.pool, shock.targetPrice);
		if (usdc <= 0n) return;
		world.ledgers.holdersGsusd18 += buyGsusd(world.pool, usdc);
	}
}

export function simulate(scenario: Scenario, seed = 1, opts: RunOptions = {}): RunResult {
	const rng = mulberry32(seed);
	const params: Params = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
	const world = buildWorld(scenario, params, opts, rng);
	const series: DayRecord[] = [];
	const goldHistory: bigint[] = [world.oracle.PAXG.marketPrice8];
	const goldRng = scenario.independentGoldPath ? mulberry32(seed + GOLD_STREAM_SALT) : rng;
	let goldSum = 0;
	// Read-only: the most debt sitting below the liquidation ratio at any close.
	let peakDebtBelowLiquidation18 = 0n;

	for (let day = 1; day <= scenario.days; day++) {
		world.day = day;
		startDay(world);
		accrueDay(world);
		applyGoldPath(world, scenario, goldRng, goldHistory);
		const samples: number[] = [poolPrice(world.pool)];
		applyDemandShock(world, scenario);
		samples.push(poolPrice(world.pool));

		liquidatorsAct(world);
		samples.push(poolPrice(world.pool));
		if (world.loopers) {
			loopersAct(world);
			samples.push(poolPrice(world.pool));
		}
		// Arbitrage is continuous, not once-a-day-after-the-damage. Interleave it with
		// holder flow in slices so the reserve bids while selling is happening, which is
		// how a guaranteed quote actually holds a floor. A single end-of-day arb pass
		// let a thin pool print lows the reserve would never have allowed.
		const SLICES = 6;
		for (let i = 0; i < SLICES; i++) {
			holdersAct(world, rng, 0n, 1 / SLICES);
			arbitrageursAct(world);
			samples.push(poolPrice(world.pool));
		}
		borrowersMint(world, rng, rng() < scenario.xautShare ? 'XAUT' : 'PAXG');
		borrowersRepay(world, rng);
		arbitrageursAct(world);
		lpsAct(world);

		checkInvariants(world);
		const atRisk = debtAtRisk(world).belowLiquidation18;
		if (atRisk > peakDebtBelowLiquidation18) peakDebtBelowLiquidation18 = atRisk;

		const price = poolPrice(world.pool);
		samples.push(price);
		const low = Math.min(...samples);
		const high = Math.max(...samples);
		world.daysBelowPeg = price < 0.99 ? world.daysBelowPeg + 1 : price >= 0.995 ? 0 : world.daysBelowPeg;
		const goldPrice = Number(world.oracle.PAXG.marketPrice8) / 1e8;
		goldSum += goldPrice;
		let gsrGoldUsd = 0;
		let gsrRedeemableUsd = 0;
		for (const a of ASSETS) {
			const g = world.gsr.assets[a];
			gsrGoldUsd += toNumber18(collateralValueUsd(g.gold18, world.oracle[a].oraclePrice8));
			const red = g.gold18 > g.minReserve18 ? g.gold18 - g.minReserve18 : 0n;
			gsrRedeemableUsd += toNumber18(collateralValueUsd(red, world.oracle[a].oraclePrice8));
		}
		// The reserve's own reads: coveragePpm() and currentSpreadPpm().
		const cov = reserveCoveragePpm(world);
		series.push(
			snapshot(world, {
				gsrGoldUsd,
				gsrRedeemableUsd,
				coverage: Number(cov) / 1e6,
				spreadPpm: Number(currentBelowSpread(world)),
				price,
				low,
				high,
				goldPrice,
				identityOk: identityHolds(world),
				ledgerOk: ledgerBalances(world),
			})
		);
	}

	return {
		scenario: scenario.name,
		seed,
		series,
		metrics: computeMetrics(series, world, goldSum / scenario.days),
		system: systemMetrics(series, world, peakDebtBelowLiquidation18),
		loopers: looperMetrics(world, goldSum / scenario.days),
	};
}

export function runGrid(scenarios: Scenario[], seeds: number[] = [1, 2, 3], opts: RunOptions = {}): RunResult[] {
	const out: RunResult[] = [];
	for (const s of scenarios) for (const seed of seeds) out.push(simulate(s, seed, opts));
	return out;
}

export { currentBelowSpread, WAD };
