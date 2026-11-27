import { compareVenues } from '@goldstandard/hooks';
import { formatTokenAmount } from '../../lib/format';

interface VenueComparisonProps {
	marketOut: bigint | undefined;
	reserveOut: bigint | undefined;
	decimals: number;
	symbol: string;
}

/**
 * One line, both venues, same GSUSD in: "Market: 0.2489 PAXG · Reserve: 0.2485 PAXG"
 * with the better payer marked. Rendered on both tabs so nobody swaps at the reserve
 * without seeing that the market would have paid more, and vice versa when GSUSD is
 * below par and the reserve is the arbitrage.
 */
export function VenueComparison({ marketOut, reserveOut, decimals, symbol }: VenueComparisonProps) {
	const better = compareVenues(marketOut, reserveOut);
	if (!better) return null;

	const cell = (label: string, value: bigint | undefined, isBetter: boolean) => (
		<span className={isBetter ? 'font-medium text-foreground' : undefined}>
			{label}: <span className="nums">{formatTokenAmount(value, decimals, 4)} {symbol}</span>
			{isBetter ? (
				<span className="ml-1.5 rounded-full border border-primary/40 px-1.5 py-px text-xs uppercase tracking-wide text-primary">
					better
				</span>
			) : null}
		</span>
	);

	return (
		<p
			className="flex flex-wrap items-center justify-center gap-x-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground"
			aria-live="polite"
		>
			{cell('Market', marketOut, better === 'market')}
			<span aria-hidden>·</span>
			{cell('Reserve', reserveOut, better === 'reserve')}
			{better === 'equal' ? <span>(same)</span> : null}
		</p>
	);
}
