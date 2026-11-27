import { describe, expect, it } from 'vitest';
import { WAD, fromNumber18, toPrice8 } from './mechanics';
import { arbitrageursAct, currentBelowSpread, startDay, swapGsusdForGold } from './agents';
import { buyGsusd, poolPrice, sellGsusd } from './market';
import { identityHolds, ledgerBalances } from './identity';
import { simulate, DEFAULT_PARAMS, DEFAULT_SPREAD_CURVE } from './run';
import type { Scenario } from './scenarios';
import type { World } from './state';

/**
 * The incident that triggered the redesign, replayed against the new architecture.
 *
 * On 2026-08-29 a redemption of 10,000 GSUSD drew 2.4875 PAXG from a borrower's
 * vault. The product rule that followed: no peg operation may alter any borrower's
 * vault. This spec is that rule, stated as a test.
 */
const SCENARIO: Scenario = {
	name: 'incident-replay',
	days: 1,
	supplyUsd: 100_000_000,
	gsrCoverage: 0.1,
	dexDepthUsd: 5_000_000,
	goldDailyVol: 0,
	goldShocks: [],
	oracleLagDays: 0,
	demandShocks: [],
	phase2: false,
	xautShare: 0.2,
};

function snapshotVaults(world: World) {
	return world.vaults.map((v) => ({ id: v.id, c: v.collateral18, p: v.principal18, n: v.normalised18 }));
}

describe('the vault-targeting incident cannot recur', () => {
	it('a 500,000 GSUSD swap at $0.98 changes no vault, and the reserve absorbs it', () => {
		// Build the world via one simulated day with no shocks, then act on it directly.
		const r = simulate(SCENARIO, 1);
		expect(r.series[0].identityOk).toBe(true);

		// Reconstruct a world at the same state to act on (simulate() does not expose it,
		// so we rebuild through the public agent functions on a fresh instance).
		const world = buildIncidentWorld();
		const before = snapshotVaults(world);
		const supplyBefore = world.supply18;
		const goldBefore = world.gsr.assets.PAXG.gold18;

		// Push the pool to $0.98 by selling, then a redeemer buys 500k and swaps.
		sellGsusd(world.pool, fromNumber18(200_000));
		const usdc = fromNumber18(500_000 * 0.98);
		const gsusd = buyGsusd(world.pool, usdc);
		world.ledgers.holdersGsusd18 -= 0n;
		const gold = swapGsusdForGold(world, 'PAXG', gsusd);

		expect(gold).toBeGreaterThan(0n);
		// Every vault is byte-identical.
		expect(snapshotVaults(world)).toEqual(before);
		// Supply is unchanged: a swap, not a burn (Phase 1, gsrIssued == 0).
		expect(world.supply18).toBe(supplyBefore);
		// The reserve paid, not a borrower.
		expect(world.gsr.assets.PAXG.gold18).toBe(goldBefore - gold);
		// Proceeds are inventory, not revenue: only the spread reached insurance.
		expect(world.gsr.gsusdInventory18 + world.ledgers.spreadRevenue18).toBe(gsusd);
		expect(world.insurance.totalFeesReceived18).toBe(world.ledgers.spreadRevenue18);
		expect(identityHolds(world)).toBe(true);
	});

	it('the 10,000 GSUSD redemption that hit a borrower\'s vault now pays 2.4875 PAXG from the reserve', () => {
		const world = buildIncidentWorld();
		const before = snapshotVaults(world);
		const gold = swapGsusdForGold(world, 'PAXG', 10_000n * WAD);
		expect(gold).toBe(2_487_500_000_000_000_000n);
		expect(snapshotVaults(world)).toEqual(before);
	});

	it('with the reserve exhausted the swap refuses rather than reaching for a vault', () => {
		const world = buildIncidentWorld();
		world.gsr.assets.PAXG.gold18 = world.gsr.assets.PAXG.minReserve18; // nothing redeemable
		const before = snapshotVaults(world);
		const gold = swapGsusdForGold(world, 'PAXG', 10_000n * WAD);
		expect(gold).toBe(0n);
		expect(snapshotVaults(world)).toEqual(before);
	});
});

/**
 * The reserve's swap price, as GoldStabilityReserve._swapSpreadPpm sets it: the tier of the
 * coverage the swap leaves behind, against the damped supply
 * less the reserve's own inventory, counting only gold a swap could draw.
 */
describe('the reserve prices a swap as the contract does', () => {
	/** The incident world on the deployed curve: $10m redeemable over $100m is exactly 10%. */
	const deployedWorld = (): World => {
		const world = buildIncidentWorld();
		world.gsr.spreadCurve = DEFAULT_SPREAD_CURVE;
		return world;
	};

	it('a swap that takes coverage through a tier boundary pays the dearer tier', () => {
		const world = deployedWorld();
		expect(currentBelowSpread(world)).toBe(5_000n);
		// 10,000 GSUSD leaves 9.99%: the 0.75% tier, so 2.48125 PAXG rather than 2.4875.
		const gold = swapGsusdForGold(world, 'PAXG', 10_000n * WAD);
		expect(gold).toBe(2_481_250_000_000_000_000n);
		expect(world.ledgers.spreadRevenue18).toBe(75n * WAD);
	});

	it('GSUSD in the surplus buffer counts as circulating, as it does on chain', () => {
		const world = deployedWorld();
		world.insurance.gsusd18 = 1_000_000n * WAD;
		// 50,000 GSUSD leaves $9.95m over $100m = 9.95%, not over $99m = 10.05%.
		swapGsusdForGold(world, 'PAXG', 50_000n * WAD);
		expect(world.ledgers.spreadRevenue18).toBe(375n * WAD);
	});

	it('a burn earlier in the day buys no cheaper tier until the day turns', () => {
		const world = deployedWorld();
		// Borrowers repay 2m: live coverage rises to 10.2%, but the smoothed supply still
		// stands at the day's opening 100m.
		world.supply18 -= 2_000_000n * WAD;
		const probe = (): bigint => {
			const copy = structuredClone(world);
			swapGsusdForGold(copy, 'PAXG', 50_000n * WAD);
			return copy.ledgers.spreadRevenue18;
		};
		expect(probe()).toBe(375n * WAD); // 0.75%
		startDay(world);
		expect(probe()).toBe(250n * WAD); // 0.50% once the burn has aged a day
	});

	it('gold of a paused or impaired asset adds no coverage', () => {
		const world = deployedWorld();
		world.gsr.assets.XAUT.gold18 = 2_500n * WAD; // a further $10m: 20% in all
		const paid = (mutate: (w: World) => void): bigint => {
			const copy = structuredClone(world);
			mutate(copy);
			swapGsusdForGold(copy, 'PAXG', 1_000_000n * WAD);
			return copy.ledgers.spreadRevenue18;
		};
		expect(paid(() => undefined)).toBe(5_000n * WAD); // 19% left: 0.50%
		expect(paid((w) => (w.gsr.assets.XAUT.paused = true))).toBe(7_500n * WAD); // 9%: 0.75%
		expect(paid((w) => (w.oracle.XAUT.impaired = true))).toBe(7_500n * WAD);
	});

	it('arbitrage lifts the pool no higher than the spread the reserve actually charged allows', () => {
		const world = deployedWorld();
		sellGsusd(world.pool, fromNumber18(200_000));
		const inventoryBefore = world.gsr.gsusdInventory18;
		arbitrageursAct(world);
		const swapped = world.gsr.gsusdInventory18 - inventoryBefore + world.ledgers.spreadRevenue18;
		expect(swapped).toBeGreaterThan(0n);
		const paidSpread = Number(world.ledgers.spreadRevenue18) / Number(swapped);
		const reserveBid = (1 - paidSpread) * (1 - world.params.arbCostFraction);
		expect(poolPrice(world.pool)).toBeLessThanOrEqual(reserveBid + 1e-9);
	});

	it('a run refuses a spread curve the contract would refuse', () => {
		expect(() =>
			simulate(SCENARIO, 1, { spreadCurve: { steps: [[150_000n, 3_000n]], restrictedSpreadPpm: 20_000n } })
		).toThrow(/Spread out of range/);
	});
});

/** A minimal world: 100 vaults, $100m supply, 10% coverage, pool at $1.00. */
function buildIncidentWorld(): World {
	const gold8 = toPrice8(4000);
	const world: World = {
		day: 1,
		daysBelowPeg: 0,
		vaults: [],
		nextVaultId: 1,
		accumulator: 10n ** 18n,
		perSecondRate: 10n ** 18n,
		supply18: 0n,
		oracle: {
			PAXG: { marketPrice8: gold8, oraclePrice8: gold8, impaired: false },
			XAUT: { marketPrice8: gold8, oraclePrice8: gold8, impaired: false },
		},
		gsr: {
			assets: {
				PAXG: { gold18: 2_750n * WAD, minReserve18: 250n * WAD, outflowToday18: 0n, paused: false },
				XAUT: { gold18: 0n, minReserve18: 0n, outflowToday18: 0n, paused: false },
			},
			gsusdInventory18: 0n,
			issued18: 0n,
			issuanceCap18: 0n,
			dailyCapPpm: 500_000n,
			aggregateOutflowToday18: 0n,
			aggregateDailyCap18: fromNumber18(50_000_000),
			spreadCurve: { steps: [[50_000n, 5_000n]], restrictedSpreadPpm: 20_000n },
			smoothedSupply18: 0n,
			aboveSpreadPpm: 2_000n,
			haircutPpm: 5_000n,
			halted: false,
		},
		insurance: { gsusd18: 0n, gold18: { PAXG: 0n, XAUT: 0n }, totalFeesReceived18: 0n, totalBadDebtAbsorbed18: 0n },
		pool: { gsusd18: fromNumber18(5_000_000), usdc18: fromNumber18(5_000_000) },
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
		params: DEFAULT_PARAMS,
	};
	for (let i = 0; i < 100; i++) {
		const principal = 1_000_000n * WAD;
		world.vaults.push({
			id: world.nextVaultId++,
			asset: 'PAXG',
			collateral18: 375n * WAD, // 150% at $4,000
			principal18: principal,
			normalised18: principal,
			heldGsusd18: 0n,
			idleUsdc18: 0n,
		});
		world.supply18 += principal;
	}
	// The day opens with the whole supply banked, as startDay leaves it.
	world.gsr.smoothedSupply18 = world.supply18;
	// All minted GSUSD is with holders except what seeds the pool.
	world.ledgers.holdersGsusd18 = world.supply18 - world.pool.gsusd18;
	expect(ledgerBalances(world)).toBe(true);
	return world;
}
