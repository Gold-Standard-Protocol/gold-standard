import { describe, expect, it } from 'vitest';
import {
	DEFAULT_UNDERWATER_DISCOUNT_PPM,
	MIN_DEBT,
	PPM,
	RAY,
	SECONDS_PER_YEAR,
	WAD,
	accrueAccumulator,
	collateralRatio,
	gsrGoldOut,
	gsrGsusdOut,
	liquidationSeizure,
	perSecondRate,
	rpow,
	dampedCirculatingSupply,
	sizeSeizure,
	spreadCurveRefusal,
	swapSpreadPpm,
	toPrice8,
	utilisationSpread,
} from './mechanics';
import { DEFAULT_SPREAD_CURVE } from './run';

/**
 * Every value here was measured against the deployed contracts or their Foundry
 * tests earlier in this project. The model is only useful if its arithmetic IS the
 * contracts' arithmetic.
 */
describe('mechanics reproduce the contracts', () => {
	it('perSecondRate matches StabilityModule._annualToPerSecond for 3%', () => {
		// Measured on-chain: stabilityFeeRate(300 bps) == 1000000000951293759
		expect(perSecondRate(300n)).toBe(1_000_000_000_951_293_759n);
	});

	it('a year at 3% compounds to e^0.03, as measured on a StabilityModule', () => {
		// Measured: rateAccumulator after 365 days at 300 bps == 1030454533925555900
		const acc = accrueAccumulator(RAY, perSecondRate(300n), SECONDS_PER_YEAR);
		expect(acc).toBe(1_030_454_533_925_555_900n);
	});

	it('rpow identity cases', () => {
		expect(rpow(RAY, 12345n)).toBe(RAY);
		expect(rpow(2n * RAY, 0n)).toBe(RAY);
		expect(rpow(2n * RAY, 3n)).toBe(8n * RAY);
	});

	it('collateral ratio: 60 PAXG at $4000 against 39,000 GSUSD is 615.4%', () => {
		// Matches the ratio read from the Sepolia vault earlier: 6153605 (1e6 precision)
		const ratio = collateralRatio(60n * WAD, toPrice8(4000), 39_000n * WAD);
		expect(ratio / 10_000n).toBe(615n);
	});

	it('no debt reports the contract sentinel, type(uint256).max', () => {
		expect(collateralRatio(WAD, toPrice8(4000), 0n)).toBe(2n ** 256n - 1n);
	});

	it('liquidation seizure splits the 5% penalty 60/40', () => {
		// Repay 1,000 GSUSD at $4,000/oz with a 5% penalty: seize 0.2625 oz;
		// debt-equivalent 0.25 oz; penalty 0.0125 oz; liquidator gets 0.25 + 0.0075.
		const o = liquidationSeizure(1_000n * WAD, 1_000n * WAD, toPrice8(4000), 10n * WAD, 50_000n, 600_000n);
		expect(o.ok).toBe(true);
		if (!o.ok) return;
		expect(o.debtRepaid18).toBe(1_000n * WAD);
		expect(o.collateralSeized18).toBe(262_500_000_000_000_000n);
		expect(o.toLiquidator18).toBe(257_500_000_000_000_000n);
		expect(o.toProtocol18).toBe(5_000_000_000_000_000n);
	});

	it('a thin but solvent vault repays all its debt for all its gold: the penalty gives way, not the debt', () => {
		// 40 PAXG against 100,000 at $2,600 is 104%: the whole penalty no longer fits.
		const o = liquidationSeizure(100_000n * WAD, 100_000n * WAD, toPrice8(2600), 40n * WAD, 50_000n, 600_000n);
		expect(o.ok).toBe(true);
		if (!o.ok) return;
		const debtEquivalent = (100_000n * WAD * 100_000_000n) / toPrice8(2600);
		expect(o.debtRepaid18).toBe(100_000n * WAD);
		expect(o.collateralSeized18).toBe(40n * WAD);
		expect(o.toLiquidator18).toBe(debtEquivalent + ((40n * WAD - debtEquivalent) * 600_000n) / PPM);
		expect(o.toProtocol18).toBe(40n * WAD - o.toLiquidator18);
	});

	it('GSR below-peg leg: 10,000 GSUSD at $4,000 and 0.5% spread pays 2.4875 PAXG', () => {
		// The exact figure from the Sepolia redemption that triggered the redesign.
		expect(gsrGoldOut(10_000n * WAD, toPrice8(4000), 5_000n)).toBe(2_487_500_000_000_000_000n);
	});

	it('GSR above-peg leg applies haircut then spread', () => {
		// 1 PAXG at $4,000, 0.5% haircut, 0.2% spread → 4000 × 0.995 × 0.998 = 3972.04
		expect(gsrGsusdOut(WAD, toPrice8(4000), 2_000n, 5_000n)).toBe(3_972_040_000_000_000_000_000n);
	});

	it('utilisation spread steps down as coverage rises and restricts below the last step', () => {
		const curve = { steps: [[150_000n, 5_000n], [50_000n, 7_500n]] as const, restrictedSpreadPpm: 20_000n };
		expect(utilisationSpread(200_000n, curve)).toBe(5_000n);
		expect(utilisationSpread(150_000n, curve)).toBe(5_000n);
		expect(utilisationSpread(100_000n, curve)).toBe(7_500n);
		expect(utilisationSpread(10_000n, curve)).toBe(20_000n);
	});

	it('constants match GoldVault', () => {
		expect(PPM).toBe(1_000_000n);
		expect(MIN_DEBT).toBe(100n * WAD);
	});
});

/**
 * GoldVault._sizeSeizure parity. Each vector is a case from
 * contracts/test-foundry/LiquidationSizing.t.sol or LiquidationAndSupplyAccounting.t.sol, with the
 * same inputs and, where the Solidity test computes its expectation, the same expression.
 * XAUT carries 6 decimals (decimal scale 1e12), PAXG 18 (scale 1).
 */
describe('sizeSeizure matches GoldVault._sizeSeizure', () => {
	const PENALTY = 50_000n;
	const DISCOUNT = DEFAULT_UNDERWATER_DISCOUNT_PPM;
	const XAUT_SCALE = 10n ** 12n;
	const ONE_XAUT = 1_000_000n;

	it('uses the deployed 2% underwater discount', () => {
		expect(DEFAULT_UNDERWATER_DISCOUNT_PPM).toBe(20_000n);
	});

	it('test_solventVaultBetween100And105PercentBooksNoBadDebt: all the gold for all the debt', () => {
		const price = 274_667_000_000n;
		const r = sizeSeizure(2000n * WAD, 2000n * WAD, 750_000n, price, PENALTY, XAUT_SCALE, DISCOUNT);
		const debtEquivalent = (2000n * WAD * 100_000_000n) / (price * XAUT_SCALE);
		expect(r).toEqual({ ok: true, repay: 2000n * WAD, seize: 750_000n, debtEquivalent });
		// The penalty was cut, not the debt.
		expect(750_000n - debtEquivalent).toBeLessThan((debtEquivalent * PENALTY) / PPM);
	});

	it('test_insolventVaultBooksExactlyTheMissingValue: the gold less the discount', () => {
		const price = 253_333_000_000n;
		const r = sizeSeizure(2000n * WAD, 2000n * WAD, 750_000n, price, PENALTY, XAUT_SCALE, DISCOUNT);
		const coverable = (750_000n * price * XAUT_SCALE) / 100_000_000n;
		const paid = (coverable * (PPM - DISCOUNT)) / PPM;
		expect(r).toEqual({ ok: true, repay: paid, seize: 750_000n, debtEquivalent: (paid * 100_000_000n) / (price * XAUT_SCALE) });
	});

	it('test_deepUnderwaterKeepsTheFullDiscount: 1800 less 2% is 1764', () => {
		const r = sizeSeizure(2000n * WAD, 2000n * WAD, ONE_XAUT, toPrice8(1800), PENALTY, XAUT_SCALE, DISCOUNT);
		expect(r.ok && r.repay).toBe(1764n * WAD);
		expect(r.ok && r.seize).toBe(ONE_XAUT);
	});

	it('test_vaultBelowHalfItsDebtLiquidates: 900 less 2% is 882', () => {
		const r = sizeSeizure(2000n * WAD, 2000n * WAD, ONE_XAUT, toPrice8(900), PENALTY, XAUT_SCALE, DISCOUNT);
		expect(r.ok && r.repay).toBe(882n * WAD);
	});

	it('test_shallowUnderwaterDiscountIsTheShortfall: the 2c - d cap gives 1960', () => {
		const r = sizeSeizure(2000n * WAD, 2000n * WAD, ONE_XAUT, toPrice8(1980), PENALTY, XAUT_SCALE, DISCOUNT);
		expect(r.ok && r.repay).toBe(1960n * WAD);
	});

	it('test_selfLiquidationJustUnderwaterGetsNoBufferBonus: the buffer covers twice the hole, no more', () => {
		const debt = 1_428_570_000_000_000_000_000n;
		const r = sizeSeizure(debt, debt, ONE_XAUT, 142_856_000_000n, PENALTY, XAUT_SCALE, DISCOUNT);
		expect(r.ok && r.repay).toBe(1_428_550_000_000_000_000_000n);
		expect(r.ok && debt - r.repay).toBe(2n * 10_000_000_000_000_000n);
	});

	it('test_partialBelowPenaltyBandIsProRataOnEveryPath: half the debt takes half the gold', () => {
		const r = sizeSeizure(1000n * WAD, 2000n * WAD, 750_000n, 274_667_000_000n, PENALTY, XAUT_SCALE, DISCOUNT);
		expect(r.ok && r.seize).toBe(375_000n);
		expect(r.ok && r.repay).toBe(1000n * WAD);
	});

	it('test_partialJustAbovePenaltyBandIsAccepted: sized at the full penalty multiple, gold left behind', () => {
		const price = 284_000_000_000n;
		const r = sizeSeizure(1500n * WAD, 2000n * WAD, 750_000n, price, PENALTY, XAUT_SCALE, DISCOUNT);
		const seize = (1500n * WAD * (PPM + PENALTY) * 100_000_000n) / (price * XAUT_SCALE * PPM);
		expect(r).toEqual({ ok: true, repay: 1500n * WAD, seize, debtEquivalent: (1500n * WAD * 100_000_000n) / (price * XAUT_SCALE) });
		expect(seize).toBeLessThan(750_000n);
	});

	it('test_oneWeiPoolAbsorbIsRefused: a repayment that moves no collateral', () => {
		expect(sizeSeizure(1n, 2000n * WAD, 750_000n, 292_000_000_000n, PENALTY, XAUT_SCALE, DISCOUNT)).toEqual({
			ok: false,
			reason: 'Liquidation too small',
		});
	});

	it('test_thinVaultLargerThanThePoolIsWorkedDownProRata: 50,000 of 100,000 takes 20 of 40 PAXG', () => {
		const r = sizeSeizure(50_000n * WAD, 100_000n * WAD, 40n * WAD, toPrice8(2600), PENALTY, 1n, DISCOUNT);
		expect(r.ok && r.seize).toBe(20n * WAD);
	});

	it('test_directThinPartialAndThenFullBookNoBadDebt: 30,000 takes 12 PAXG, then the rest takes all 28', () => {
		const partial = sizeSeizure(30_000n * WAD, 100_000n * WAD, 40n * WAD, toPrice8(2600), PENALTY, 1n, DISCOUNT);
		expect(partial.ok && partial.seize).toBe(12n * WAD);
		const full = sizeSeizure(70_000n * WAD, 70_000n * WAD, 28n * WAD, toPrice8(2600), PENALTY, 1n, DISCOUNT);
		expect(full.ok && full.repay).toBe(70_000n * WAD);
		expect(full.ok && full.seize).toBe(28n * WAD);
	});

	it('test_underwaterPartialIsStillRefused, and the full liquidation at 96% repays the discounted gold', () => {
		expect(sizeSeizure(50_000n * WAD, 100_000n * WAD, 40n * WAD, toPrice8(2400), PENALTY, 1n, DISCOUNT)).toEqual({
			ok: false,
			reason: 'Thin vault: liquidate in full',
		});
		const full = sizeSeizure(100_000n * WAD, 100_000n * WAD, 40n * WAD, toPrice8(2400), PENALTY, 1n, DISCOUNT);
		// 96,000 of gold less 2% is 94,080, above the 2c - d figure of 92,000.
		expect(full.ok && full.repay).toBe(94_080n * WAD);
		expect(full.ok && full.seize).toBe(40n * WAD);
	});

	it('liquidationSeizure passes a refusal through instead of sizing anything', () => {
		expect(liquidationSeizure(50_000n * WAD, 100_000n * WAD, toPrice8(2400), 40n * WAD, PENALTY, 600_000n)).toEqual({
			ok: false,
			reason: 'Thin vault: liquidate in full',
		});
	});
});

/**
 * GoldStabilityReserve parity. The simulator ran a 0.30% top
 * tier that setSpreadCurve refuses and priced every swap at the tier it started on. The
 * vectors are the reserve's own cases in contracts/test/GoldStabilityReserve.test.ts.
 */
describe('the reserve spread matches GoldStabilityReserve', () => {
	/** contracts/scripts/lib/deployCeremony.ts: the curve every deployment sets. */
	const DEPLOYED_CURVE = {
		steps: [
			[150_000n, 5_000n],
			[100_000n, 5_000n],
			[50_000n, 7_500n],
			[20_000n, 12_500n],
		],
		restrictedSpreadPpm: 20_000n,
	} as const;

	it('the default curve is the deployed one', () => {
		expect(DEFAULT_SPREAD_CURVE).toEqual(DEPLOYED_CURVE);
	});

	it('every default step lies inside [MIN_SPREAD_PPM, MAX_SPREAD_PPM] and setSpreadCurve would accept the curve', () => {
		for (const [, spread] of DEFAULT_SPREAD_CURVE.steps) {
			expect(spread).toBeGreaterThanOrEqual(5_000n);
			expect(spread).toBeLessThanOrEqual(50_000n);
		}
		expect(spreadCurveRefusal(DEFAULT_SPREAD_CURVE)).toBeUndefined();
	});

	it('refuses each curve setSpreadCurve refuses, with its reason', () => {
		const ok = (steps: Array<readonly [bigint, bigint]>, restricted = 20_000n) => ({ steps, restrictedSpreadPpm: restricted });
		expect(spreadCurveRefusal(ok([[150_000n, 3_000n]]))).toBe('Spread out of range');
		expect(spreadCurveRefusal(ok([[150_000n, 5_000n]], 60_000n))).toBe('Restricted spread out of range');
		expect(spreadCurveRefusal(ok([[100_000n, 5_000n], [150_000n, 7_500n]]))).toBe('Steps must descend in coverage');
		expect(spreadCurveRefusal(ok([[150_000n, 7_500n], [100_000n, 5_000n]]))).toBe('Spreads must ascend');
		expect(spreadCurveRefusal(ok([[150_000n, 30_000n]], 20_000n))).toBe('Step exceeds restricted spread');
		const nine = Array.from({ length: 9 }, (_, i) => [BigInt(900_000 - i * 50_000), 5_000n] as const);
		expect(spreadCurveRefusal(ok(nine))).toBe('Too many steps');
	});

	it('"prices a swap at the tier of the coverage it leaves behind": 2,000 GSUSD from 10% pays 0.75%', () => {
		const reserve = 100_000n * WAD; // 50 PAXG at $2,000
		const circulating = 1_000_000n * WAD;
		expect(swapSpreadPpm(reserve, 0n, circulating, DEPLOYED_CURVE)).toBe(5_000n);
		expect(swapSpreadPpm(reserve, 2_000n * WAD, circulating, DEPLOYED_CURVE)).toBe(7_500n);
	});

	it('a swap at least as large as the reserve pays the restricted spread, and nothing in circulation the top tier', () => {
		expect(swapSpreadPpm(100n * WAD, 200n * WAD, 1_000n * WAD, DEPLOYED_CURVE)).toBe(20_000n);
		expect(swapSpreadPpm(0n, 0n, 0n, DEPLOYED_CURVE)).toBe(5_000n);
	});

	it('dampedCirculatingSupply is the higher of live and smoothed supply, each net of the reserve inventory', () => {
		// A burn today: live 98, smoothed still 100, inventory 5.
		expect(dampedCirculatingSupply(98n * WAD, 100n * WAD, 5n * WAD)).toBe(95n * WAD);
		// A mint today: live leads.
		expect(dampedCirculatingSupply(102n * WAD, 100n * WAD, 5n * WAD)).toBe(97n * WAD);
		// Inventory above either figure floors at zero, as circulatingSupply() does.
		expect(dampedCirculatingSupply(3n * WAD, 2n * WAD, 5n * WAD)).toBe(0n);
	});
});
