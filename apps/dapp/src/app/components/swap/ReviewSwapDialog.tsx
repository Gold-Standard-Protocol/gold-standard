import { type ReactNode, type FC, useEffect, useRef, useState } from 'react';
import {
	Button,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@goldstandard/ui';
import { EXPLORER_BASE_URL, TARGET_CHAIN_ID } from '@goldstandard/constants';
import type { ConfirmationStatus, WriteFn } from '@goldstandard/hooks';
import { DialogConfirm, DialogProvider, DialogReview } from '../Dialog';
import { formatEnteredAmount, formatTokenAmount } from '../../lib/format';
import { describeTxError, type TxErrorContext } from '../../lib/txError';

/** Where the swap fills: protocol-owned gold at the oracle price, or pooled DEX liquidity. */
export type SwapVenue = 'reserve' | 'market';

export interface ReviewRow {
	label: string;
	value: string;
}

interface ReviewSwapDialogProps {
	venue: SwapVenue;
	/** The exact decimal the wallet will be asked to sign, as text (canonicalAmount). */
	amount: string;
	/** The token being spent: GSUSD on the reserve, either side on the market. */
	sellSymbol: string;
	receiveSymbol: string;
	rows: ReviewRow[];
	minReceiveLabel: string;
	/**
	 * The minimum the swap would be signed with now, in the received token's units. A review
	 * holds the minimum it opened with and asks before signing a lower one.
	 */
	minReceive: bigint | undefined;
	/** What the swap actually paid, read from the confirmed receipt. */
	receivedAmount?: bigint;
	receiveDecimals?: number;
	/** The price moved into a gap the user has not acknowledged: nothing can be sent until they do. */
	needsReacknowledgement?: boolean;
	write: WriteFn | undefined;
	/** Forgets the last write: its hash, its error and its pending flag. */
	reset: () => void;
	/** True from the click until the wallet returns a hash or a refusal. */
	isWritePending?: boolean;
	confirmationStatus: ConfirmationStatus;
	isSimulationSuccess: boolean;
	isSimulationError: boolean;
	simulationError: Error | null;
	/** The wallet's or node's rejection of the write itself, shown where a simulation error would be. */
	writeError?: Error | null;
	txHash: `0x${string}` | undefined;
	children(props: { error: Error | null; isSuccess: boolean }): ReactNode;
	/** Called when the user closes a successful receipt, so the host can clear the form. */
	onClosed?: () => void;
}

interface VenueCopy {
	action: NonNullable<TxErrorContext['action']>;
	footnote(minReceiveLabel: string): string;
	/** `received` is the amount and symbol from the receipt, or the bare symbol when it could not be read. */
	success(amount: string, sellSymbol: string, received: string): string;
}

/**
 * The two legs share one dialog because the review is the same act: an amount, a
 * few rows and a floor below which the transaction reverts. Only the provenance of
 * the fill and the revert vocabulary differ, and both live here rather than in a
 * second hundred-line dialog.
 */
const VENUE_COPY: Record<SwapVenue, VenueCopy> = {
	reserve: {
		action: 'swap',
		footnote: min =>
			`The gold amount shown is an estimate at the current oracle price. Final pricing settles on-chain when the transaction executes, and the transaction reverts if it would deliver less than ${min}. The gold comes from the protocol's own reserve; no borrower's vault is involved.`,
		success: (amount, _sell, received) => `Swapped ${amount} GSUSD for ${received} from the protocol reserve.`,
	},
	market: {
		action: 'dex-swap',
		footnote: min =>
			`The amount shown is the pool quote at the last refresh. Final pricing settles on-chain when the transaction executes, and the transaction reverts if it would deliver less than ${min}. The trade fills against Uniswap v3 liquidity, and the pool fee is included in the quote.`,
		success: (amount, sell, received) => `Swapped ${amount} ${sell} for ${received} on Uniswap v3.`,
	},
};

/** The figures a review shows: the rows, the minimum's label and the minimum itself. */
interface ReviewedQuote {
	rows: ReviewRow[];
	minReceiveLabel: string;
	minReceive: bigint | undefined;
}

/**
 * The quote a review stands on. Quotes refresh every few seconds
 * while the review is open, and the minimum used to follow them down silently, so the user
 * could sign a floor below the one they had read. The minimum shown when the review opened
 * is held; a refresh that keeps or raises it is shown as it comes, and one that lowers it
 * holds the old figures until the user accepts the new price. Lives inside the dialog
 * content, so each opening of the review starts from the quote of that moment.
 */
function useReviewedQuote(live: ReviewedQuote) {
	const [accepted, setAccepted] = useState<ReviewedQuote>(live);
	const priceDropped =
		live.minReceive !== undefined && accepted.minReceive !== undefined && live.minReceive < accepted.minReceive;
	// A minimum that holds or improves becomes the one the review stands on.
	useEffect(() => {
		if (!priceDropped && live.minReceive !== undefined && live.minReceive !== accepted.minReceive) {
			setAccepted(live);
		}
	}, [priceDropped, live, accepted.minReceive]);
	return {
		shown: priceDropped ? accepted : live,
		previousLabel: accepted.minReceiveLabel,
		priceDropped,
		accept: () => setAccepted(live),
	};
}

interface ReviewBodyProps extends ReviewedQuote {
	shownAmount: string;
	sellSymbol: string;
	footnote: (minReceiveLabel: string) => string;
	reason: string | undefined;
	needsReacknowledgement: boolean;
	isWritePending: boolean;
	isSimulationError: boolean;
	isChecking: boolean;
	canWrite: boolean;
	onConfirm: () => void;
}

/**
 * The content of the review dialog. DialogContent mounts its children only while the review is open, so
 * the quote snapshot below starts afresh with each opening.
 */
function ReviewBody(props: ReviewBodyProps) {
	return (
		<DialogContent>
			<ReviewFigures {...props} />
		</DialogContent>
	);
}

function ReviewFigures({
	rows,
	minReceiveLabel,
	minReceive,
	shownAmount,
	sellSymbol,
	footnote,
	reason,
	needsReacknowledgement,
	isWritePending,
	isSimulationError,
	isChecking,
	canWrite,
	onConfirm,
}: ReviewBodyProps) {
	const quote = useReviewedQuote({ rows, minReceiveLabel, minReceive });
	const { shown, priceDropped } = quote;
	return (
		<>
			<DialogHeader>
				<DialogTitle>Review swap</DialogTitle>
				<DialogDescription>
					Check these figures, then confirm in your wallet.
				</DialogDescription>
			</DialogHeader>

			<div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-muted/40 py-6">
				<span className="label-mono text-xs text-primary">Swapping</span>
				<span className="nums font-serif text-4xl font-semibold text-foreground">
					{formatEnteredAmount(shownAmount)} <span className="text-2xl text-muted-foreground">{sellSymbol}</span>
				</span>
			</div>

			<dl className="space-y-2.5 text-sm">
				{shown.rows.map(row => (
					<div key={row.label} className="flex items-center justify-between gap-3">
						<dt className="text-muted-foreground">{row.label}</dt>
						<dd className="nums text-right font-medium text-foreground">{row.value}</dd>
					</div>
				))}
				<div className="flex items-center justify-between gap-3">
					<dt className="text-muted-foreground">Price protection</dt>
					<dd className="nums text-right font-medium text-foreground">
						Reverts below {shown.minReceiveLabel}
					</dd>
				</div>
			</dl>

			<p className="text-xs leading-relaxed text-muted-foreground">{footnote(shown.minReceiveLabel)}</p>

			{reason ? (
				<p role="alert" className="text-sm text-destructive">
					{reason}
				</p>
			) : null}

			{needsReacknowledgement && !isWritePending ? (
				<p
					role="status"
					className="rounded-lg border border-warning/20 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning"
				>
					The price moved while you were reviewing. Close this review and tick the acknowledgement again.
				</p>
			) : priceDropped && !isWritePending ? (
				<p
					role="status"
					className="rounded-lg border border-warning/20 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning"
				>
					The price moved against you while you were reviewing. The swap would now revert below{' '}
					<span className="nums">{minReceiveLabel}</span> instead of{' '}
					<span className="nums">{quote.previousLabel}</span>. Accept the new price to continue.
				</p>
			) : null}

			<DialogFooter>
				{priceDropped && !needsReacknowledgement && !isWritePending ? (
					<Button size="lg" fullWidth onClick={quote.accept}>
						Accept new price
					</Button>
				) : (
					<Button
						disabled={isSimulationError || !canWrite || isWritePending || needsReacknowledgement || priceDropped}
						loading={isWritePending}
						aria-busy={isChecking || isWritePending}
						size="lg"
						fullWidth
						onClick={() => {
							// The click is judged against the figures on screen in this render.
							if (!priceDropped) onConfirm();
						}}
					>
						{isWritePending
							? 'Waiting for your wallet'
							: needsReacknowledgement
							? 'Price moved'
							: isChecking
							? 'Checking'
							: 'Confirm swap'}
					</Button>
				)}
			</DialogFooter>
			{isWritePending && (
				<p className="text-xs leading-relaxed text-muted-foreground" aria-live="polite">
					Waiting for your wallet. Reject in your wallet to cancel.
				</p>
			)}
		</>
	);
}

export const ReviewSwapDialog: FC<ReviewSwapDialogProps> = ({
	venue,
	amount,
	sellSymbol,
	receiveSymbol,
	rows,
	minReceiveLabel,
	minReceive,
	receivedAmount,
	receiveDecimals = 18,
	needsReacknowledgement = false,
	write,
	reset,
	isWritePending = false,
	confirmationStatus,
	isSimulationSuccess,
	isSimulationError,
	simulationError,
	writeError = null,
	txHash,
	children,
	onClosed,
}) => {
	const copy = VENUE_COPY[venue];
	// Frozen at the confirm click: the host clears the amount when the swap lands, and the
	// receive figure comes from a quote that empties with it. Forgotten when the attempt
	// ends or the inputs change, so the next review never restates an earlier amount.
	const [submitted, setSubmitted] = useState<{ amount: string; receiveSymbol: string; receiveDecimals: number }>();
	useEffect(() => setSubmitted(undefined), [amount, sellSymbol, receiveSymbol, receiveDecimals]);
	const shown = submitted ?? { amount, receiveSymbol, receiveDecimals };
	const received =
		receivedAmount !== undefined
			? `${formatTokenAmount(receivedAmount, shown.receiveDecimals, 6)} ${shown.receiveSymbol}`
			: shown.receiveSymbol;
	const reason = describeTxError(simulationError ?? writeError, { action: copy.action, tokenSymbol: sellSymbol });
	const isChecking = !write && !isSimulationError && !isWritePending && !needsReacknowledgement;
	// A synchronous lock: two clicks inside one frame both saw isWritePending false and
	// sent two requests. Released when the wallet answers, whichever way.
	const sending = useRef(false);
	// A reset on an account or chain change detaches the write, so onSettled never fires;
	// the wallet no longer holding the request is the other moment the lock must open.
	useEffect(() => {
		if (!isWritePending) sending.current = false;
	}, [isWritePending]);
	const forget = () => {
		sending.current = false;
		setSubmitted(undefined);
		reset();
	};
	const confirm = (onSuccess: () => void) => {
		if (sending.current || !write) return;
		sending.current = true;
		setSubmitted({ amount, receiveSymbol, receiveDecimals });
		write({ onSuccess, onSettled: () => (sending.current = false) });
	};

	return (
		<DialogProvider>
			<DialogReview dismissable={!isWritePending} onDismiss={forget}>
				{({ showConfirmDialog }) => (
					<>
						{children({ error: simulationError, isSuccess: isSimulationSuccess })}
						<ReviewBody
							rows={rows}
							minReceiveLabel={minReceiveLabel}
							minReceive={minReceive}
							shownAmount={shown.amount}
							sellSymbol={sellSymbol}
							footnote={copy.footnote}
							reason={reason}
							needsReacknowledgement={needsReacknowledgement}
							isWritePending={isWritePending}
							isSimulationError={isSimulationError}
							isChecking={isChecking}
							canWrite={!!write}
							onConfirm={() => confirm(showConfirmDialog)}
						/>
					</>
				)}
			</DialogReview>
			<DialogConfirm
				closeButtonText="Close"
				status={confirmationStatus}
				txHash={txHash}
				explorerUrl={EXPLORER_BASE_URL[TARGET_CHAIN_ID]}
				errorMessage={reason}
				onClosed={onClosed}
				onDismissed={forget}
				successMessage={<>{copy.success(formatEnteredAmount(shown.amount), sellSymbol, received)} The figures on this page refresh over the next few seconds.</>}
			/>
		</DialogProvider>
	);
};
