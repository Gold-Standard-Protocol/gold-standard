import { toNumber18 } from './mechanics';
import type { World } from './state';

export interface DayRecord {
	day: number;
	/** Close: after every agent has acted. */
	price: number;
	/** Intraday low and high, sampled after each agent group. The low is what a holder saw. */
	low: number;
	high: number;
	goldPrice: number;
	supply: number;
	circulating: number;
	gsrGoldUsd: number;
	gsrRedeemableUsd: number;
	gsrInventory: number;
	gsrIssued: number;
	coverage: number;
	spreadPpm: number;
	insuranceGsusd: number;
	vaults: number;
	identityOk: boolean;
	ledgerOk: boolean;
}

export interface Metrics {
	minPrice: number;
	maxPrice: number;
	maxDeviationBelowPct: number;
	daysBelow099: number;
	daysBelow095: number;
	/** Longest contiguous run of closes below 0.99. */
	longestExcursionDays: number;
	/** True if the final close is at or above 0.995. */
	endedRecovered: boolean;
	gsrMinRedeemableUsd: number;
	gsrExhaustedDays: number;
	goldInUsd: number;
	goldOutUsd: number;
	arbProfitUsd: number;
	spreadRevenueUsd: number;
	supplyStart: number;
	supplyEnd: number;
	repaidUsd: number;
	liquidatedUsd: number;
	identityViolations: number;
	ledgerViolations: number;
}

export function snapshot(world: World, extra: { gsrGoldUsd: number; gsrRedeemableUsd: number; coverage: number; spreadPpm: number; price: number; low: number; high: number; goldPrice: number; identityOk: boolean; ledgerOk: boolean }): DayRecord {
	return {
		day: world.day,
		price: extra.price,
		low: extra.low,
		high: extra.high,
		goldPrice: extra.goldPrice,
		supply: toNumber18(world.supply18),
		circulating: toNumber18(world.supply18 - world.gsr.gsusdInventory18 - world.insurance.gsusd18),
		gsrGoldUsd: extra.gsrGoldUsd,
		gsrRedeemableUsd: extra.gsrRedeemableUsd,
		gsrInventory: toNumber18(world.gsr.gsusdInventory18),
		gsrIssued: toNumber18(world.gsr.issued18),
		coverage: extra.coverage,
		spreadPpm: extra.spreadPpm,
		insuranceGsusd: toNumber18(world.insurance.gsusd18),
		vaults: world.vaults.length,
		identityOk: extra.identityOk,
		ledgerOk: extra.ledgerOk,
	};
}

export function computeMetrics(series: DayRecord[], world: World, goldPriceAvg: number): Metrics {
	const lows = series.map((d) => d.low);
	const closes = series.map((d) => d.price);
	const minPrice = Math.min(...lows);
	const maxPrice = Math.max(...series.map((d) => d.high));
	// The longest stretch of closes under 0.99, and whether the run ENDS recovered. The
	// first version measured only the first breach and reported "never left" beside a
	// $0.00 low, because the first dip happened to close above 0.995.
	let longest = 0;
	let current = 0;
	for (const c of closes) {
		current = c < 0.99 ? current + 1 : 0;
		if (current > longest) longest = current;
	}
	const endedRecovered = (closes[closes.length - 1] ?? 0) >= 0.995;
	const l = world.ledgers;
	const goldIn = toNumber18(l.goldInToGsr18.PAXG + l.goldInToGsr18.XAUT) * goldPriceAvg;
	const goldOut = toNumber18(l.goldOutOfGsr18.PAXG + l.goldOutOfGsr18.XAUT) * goldPriceAvg;
	return {
		minPrice,
		maxPrice,
		maxDeviationBelowPct: Math.max(0, (1 - minPrice) * 100),
		daysBelow099: closes.filter((p) => p < 0.99).length,
		daysBelow095: closes.filter((p) => p < 0.95).length,
		longestExcursionDays: longest,
		endedRecovered,
		gsrMinRedeemableUsd: Math.min(...series.map((d) => d.gsrRedeemableUsd)),
		gsrExhaustedDays: series.filter((d) => d.gsrRedeemableUsd <= 1).length,
		goldInUsd: goldIn,
		goldOutUsd: goldOut,
		arbProfitUsd: l.arbProfitUsd,
		spreadRevenueUsd: toNumber18(l.spreadRevenue18),
		supplyStart: series[0]?.supply ?? 0,
		supplyEnd: series[series.length - 1]?.supply ?? 0,
		repaidUsd: toNumber18(l.repaid18),
		liquidatedUsd: toNumber18(l.liquidatedDebt18),
		identityViolations: l.identityViolations,
		ledgerViolations: l.ledgerViolations,
	};
}
