import type { Address } from 'viem';
import type { LedgerAccountResponse } from '@goldstandard/trpc';
import { ConnectButton } from '../components/ConnectButton';
import { LEDGER_COPY } from '../content/ledger';
import { formatTokenAmount } from '../lib/format';
import { formatFigure, formatUtc, isZeroFigure, parseWei } from './formatLedger';
import { LedgerCard, LoadingBars, Sentence } from './LedgerCard';
import type { QueryView } from './useLedger';

const COPY = LEDGER_COPY.usage;

type OkAccount = Extract<LedgerAccountResponse, { status: 'ok' }>;

interface UsageCardProps {
	address: Address | undefined;
	account: QueryView<LedgerAccountResponse>;
	/** Set while recording has not started: the sentence that says when it does. */
	startsOn?: string;
	/** True while the API records liquidity as a third dimension; nothing about it is shown otherwise. */
	liquidity?: boolean;
}

/** One dimension's figure, in its own unit. */
function Figure({ label, value, unit }: { label: string; value: string; unit: string }) {
	return (
		<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="flex items-baseline gap-x-1.5 text-sm text-foreground">
				<span className="nums font-medium">{formatFigure(value)}</span>
				<span className="text-xs font-medium text-muted-foreground">{unit}</span>
			</dd>
		</div>
	);
}

function Balance({ label, wei, unit, wide = false }: { label: string; wei: string; unit: string; wide?: boolean }) {
	const amount = parseWei(wei);
	return (
		<div className={`rounded-lg border border-border bg-muted/40 px-4 py-3${wide ? ' min-[420px]:col-span-2' : ''}`}>
			<dt className="label-mono text-xs text-muted-foreground">{label}</dt>
			<dd className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5">
				{amount === undefined ? (
					<span className="text-sm text-muted-foreground">{COPY.unreadBalance}</span>
				) : (
					<>
						<span className="nums font-serif text-xl font-semibold leading-none text-foreground">
							{formatTokenAmount(amount, 18, 2)}
						</span>
						<span className="text-xs font-medium text-muted-foreground">{unit}</span>
					</>
				)}
			</dd>
		</div>
	);
}

function Figures({ account, startsOn, liquidity }: { account: OkAccount; startsOn?: string; liquidity: boolean }) {
	const { usage, balances } = account;
	const shown = liquidity ? [usage.debt, usage.pool, usage.liquidity] : [usage.debt, usage.pool];
	const nothing = shown.every(isZeroFigure);
	return (
		<>
			{startsOn && <Sentence>{startsOn}</Sentence>}
			{nothing && <Sentence>{liquidity ? COPY.noneWithLiquidity : COPY.none}</Sentence>}

			<div>
				<dl className="divide-y divide-border border-y border-border" data-testid="ledger-figures">
					<Figure label={COPY.debt} value={usage.debt} unit={COPY.gsusdDays} />
					<Figure label={COPY.pool} value={usage.pool} unit={COPY.gsusdDays} />
					{liquidity && <Figure label={COPY.liquidity} value={usage.liquidity} unit={COPY.dollarDays} />}
				</dl>
				<p className="mt-3 text-pretty text-xs leading-relaxed text-muted-foreground">{COPY.separate}</p>
			</div>

			<div>
				<dl className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2" data-testid="ledger-balances">
					<Balance label={COPY.debtNow} wei={balances.debt} unit={COPY.gsusd} />
					<Balance label={COPY.poolNow} wei={balances.poolDeposit} unit={COPY.gsusd} />
					{liquidity && <Balance label={COPY.liquidityNow} wei={balances.liquidity} unit={COPY.dollars} wide />}
				</dl>
				<p className="mt-3 text-pretty text-xs leading-relaxed text-muted-foreground">
					{COPY.asOf(account.asOfBlock, formatUtc(account.asOfTimestamp))}
				</p>
			</div>
		</>
	);
}

/** The connected wallet's own record: one figure per dimension, never a sum, and the balances behind them. */
export function UsageCard({ address, account, startsOn, liquidity = false }: UsageCardProps) {
	if (!address) {
		return (
			<LedgerCard title={COPY.title}>
				<Sentence>{COPY.connect}</Sentence>
				<ConnectButton />
			</LedgerCard>
		);
	}

	const { data } = account;
	if (!data) {
		// A failed request with no earlier answer; a request still in flight shows the skeleton.
		if (account.isError) {
			return (
				<LedgerCard title={COPY.title}>
					<Sentence>{LEDGER_COPY.states.unreachable}</Sentence>
				</LedgerCard>
			);
		}
		return (
			<LedgerCard title={COPY.title}>
				<LoadingBars label={COPY.loading} className="space-y-4" bars={['h-24 w-full', 'h-20 w-full']} />
			</LedgerCard>
		);
	}

	if (data.status === 'disabled') {
		return (
			<LedgerCard title={COPY.title}>
				<Sentence>{LEDGER_COPY.states.off}</Sentence>
			</LedgerCard>
		);
	}

	// Never zeros: while the index is rebuilt the figures are unknown, not empty.
	if (data.status === 'unavailable') {
		return (
			<LedgerCard title={COPY.title}>
				<Sentence>{LEDGER_COPY.states.unavailable}</Sentence>
			</LedgerCard>
		);
	}

	return (
		<LedgerCard title={COPY.title}>
			<Figures account={data} startsOn={startsOn} liquidity={liquidity} />
		</LedgerCard>
	);
}
