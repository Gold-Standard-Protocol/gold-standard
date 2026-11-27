import { Input } from '@goldstandard/ui';
import { Token } from '@goldstandard/models';
import { SLIPPAGE_OPTIONS } from './SwapForm';
import { TokenPill } from '../TokenPill';

/** Which way the market swap runs. The reserve leg only ever runs GSUSD to gold. */
export type SwapDirection = 'gsusd-to-gold' | 'gold-to-gsusd';

const DIRECTIONS: { value: SwapDirection; label: string }[] = [
	{ value: 'gsusd-to-gold', label: 'GSUSD to gold' },
	{ value: 'gold-to-gsusd', label: 'Gold to GSUSD' },
];

/** How the fill compares with the oracle, and the acknowledgement a severe gap demands. */
export interface PriceImpactView {
	oracleLabel: string;
	level: 'ok' | 'warn' | 'severe';
	/** Undefined when the fill is close to the oracle. */
	message: string | undefined;
	/** True when buying gold, where the reserve swap is an alternative worth naming. */
	reserveHint: boolean;
	acknowledged: boolean;
	onAcknowledgedChange: (checked: boolean) => void;
}

export interface MarketSwapFormProps {
	direction: SwapDirection;
	onDirectionChange: (direction: SwapDirection) => void;
	typedAmount: string;
	onAmountChange: (value: string) => void;
	onMax: (() => void) | undefined;
	balanceLabel: string | undefined;
	/** Said in place of the balance when the wallet's balance could not be read. */
	balanceNote?: string;
	tokens: Token[];
	selectedToken: Token | undefined;
	onSelectToken: (token: Token) => void;
	slippageBps: bigint;
	onSlippageChange: (bps: bigint) => void;
	sellSymbol: string;
	receiveSymbol: string;
	routeLabel: string;
	quoteLabel: string;
	impliedPriceLabel: string;
	minReceiveLabel: string;
	quoteLoading: boolean;
	noLiquidity: boolean;
	validationMessage: string | undefined;
	priceImpact?: PriceImpactView | undefined;
	/** The oracle gave no price, so the fill cannot be compared with it. */
	oracleUnavailable?: boolean;
}

const pillClass = (isSelected: boolean) =>
	`inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
		isSelected
			? 'border-primary bg-card text-foreground'
			: 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
	}`;

export const MarketSwapForm = ({
	direction,
	onDirectionChange,
	typedAmount,
	onAmountChange,
	onMax,
	balanceLabel,
	balanceNote,
	tokens,
	selectedToken,
	onSelectToken,
	slippageBps,
	onSlippageChange,
	sellSymbol,
	receiveSymbol,
	routeLabel,
	quoteLabel,
	impliedPriceLabel,
	minReceiveLabel,
	quoteLoading,
	noLiquidity,
	validationMessage,
	priceImpact,
	oracleUnavailable = false,
}: MarketSwapFormProps) => {
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<span className="label-mono text-xs text-muted-foreground">Direction</span>
				<div className="flex gap-1.5" role="group" aria-label="Swap direction">
					{DIRECTIONS.map(option => (
						<button
							key={option.value}
							type="button"
							onClick={() => onDirectionChange(option.value)}
							aria-pressed={direction === option.value}
							className={pillClass(direction === option.value)}
						>
							{option.label}
						</button>
					))}
				</div>
			</div>

			<div className="rounded-lg border border-border bg-muted/40 p-3.5 transition-colors focus-within:border-ring/60">
				<div className="mb-2 flex items-center justify-between">
					<label htmlFor="market-swap-amount" className="label-mono text-xs text-muted-foreground">
						Sell {sellSymbol}
					</label>
					<span className="text-xs text-muted-foreground">
						{balanceLabel ? `Balance ${balanceLabel}` : (balanceNote ?? null)}
						{balanceLabel && onMax ? (
							// A 44px target in its own right: axe measures the box, not a tap-target pseudo-element.
							<button
								type="button"
								onClick={onMax}
								className="-my-3 ml-1 inline-flex min-h-11 min-w-11 items-center justify-center px-2 font-medium text-primary underline-offset-4 hover:underline"
							>
								Max
							</button>
						) : null}
					</span>
				</div>
				<div className="flex items-center gap-2">
					<Input
						id="market-swap-amount"
						className="nums min-h-11 border-0 bg-transparent p-0 text-2xl font-medium shadow-none focus-visible:ring-0 disabled:opacity-100"
						placeholder="0"
						inputMode="decimal"
						onChange={e => onAmountChange(e.target.value)}
						value={typedAmount}
					/>
					<TokenPill symbol={sellSymbol} />
				</div>
			</div>

			<div className="flex items-center justify-between gap-3">
				<span className="label-mono text-xs text-muted-foreground">Gold</span>
				<div className="flex gap-1.5">
					{tokens.map(token => {
						const isSelected = selectedToken?.address === token.address;
						return (
							<button
								key={token.address}
								type="button"
								onClick={() => onSelectToken(token)}
								aria-pressed={isSelected}
								className={`flex min-h-11 items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm font-medium transition-colors ${
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
								className={pillClass(isSelected)}
							>
								{option.label}
							</button>
						);
					})}
				</div>
			</div>

			{noLiquidity ? (
				<div
					role="status"
					className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm leading-relaxed text-muted-foreground"
				>
					<p className="font-medium text-foreground">No DEX liquidity for this pair yet.</p>
					<p className="mt-1 text-xs">
						There is no {selectedToken?.symbol ?? 'gold'}/GSUSD pool with liquidity on this route.
						The reserve swap is still available.
					</p>
				</div>
			) : (
				<dl className="space-y-2 rounded-lg border border-border bg-muted/40 p-3.5 text-sm">
					<div className="flex items-center justify-between gap-3">
						<dt className="text-muted-foreground">Route</dt>
						<dd className="text-right">{routeLabel}</dd>
					</div>
					<div className="flex items-center justify-between gap-3">
						<dt className="text-muted-foreground">You receive</dt>
						<dd className="nums font-medium text-foreground">{quoteLoading ? 'Quoting…' : quoteLabel}</dd>
					</div>
					<div className="flex items-center justify-between gap-3">
						<dt className="text-muted-foreground">Implied price</dt>
						<dd className="nums">{impliedPriceLabel}</dd>
					</div>
					{priceImpact ? (
						<div className="flex items-center justify-between gap-3">
							<dt className="text-muted-foreground">Oracle price</dt>
							<dd className="nums">{priceImpact.oracleLabel}</dd>
						</div>
					) : null}
					<div className="flex items-center justify-between gap-3">
						<dt className="text-muted-foreground">Minimum received</dt>
						<dd className="nums">{minReceiveLabel}</dd>
					</div>
				</dl>
			)}

			{!noLiquidity && oracleUnavailable ? (
				<p role="status" className="rounded-lg border border-warning/20 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning">
					The oracle price is not available right now, so this fill cannot be compared with it. Check the
					implied price above before you confirm.
				</p>
			) : null}

			{!noLiquidity && priceImpact?.message ? (
				priceImpact.level === 'severe' ? (
					<div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm leading-relaxed">
						<p className="font-medium text-destructive">{priceImpact.message}</p>
						<p className="mt-1 text-xs text-muted-foreground">
							The pool&apos;s price at this size is far from the oracle. A smaller amount may fill closer to it
							{priceImpact.reserveHint ? ', and the reserve swap fills at the oracle price instead' : ''}.
						</p>
						<label className="mt-2 flex min-h-11 cursor-pointer items-start gap-3 py-1 text-xs text-foreground">
							<input
								type="checkbox"
								className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
								checked={priceImpact.acknowledged}
								onChange={e => priceImpact.onAcknowledgedChange(e.target.checked)}
							/>
							<span>I understand and want to swap at this price.</span>
						</label>
					</div>
				) : (
					<p role="status" className="rounded-lg border border-warning/20 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning">
						{priceImpact.message} A smaller amount may fill closer to the oracle.
					</p>
				)
			) : null}

			<p className="text-xs leading-relaxed text-muted-foreground">
				You receive {receiveSymbol} from pooled liquidity on Uniswap v3. The pool fee on this
				trade goes to the pool&apos;s liquidity providers. Neither the reserve nor any
				borrower&apos;s vault is touched.
			</p>

			{validationMessage ? (
				<p role="alert" className="text-sm text-destructive">
					{validationMessage}
				</p>
			) : null}
		</div>
	);
};
