import type { LooperSpec } from './loopers';
import type { Asset } from './state';

export interface PriceShock {
	day: number;
	/** Multiplicative move applied to the market gold price, e.g. −0.10. */
	pct: number;
}

export interface DemandShock {
	day: number;
	/**
	 * The pool price sellers (or buyers) push towards and then stop. A fixed notional
	 * dumped regardless of price is not how sellers behave and, into a constant-product
	 * pool, produced $0.02 prints that were arithmetic, not economics. Bounded by what
	 * holders actually hold.
	 */
	targetPrice: number;
}

export interface Scenario {
	name: string;
	days: number;
	/** Initial GSUSD supply in USD. */
	supplyUsd: number;
	/** Initial GSR redeemable gold as a fraction of supply. */
	gsrCoverage: number;
	/** Initial pool depth, USDC side, in USD. */
	dexDepthUsd: number;
	/** Daily gold volatility (stdev of log return). */
	goldDailyVol: number;
	goldShocks: PriceShock[];
	/** Oracle reports the market price from `lagDays` ago. */
	oracleLagDays: number;
	/** Days on which an asset's oracle is impaired (all price paths for it pause). */
	impairment?: { asset: Asset; from: number; to: number };
	demandShocks: DemandShock[];
	phase2: boolean;
	/** Share of vaults collateralised in XAUT rather than PAXG. */
	xautShare: number;
	/** Leverage loopers (loopers.ts). Absent in every scenario of the committed grid. */
	loopers?: LooperSpec;
	/**
	 * Draw the gold path from its own random stream, so that agent behaviour cannot
	 * shift it. A looper scenario and its paired baseline set this and so see the same
	 * gold prices day by day. Absent (shared stream) in the committed grid.
	 */
	independentGoldPath?: boolean;
	/** See Params.proRataLiquidationFill. */
	proRataLiquidationFill?: boolean;
}

const BASE: Omit<Scenario, 'name'> = {
	days: 120,
	supplyUsd: 100_000_000,
	gsrCoverage: 0.1,
	dexDepthUsd: 5_000_000,
	goldDailyVol: 0.009, // ≈ 15% annualised
	goldShocks: [],
	oracleLagDays: 0,
	demandShocks: [],
	phase2: false,
	xautShare: 0.2,
};

/** Sellers push the pool down to `price` on `day`. */
const sellTo = (day: number, price: number): DemandShock => ({ day, targetPrice: price });
/**
 * A run: sellers return every day for `days` and push to `price` each time. This is
 * how SAI (2019) and GHO (2023) actually failed — not one bad day, but weeks of net
 * outflow that dip-buyers stopped absorbing. It is the shape the reserve must be
 * sized against.
 */
const sustained = (from: number, days: number, price: number): DemandShock[] =>
	Array.from({ length: days }, (_, i) => sellTo(from + i, price));
/** Buyers push the pool up to `price` on `day`. */
const buyTo = (day: number, price: number): DemandShock => ({ day, targetPrice: price });

/** The scenario grid from docs/PEG_ARCHITECTURE.md and the external brief. */
export const SCENARIOS: Scenario[] = [
	{ ...BASE, name: 'calm-at-peg' },
	{ ...BASE, name: 'drift-to-0.99', demandShocks: [sellTo(10, 0.995), sellTo(20, 0.99), sellTo(30, 0.99)] },
	{ ...BASE, name: 'shock-to-0.95', demandShocks: [sellTo(10, 0.95)] },
	{ ...BASE, name: 'severe-0.90', demandShocks: [sellTo(10, 0.9)] },
	{ ...BASE, name: 'premium-1.01', demandShocks: [buyTo(10, 1.01)] },
	{ ...BASE, name: 'premium-1.05', demandShocks: [buyTo(10, 1.05)] },
	{ ...BASE, name: 'premium-1.05-phase2', demandShocks: [buyTo(10, 1.05)], phase2: true },
	{ ...BASE, name: 'sustained-outflow', demandShocks: sustained(10, 30, 0.97) },
	{ ...BASE, name: 'refill-after-recovery', demandShocks: [sellTo(10, 0.93), buyTo(40, 1.03), buyTo(50, 1.03)], phase2: true },
	{ ...BASE, name: 'oracle-lag-3d', oracleLagDays: 3, demandShocks: [sellTo(10, 0.95)], goldShocks: [{ day: 12, pct: 0.08 }] },
	{ ...BASE, name: 'paxg-impaired', impairment: { asset: 'PAXG', from: 10, to: 20 }, demandShocks: [sellTo(12, 0.95)] },
	{ ...BASE, name: 'xaut-impaired', impairment: { asset: 'XAUT', from: 10, to: 20 }, demandShocks: [sellTo(12, 0.95)] },
	{ ...BASE, name: 'gold-minus-10', goldShocks: [{ day: 10, pct: -0.1 }] },
	{ ...BASE, name: 'gold-minus-10-x2', goldShocks: [{ day: 10, pct: -0.1 }, { day: 11, pct: -0.1 }] },
	{ ...BASE, name: 'gold-plus-10', goldShocks: [{ day: 10, pct: 0.1 }] },
	{ ...BASE, name: 'dex-depth-shock', dexDepthUsd: 500_000, demandShocks: [sellTo(10, 0.95)] },
	// Coverage sweep under a 20-day run to $0.96: the depth question, directly. One-day
	// shocks are absorbed by dip-buyers with or without a reserve; a run is not.
	{ ...BASE, name: 'run-cov-0pct', gsrCoverage: 0, demandShocks: sustained(10, 20, 0.96) },
	{ ...BASE, name: 'run-cov-1pct', gsrCoverage: 0.01, demandShocks: sustained(10, 20, 0.96) },
	{ ...BASE, name: 'run-cov-5pct', gsrCoverage: 0.05, demandShocks: sustained(10, 20, 0.96) },
	{ ...BASE, name: 'run-cov-10pct', gsrCoverage: 0.1, demandShocks: sustained(10, 20, 0.96) },
	{ ...BASE, name: 'run-cov-25pct', gsrCoverage: 0.25, demandShocks: sustained(10, 20, 0.96) },
	{ ...BASE, name: 'run-cov-50pct', gsrCoverage: 0.5, demandShocks: sustained(10, 20, 0.96) },
	...[0, 0.01, 0.05, 0.1, 0.25, 0.5].map((c) => ({
		...BASE,
		name: `mild-${c === 0 ? 0 : c * 100}pct`,
		gsrCoverage: c,
		demandShocks: sustained(10, 10, 0.98),
	})),
	...[0, 0.01, 0.05, 0.1, 0.25, 0.5].map((c) => ({
		...BASE,
		name: `severe-${c === 0 ? 0 : c * 100}pct`,
		gsrCoverage: c,
		demandShocks: sustained(10, 30, 0.93),
	})),
	// Intraday depth at a one-day shock, for completeness.
	{ ...BASE, name: 'coverage-1pct-shock', gsrCoverage: 0.01, demandShocks: [sellTo(10, 0.95)] },
	{ ...BASE, name: 'coverage-25pct-shock', gsrCoverage: 0.25, demandShocks: [sellTo(10, 0.95)] },
	// Scale sweep.
	{ ...BASE, name: 'supply-10m-shock', supplyUsd: 10_000_000, dexDepthUsd: 500_000, demandShocks: [sellTo(10, 0.95)] },
	{ ...BASE, name: 'supply-1b-shock', supplyUsd: 1_000_000_000, dexDepthUsd: 50_000_000, demandShocks: [sellTo(10, 0.95)] },
	{ ...BASE, name: 'supply-10b-shock', supplyUsd: 10_000_000_000, dexDepthUsd: 500_000_000, demandShocks: [sellTo(10, 0.95)] },
	// The control: no reserve at all. What the no-floor design looks like.
	{ ...BASE, name: 'NO-RESERVE-shock', gsrCoverage: 0, demandShocks: [sellTo(10, 0.95)] },
	{ ...BASE, name: 'NO-RESERVE-severe', gsrCoverage: 0, demandShocks: [sellTo(10, 0.9)] },
	{ ...BASE, name: 'NO-RESERVE-sustained', gsrCoverage: 0, demandShocks: sustained(10, 30, 0.97) },
];

// ---------------------------------------------------------------------------
// Leverage loopers. Kept out of SCENARIOS so the committed grid and RESULTS.md are
// unchanged; run with `npx nx grid peg-sim --loopers`. Each is compared with its
// paired baseline (pairedBaseline below): the same scenario, the same gold path and
// no loopers.
// ---------------------------------------------------------------------------

/** Every looper scenario shares the gold stream with its baseline and fills liquidations pro rata. */
const LOOP: Pick<Scenario, 'independentGoldPath' | 'proRataLiquidationFill'> = {
	independentGoldPath: true,
	proRataLiquidationFill: true,
};
const minus10: PriceShock[] = [{ day: 10, pct: -0.1 }];
const minus10x2: PriceShock[] = [{ day: 10, pct: -0.1 }, { day: 11, pct: -0.1 }];
const plus10: PriceShock[] = [{ day: 10, pct: 0.1 }];
/** All looped debt at the 130% minimum: the clustered edge book. */
const MAX_LOOP = { targetRatiosPpm: [1_300_000n] };
/** A top-up band no gold move reaches: the loopers never act. */
const INERT = { topUpBandPpm: 1_000_000_000n };

export const LOOPER_SCENARIOS: Scenario[] = [
	{ ...BASE, ...LOOP, name: 'loop-10pct-calm', loopers: { shareOfSupply: 0.1 } },
	{ ...BASE, ...LOOP, name: 'loop-30pct-calm', loopers: { shareOfSupply: 0.3 } },
	// Controls: the same looped book that never tops up. What is left is the effect of
	// the composition alone (a looper's GSUSD sits with holders and it has none to repay with).
	{ ...BASE, ...LOOP, name: 'loop-10pct-calm-inert', loopers: { shareOfSupply: 0.1, ...INERT } },
	{ ...BASE, ...LOOP, name: 'loop-30pct-calm-inert', loopers: { shareOfSupply: 0.3, ...INERT } },
	{ ...BASE, ...LOOP, name: 'loop-30pct-gold-minus-10', goldShocks: minus10, loopers: { shareOfSupply: 0.3 } },
	{ ...BASE, ...LOOP, name: 'loop-30pct-gold-minus-10-x2', goldShocks: minus10x2, loopers: { shareOfSupply: 0.3 } },
	{ ...BASE, ...LOOP, name: 'loop-30pct-gold-plus-10', goldShocks: plus10, loopers: { shareOfSupply: 0.3 } },
	{ ...BASE, ...LOOP, name: 'loop-30pct-max-gold-minus-10-x2', goldShocks: minus10x2, loopers: { shareOfSupply: 0.3, ...MAX_LOOP } },
	// The same crash with the grid's original liquidation fill, to show how much of the
	// bad debt comes from the model's liquidator rather than from the loopers.
	{ ...BASE, independentGoldPath: true, name: 'loop-30pct-gold-minus-10-x2-legacy-fill', goldShocks: minus10x2, loopers: { shareOfSupply: 0.3 } },
	// Loopers arrive with equity only and build the loop through the modelled venues.
	{ ...BASE, ...LOOP, name: 'loop-10pct-buildup', loopers: { shareOfSupply: 0.1, start: 'unlevered' } },
	{ ...BASE, ...LOOP, name: 'loop-30pct-buildup', loopers: { shareOfSupply: 0.3, start: 'unlevered' } },
];

/** The comparison run for a looper scenario: identical except that it has no loopers. */
export function pairedBaseline(scenario: Scenario): Scenario {
	return { ...scenario, name: `${scenario.name}~baseline`, loopers: undefined };
}
