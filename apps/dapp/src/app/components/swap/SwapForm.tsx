import { formatUnits } from 'viem';
import { Input } from '@goldstandard/ui';
import { Token } from '@goldstandard/models';
import { type SwapPreview } from '@goldstandard/hooks';
import { formatPercent, formatTokenAmount } from '../../lib/format';
import { TokenPill } from '../TokenPill';

interface SlippageOption {
	label: string;
	bps: bigint;
}

/** Tolerance on the previewed gold: the transaction reverts rather than fill below it. */
export const SLIPPAGE_OPTIONS: SlippageOption[] = [
	{ label: '0.1%', bps: 10n },
	{ label: '0.5%', bps: 50n },
	{ label: '1%', bps: 100n },
];

export interface SwapFormProps {
	typedAmount: string;
	onAmountChange: (value: string) => void;
	tokens: Token[];
	selectedToken: Token | undefined;
	onSelectToken: (token: Token) => void;
	slippageBps: bigint;
	onSlippageChange: (bps: bigint) => void;
	preview: SwapPreview | undefined;
	/** The amount-specific quote is in flight: the figures it decides say so. */
	quoting?: boolean;
	minGoldOut: bigint | undefined;
	spreadPercent: number | undefined;
	redeemable: bigint | undefined;
	remainingToday: bigint | undefined;
	reserveLoading: boolean;
	/** The reserve read failed: the figures it supplies say so instead of waiting. */
	reserveError?: boolean;
	oraclePrice: bigint | undefined;
	/** The oracle read is still in flight, so a missing price is not yet a refusal. */
	oracleLoading?: boolean;
	oracleIsStale: boolean;
	/** quoteReservePrice's refusal reason, when the oracle refused the reserve price. */
	oracleRefusal?: string;
	validationMessage: string | undefined;
}

/**
 * Why the reserve cannot price the swap now. Off the gold band the reserve waits for the
 * market price to return to gold (it never sells against a price that has left gold);
 * otherwise a feed is stale or invalid and the swap waits for both feeds to answer.
 */
export const staleOracleNote = (refusal: string | undefined): string =>
	refusal === 'Off gold band'
		? 'Reserve swaps into this gold token are paused while its market price sits outside the band around the gold price (2% at launch). The quote shown uses the last known price; the swap will revert until the price is back inside the band.'
		: 'The oracle is not pricing this gold token right now. The quote shown uses the last known price; the swap will revert until both of its price feeds answer again.';

export const SwapForm = ({
	typedAmount,
	onAmountChange,
	tokens,
	selectedToken,
	onSelectToken,
	slippageBps,
	onSlippageChange,
	preview,
	quoting = false,
	minGoldOut,
	spreadPercent,
	redeemable,
	remainingToday,
	reserveLoading,
	reserveError = false,
	oraclePrice,
	oracleLoading = false,
	oracleIsStale,
	oracleRefusal,
	validationMessage,
}: SwapFormProps) => {
	const decimals = selectedToken?.decimals ?? 18;
	const symbol = selectedToken?.symbol ?? '';
	// A missing figure says why: an ellipsis read the same whether the
	// reserve was still loading or its read had failed.
	const reserveFailed = reserveError && !reserveLoading;
	const pendingLabel = quoting ? 'Quoting…' : 'Enter an amount';
	const gold = (value: bigint | undefined) =>
		value === undefined || !selectedToken
			? reserveFailed
				? 'Reserve read failed, retrying'
				: 'Loading'
			: `${formatTokenAmount(value, decimals)} ${symbol}`;
	const priceLabel =
		oraclePrice !== undefined
			? `$${formatTokenAmount(oraclePrice, 8, 2)} / ${symbol || 'oz'}`
			: oracleLoading
				? 'Loading'
				: `No oracle price${symbol ? ` for ${symbol}` : ''}`;

	return (
		<div className="flex flex-col gap-3">
			<div className="rounded-lg border border-border bg-muted/40 p-3.5 transition-colors focus-within:border-ring/60">
				<div className="mb-2 flex items-center justify-between">
					<label htmlFor="swap-amount" className="label-mono text-xs text-muted-foreground">
						Swap GSUSD
					</label>
					<span className="text-xs text-muted-foreground">
						{spreadPercent !== undefined
							? `Current spread ${formatPercent(spreadPercent, 2)}`
							: reserveFailed
								? 'Spread unavailable, retrying'
								: 'Loading spread…'}
					</span>
				</div>
				<div className="flex items-center gap-2">
					<Input
						id="swap-amount"
						className="nums min-h-11 border-0 bg-transparent p-0 text-2xl font-medium shadow-none focus-visible:ring-0 disabled:opacity-100"
						placeholder="0"
						inputMode="decimal"
						onChange={e => onAmountChange(e.target.value)}
						value={typedAmount}
					/>
					<TokenPill symbol="GSUSD" />
				</div>
			</div>

			<div className="flex items-center justify-between gap-3">
				<span className="label-mono text-xs text-muted-foreground">Receive</span>
				<div className="flex gap-1.5">
					{tokens.map(token => {
						const isSelected = selectedToken?.address === token.address;
						return (
							<button
								key={token.address}
								type="button"
								onClick={() => onSelectToken(token)}
								aria-pressed={isSelected}
								className={`flex min-h-11 items-center gap-2 rounded-full border py-1 pl-1 pr-2.5 text-sm font-medium transition-colors ${
									isSelected
										? 'border-primary bg-card text-foreground'
										: 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
								}`}
							>
								<img className="h-6 w-6 rounded-full" src={token.image} alt={token.name} />
								{token.symbol}
							</button>
						);
					})}
				</div>
			</div>

			<div className="flex items-center justify-between gap-3">
				<span className="label-mono text-xs text-muted-foreground">Price tolerance</span>
				<div className="flex gap-1.5">
					{SLIPPAGE_OPTIONS.map(option => {
						const isSelected = option.bps === slippageBps;
						return (
							<button
								key={option.label}
								type="button"
								onClick={() => onSlippageChange(option.bps)}
								aria-pressed={isSelected}
								className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
									isSelected
										? 'border-primary bg-card text-foreground'
										: 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
								}`}
							>
								{option.label}
							</button>
						);
					})}
				</div>
			</div>

			<dl className="space-y-2 rounded-lg border border-border bg-muted/40 p-3.5 text-sm">
				<div className="flex items-center justify-between gap-3">
					<dt className="text-muted-foreground">Oracle price</dt>
					<dd className="nums">
						{priceLabel}
					</dd>
				</div>
				<div className="flex items-center justify-between gap-3">
					<dt className="text-muted-foreground">Spread</dt>
					<dd className="nums">
						{preview ? `${formatTokenAmount(preview.spreadAmount, 18, 2)} GSUSD` : pendingLabel}
					</dd>
				</div>
				<div className="flex items-center justify-between gap-3">
					<dt className="text-muted-foreground">You receive</dt>
					<dd className="nums font-medium text-foreground">{preview ? gold(preview.goldOut) : pendingLabel}</dd>
				</div>
				<div className="flex items-center justify-between gap-3">
					<dt className="text-muted-foreground">Minimum received</dt>
					<dd className="nums">{preview && minGoldOut !== undefined ? gold(minGoldOut) : pendingLabel}</dd>
				</div>
				<div className="flex items-center justify-between gap-3">
					<dt className="text-muted-foreground">Drawn from</dt>
					<dd className="text-right">
						Protocol gold reserve
						<span className="block text-xs text-muted-foreground">{gold(redeemable)} available</span>
					</dd>
				</div>
				<div className="flex items-center justify-between gap-3">
					<dt className="text-muted-foreground">Capacity remaining today</dt>
					<dd className="nums">{gold(remainingToday)}</dd>
				</div>
			</dl>

			<p className="text-xs leading-relaxed text-muted-foreground">
				Gold comes from the protocol&apos;s own reserve. No borrower&apos;s vault is touched by this
				swap. The spread goes to the insurance buffer; the GSUSD you swap is held by the reserve.
			</p>

			{oracleIsStale ? (
				<p role="alert" className="text-sm text-destructive">
					{staleOracleNote(oracleRefusal)}
				</p>
			) : null}

			{validationMessage ? (
				<p role="alert" className="text-sm text-destructive">
					{validationMessage}
				</p>
			) : null}

			{preview && selectedToken && remainingToday !== undefined && preview.goldOut > remainingToday ? (
				<p className="text-xs text-muted-foreground">
					Largest swap right now: about {formatUnits(remainingToday, decimals)} {symbol} of gold.
				</p>
			) : null}
		</div>
	);
};
