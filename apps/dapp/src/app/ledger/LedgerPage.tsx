import { Link } from 'react-router-dom';
import type { Address } from 'viem';
import { useConnection } from 'wagmi';
import { SectionHeader } from '../components/marketing/Section';
import { Reveal } from '../components/Reveal';
import { LEDGER_COPY } from '../content/ledger';
import { ledgerRecordUrl } from '../lib/deployment';
import { AboutCard, RecordCard } from './AboutCards';
import { formatUtc } from './formatLedger';
import { UsageCard } from './UsageCard';
import { useLedgerAccount, useLedgerStatus } from './useLedger';

/** The wallet's connected address, once the connection is settled. */
function useWalletAddress(): Address | undefined {
	const connection = useConnection();
	return connection.isConnected ? connection.address : undefined;
}

/**
 * The usage ledger: the connected wallet's own record, what the ledger records and where the
 * whole record is described. The disclaimer is part of the page itself and is always shown.
 * The page lists no other wallet and orders nobody.
 */
export default function LedgerPage() {
	const address = useWalletAddress();
	const status = useLedgerStatus();
	const account = useLedgerAccount(address);

	const nowSeconds = Math.floor(Date.now() / 1000);
	const terms = status.data && status.data.status !== 'disabled' ? status.data.terms : undefined;
	const startsOn = terms && nowSeconds < terms.startTimestamp ? LEDGER_COPY.states.startsOn(formatUtc(terms.startTimestamp)) : undefined;
	// Liquidity is a dimension only while the API says so; until then the page says nothing about it.
	const liquidity = terms?.liquidity === true;

	return (
		<div className="mx-auto w-full max-w-2xl animate-rise">
			<div className="mb-6">
				<SectionHeader title={LEDGER_COPY.title} lead={LEDGER_COPY.lead} as="h1" variant="stack" align="left" />
			</div>

			<section
				aria-labelledby="ledger-disclaimer-title"
				className="mb-6 rounded-lg border border-border bg-muted/40 px-4 py-3"
				data-testid="ledger-disclaimer"
			>
				<h2 id="ledger-disclaimer-title" className="label-mono text-xs text-muted-foreground">
					{LEDGER_COPY.disclaimerTitle}
				</h2>
				<p className="mt-1.5 text-pretty text-sm font-medium leading-relaxed text-foreground">{LEDGER_COPY.disclaimer}</p>
				<p className="flex flex-wrap items-center gap-x-1.5 text-pretty text-xs leading-relaxed text-muted-foreground">
					<span>{LEDGER_COPY.termsNote}</span>
					{/* A 44px target in its own right: the accessibility check measures the box. */}
					<Link
						to="/terms"
						className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4"
						data-testid="ledger-terms-link"
					>
						{LEDGER_COPY.termsLink}
					</Link>
				</p>
			</section>

			<Reveal className="mb-6">
				<UsageCard address={address} account={account} startsOn={startsOn} liquidity={liquidity} />
			</Reveal>

			<Reveal className="mb-6">
				<AboutCard status={status} nowSeconds={nowSeconds} />
			</Reveal>

			<Reveal>
				<RecordCard status={status} downloadUrl={ledgerRecordUrl(import.meta.env)} />
			</Reveal>
		</div>
	);
}
