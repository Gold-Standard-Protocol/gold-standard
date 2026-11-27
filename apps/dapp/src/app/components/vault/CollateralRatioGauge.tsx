import { useMemo } from 'react';
import { ratioBands } from '@goldstandard/hooks';
import { healthStatus, type RiskRatios } from '../../lib/riskDefaults';

interface CollateralRatioGaugeProps {
	ratioPercent: number | undefined;
	/** The collateral's governed ratios; the zones and colours follow them. */
	ratios: RiskRatios;
	className?: string;
}

const GAUGE_MIN = 100;
const GAUGE_MAX = 200;
/** Where a ratio sits on the 100% to 200% track, as a percentage of its width. */
const position = (ratioPercent: number) =>
	((Math.min(Math.max(ratioPercent, GAUGE_MIN), GAUGE_MAX) - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * 100;

export function CollateralRatioGauge({ ratioPercent, ratios, className }: CollateralRatioGaugeProps) {
	const bands = ratioBands(ratios.minRatio, ratios.liquidationRatio);
	const atRiskWidth = position(bands.minimum);
	const cautionWidth = position(bands.comfort) - atRiskWidth;
	const { fillWidth, fillColor, labelColor, label } = useMemo(() => {
		if (!ratioPercent || ratioPercent === Infinity) {
			return {
				fillWidth: 0,
				fillColor: 'bg-muted-foreground/30',
				labelColor: 'text-muted-foreground',
				label: 'N/A',
			};
		}

		// Map ratio to bar width: 0% at 100%, 100% at 200%+
		const width = position(ratioPercent);

		const status = healthStatus(ratioPercent, ratios);
		let fillColor: string;
		let labelColor: string;
		if (status === 'healthy') {
			fillColor = 'bg-success';
			labelColor = 'text-success';
		} else if (status === 'warning') {
			fillColor = 'bg-warning';
			labelColor = 'text-warning';
		} else {
			fillColor = 'bg-danger';
			labelColor = 'text-danger';
		}

		// Past 1,000% the figure is only noise (a near-empty debt against a full vault); say "very safe" the way the preview table does.
		return { fillWidth: width, fillColor, labelColor, label: ratioPercent >= 1000 ? '>1,000%' : `${ratioPercent.toFixed(1)}%` };
	}, [ratioPercent, ratios]);

	return (
		<div className={className}>
			<div className="mb-2 flex items-baseline justify-between">
				<span className="label-mono text-xs text-muted-foreground">Collateral ratio</span>
				<span className={`nums text-lg font-semibold ${labelColor}`}>{label}</span>
			</div>
			<div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted">
				{/* Zone tints from the governed ratios: below the minimum at risk, up to the
				    comfort line caution, healthy above it. */}
				<div className="absolute inset-0 flex">
					<div className="bg-danger/15" style={{ width: `${atRiskWidth}%` }} />
					<div className="bg-warning/15" style={{ width: `${cautionWidth}%` }} />
					<div className="flex-1 bg-success/15" />
				</div>
				<div
					className={`absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out ${fillColor}`}
					style={{ width: `${fillWidth}%` }}
				/>
			</div>
			<div className="mt-1.5 flex justify-between text-xs tabular-nums text-muted-foreground">
				<span>100%</span>
				<span>{bands.minimum}%</span>
				<span>{bands.comfort}%</span>
				<span>200%+</span>
			</div>
		</div>
	);
}
