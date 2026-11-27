import type { RunResult } from './run';

export function fmtUsd(n: number): string {
	if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}bn`;
	if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}m`;
	if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
	return `$${n.toFixed(0)}`;
}

interface Aggregate {
	scenario: string;
	runs: number;
	minPrice: number;
	maxDevPct: number;
	daysBelow099: number;
	recovery: string;
	exhaustedDays: number;
	goldOut: number;
	goldIn: number;
	arb: number;
	revenue: number;
	violations: number;
}

/** Average the seeds per scenario; report the worst-case price and the mean elsewhere. */
export function aggregate(results: RunResult[]): Aggregate[] {
	const by = new Map<string, RunResult[]>();
	for (const r of results) by.set(r.scenario, [...(by.get(r.scenario) ?? []), r]);
	const rows: Aggregate[] = [];
	for (const [scenario, runs] of by) {
		const m = runs.map((r) => r.metrics);
		const mean = (f: (x: (typeof m)[number]) => number) => m.reduce((a, x) => a + f(x), 0) / m.length;
		const longest = Math.max(...m.map((x) => x.longestExcursionDays));
		const allRecovered = m.every((x) => x.endedRecovered);
		const recovery = longest === 0 ? 'held' : allRecovered ? `${longest}d then recovered` : `NO (${longest}d+)`;
		rows.push({
			scenario,
			runs: runs.length,
			minPrice: Math.min(...m.map((x) => x.minPrice)),
			maxDevPct: Math.max(...m.map((x) => x.maxDeviationBelowPct)),
			daysBelow099: Math.round(mean((x) => x.daysBelow099)),
			recovery,
			exhaustedDays: Math.round(mean((x) => x.gsrExhaustedDays)),
			goldOut: mean((x) => x.goldOutUsd),
			goldIn: mean((x) => x.goldInUsd),
			arb: mean((x) => x.arbProfitUsd),
			revenue: mean((x) => x.spreadRevenueUsd),
			violations: m.reduce((a, x) => a + x.identityViolations + x.ledgerViolations, 0),
		});
	}
	return rows;
}

export function markdownSummary(results: RunResult[], title = 'peg-sim results'): string {
	const rows = aggregate(results);
	const lines = [
		`# ${title}`,
		'',
		`Seeds per scenario: ${rows[0]?.runs ?? 0}. Worst-case price and deviation across seeds; means elsewhere.`,
		'',
		'| Scenario | Low | Max dev | Days <0.99 | Recovery | GSR exhausted (days) | Gold out | Gold in | Arb profit | Spread revenue | Invariant violations |',
		'|---|---|---|---|---|---|---|---|---|---|---|',
		...rows.map(
			(r) =>
				`| ${r.scenario} | ${r.minPrice.toFixed(4)} | ${r.maxDevPct.toFixed(2)}% | ${r.daysBelow099} | ${r.recovery} | ${r.exhaustedDays} | ${fmtUsd(r.goldOut)} | ${fmtUsd(r.goldIn)} | ${fmtUsd(r.arb)} | ${fmtUsd(r.revenue)} | ${r.violations} |`
		),
		'',
		'Reading the table:',
		'- **Low / Max dev** is the intraday low across seeds: what a holder could actually have sold at.',
		'- **Recovery**: "held" = no close under 0.99; "Nd then recovered" = longest excursion under 0.99 lasted N days and the run ended at or above 0.995; "NO" = the run ended still below peg.',
		'- **GSR exhausted** counts days the redeemable reserve was zero: the floor-absent state.',
		'- **Gold in** with Phase 2 off is penalty share only; with Phase 2 on it includes above-peg inflows.',
		'- **Invariant violations** must be 0 except where bad debt was written off, which the model records deliberately.',
		'',
	];
	return lines.join('\n');
}

interface SweepRow {
	key: string;
	label: string;
}

function sweepTable(rows: ReturnType<typeof aggregate>, title: string, order: SweepRow[]): string {
	const lines = [`## ${title}`, '', '| GSR coverage | Low | Days <0.99 | Recovery | Exhausted days | Gold out |', '|---|---|---|---|---|---|'];
	for (const { key, label } of order) {
		const r = rows.find((x) => x.scenario === key);
		if (!r) continue;
		lines.push(`| ${label} | ${r.minPrice.toFixed(4)} | ${r.daysBelow099} | ${r.recovery} | ${r.exhaustedDays} | ${fmtUsd(r.goldOut)} |`);
	}
	lines.push('');
	return lines.join('\n');
}

const COV = (prefix: string): SweepRow[] => [
	{ key: `${prefix}-0pct`, label: '0% (no floor)' },
	{ key: `${prefix}-1pct`, label: '1%' },
	{ key: `${prefix}-5pct`, label: '5%' },
	{ key: `${prefix}-10pct`, label: '10%' },
	{ key: `${prefix}-25pct`, label: '25%' },
	{ key: `${prefix}-50pct`, label: '50%' },
];

/** Reserve depth under three run severities: the parameter the project must size first. */
export function coverageTable(results: RunResult[]): string {
	const rows = aggregate(results);
	return [
		sweepTable(rows, 'Reserve depth: mild run (10 days, sellers push to $0.98)', COV('mild')),
		sweepTable(rows, 'Reserve depth: base run (20 days, sellers push to $0.96)', COV('run-cov')),
		sweepTable(rows, 'Reserve depth: severe run (30 days, sellers push to $0.93)', COV('severe')),
		recommendation(rows),
	].join('\n');
}

/** The smallest coverage at which each run severity is held at the close, if any. */
function recommendation(rows: ReturnType<typeof aggregate>): string {
	const pick = (prefix: string): string => {
		for (const { key, label } of COV(prefix)) {
			const r = rows.find((x) => x.scenario === key);
			if (r && r.daysBelow099 === 0 && r.exhaustedDays === 0) return label;
		}
		return 'none in the sweep';
	};
	return [
		'## Smallest coverage that holds the close above $0.99 with no exhaustion',
		'',
		'| Run severity | Coverage |',
		'|---|---|',
		`| Mild (10d to $0.98) | ${pick('mild')} |`,
		`| Base (20d to $0.96) | ${pick('run-cov')} |`,
		`| Severe (30d to $0.93) | ${pick('severe')} |`,
		'',
		'These are model outputs under the behavioural assumptions in `DEFAULT_PARAMS`, not',
		'protocol parameters. The project chooses which severity the reserve must withstand;',
		'the table says what that costs in coverage. Beyond the holding level, extra coverage',
		'bought nothing in any sweep: the binding limit becomes the daily cap, not depth.',
		'',
	].join('\n');
}
