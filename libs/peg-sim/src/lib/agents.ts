import type { Rng } from './rng';
import {
	PPM,
	WAD,
	SECONDS_PER_DAY,
	accrueAccumulator,
	collateralRatio,
	collateralValueUsd,
	coveragePpm,
	currentDebt,
	dampedCirculatingSupply,
	fromNumber18,
	gsrGoldOut,
	gsrGsusdOut,
	gsrSpreadTaken,
	liquidationSeizure,
	mulDiv,
	normaliseDebtCeil,
	normaliseDebtFloor,
	swapSpreadPpm,
	toNumber18,
} from './mechanics';
import { buyGsusd, gsusdToReachPrice, poolPrice, sellGsusd, usdcToReachPrice, withdrawLiquidity } from './market';
import type { Asset, Vault, World } from './state';
import { totalPrincipal } from './state';

const ASSETS: Asset[] = ['PAXG', 'XAUT'];

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** One day of stability-fee accrual, exactly as StabilityModule compounds it. */
export function accrueDay(world: World): void {
	world.accumulator = accrueAccumulator(world.accumulator, world.perSecondRate, SECONDS_PER_DAY);
}

/** Reset daily GSR outflow counters and bank the opening supply as the smoothed supply. */
export function startDay(world: World): void {
	for (const a of ASSETS) world.gsr.assets[a].outflowToday18 = 0n;
	world.gsr.aggregateOutflowToday18 = 0n;
	world.gsr.smoothedSupply18 = world.supply18;
}

// ---------------------------------------------------------------------------
// Borrowers
// ---------------------------------------------------------------------------

function openVault(world: World, asset: Asset, collateral18: bigint, debt18: bigint): Vault {
	const v: Vault = {
		id: world.nextVaultId++,
		asset,
		collateral18,
		principal18: debt18,
		normalised18: normaliseDebtCeil(debt18, world.accumulator),
		heldGsusd18: debt18,
		idleUsdc18: 0n,
	};
	world.vaults.push(v);
	world.supply18 += debt18;
	world.ledgers.minted18 += debt18;
	return v;
}

/**
 * New borrowers arrive in proportion to demand, but only while minting is worth it:
 * a borrower who mints at $0.97 takes a 3% haircut on every dollar borrowed, so mint
 * demand collapses below `mintFloorPrice`. A share of what they mint is sold
 * immediately (the leverage user); the rest is retained.
 */
export function borrowersMint(world: World, rng: Rng, asset: Asset): void {
	const p = world.params;
	const price = poolPrice(world.pool);
	if (price < p.mintFloorPrice) return;
	if (world.oracle[asset].impaired) return;

	const base = mulDiv(world.supply18 > 0n ? world.supply18 : 1_000_000n * WAD, p.mintDemandPpmPerDay, PPM);
	const jitter = 0.5 + rng();
	const debt = fromNumber18(toNumber18(base) * jitter);
	if (debt < 100n * WAD) return;

	// Mint at a ratio drawn from a plausible distribution above the minimum.
	const ratioPpm = p.minRatioPpm + BigInt(Math.floor(rng() * 1_200_000)); // 130%..250%
	const priceUsd = world.oracle[asset].oraclePrice8;
	const collateral = mulDiv(mulDiv(debt, ratioPpm, PPM), 100_000_000n, priceUsd);

	const v = openVault(world, asset, collateral, debt);
	const toSell = mulDiv(debt, p.borrowerSellPpm, PPM);
	if (toSell > 0n) {
		v.heldGsusd18 -= toSell;
		const usdc = sellGsusd(world.pool, toSell);
		// Most of the proceeds are deployed and gone; a share stays idle and is the only
		// cash this borrower has to buy their debt back with later.
		v.idleUsdc18 += mulDiv(usdc, p.borrowerIdleUsdcPpm, PPM);
	}
}

/**
 * Repayment is the only floor without redemption: a borrower buys their own debt back
 * at a discount. It fires when the discount beats the carry they would otherwise pay
 * over `repayCarryDays`, and then only with a propensity — nobody is obliged to repay
 * today. Retained GSUSD is used first; the shortfall is bought from the pool.
 */
export function borrowersRepay(world: World, rng: Rng): void {
	const p = world.params;
	const price = poolPrice(world.pool);
	const dailyCarry = Number(p.stabilityFeeBps) / 10_000 / 365;
	const discount = 1 - price;
	if (discount <= dailyCarry * p.repayCarryDays) return;

	for (const v of world.vaults) {
		// Loopers hold no GSUSD and no idle USDC, so this step could never act for them;
		// skipping them before the draw keeps the random stream as it is without them.
		if (v.principal18 === 0n || v.looper) continue;
		if (rng() > Number(p.repayPropensityPpm) / 1e6) continue;
		const owed = currentDebt(v.normalised18, world.accumulator);
		let pay = owed;
		// Source GSUSD: held first, then buy from the pool with USDC the borrower has.
		let have = v.heldGsusd18;
		if (have < pay) {
			const need = pay - have;
			// Bounded by the cash they actually have. Unlimited buy-back made borrowers
			// restore the peg every day from any depth, which is not the record.
			let usdcCost = fromNumber18(toNumber18(need) * price * 1.01);
			if (usdcCost > v.idleUsdc18) usdcCost = v.idleUsdc18;
			if (usdcCost > 0n) {
				const bought = buyGsusd(world.pool, usdcCost);
				v.idleUsdc18 -= usdcCost;
				have += bought;
				v.heldGsusd18 += bought;
			}
		}
		if (have < pay) pay = have;
		if (pay === 0n) continue;
		repay(world, v, pay);
	}
}

/** GoldVault.repay: pro-rata principal, cap at current debt, MIN_DEBT floor on remainder. */
export function repay(world: World, v: Vault, amount18: bigint): void {
	const owed = currentDebt(v.normalised18, world.accumulator);
	let amount = amount18 > owed ? owed : amount18;
	let principalPortion = amount >= owed ? v.principal18 : mulDiv(v.principal18, amount, owed);
	const remaining = v.principal18 - principalPortion;
	if (remaining !== 0n && remaining < 100n * WAD) {
		// Leave MIN_DEBT rather than revert: repay only down to the floor.
		principalPortion = v.principal18 - 100n * WAD;
		amount = mulDiv(principalPortion, owed, v.principal18);
	}
	if (amount <= 0n) return;
	v.heldGsusd18 -= amount;
	v.principal18 -= principalPortion;
	v.normalised18 = amount >= owed ? 0n : v.normalised18 - normaliseDebtFloor(amount, world.accumulator);
	// Burn the principal; bank the accrued fee (GoldVault._settleGsusdPayment).
	world.supply18 -= principalPortion;
	const fee = amount - principalPortion;
	world.insurance.gsusd18 += fee;
	world.insurance.totalFeesReceived18 += fee;
	world.ledgers.repaid18 += amount;
	if (v.principal18 === 0n) {
		// Return collateral to the borrower; it leaves the model. Any GSUSD they bought
		// beyond what the close needed does NOT leave: the ex-borrower is now simply a
		// holder of it, and the ledger must say so before the vault is dropped.
		v.collateral18 = 0n;
		v.normalised18 = 0n;
		world.ledgers.holdersGsusd18 += v.heldGsusd18;
		v.heldGsusd18 = 0n;
	}
}

// ---------------------------------------------------------------------------
// Holders and LPs
// ---------------------------------------------------------------------------

/**
 * External holders sell with a base propensity that rises as the price falls: a
 * holder at $0.99 is mildly uneasy; at $0.95 they run. They also buy back when the
 * price is above their entry and they have USDC — modelled as external demand.
 */
export function holdersAct(world: World, rng: Rng, externalUsdcInflow18: bigint, fractionOfDay = 1): void {
	const p = world.params;
	const price = poolPrice(world.pool);
	// Sell pressure, bounded: panic scales it up, but nobody dumps their whole balance
	// into an air-pocket in one day. The cap is what keeps a thin pool from printing
	// lows that no real seller would accept.
	const pctBelow = Math.max(0, (1 - price) * 100);
	const panic = 1 + pctBelow * p.holderPanicPerPct;
	let sellPpm = BigInt(Math.floor(Number(p.holderSellPpmPerDay) * panic * (0.7 + 0.6 * rng())));
	if (sellPpm > p.holderMaxSellPpmPerDay) sellPpm = p.holderMaxSellPpmPerDay;
	sellPpm = BigInt(Math.floor(Number(sellPpm) * fractionOfDay));
	const toSell = mulDiv(world.ledgers.holdersGsusd18, sellPpm, PPM);
	if (toSell > 0n) {
		world.ledgers.holdersGsusd18 -= toSell;
		world.ledgers.holdersUsdc18 += sellGsusd(world.pool, toSell);
	}
	// Baseline buy demand. Matched to selling at peg; a discount attracts more buying
	// until the price is low enough to read as distress, at which point buyers step
	// back and the reflexive run is on. This is the "elastic demand" that exists
	// without any reserve, and the NO-RESERVE control rows show exactly what it is worth.
	const rawAttraction =
		price >= p.buyFearBelowPrice ? 1 + pctBelow * p.buyAttractionPerPct : Math.max(0.1, 1 - (p.buyFearBelowPrice - price) * 20);
	// Conviction halves every `buyConvictionHalfLifeDays` the discount persists: the
	// first dip is bought; the tenth day at $0.97 is not. Only the extra buying decays —
	// baseline demand at peg does not.
	const decay = Math.pow(0.5, world.daysBelowPeg / p.buyConvictionHalfLifeDays);
	const attraction = 1 + (rawAttraction - 1) * decay;
	const buyPpm = BigInt(Math.floor(Number(p.holderBuyPpmPerDay) * attraction * (0.7 + 0.6 * rng()) * fractionOfDay));
	const baselineUsdc = mulDiv(world.supply18, buyPpm, PPM);
	const inflow = baselineUsdc + externalUsdcInflow18;
	if (inflow > 0n) {
		world.ledgers.holdersGsusd18 += buyGsusd(world.pool, inflow);
	}
}

/** LPs withdraw a slice of depth each day the price sits below their comfort line. */
export function lpsAct(world: World): void {
	const p = world.params;
	if (poolPrice(world.pool) < p.lpWithdrawBelowPrice) {
		const before = world.pool.gsusd18;
		withdrawLiquidity(world.pool, p.lpWithdrawPpmPerDay);
		// The GSUSD an LP pulls out does not vanish: they now hold it, and will sell it
		// like any other holder. Dropping it broke the ledger on every scenario.
		world.ledgers.holdersGsusd18 += before - world.pool.gsusd18;
	}
}

// ---------------------------------------------------------------------------
// The Gold Stability Reserve and its arbitrageurs
// ---------------------------------------------------------------------------

/**
 * GoldStabilityReserve.reserveValueUsd: redeemable gold a swap could draw. A paused asset,
 * or one the oracle cannot price, adds nothing, as on chain.
 */
function reserveValueUsd(world: World): bigint {
	let v = 0n;
	for (const a of ASSETS) {
		const g = world.gsr.assets[a];
		if (g.paused || world.oracle[a].impaired) continue;
		const redeemable = g.gold18 > g.minReserve18 ? g.gold18 - g.minReserve18 : 0n;
		v += collateralValueUsd(redeemable, world.oracle[a].oraclePrice8);
	}
	return v;
}

/**
 * GoldStabilityReserve.circulatingSupply: supply less the reserve's own inventory. GSUSD in
 * the surplus buffer is circulating on chain, so it is not netted out here either.
 */
function circulating(world: World): bigint {
	const supply = world.supply18;
	return supply > world.gsr.gsusdInventory18 ? supply - world.gsr.gsusdInventory18 : 0n;
}

/** GoldStabilityReserve.coveragePpm: redeemable reserve value over live circulating supply. */
export function reserveCoveragePpm(world: World): bigint {
	return coveragePpm(reserveValueUsd(world), circulating(world));
}

/**
 * The spread a swap of `gsusdIn18` pays, as GoldStabilityReserve._swapSpreadPpm prices it:
 * the tier of the coverage it leaves behind, against the damped circulating supply. The
 * simulator used to charge the tier a swap started on against the live supply less the
 * surplus buffer, which made every tier-crossing swap cheaper than the contract allows.
 */
export function reserveSwapSpread(world: World, gsusdIn18: bigint): bigint {
	const damped = dampedCirculatingSupply(world.supply18, world.gsr.smoothedSupply18, world.gsr.gsusdInventory18);
	return swapSpreadPpm(reserveValueUsd(world), gsusdIn18, damped, world.gsr.spreadCurve);
}

/** GoldStabilityReserve.currentSpreadPpm: the spread of a vanishingly small swap. */
export function currentBelowSpread(world: World): bigint {
	return reserveSwapSpread(world, 0n);
}

/** Remaining gold the GSR may pay out today for `asset`, honouring floor and caps. */
export function gsrCapacity(world: World, asset: Asset): bigint {
	const g = world.gsr.assets[asset];
	if (world.gsr.halted || g.paused || world.oracle[asset].impaired) return 0n;
	const aboveFloor = g.gold18 > g.minReserve18 ? g.gold18 - g.minReserve18 : 0n;
	const dayCap = mulDiv(g.gold18 + g.outflowToday18, world.gsr.dailyCapPpm, PPM);
	const dayRemaining = dayCap > g.outflowToday18 ? dayCap - g.outflowToday18 : 0n;
	const aggRemaining =
		world.gsr.aggregateDailyCap18 > world.gsr.aggregateOutflowToday18
			? world.gsr.aggregateDailyCap18 - world.gsr.aggregateOutflowToday18
			: 0n;
	const aggInGold = mulDiv(aggRemaining, 100_000_000n, world.oracle[asset].oraclePrice8);
	return [aboveFloor, dayRemaining, aggInGold].reduce((m, x) => (x < m ? x : m));
}

/**
 * GSR below-peg leg. Takes GSUSD, pays gold at oracle minus spread. The spread goes
 * to insurance as revenue; the rest of the GSUSD is retained as inventory after
 * burning any GSR-issued GSUSD first (docs/PEG_ARCHITECTURE.md §4, row 3).
 */
export function swapGsusdForGold(world: World, asset: Asset, gsusdIn18: bigint): bigint {
	const price = world.oracle[asset].oraclePrice8;
	const spread = reserveSwapSpread(world, gsusdIn18);
	const goldOut = gsrGoldOut(gsusdIn18, price, spread);
	const cap = gsrCapacity(world, asset);
	if (goldOut > cap || goldOut === 0n) return 0n;

	const g = world.gsr.assets[asset];
	g.gold18 -= goldOut;
	g.outflowToday18 += goldOut;
	world.gsr.aggregateOutflowToday18 += collateralValueUsd(goldOut, price);
	world.ledgers.goldOutOfGsr18[asset] += goldOut;

	const fee = gsrSpreadTaken(gsusdIn18, spread);
	world.insurance.gsusd18 += fee;
	world.insurance.totalFeesReceived18 += fee;
	world.ledgers.spreadRevenue18 += fee;

	// Proceeds are held, never burned: the reserve owes nothing, so there is nothing of
	// its own to retire, and burning borrower-issued GSUSD would break supply == debt.
	world.gsr.gsusdInventory18 += gsusdIn18 - fee;
	return goldOut;
}

/**
 * GSR above-peg leg (Phase 2): inventory recycling ONLY. Takes gold, releases GSUSD
 * the reserve already holds from earlier below-peg swaps, and refuses when that
 * inventory is exhausted. It never mints: a minting reserve would make the protocol
 * the party bearing gold/USD risk on that GSUSD, with no loss absorber
 * (docs/PEG_ARCHITECTURE.md §4). Above-peg supply beyond inventory comes from
 * borrowers minting at ≥130% and selling into the premium.
 */
export function swapGoldForGsusd(world: World, asset: Asset, goldIn18: bigint): bigint {
	if (!world.params.phase2 || world.gsr.halted || world.gsr.assets[asset].paused) return 0n;
	if (world.oracle[asset].impaired) return 0n;
	const price = world.oracle[asset].oraclePrice8;
	const out = gsrGsusdOut(goldIn18, price, world.gsr.aboveSpreadPpm, world.gsr.haircutPpm);
	if (out === 0n || out > world.gsr.gsusdInventory18) return 0n;

	world.gsr.assets[asset].gold18 += goldIn18;
	world.ledgers.goldInToGsr18[asset] += goldIn18;
	world.gsr.gsusdInventory18 -= out;
	return out;
}

/**
 * Arbitrageurs close the gap between the pool and the GSR quote whenever the profit
 * beats their round-trip cost. Below peg: buy GSUSD from the pool, swap for gold.
 * Above peg (Phase 2): bring gold, take GSUSD, sell into the pool.
 */
export function arbitrageursAct(world: World): void {
	const p = world.params;
	for (const asset of ASSETS) {
		// --- below peg ---
		const spread = currentBelowSpread(world);
		const quote = 1 - Number(spread) / 1e6; // USD of gold per GSUSD at the GSR
		const price = poolPrice(world.pool);
		if (price > 0 && price < quote * (1 - p.arbCostFraction)) {
			// Buy enough to lift the pool to the quote, bounded by GSR capacity.
			const capGold = gsrCapacity(world, asset);
			if (capGold === 0n) continue;
			const capUsd = collateralValueUsd(capGold, world.oracle[asset].oraclePrice8);
			const capUsdc = fromNumber18(toNumber18(capUsd) * price);
			const usdcToLift = (target: number): bigint => {
				const usdc = usdcToReachPrice(world.pool, target);
				return usdc > capUsdc ? capUsdc : usdc;
			};
			let usdcIn = usdcToLift(quote * (1 - p.arbCostFraction));
			if (usdcIn <= 0n) continue;
			// Quote the size as quoteGoldOut would: a swap that crosses a tier pays the
			// dearer one, so stop where that tier's quote meets the pool. A smaller swap
			// pays that tier or a cheaper one, so the trade stays in profit.
			const sizedSpread = reserveSwapSpread(world, buyGsusd({ ...world.pool }, usdcIn));
			if (sizedSpread > spread) {
				const dearerTarget = (1 - Number(sizedSpread) / 1e6) * (1 - p.arbCostFraction);
				if (price >= dearerTarget) continue;
				usdcIn = usdcToLift(dearerTarget);
				if (usdcIn <= 0n) continue;
			}
			const gsusd = buyGsusd(world.pool, usdcIn);
			const gold = swapGsusdForGold(world, asset, gsusd);
			if (gold === 0n) {
				// Capacity refused; unwind by selling back (approximately).
				sellGsusd(world.pool, gsusd);
				continue;
			}
			const goldUsd = toNumber18(collateralValueUsd(gold, world.oracle[asset].marketPrice8));
			world.ledgers.arbProfitUsd += goldUsd - toNumber18(usdcIn) * (1 + p.arbCostFraction);
		}
		// --- above peg (Phase 2) ---
		if (p.phase2) {
			const aboveQuote = (1 - Number(world.gsr.haircutPpm) / 1e6) * (1 - Number(world.gsr.aboveSpreadPpm) / 1e6);
			const priceNow = poolPrice(world.pool);
			if (priceNow > (1 / aboveQuote) * (1 + p.arbCostFraction)) {
				const gsusdToSell = gsusdToReachPrice(world.pool, (1 / aboveQuote) * (1 + p.arbCostFraction));
				if (gsusdToSell <= 0n) continue;
				const goldNeeded = mulDiv(mulDiv(gsusdToSell, PPM, PPM - world.gsr.aboveSpreadPpm), 100_000_000n, world.oracle[asset].oraclePrice8);
				const got = swapGoldForGsusd(world, asset, goldNeeded);
				if (got === 0n) continue;
				const usdc = sellGsusd(world.pool, got);
				world.ledgers.holdersUsdc18 += 0n;
				world.ledgers.arbProfitUsd += toNumber18(usdc) - toNumber18(collateralValueUsd(goldNeeded, world.oracle[asset].marketPrice8)) * (1 + p.arbCostFraction);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Liquidators
// ---------------------------------------------------------------------------

/**
 * Liquidators need GSUSD to repay debt, so a gold crash is GSUSD DEMAND: they buy
 * from the pool, which is why a crash pushes the price up, not down. Penalty splits
 * 60/40 liquidator/protocol; the protocol's share splits insurance/GSR.
 */
export function liquidatorsAct(world: World): void {
	const p = world.params;
	for (const v of world.vaults) {
		if (v.principal18 === 0n) continue;
		const o = world.oracle[v.asset];
		if (o.impaired) continue;
		const owed = currentDebt(v.normalised18, world.accumulator);
		if (collateralRatio(v.collateral18, o.oraclePrice8, owed) >= p.liquidationRatioPpm) continue;

		// Direct liquidation is profitable only while GSUSD costs less than ~$1.03.
		const price = poolPrice(world.pool);
		if (price > 1.03) continue;

		// GoldVault._sizeSeizure: a thin but solvent vault repays
		// all its debt for all its gold, an underwater one repays the gold's value less the
		// discount and leaves the rest as bad debt. A full liquidation is refused only when
		// it would move no collateral.
		const outcome = liquidationSeizure(owed, owed, o.oraclePrice8, v.collateral18, p.penaltyPpm, p.liquidatorSharePpm, p.underwaterDiscountPpm);
		if (!outcome.ok) continue;
		const usdc = fromNumber18(toNumber18(outcome.debtRepaid18) * price * 1.005);
		const bought = buyGsusd(world.pool, usdc);
		const pay = bought < outcome.debtRepaid18 ? bought : outcome.debtRepaid18;
		if (pay === 0n) continue;
		// The grid's original fill seizes for the whole debt even when the liquidator
		// could buy only part of it. GoldVault sizes the seizure on the debt actually
		// repaid; proRataLiquidationFill opts into that without moving the committed grid.
		const settled =
			p.proRataLiquidationFill && pay < outcome.debtRepaid18
				? liquidationSeizure(pay, owed, o.oraclePrice8, v.collateral18, p.penaltyPpm, p.liquidatorSharePpm, p.underwaterDiscountPpm)
				: outcome;
		if (!settled.ok) {
			// The vault refuses the partial (underwater, or too small to move any gold): the
			// liquidator keeps the GSUSD it bought.
			world.ledgers.holdersGsusd18 += bought;
			continue;
		}
		const looperBook = v.looper ? world.loopers : undefined;

		// Settle exactly like GoldVault: principal burned, fee banked.
		const principalPortion = pay >= owed ? v.principal18 : mulDiv(v.principal18, pay, owed);
		world.supply18 -= principalPortion;
		const fee = pay - principalPortion;
		world.insurance.gsusd18 += fee;
		world.insurance.totalFeesReceived18 += fee;
		// Any GSUSD bought but not needed returns to holders (liquidator keeps it).
		if (bought > pay) world.ledgers.holdersGsusd18 += bought - pay;

		v.principal18 -= principalPortion;
		v.normalised18 = pay >= owed ? 0n : v.normalised18 - normaliseDebtFloor(pay, world.accumulator);
		v.collateral18 -= settled.collateralSeized18;
		world.ledgers.liquidatedDebt18 += pay;
		if (looperBook) {
			looperBook.liquidatedDebt18 += pay;
			looperBook.liquidatedVaultIds.add(v.id);
		}

		// Protocol penalty share: split between insurance and the GSR.
		const toGsr = mulDiv(settled.toProtocol18, p.gsrPenaltySharePpm, PPM);
		world.gsr.assets[v.asset].gold18 += toGsr;
		world.ledgers.goldInToGsr18[v.asset] += toGsr;
		world.insurance.gold18[v.asset] += settled.toProtocol18 - toGsr;

		// Bad debt: collateral gone, debt remains → insurance absorbs, then it is written off.
		if (v.collateral18 === 0n && v.principal18 > 0n) {
			if (looperBook) looperBook.badDebt18 += v.principal18;
			const absorb = v.principal18 < world.insurance.gsusd18 ? v.principal18 : world.insurance.gsusd18;
			world.insurance.gsusd18 -= absorb;
			world.insurance.totalBadDebtAbsorbed18 += absorb;
			world.supply18 -= absorb;
			// Remaining unbacked principal is written off: supply no longer matches; the
			// identity records it as a violation, which is the honest signal of bad debt.
			v.principal18 = 0n;
			v.normalised18 = 0n;
		}
	}
	// Drop closed vaults, but never the GSUSD their owners still hold.
	for (const v of world.vaults) {
		if (v.principal18 === 0n && v.collateral18 === 0n && v.heldGsusd18 > 0n) {
			world.ledgers.holdersGsusd18 += v.heldGsusd18;
			v.heldGsusd18 = 0n;
		}
	}
	world.vaults = world.vaults.filter((v) => v.principal18 > 0n || v.collateral18 > 0n);
	void totalPrincipal;
}
