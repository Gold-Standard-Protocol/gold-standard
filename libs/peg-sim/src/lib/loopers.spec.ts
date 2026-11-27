import { describe, expect, it } from 'vitest';
import { liquidatorsAct } from './agents';
import { identityHolds, ledgerBalances } from './identity';
import { loopersAct, resolveLooperConfig, DEFAULT_LOOPER } from './loopers';
import { PPM, collateralRatio, currentDebt, fromNumber18, liquidationSeizure, mulDiv, toNumber18 } from './mechanics';
import { poolPrice } from './market';
import { mulberry32 } from './rng';
import { buildWorld, DEFAULT_PARAMS, simulate } from './run';
import { LOOPER_SCENARIOS, SCENARIOS, pairedBaseline, type Scenario } from './scenarios';
import { totalPrincipal, type World } from './state';

const byName = (name: string): Scenario => {
	const s = [...SCENARIOS, ...LOOPER_SCENARIOS].find((x) => x.name === name);
	if (!s) throw new Error(`no scenario ${name}`);
	return s;
};

const worldFor = (name: string, seed = 1): World => buildWorld(byName(name), { ...DEFAULT_PARAMS }, {}, mulberry32(seed));

const looperVaults = (world: World) => world.vaults.filter((v) => v.looper);

const snapshotLoopers = (world: World) =>
	looperVaults(world).map((v) => ({ id: v.id, c: v.collateral18, p: v.principal18, n: v.normalised18, h: v.heldGsusd18 }));

/** Sets the pool's GSUSD price; the GSUSD taken out or put in is the holders'. */
function pricePoolAt(world: World, price: number): void {
	const gsusd = fromNumber18(toNumber18(world.pool.usdc18) / price);
	world.ledgers.holdersGsusd18 += world.pool.gsusd18 - gsusd;
	world.pool.gsusd18 = gsusd;
}

/** Moves gold for both assets, oracle and market together, by `pct`. */
function moveGold(world: World, pct: number): void {
	for (const a of ['PAXG', 'XAUT'] as const) {
		const next = BigInt(Math.round(Number(world.oracle[a].marketPrice8) * (1 + pct)));
		world.oracle[a].marketPrice8 = next;
		world.oracle[a].oraclePrice8 = next;
	}
}

describe('looper configuration', () => {
	it('fills defaults and refuses a target below the PAXG minimum ratio', () => {
		const c = resolveLooperConfig({ shareOfSupply: 0.3 }, DEFAULT_PARAMS.minRatioPpm);
		expect(c.originationFeeBps).toBe(5n);
		expect(c.targetRatiosPpm).toEqual(DEFAULT_LOOPER.targetRatiosPpm);
		expect(() => resolveLooperConfig({ shareOfSupply: 0.3, targetRatiosPpm: [1_250_000n] }, DEFAULT_PARAMS.minRatioPpm)).toThrow(/below the minimum/);
		expect(() => resolveLooperConfig({ shareOfSupply: 1 }, DEFAULT_PARAMS.minRatioPpm)).toThrow(/shareOfSupply/);
	});
});

describe('seeding', () => {
	it('levered loopers hold the asked share of an unchanged supply, each at its target ratio', () => {
		const world = worldFor('loop-30pct-calm');
		const target = fromNumber18(100_000_000);
		const looped = looperVaults(world).reduce((a, v) => a + v.principal18, 0n);
		// Supply is the scenario's size to within the base book's per-vault rounding.
		expect(target - world.supply18 >= 0n && target - world.supply18 < 1_000n).toBe(true);
		expect(toNumber18(looped) / toNumber18(world.supply18)).toBeCloseTo(0.3, 6);
		for (const v of looperVaults(world)) {
			const ratio = collateralRatio(v.collateral18, world.oracle.PAXG.oraclePrice8, currentDebt(v.normalised18, world.accumulator));
			expect(v.looper?.targetRatioPpm !== undefined && ratio >= v.looper.targetRatioPpm - 1n && ratio <= v.looper.targetRatioPpm).toBe(true);
			expect(v.heldGsusd18).toBe(0n);
			expect(v.asset).toBe('PAXG');
		}
		expect(identityHolds(world)).toBe(true);
		expect(ledgerBalances(world)).toBe(true);
	});

	it('unlevered loopers start with equity only, on top of the full base book', () => {
		const world = worldFor('loop-10pct-buildup');
		const base = buildWorld(pairedBaseline(byName('loop-10pct-buildup')), { ...DEFAULT_PARAMS }, {}, mulberry32(1));
		expect(looperVaults(world).length).toBeGreaterThan(0);
		expect(looperVaults(world).every((v) => v.principal18 === 0n && v.collateral18 > 0n)).toBe(true);
		expect(world.supply18).toBe(base.supply18);
		expect(ledgerBalances(world)).toBe(true);
	});
});

describe('daily behaviour', () => {
	it('after a 10% rise each looper loops back to its target band, and every GSUSD is accounted for', () => {
		const world = worldFor('loop-30pct-calm');
		const goldBefore = world.gsr.assets.PAXG.gold18;
		moveGold(world, 0.1);
		loopersAct(world);
		const book = world.loopers;
		expect(book).toBeDefined();
		if (!book) return;
		expect(book.minted18).toBeGreaterThan(0n);
		// 5 bps on every mint, banked in the buffer; per-mint flooring loses at most a wei per round.
		const expectedFees = mulDiv(book.minted18, 5n, 10_000n);
		expect(expectedFees - book.originationFees18 >= 0n && expectedFees - book.originationFees18 <= BigInt(book.rounds)).toBe(true);
		expect(world.insurance.gsusd18).toBe(book.originationFees18 + world.ledgers.spreadRevenue18);
		// Reserve gold left only to loopers here: no other agent acted.
		expect(goldBefore - world.gsr.assets.PAXG.gold18).toBe(book.goldFromReserve18);
		expect(book.soldToReserve18 + book.soldToMarket18 + book.originationFees18 + book.repaidUnsold18).toBe(book.minted18);
		for (const v of looperVaults(world)) {
			expect(v.heldGsusd18).toBe(0n);
			const target = v.looper?.targetRatioPpm ?? 0n;
			const ratio = collateralRatio(v.collateral18, world.oracle.PAXG.oraclePrice8, currentDebt(v.normalised18, world.accumulator));
			// Never below the mint check; above the band only if the venues ran out first.
			expect(ratio >= target).toBe(true);
		}
		expect(identityHolds(world)).toBe(true);
		expect(ledgerBalances(world)).toBe(true);
	});

	it('the reserve is the first venue: a looper at par takes reserve gold before pushing the pool down', () => {
		const world = worldFor('loop-30pct-calm');
		moveGold(world, 0.1);
		loopersAct(world);
		const book = world.loopers;
		expect(book && book.soldToReserve18 > book.soldToMarket18).toBe(true);
	});

	it('with the reserve halted, loopers sell into the pool only down to their cost limit and mint no more than they can swap', () => {
		const world = worldFor('loop-30pct-calm');
		world.gsr.halted = true;
		moveGold(world, 0.1);
		loopersAct(world);
		const book = world.loopers;
		expect(book).toBeDefined();
		if (!book) return;
		const floor = (1 - 0.015) * (1 + 0.003);
		expect(poolPrice(world.pool)).toBeGreaterThanOrEqual(floor - 1e-6);
		expect(book.soldToReserve18).toBe(0n);
		expect(book.venueLimitedRounds).toBeGreaterThan(0);
		// The pool alone absorbs a sliver of what the reserve route allowed.
		const withReserve = worldFor('loop-30pct-calm');
		moveGold(withReserve, 0.1);
		loopersAct(withReserve);
		expect(book.minted18 * 10n < (withReserve.loopers?.minted18 ?? 0n)).toBe(true);
		expect(ledgerBalances(world)).toBe(true);
	});

	it('never sells into a pool that pays more than par: with the reserve halted it mints nothing', () => {
		const world = worldFor('loop-30pct-calm');
		world.gsr.halted = true;
		pricePoolAt(world, 1.5);
		const pool = { ...world.pool };
		moveGold(world, 0.1);
		loopersAct(world);
		expect(world.loopers?.minted18).toBe(0n);
		expect(world.loopers?.soldToMarket18).toBe(0n);
		expect(world.pool).toEqual(pool);
		expect(ledgerBalances(world)).toBe(true);
	});

	it('with the pool above par and the reserve open, every GSUSD a looper sells goes to the reserve', () => {
		const world = worldFor('loop-30pct-calm');
		pricePoolAt(world, 1.5);
		const pool = { ...world.pool };
		moveGold(world, 0.1);
		loopersAct(world);
		const book = world.loopers;
		expect(book && book.soldToReserve18 > 0n).toBe(true);
		expect(book?.soldToMarket18).toBe(0n);
		expect(world.pool).toEqual(pool);
		// No windfall: each GSUSD bought at most its value in reserve gold.
		const goldValue = toNumber18(book?.goldFromReserve18 ?? 0n) * (Number(world.oracle.PAXG.oraclePrice8) / 1e8);
		expect(goldValue).toBeLessThanOrEqual(toNumber18(book?.soldToReserve18 ?? 0n));
		expect(ledgerBalances(world)).toBe(true);
	});

	it('does nothing clever when gold falls: no vault changes', () => {
		const world = worldFor('loop-30pct-calm');
		const before = snapshotLoopers(world);
		moveGold(world, -0.1);
		loopersAct(world);
		expect(snapshotLoopers(world)).toEqual(before);
		expect(world.loopers?.minted18).toBe(0n);
	});

	it('an inert looper never mints, even after a large rise', () => {
		const world = worldFor('loop-30pct-calm-inert');
		moveGold(world, 0.3);
		loopersAct(world);
		expect(world.loopers?.minted18).toBe(0n);
	});
});

describe('liquidation fill', () => {
	function worldWithOneUnsafeVault(proRata: boolean): { world: World; id: number; before: bigint; owed: bigint } {
		const world = buildWorld(byName('calm-at-peg'), { ...DEFAULT_PARAMS, proRataLiquidationFill: proRata }, {}, mulberry32(1));
		const v = world.vaults.find((x) => x.asset === 'PAXG');
		if (!v) throw new Error('no PAXG vault');
		const owed = currentDebt(v.normalised18, world.accumulator);
		// 108%: liquidatable but solvent. A 1m/1m pool cannot fill 250k without slippage.
		v.collateral18 = mulDiv(mulDiv(owed, 1_080_000n, PPM), 100_000_000n, world.oracle.PAXG.oraclePrice8);
		world.pool.gsusd18 = fromNumber18(1_000_000);
		world.pool.usdc18 = fromNumber18(1_000_000);
		world.ledgers.holdersGsusd18 += fromNumber18(5_000_000) - fromNumber18(1_000_000);
		return { world, id: v.id, before: v.collateral18, owed };
	}

	it('pro rata: a partial fill seizes collateral for the debt actually repaid, as GoldVault does', () => {
		const { world, id, before, owed } = worldWithOneUnsafeVault(true);
		liquidatorsAct(world);
		const paid = world.ledgers.liquidatedDebt18;
		// The fill must be partial, or this would not exercise the pro rata branch.
		expect(paid < owed).toBe(true);
		const v = world.vaults.find((x) => x.id === id);
		const expected = liquidationSeizure(paid, owed, world.oracle.PAXG.oraclePrice8, before, DEFAULT_PARAMS.penaltyPpm, DEFAULT_PARAMS.liquidatorSharePpm);
		if (!expected.ok) throw new Error(expected.reason);
		expect(v?.collateral18).toBe(before - expected.collateralSeized18);
	});

	it('legacy (the committed grid): the same partial fill seizes for the whole debt', () => {
		const { world, id, before, owed } = worldWithOneUnsafeVault(false);
		liquidatorsAct(world);
		const v = world.vaults.find((x) => x.id === id);
		const full = liquidationSeizure(owed, owed, world.oracle.PAXG.oraclePrice8, before, DEFAULT_PARAMS.penaltyPpm, DEFAULT_PARAMS.liquidatorSharePpm);
		if (!full.ok) throw new Error(full.reason);
		expect(world.ledgers.liquidatedDebt18 < owed).toBe(true);
		expect(v?.collateral18).toBe(before - full.collateralSeized18);
	});
});

describe('looper scenarios', () => {
	it('each looper scenario and its paired baseline see the identical gold path', () => {
		for (const s of LOOPER_SCENARIOS) {
			const a = simulate(s, 3).series.map((d) => d.goldPrice);
			const b = simulate(pairedBaseline(s), 3).series.map((d) => d.goldPrice);
			expect(a).toEqual(b);
		}
	});

	for (const scenario of LOOPER_SCENARIOS) {
		it(`${scenario.name}: ledger holds every day; the identity breaks only with booked bad debt`, () => {
			const r = simulate(scenario, 7);
			expect(r.series.every((d) => d.ledgerOk)).toBe(true);
			if (r.series.some((d) => !d.identityOk)) expect(r.system.badDebtUnbackedUsd).toBeGreaterThan(0);
			expect(r.loopers).toBeDefined();
		});
	}

	it('a run without loopers reports no looper metrics and no unbacked debt it did not book', () => {
		const r = simulate(byName('calm-at-peg'), 1);
		expect(r.loopers).toBeUndefined();
		expect(r.system.badDebtUnbackedUsd).toBe(0);
	});
});

describe('the committed grid is untouched', () => {
	it('no committed scenario carries a looper option', () => {
		for (const s of SCENARIOS) {
			expect(s.loopers).toBeUndefined();
			expect(s.independentGoldPath).toBeUndefined();
			expect(s.proRataLiquidationFill).toBeUndefined();
		}
	});

	it('baseline runs reproduce the figures measured before loopers existed (seed 1)', () => {
		// Captured from the grid at commit b5dbfc1, before loopers.ts was added. The crash run
		// moved once since, deliberately, when liquidation sizing became GoldVault._sizeSeizure:
		// liquidated 2,702,304.54 became 2,713,151.26 and reserve
		// gold out 427,306.91 became 425,803.60. The other two runs liquidate nothing thin.
		// The outflow run moved once more, deliberately, when the reserve began pricing a
		// swap at the tier it leaves behind against the damped supply, as
		// GoldStabilityReserve._swapSpreadPpm does: reserve gold
		// out 10,070,228.89 became 9,988,689.98. The calm and crash figures did not move.
		const calm = simulate(byName('calm-at-peg'), 1).metrics;
		expect(calm.minPrice).toBe(0.993009999999764);
		expect(calm.goldOutUsd).toBe(2050585.9142189038);
		expect(calm.supplyEnd).toBe(76079615.276633);
		const crash = simulate(byName('gold-minus-10-x2'), 1).metrics;
		expect(crash.liquidatedUsd).toBe(2713151.263908);
		expect(crash.identityViolations).toBe(67);
		expect(crash.goldOutUsd).toBe(425803.59866705694);
		const run = simulate(byName('sustained-outflow'), 1).metrics;
		expect(run.goldOutUsd).toBe(9988689.98368397);
		expect(run.minPrice).toBe(0.9700000000001989);
	});

	it('Σ principal equals supply at the start of every looper scenario', () => {
		for (const s of LOOPER_SCENARIOS) {
			const w = buildWorld(s, { ...DEFAULT_PARAMS }, {}, mulberry32(1));
			expect(w.supply18).toBe(totalPrincipal(w));
		}
	});
});
