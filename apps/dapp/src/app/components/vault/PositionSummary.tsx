import { useMemo } from 'react';
import { formatUnits } from 'viem';
import { HEALTH_TEXT, healthStatus, type RiskRatios } from '../../lib/riskDefaults';

interface PositionSummaryProps {
	/** The collateral's governed ratios, which set the colour bands. */
	ratios: RiskRatios;
	currentRatioPercent: number;
	newRatioPercent: number;
	currentLiquidationPrice: number;
	newLiquidationPrice: number;
	currentDebt: bigint;
	newDebt: bigint;
	isValid: boolean;
	errorMessage?: string;
	/** A remark on an action that will go through, shown without the error treatment. */
	note?: string;
}

function formatUsd(value: number): string {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(value);
}

/**
 * Ratios go asymptotic as debt approaches zero: repaying down to the last GSUSD of a
 * 40,000 position previewed as "9362909.0%", which is arithmetically correct and tells
 * the reader nothing. Anything past 1,000% is simply "very safe", so say that instead.
 */
function formatRatio(ratioPercent: number): string {
	if (!Number.isFinite(ratioPercent)) return 'No debt';
	if (ratioPercent >= 1000) return '>1,000%';
	return `${ratioPercent.toFixed(1)}%`;
}

function formatDebt(debt: bigint): string {
	return Number(formatUnits(debt, 18)).toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

/**
 * The resulting ratio's own health, on the same bands as the position card. Colouring by
 * direction painted a first mint's perfectly healthy 160% red because it was "lower than
 * before", which read as danger on the one screen meant to reassure.
 */
function healthColor(ratioPercent: number, ratios: RiskRatios): string {
	if (!Number.isFinite(ratioPercent)) return 'text-muted-foreground';
	return HEALTH_TEXT[healthStatus(ratioPercent, ratios)];
}

export function PositionSummary({
	ratios,
	currentRatioPercent,
	newRatioPercent,
	currentLiquidationPrice,
	newLiquidationPrice,
	currentDebt,
	newDebt,
	isValid,
	errorMessage,
	note,
}: PositionSummaryProps) {
	const rows = useMemo(() => [
		{
			label: 'Collateral Ratio',
			current: formatRatio(currentRatioPercent),
			after: formatRatio(newRatioPercent),
			afterColor: healthColor(newRatioPercent, ratios),
		},
		{
			label: 'Liquidation Price',
			current: currentLiquidationPrice === 0 ? 'None' : formatUsd(currentLiquidationPrice),
			after: newLiquidationPrice === 0 ? 'None' : formatUsd(newLiquidationPrice),
			// The price inherits the ratio's verdict: a safer ratio is a further liquidation price.
			afterColor: newLiquidationPrice === 0 ? 'text-muted-foreground' : healthColor(newRatioPercent, ratios),
		},
		{
			label: 'Total Debt',
			current: `${formatDebt(currentDebt)} GSUSD`,
			after: `${formatDebt(newDebt)} GSUSD`,
			afterColor: 'text-foreground',
		},
	], [ratios, currentRatioPercent, newRatioPercent, currentLiquidationPrice, newLiquidationPrice, currentDebt, newDebt]);

	return (
		<div className="rounded-lg border border-border bg-muted/40 p-3.5">
			<div className="mb-1 grid grid-cols-[1.4fr_1fr_1fr] gap-2 text-muted-foreground">
				<span></span>
				<span className="label-mono text-right text-xs">Current</span>
				<span className="label-mono text-right text-xs">After</span>
			</div>
			{rows.map(row => (
				<div
					key={row.label}
					className="grid grid-cols-[1.4fr_1fr_1fr] items-center gap-2 border-t border-border/70 py-2 text-sm first-of-type:border-t-0"
				>
					<span className="label-mono text-xs text-muted-foreground">{row.label}</span>
					<span className="nums text-right text-muted-foreground">{row.current}</span>
					<span className={`nums text-right font-medium ${row.afterColor}`}>
						{row.after}
					</span>
				</div>
			))}
			{!isValid && errorMessage && (
				<div className="mt-2 rounded-md border border-danger/20 bg-danger-soft px-2.5 py-1.5 text-xs font-medium text-danger">
					{errorMessage}
				</div>
			)}
			{isValid && note && (
				<p className="mt-2 border-t border-border/70 pt-2 text-xs leading-relaxed text-muted-foreground">{note}</p>
			)}
		</div>
	);
}
