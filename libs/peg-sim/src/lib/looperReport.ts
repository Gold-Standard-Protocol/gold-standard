import { fmtUsd } from './report';
import { runGrid, type RunResult } from './run';
import { LOOPER_SCENARIOS, pairedBaseline, type Scenario } from './scenarios';

export interface LooperPair {
	looper: string;
	baseline: string;
}

export interface LooperGrid {
	results: RunResult[];
	pairs: LooperPair[];
}

/** Runs each looper scenario beside its paired baseline (same gold path, no loopers). */
export function looperGrid(seeds: number[], scenarios: Scenario[] = LOOPER_SCENARIOS): LooperGrid {
	const runs: Scenario[] = [];
	const pairs: LooperPair[] = [];
	for (const s of scenarios) {
		const b = pairedBaseline(s);
		runs.push(s, b);
		pairs.push({ looper: s.name, baseline: b.name });
	}
	return { results: runGrid(runs, seeds), pairs };
}

interface Row {
	name: string;
	low: number;
	high: number;
	daysBelow099: number;
	goldOut: number;
	redeemableMin: number;
	redeemableEnd: number;
	minCoverage: number;
	maxSpreadPpm: number;
	exhaustedDays: number;
	liquidated: number;
	badAbsorbed: number;
	badUnbacked: number;
	bufferEnd: number;
	fees: number;
	peakBelowLiq: number;
	belowLiqEnd: number;
	underwaterEnd: number;
	looper?: {
		debtStart: number;
		debtEnd: number;
		shareEnd: number;
		minted: number;
		toReserve: number;
		toMarket: number;
		reserveGold: number;
		vaults: number;
		vaultsLiquidated: number;
		liquidated: number;
		badDebt: number;
		equityEnd: number;
		holdEnd: number;
		equityStart: number;
	};
}

function mean(xs: number[]): number {
	return xs.length === 0 ? 0 : xs.reduce((a, x) => a + x, 0) / xs.length;
}

function row(name: string, runs: RunResult[]): Row {
	const m = runs.map((r) => r.metrics);
	const s = runs.map((r) => r.system);
	const l = runs.map((r) => r.loopers).filter((x): x is NonNullable<typeof x> => x !== undefined);
	return {
		name,
		low: Math.min(...m.map((x) => x.minPrice)),
		high: Math.max(...m.map((x) => x.maxPrice)),
		daysBelow099: mean(m.map((x) => x.daysBelow099)),
		goldOut: mean(m.map((x) => x.goldOutUsd)),
		redeemableMin: mean(m.map((x) => x.gsrMinRedeemableUsd)),
		redeemableEnd: mean(s.map((x) => x.gsrRedeemableEndUsd)),
		minCoverage: Math.min(...s.map((x) => x.minCoverage)),
		maxSpreadPpm: Math.max(...s.map((x) => x.maxSpreadPpm)),
		exhaustedDays: mean(m.map((x) => x.gsrExhaustedDays)),
		liquidated: mean(m.map((x) => x.liquidatedUsd)),
		badAbsorbed: mean(s.map((x) => x.badDebtAbsorbedUsd)),
		badUnbacked: mean(s.map((x) => x.badDebtUnbackedUsd)),
		bufferEnd: mean(s.map((x) => x.insuranceEndUsd)),
		fees: mean(s.map((x) => x.feesReceivedUsd)),
		peakBelowLiq: mean(s.map((x) => x.peakDebtBelowLiquidationUsd)),
		belowLiqEnd: mean(s.map((x) => x.debtBelowLiquidationEndUsd)),
		underwaterEnd: mean(s.map((x) => x.debtUnderwaterEndUsd)),
		looper:
			l.length === 0
				? undefined
				: {
						debtStart: mean(l.map((x) => x.debtStartUsd)),
						debtEnd: mean(l.map((x) => x.debtEndUsd)),
						shareEnd: mean(l.map((x) => x.shareOfSupplyEnd)),
						minted: mean(l.map((x) => x.mintedUsd)),
						toReserve: mean(l.map((x) => x.soldToReserveUsd)),
						toMarket: mean(l.map((x) => x.soldToMarketUsd)),
						reserveGold: mean(l.map((x) => x.goldFromReserveUsd)),
						vaults: mean(l.map((x) => x.vaults)),
						vaultsLiquidated: mean(l.map((x) => x.vaultsLiquidated)),
						liquidated: mean(l.map((x) => x.liquidatedDebtUsd)),
						badDebt: mean(l.map((x) => x.badDebtUsd)),
						equityEnd: mean(l.map((x) => x.equityEndUsd)),
						holdEnd: mean(l.map((x) => x.holdEquityEndUsd)),
						equityStart: mean(l.map((x) => x.equityStartUsd)),
					},
	};
}

function rowsFor(results: RunResult[], name: string): Row {
	const runs = results.filter((r) => r.scenario === name);
	if (runs.length === 0) throw new Error(`looperReport: no runs for ${name}`);
	return row(name, runs);
}

const pct = (x: number, dp = 1): string => `${(x * 100).toFixed(dp)}%`;
/** Highs from the base model's repay buy-backs can run to six figures; they are shown so the artefact stays visible. */
const fmtHigh = (x: number): string => (x < 10 ? x.toFixed(4) : x.toLocaleString('en-GB', { maximumFractionDigits: 0 }));

/** Three tables, each looper scenario directly above its paired baseline. */
export function looperSummary(results: RunResult[], pairs: LooperPair[]): string {
	const seeds = new Set(results.map((r) => r.seed)).size;
	const peg: string[] = [
		'## Peg and reserve',
		'',
		'| Scenario | Low | High | Days <0.99 | Reserve gold out | Redeemable min | Redeemable end | Min coverage | Max spread | Exhausted days |',
		'|---|---|---|---|---|---|---|---|---|---|',
	];
	const credit: string[] = [
		'## Liquidations, bad debt and the buffer',
		'',
		'| Scenario | Liquidated debt | Peak debt below 110% | Debt below 110% at end | of which below 100% | Bad debt absorbed | Bad debt unbacked | Buffer end | Fees received |',
		'|---|---|---|---|---|---|---|---|---|',
	];
	const loop: string[] = [
		'## Looper flows and outcome',
		'',
		'| Scenario | Looped debt start | Looped debt end (share of supply) | Minted in run | Sold to reserve | Sold to pool | Reserve gold taken | Vaults liquidated | Looper liquidated debt | Looper bad debt | Looper equity end | Same equity held as PAXG |',
		'|---|---|---|---|---|---|---|---|---|---|---|---|',
	];
	for (const pair of pairs) {
		for (const r of [rowsFor(results, pair.looper), rowsFor(results, pair.baseline)]) {
			peg.push(
				`| ${r.name} | ${r.low.toFixed(4)} | ${fmtHigh(r.high)} | ${r.daysBelow099.toFixed(1)} | ${fmtUsd(r.goldOut)} | ${fmtUsd(r.redeemableMin)} | ${fmtUsd(r.redeemableEnd)} | ${pct(r.minCoverage, 2)} | ${(r.maxSpreadPpm / 1e4).toFixed(2)}% | ${r.exhaustedDays.toFixed(1)} |`
			);
			credit.push(
				`| ${r.name} | ${fmtUsd(r.liquidated)} | ${fmtUsd(r.peakBelowLiq)} | ${fmtUsd(r.belowLiqEnd)} | ${fmtUsd(r.underwaterEnd)} | ${fmtUsd(r.badAbsorbed)} | ${fmtUsd(r.badUnbacked)} | ${fmtUsd(r.bufferEnd)} | ${fmtUsd(r.fees)} |`
			);
			const x = r.looper;
			if (x) {
				loop.push(
					`| ${r.name} | ${fmtUsd(x.debtStart)} | ${fmtUsd(x.debtEnd)} (${pct(x.shareEnd)}) | ${fmtUsd(x.minted)} | ${fmtUsd(x.toReserve)} | ${fmtUsd(x.toMarket)} | ${fmtUsd(x.reserveGold)} | ${x.vaultsLiquidated.toFixed(1)} of ${x.vaults.toFixed(0)} | ${fmtUsd(x.liquidated)} | ${fmtUsd(x.badDebt)} | ${fmtUsd(x.equityEnd)} (start ${fmtUsd(x.equityStart)}) | ${fmtUsd(x.holdEnd)} |`
				);
			}
		}
	}
	return [
		'# GSUSD peg-sim: leverage loopers against paired baselines',
		'',
		`Seeds per scenario: ${seeds}. Low and High are the lowest and highest intraday prints across seeds; everything else is the mean.`,
		"High mostly reflects the base model's repay buy-backs (see the README), not a market price. Loopers never sell into a pool that pays more than par, so it adds nothing to their equity.",
		'A paired baseline (`~baseline`) is the same scenario with the same gold path and no loopers.',
		'',
		...peg,
		'',
		...credit,
		'',
		...loop,
		'',
	].join('\n');
}
