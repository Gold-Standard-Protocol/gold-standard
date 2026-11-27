import type { LedgerRecordSummary, LedgerStatusResponse } from '@goldstandard/trpc';
import { buttonVariants, cn } from '@goldstandard/ui';
import { LEDGER_COPY } from '../content/ledger';
import { formatUtc } from './formatLedger';
import { LedgerCard, LoadingBars, Sentence } from './LedgerCard';
import type { QueryView } from './useLedger';

const ABOUT = LEDGER_COPY.about;
const RECORD = LEDGER_COPY.record;

interface StatusCardProps {
	status: QueryView<LedgerStatusResponse>;
	nowSeconds: number;
}

/** The sentence a card shows in place of its content while there is no answer or the ledger is off. */
function standIn(status: QueryView<LedgerStatusResponse>): string | undefined {
	if (!status.data) return status.isError ? LEDGER_COPY.states.unreachable : undefined;
	return status.data.status === 'disabled' ? LEDGER_COPY.states.off : undefined;
}

/** What each dimension records and in which unit. It is configuration, so it shows while the figures are recomputed. */
export function AboutCard({ status, nowSeconds }: StatusCardProps) {
	const sentence = standIn(status);
	const { data } = status;
	if (sentence || !data || data.status === 'disabled') {
		return (
			<LedgerCard title={ABOUT.title}>
				{sentence ? <Sentence>{sentence}</Sentence> : <LoadingBars label={ABOUT.loading} className="space-y-2.5" bars={['h-5 w-full', 'h-5 w-4/5', 'h-5 w-full']} />}
			</LedgerCard>
		);
	}
	const { terms } = data;
	const start = formatUtc(terms.startTimestamp);
	return (
		<LedgerCard title={ABOUT.title}>
			<ul className="space-y-2 text-pretty text-sm leading-relaxed text-foreground">
				<li>{ABOUT.debt}</li>
				<li>{ABOUT.pool}</li>
				{terms.liquidity && <li data-testid="ledger-about-liquidity">{ABOUT.liquidity}</li>}
			</ul>
			<div className="space-y-1.5 text-pretty text-sm leading-relaxed text-muted-foreground">
				<p>{ABOUT.even}</p>
				<p data-testid="ledger-start">{nowSeconds >= terms.startTimestamp ? ABOUT.startedOn(start) : LEDGER_COPY.states.startsOn(start)}</p>
			</div>
		</LedgerCard>
	);
}

/** The block the downloadable file is as of and its hash, set so that a long hash wraps instead of overflowing. */
function FileFacts({ record }: { record: LedgerRecordSummary }) {
	return (
		<div className="space-y-1.5 text-pretty text-xs leading-relaxed text-muted-foreground" data-testid="ledger-file">
			<p>{RECORD.fileAsOf(record.asOfBlock, formatUtc(record.asOfTimestamp))}</p>
			<p>
				{RECORD.hashLabel}: <span className="break-all font-mono text-foreground">{record.sha256}</span>
			</p>
		</div>
	);
}

/**
 * That the whole record is published as one file, the link to download it, the block and the
 * hash of that file, and where the way to recompute it is written down. With no answer from
 * the API there is no link: the card says the service cannot be reached.
 */
export function RecordCard({ status, downloadUrl }: Pick<StatusCardProps, 'status'> & { downloadUrl: string }) {
	const sentence = standIn(status);
	const { data } = status;
	if (sentence || !data || data.status === 'disabled') {
		return (
			<LedgerCard title={RECORD.title}>
				{sentence ? <Sentence>{sentence}</Sentence> : <LoadingBars label={RECORD.loading} className="space-y-2.5" bars={['h-5 w-full', 'h-5 w-3/5']} />}
			</LedgerCard>
		);
	}
	return (
		<LedgerCard title={RECORD.title}>
			<div className="space-y-1.5 text-pretty text-sm leading-relaxed text-foreground">
				<p>{RECORD.body}</p>
				<p>{RECORD.verify}</p>
			</div>
			{data.status === 'ok' ? (
				<>
					<div className="space-y-3">
						{/* The classes sit on the link itself, so that the whole 44px box is the target. */}
						<a
							href={downloadUrl}
							download
							data-testid="ledger-download"
							className={cn(buttonVariants({ variant: 'outline' }), 'h-auto min-h-11 w-full whitespace-normal py-2 text-center sm:w-auto')}
						>
							{RECORD.download}
						</a>
						{data.record ? <FileFacts record={data.record} /> : <Sentence>{RECORD.preparing}</Sentence>}
					</div>
					<div className="space-y-1.5 text-pretty text-sm leading-relaxed text-muted-foreground">
						<p data-testid="ledger-count">{RECORD.count(data.addresses, data.asOfBlock, formatUtc(data.asOfTimestamp))}</p>
						{data.incomplete && <p data-testid="ledger-incomplete">{RECORD.incomplete}</p>}
					</div>
				</>
			) : (
				<Sentence>{LEDGER_COPY.states.unavailable}</Sentence>
			)}
		</LedgerCard>
	);
}
