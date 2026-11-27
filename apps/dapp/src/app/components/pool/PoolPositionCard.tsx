import { formatUnits } from 'viem';
import { useAccount, useChainId } from 'wagmi';
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Skeleton,
} from '@goldstandard/ui';
import { poolShareBps, useStabilityPoolPosition } from '@goldstandard/hooks';
import type { GoldVaultChainId } from '@goldstandard/constants';
import { InfoTip } from '../InfoTip';

/** Said where a figure the chain did not return would otherwise read as 0.00. */
const UNREAD = 'Read failed, retrying';

function formatAmount(value: bigint, decimals = 18, dp = 4): string {
	return Number(formatUnits(value, decimals)).toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: dp,
	});
}

function Stat({
	label,
	value,
	suffix,
	info,
	infoLabel,
}: {
	label: string;
	value: string | undefined;
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
				{value !== undefined ? (
					<>
						<span className="nums font-serif text-2xl font-semibold leading-none text-foreground">
							{value}
						</span>
						<span className="text-xs font-medium text-muted-foreground">
							{suffix}
						</span>
					</>
				) : (
					<span className="text-sm text-muted-foreground">{UNREAD}</span>
				)}
			</p>
		</div>
	);
}

export function PoolPositionCard() {
	const chainId = useChainId() as GoldVaultChainId;
	const { address } = useAccount();
	const position = useStabilityPoolPosition(chainId, address);

	if (!position.isDeployed) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Your pool position</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-sm leading-relaxed text-muted-foreground">
						The stability pool contract is not yet deployed. Your deposit, your
						share of the pool and any liquidation collateral gains will appear
						here once the protocol launches.
					</p>
				</CardContent>
			</Card>
		);
	}

	if (!address) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Your pool position</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-sm leading-relaxed text-muted-foreground">
						Connect a wallet to view your deposit, your share of the pool and
						any liquidation collateral gains.
					</p>
				</CardContent>
			</Card>
		);
	}

	if (position.isLoading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Your pool position</CardTitle>
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

	if (position.isError) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Your pool position</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-sm leading-relaxed text-muted-foreground">
						The pool position could not be loaded. Please check your connection
						and try again.
					</p>
				</CardContent>
			</Card>
		);
	}

	// An amount the chain did not return is unknown, not zero: 0.00 read
	// as an empty deposit when the read had failed.
	const { effectiveDeposit, totalDeposits } = position;
	const shareBps =
		effectiveDeposit !== undefined && totalDeposits !== undefined
			? poolShareBps(effectiveDeposit, totalDeposits)
			: undefined;
	const claimableGains = (position.gains ?? []).filter((gain) => gain.amount > 0n);

	return (
		<Card>
			<CardHeader className="flex-row items-center justify-between space-y-0">
				<CardTitle>Your pool position</CardTitle>
				{position.paused && (
					<span className="label-mono text-xs text-warning">Paused</span>
				)}
			</CardHeader>
			<CardContent className="space-y-5">
				<div className="grid grid-cols-2 gap-3">
					<Stat
						label="Your deposit"
						value={effectiveDeposit !== undefined ? formatAmount(effectiveDeposit, 18, 2) : undefined}
						suffix="GSUSD"
						info="Your effective deposit after any liquidations the pool has absorbed. It can be lower than the amount you originally deposited."
						infoLabel="About your deposit"
					/>
					<Stat
						label="Pool total"
						value={totalDeposits !== undefined ? formatAmount(totalDeposits, 18, 2) : undefined}
						suffix="GSUSD"
						info="The total GSUSD currently deposited in the stability pool by all depositors."
						infoLabel="About the pool total"
					/>
				</div>

				<div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-4 py-3">
					<span className="flex items-center gap-1.5 text-sm text-muted-foreground">
						Your share of the pool
						<InfoTip label="About your pool share">
							Liquidated debt and seized collateral are split across depositors
							in proportion to this share.
						</InfoTip>
					</span>
					<span className="nums text-sm font-medium text-foreground">
						{shareBps !== undefined ? `${(shareBps / 100).toFixed(2)}%` : UNREAD}
					</span>
				</div>

				<div className="border-t border-border pt-4">
					<span className="label-mono flex items-center gap-1.5 text-xs text-muted-foreground">
						Liquidation collateral gains
						<InfoTip label="About liquidation collateral gains">
							Gold collateral credited to you when the pool absorbs a
							liquidation. Gains accrue only when liquidations occur and can be
							claimed at any time.
						</InfoTip>
					</span>
					{position.gains === undefined ? (
						<p className="mt-2 text-sm leading-relaxed text-muted-foreground">
							Gains could not be read, retrying.
						</p>
					) : claimableGains.length === 0 ? (
						<p className="mt-2 text-sm leading-relaxed text-muted-foreground">
							No liquidation collateral gains yet. Gains appear after the pool
							absorbs a liquidation.
						</p>
					) : (
						<ul className="mt-2 space-y-2">
							{claimableGains.map((gain) => (
								<li
									key={gain.token}
									className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-4 py-2.5"
								>
									<span className="text-sm font-medium text-foreground">
										{gain.symbol}
									</span>
									<span className="nums text-sm font-medium text-foreground">
										{formatAmount(gain.amount, gain.decimals)}
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
