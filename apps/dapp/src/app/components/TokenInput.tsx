import { ChevronDownIcon } from '@heroicons/react/20/solid'
import { useAccount } from 'wagmi'
import { useTokenBalance } from '@goldstandard/hooks'
import { CurrencyAmount, Token } from '@goldstandard/models'
import { Button, Input } from '@goldstandard/ui'
import { withinDecimals } from '@goldstandard/utils'
import { AmountReason } from './vault/AmountReason'
import { TokenPill } from './TokenPill';

export interface TokenInputProps {
	amount: string | undefined
	children?: React.ReactNode
	disableInput?: boolean
	disableTokenSelection?: boolean
	id?: string
	label?: string
	onChangeAmount: (newAmount: string) => void
	onChooseToken?: () => void
	onMax?: () => void
	selectedToken: Token | undefined
	showMax?: boolean
	slippage?: number | undefined
	usdValue?: number
	/**
	 * Overrides the wallet-balance line. Some inputs are not spending the wallet: a
	 * stability pool withdrawal is bounded by the deposit in the pool, and showing
	 * "Balance: 29,000" beside a Max that fills 10,000 invites the reader to conclude
	 * the Max is broken. Pass what actually caps this input.
	 */
	availableLabel?: string
	availableAmount?: string
	/** Why the amount cannot be acted on yet, shown under the field. */
	reason?: string | undefined
	/** A standing line about this field, shown inside it under the amount and any reason. */
	note?: React.ReactNode
}

/**
 * The wallet-balance line, or undefined when there is no wallet to read. A balance that
 * could not be read says so and is never shown as 0.00: a
 * failed RPC or token read must not look like an empty wallet. Exported for tests.
 */
/** A balance as the figure shown: six significant digits, and a read zero as 0.00. */
function balanceFigure(balance: CurrencyAmount<Token>, symbol: string): string {
	return `${balance.quotient.toString() !== '0' ? balance.toSignificant(6) : '0.00'} ${symbol}`
}

export function walletBalanceLine(
	balance: CurrencyAmount<Token> | undefined,
	status: { connected: boolean; loading: boolean },
	symbol: string
): string | undefined {
	if (!status.connected) return undefined
	if (balance) return `Balance: ${balanceFigure(balance, symbol)}`
	return status.loading ? 'Balance: …' : 'Balance unavailable'
}

export function TokenInput({
	disableInput,
	disableTokenSelection,
	id,
	label,
	amount,
	onChangeAmount,
	onChooseToken,
	onMax,
	selectedToken,
	showMax,
	slippage,
	usdValue,
	availableLabel,
	availableAmount,
	reason,
	note,
}: TokenInputProps) {
	const { isConnected } = useAccount()
	const { data: balance, isLoading } = useTokenBalance(selectedToken ?? undefined)
	const reasonId = id ? `${id}-reason` : undefined
	const symbol = selectedToken?.symbol ?? ''
	const balanceLine = selectedToken
		? availableAmount !== undefined
			? `${availableLabel ?? 'Balance'}: ${availableAmount} ${symbol}`
			: walletBalanceLine(balance, { connected: isConnected, loading: isLoading }, symbol)
		: undefined
	// Max fills from one figure, so it is offered only when that figure is read and is not
	// nothing. Offered, the figure is the button ("Max: 8.9 PAXG"), in the label row like the
	// mint and withdraw fields; otherwise the line states the balance, or why there is none.
	const maxFigure =
		availableAmount !== undefined
			? Number(availableAmount.replace(/,/g, '')) > 0
				? `${availableAmount} ${symbol}`
				: undefined
			: balance && balance.quotient.toString() !== '0'
				? balanceFigure(balance, symbol)
				: undefined
	const offersMax = Boolean(showMax && selectedToken && maxFigure)

	// A seventh decimal on a 6-decimal token is refused at the keystroke: parseUnits would
	// otherwise round it, and the review would show a figure the wallet never signs.
	const handleChange = (next: string) => {
		if (selectedToken && !withinDecimals(next, selectedToken.decimals)) return
		onChangeAmount(next)
	}

	return (
		<div className="rounded-lg border border-input bg-muted/40 p-3.5 transition-colors focus-within:border-ring/60">
			{(label || balanceLine) && (
				<div className="mb-2 flex items-center justify-between gap-3">
					{label ? (
						<label htmlFor={id} className="label-mono text-xs text-muted-foreground">{label}</label>
					) : (
						<span />
					)}
					{offersMax ? (
						// A 44px target in its own right: axe measures the box, not the tap-target pseudo-element.
						<Button variant="link" size="xs" className="-my-3 -mr-2 min-h-11 justify-end px-2" onClick={onMax}>
							<span className="nums whitespace-nowrap">Max: {maxFigure}</span>
						</Button>
					) : (
						balanceLine && <span className="nums whitespace-nowrap text-xs text-muted-foreground">{balanceLine}</span>
					)}
				</div>
			)}
			<div className="flex items-center justify-between gap-3">
				<Input
					id={id}
					disabled={disableInput || !selectedToken}
					inputMode="decimal"
					aria-invalid={reason ? true : undefined}
					aria-describedby={reason ? reasonId : undefined}
					className="nums min-h-11 border-0 bg-transparent p-0 text-2xl font-medium shadow-none focus-visible:ring-0 disabled:opacity-100"
					placeholder="0"
					onChange={e => handleChange(e.target.value)}
					value={amount}
				/>

				{!selectedToken ? (
					<Button size="sm" className="shrink-0" onClick={() => onChooseToken?.()}>
						Choose token
						<ChevronDownIcon className="h-4 w-4" />
					</Button>
				) : disableTokenSelection ? (
					<TokenPill symbol={symbol} image={selectedToken.image} />
				) : (
					// The button keeps a 44 pixel tap target; the negative margin lets the row stay the
					// height of the pill, so this field is no taller than one with a fixed token.
					<button
						type="button"
						onClick={() => onChooseToken?.()}
						className="group -my-1.5 flex min-h-11 shrink-0 items-center rounded-full"
					>
						<TokenPill
							symbol={symbol}
							image={selectedToken.image}
							className="transition-colors group-hover:bg-accent"
							trailing={<ChevronDownIcon className="h-4 w-4 text-muted-foreground" />}
						/>
					</button>
				)}
			</div>

			{selectedToken && usdValue ? (
				<div data-token-input-value className="nums mt-2 text-xs text-muted-foreground">
					{new Intl.NumberFormat('en-US', {
						style: 'currency',
						currency: 'USD',
						minimumFractionDigits: 2,
						maximumFractionDigits: 2,
					}).format(usdValue)}
					{slippage ? <span className="ml-1">({slippage.toFixed(2)}%)</span> : null}
				</div>
			) : null}
			{reasonId && <AmountReason id={reasonId} reason={reason} />}
			{note ? (
				<span data-token-input-note className="mt-2 block text-xs text-muted-foreground">{note}</span>
			) : null}
		</div>
	)
}
