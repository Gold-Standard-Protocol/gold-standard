import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle, Skeleton } from '@goldstandard/ui';

/** One section of the ledger page: a card whose title is a second level heading. */
export function LedgerCard({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle as="h2">{title}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-5">{children}</CardContent>
		</Card>
	);
}

/** A state said in words: why there is no figure, or what to do next. */
export function Sentence({ children }: { children: ReactNode }) {
	return <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

/**
 * A loading state said once: the wrapper is the one status region and carries the name, and
 * the bars inside it are decoration. A bare Skeleton is a status region of its own with the
 * text "Loading", so three of them in a named wrapper announced the same thing four times.
 */
export function LoadingBars({ label, className, bars }: { label: string; className?: string; bars: readonly string[] }) {
	return (
		<div role="status" aria-label={label} className={className}>
			{bars.map((bar, index) => (
				<Skeleton key={index} role="presentation" aria-hidden="true" className={bar} />
			))}
		</div>
	);
}
