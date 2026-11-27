import { useAccount } from 'wagmi';
import { type Address } from 'viem';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@goldstandard/ui';
import { EXPLORER_BASE_URL, TARGET_CHAIN_ID, findTokenInfoByAddress, type GoldVaultChainId } from '@goldstandard/constants';
import { useVaultContext, useVaultHistory, type VaultHistoryItem } from '@goldstandard/hooks';
import { formatRelativeTime, formatTokenAmount, shortAddress } from '../../lib/format';

/**
 * A public RPC that has pruned old logs answers eth_getLogs with "pruned history
 * unavailable" (publicnode, for one); retrying cannot help, so the feed says so.
 */
function historyUnavailable(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? '');
	return /pruned|history unavailable|exceeds the range|too many results/i.test(message);
}

interface GoldToken {
	symbol: string;
	/** Undefined when the token cannot be identified; the amount is then not shown. */
	decimals: number | undefined;
}

/**
 * The gold token an event refers to. The token list answers for PAXG and XAUT; an
 * event for the collateral the vault holds now can use the context's on-chain read;
 * anything else is shown as "gold" with no figure rather than a figure at a guessed
 * scale, since a 6-decimal amount rendered at 18 reads as zero.
 */
function goldToken(address: Address | undefined, held: GoldToken & { address: Address | undefined }): GoldToken {
	const match = findTokenInfoByAddress(address, TARGET_CHAIN_ID);
	if (match?.gold) return { symbol: match.symbol, decimals: match.decimals };
	if (address && held.address && address.toLowerCase() === held.address.toLowerCase()) {
		return { symbol: held.symbol, decimals: held.decimals };
	}
	return { symbol: 'gold', decimals: undefined };
}

const gsusd = (v: bigint) => `${formatTokenAmount(v, 18, 6)} GSUSD`;
const gold = (v: bigint, t: GoldToken) =>
	t.decimals === undefined ? t.symbol : `${formatTokenAmount(v, t.decimals, 6)} ${t.symbol}`;

/** One line per event, phrased as what happened to this wallet. */
function describe(
	item: VaultHistoryItem,
	held: GoldToken & { address: Address | undefined }
): { title: string; detail: string | undefined } {
	const t = goldToken(item.token, held);
	switch (item.kind) {
		case 'deposit':
			return { title: `Deposited ${gold(item.amount, t)}`, detail: undefined };
		case 'withdraw':
			return { title: `Withdrew ${gold(item.amount, t)}`, detail: undefined };
		case 'mint':
			return { title: `Minted ${gsusd(item.amount)}`, detail: undefined };
		case 'repay':
			return { title: `Repaid ${gsusd(item.amount)}`, detail: 'The exact amount owed at confirmation.' };
		case 'liquidated':
			return {
				title: `Liquidated: ${gsusd(item.amount)} of debt repaid by a liquidator`,
				detail: item.goldAmount !== undefined ? `${gold(item.goldAmount, t)} of collateral seized.` : undefined,
			};
		case 'swap':
			return {
				title: `Swapped ${gsusd(item.amount)} for ${item.goldAmount !== undefined ? gold(item.goldAmount, t) : t.symbol}`,
				detail: 'Paid from the protocol reserve.',
			};
		default:
			return { title: 'Activity', detail: undefined };
	}
}

/**
 * The wallet's own history with the vault and the reserve, from the contract events.
 * Every figure is what the chain recorded, which is what makes the feed worth having
 * next to a form that quotes estimates.
 */
export function VaultHistory() {
	const { chainId, position, collateralDecimals, collateralSymbol } = useVaultContext();
	const { address } = useAccount();
	const history = useVaultHistory(chainId as GoldVaultChainId, address);
	const explorer = EXPLORER_BASE_URL[TARGET_CHAIN_ID];
	const held = {
		address: position.position?.collateralToken,
		symbol: collateralSymbol ?? 'gold',
		decimals: collateralDecimals,
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle as="h2">Activity</CardTitle>
				<CardDescription>
					{address
						? `What ${shortAddress(address)} has done here, read from the contracts.`
						: 'Connect a wallet to see its history with the vault.'}
				</CardDescription>
			</CardHeader>
			<CardContent>
				{!address ? null : history.isLoading ? (
					<div className="space-y-2">
						<Skeleton className="h-10 w-full rounded-lg" />
						<Skeleton className="h-10 w-full rounded-lg" />
						<Skeleton className="h-10 w-full rounded-lg" />
					</div>
				) : history.isError ? (
					<p role="alert" className="text-sm text-destructive">
						{historyUnavailable(history.error)
							? 'This RPC endpoint does not keep event history back to the deployment, so the feed cannot be read from it. The rest of the page is unaffected; an endpoint with archive logs fixes the feed.'
							: "Could not load this wallet's history from the RPC. It will retry shortly."}
					</p>
				) : !history.data || history.data.length === 0 ? (
					<p className="text-sm text-muted-foreground">No activity yet for this wallet.</p>
				) : (
					<ol className="divide-y divide-border">
						{history.data.map(item => {
							const { title, detail } = describe(item, held);
							return (
								<li key={`${item.txHash}-${item.logIndex}`} className="flex items-start justify-between gap-3 py-2.5 text-sm">
									<div className="min-w-0">
										<p className="nums font-medium text-foreground">{title}</p>
										{detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
									</div>
									<div className="shrink-0 text-right text-xs text-muted-foreground">
										<p>{item.timestamp !== undefined ? formatRelativeTime(item.timestamp) : `Block ${item.blockNumber}`}</p>
										{explorer ? (
											<a
												className="-my-3 inline-flex min-h-11 items-center underline underline-offset-2 hover:text-foreground"
												href={`${explorer}/tx/${item.txHash}`}
												target="_blank"
												rel="noreferrer"
											>
												View transaction
											</a>
										) : null}
									</div>
								</li>
							);
						})}
					</ol>
				)}
			</CardContent>
		</Card>
	);
}
