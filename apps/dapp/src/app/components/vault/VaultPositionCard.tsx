import { formatUnits } from 'viem';
import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Skeleton,
	Spinner,
} from '@goldstandard/ui';
import { CollateralRatioGauge } from './CollateralRatioGauge';
import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { useActiveCollateralTokens, useRefreshWindow, useVaultContext } from '@goldstandard/hooks';
import { TARGET_CHAIN_ID } from '@goldstandard/constants';
import { joinWithOr } from '../../lib/format';
import { HEALTH_TEXT, healthStatus, riskRatios, type RiskRatios } from '../../lib/riskDefaults';
import { InfoTip } from '../InfoTip';

function formatAmount(value: bigint, decimals: number, dp = 4): string {
	return Number(formatUnits(value, decimals)).toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: dp,
	});
}

/** GSUSD is always 18 decimals; the collateral is not, so it takes its own decimals. */
const GSUSD_DECIMALS = 18;

const BADGE_LABEL = {
	healthy: 'Healthy',
	warning: 'Caution',
	danger: 'At risk',
	liquidatable: 'Liquidatable',
} as const;

/**
 * The badge's colour follows its verdict; a danger label in the brand gold said nothing. The
 * bands come from the collateral's governed ratios, not a fixed 150% and 120%. Exported for tests.
 */
export function healthBadge(ratioPercent: number | undefined, ratios: RiskRatios): { label: string; className: string } {
	// A failed or pending read is NOT "no debt". This codebase already holds that line in
	// useTokenBalance and RevenuePanel; the badge was the one place still conflating them,
	// and it printed "No debt" directly above a non-zero debt figure.
	if (ratioPercent === undefined) return { label: 'Ratio unavailable', className: 'text-muted-foreground' };
	if (ratioPercent === Infinity) return { label: 'No debt', className: 'text-muted-foreground' };
	const status = healthStatus(ratioPercent, ratios);
	if (status === 'none') return { label: 'Ratio unavailable', className: 'text-muted-foreground' };
	return { label: BADGE_LABEL[status], className: HEALTH_TEXT[status] };
}

/**
 * What the card says about freshness after a confirmed transaction: "Updating" until
 * the figures move, "Updated" once they have, nothing outside that window. The seconds
 * a public RPC takes to catch up must never look like a transaction that did nothing.
 */
function useUpdateCue(figuresKey: string): 'updating' | 'updated' | undefined {
	const window = useRefreshWindow();
	const [baseline, setBaseline] = useState<{ startedAt: number | null; key: string }>({
		startedAt: null,
		key: figuresKey,
	});
	// A new window starts a new baseline: the figures as they stood at confirmation.
	if (baseline.startedAt !== window.startedAt) {
		setBaseline({ startedAt: window.startedAt, key: figuresKey });
		return window.active ? 'updating' : undefined;
	}
	if (!window.active) return undefined;
	return figuresKey === baseline.key ? 'updating' : 'updated';
}

function Stat({
	label,
	value,
	suffix,
	info,
	infoLabel,
}: {
	label: string;
	value: string;
	suffix: string;
	info?: string;
	infoLabel?: string;
}) {
	return (
		<div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
			<span className="label-mono flex items-center gap-1.5 text-xs text-muted-foreground">
				{label}
				{info && <InfoTip label={infoLabel ?? `About ${label}`}>{info}</InfoTip>}
			</span>
			<p className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5">
				<span className="nums font-serif text-2xl font-semibold leading-none text-foreground">
					{value}
				</span>
				<span className="text-xs font-medium text-muted-foreground">
					{suffix}
				</span>
			</p>
		</div>
	);
}

interface BoundaryState {
	failed: boolean;
}

/** A fault in the card must not take the forms below it down with it. */
class CardBoundary extends Component<{ children: ReactNode }, BoundaryState> {
	override state: BoundaryState = { failed: false };

	static getDerivedStateFromError(): BoundaryState {
		return { failed: true };
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error('VaultPositionCard failed to render', error, info.componentStack);
	}

	override render(): ReactNode {
		if (!this.state.failed) return this.props.children;
		return (
			<Card>
				<CardHeader>
					<CardTitle as="h2">Position overview</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-sm leading-relaxed text-muted-foreground">
						The position overview could not be shown. Reload the page; your vault itself is unaffected.
					</p>
				</CardContent>
			</Card>
		);
	}
}

export function VaultPositionCard() {
	return (
		<CardBoundary>
			<PositionCard />
		</CardBoundary>
	);
}

function PositionCard() {
	const { chainId, position, ratio, liquidationPrice, fees, collateralDecimals, collateralSymbol } =
		useVaultContext();
	// Name only the collateral the vault accepts: a dormant XAUT on a PAXG-first deployment
	// must not be offered here while the deposit picker leaves it out.
	// The context has no chain id while the wallet sits on an unsupported network; the
	// deployment's own chain answers which collateral it accepts.
	const activeCollateral = useActiveCollateralTokens(chainId ?? TARGET_CHAIN_ID);
	const acceptedSymbols = joinWithOr(
		Object.values(activeCollateral ?? {}).flatMap((token) => (token.symbol ? [token.symbol] : []))
	);
	// Hooks run before any early return; the key is empty until a position exists.
	const pos = position.position;
	const cue = useUpdateCue(pos ? `${pos.collateralAmount}:${pos.debtAmount}` : '');

	// A failed read is not an empty vault. "No active vault" here told a holder with collateral
	// and debt that the position was gone whenever the RPC was down. A later failure keeps the
	// last figures read, so only a read that never succeeded lands here. It is tested ahead of
	// the loading skeleton: each retry puts the read back to loading, and the notice and its
	// button would otherwise come and go every few seconds for as long as the outage lasts.
	if (position.hasFailed && !pos) {
		return (
			<Card>
				<CardHeader>
					<CardTitle as="h2">Position overview</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<p role="status" className="text-sm leading-relaxed text-muted-foreground">
						Chain read failed, retrying. Your position could not be read. The vault itself is unaffected.
					</p>
					{/* Not disabled while a retry runs: a disabled button drops keyboard focus. */}
					<Button
						variant="outline"
						size="sm"
						aria-disabled={position.isFetching}
						onClick={() => {
							if (!position.isFetching) void position.refetch();
						}}
					>
						{position.isFetching ? 'Retrying' : 'Retry now'}
					</Button>
				</CardContent>
			</Card>
		);
	}

	if (position.isLoading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle as="h2">Position overview</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="grid grid-cols-2 gap-3">
						<Skeleton className="h-[72px] w-full" />
						<Skeleton className="h-[72px] w-full" />
					</div>
					<Skeleton className="h-12 w-full" />
				</CardContent>
			</Card>
		);
	}

	if (!position.hasPosition || !pos) {
		return (
			<Card>
				<CardContent className="flex flex-col items-center gap-3 py-10 text-center">
					<div className="grid h-12 w-12 place-items-center rounded-full border border-gold-200 bg-gold-50 text-primary">
						<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
							<path
								d="M12 3 4 7v5c0 4.5 3.2 7.5 8 9 4.8-1.5 8-4.5 8-9V7l-8-4Z"
								stroke="currentColor"
								strokeWidth="1.6"
								strokeLinejoin="round"
							/>
						</svg>
					</div>
					<div>
						<h2 className="font-serif text-lg font-semibold text-foreground">
							No active vault
						</h2>
						<p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground text-pretty">
							{acceptedSymbols
								? `Deposit gold collateral (${acceptedSymbols}) below to open a position and mint GSUSD.`
								: 'Deposit gold collateral below to open a position and mint GSUSD.'}
						</p>
					</div>
				</CardContent>
			</Card>
		);
	}

	// A 6-decimal XAUT balance rendered at 18 decimals read as 0.00; a dash is honest
	// for the moment before the token is identified, and the right figure after.
	const collateralValue =
		collateralDecimals === undefined ? 'n/a' : formatAmount(pos.collateralAmount, collateralDecimals);

	const ratios = riskRatios(ratio);
	const badge = healthBadge(ratio.ratioPercent, ratios);

	return (
		<Card>
			<CardHeader className="flex-row items-center justify-between space-y-0">
				<CardTitle as="h2">Position overview</CardTitle>
				<span className="flex items-center gap-3">
					{cue && (
						<span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite">
							{cue === 'updating' && <Spinner className="h-3.5 w-3.5" />}
							{cue === 'updating' ? 'Updating from the chain' : 'Updated'}
						</span>
					)}
					<span className={`label-mono text-xs ${badge.className}`}>{badge.label}</span>
				</span>
			</CardHeader>
			<CardContent className="space-y-5">
				<div className="grid grid-cols-2 gap-3">
					<Stat
						label="Collateral"
						value={collateralValue}
						suffix={collateralSymbol ?? 'gold'}
						info="The tokenised gold locked in your vault, backing the GSUSD you have minted."
						infoLabel="About collateral"
					/>
					<Stat
						label="Debt"
						value={formatAmount(pos.debtAmount, GSUSD_DECIMALS, 2)}
						suffix="GSUSD"
						info="The GSUSD you have minted against your collateral. Repay it to release your gold."
						infoLabel="About debt"
					/>
				</div>

				{fees.accruedFees > 0n && (
					<div className="flex items-center justify-between rounded-lg border border-warning/20 bg-warning-soft px-3 py-2">
						<span className="flex items-center gap-1.5 text-xs font-medium text-warning">
							Accrued fees
							<InfoTip label="About accrued fees">
								The stability fee that has accumulated on your debt over time.
								It is added to the amount you must repay to close the position.
							</InfoTip>
						</span>
						<span className="nums text-sm font-medium text-warning">
							{fees.accruedFeesFormatted} GSUSD
						</span>
					</div>
				)}

				<div className="space-y-2">
					<CollateralRatioGauge ratioPercent={ratio.ratioPercent} ratios={ratios} />
					{/* The ratio is priced at the live liquidation quote;
					    when the oracle refuses it, the stored view stands in and says so. */}
					{ratio.source === 'stored' && (
						<p className="text-pretty text-xs leading-relaxed text-warning">
							Live gold price unavailable. This ratio uses the last price the oracle recorded,
							which can lag the market.
						</p>
					)}
				</div>

				{liquidationPrice.priceFormatted && (
					<div className="flex items-center justify-between border-t border-border pt-4">
						<span className="flex items-center gap-1.5 text-sm text-muted-foreground">
							Liquidation price
							<InfoTip label="About liquidation price">
								If the gold price falls to this level, your vault can be
								liquidated. Keep your collateral ratio comfortably above the
								minimum to stay clear of it.
							</InfoTip>
						</span>
						<span className="nums text-sm font-medium text-foreground">
							$
							{Number(liquidationPrice.priceFormatted).toLocaleString('en-US', {
								minimumFractionDigits: 2,
							})}
						</span>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
