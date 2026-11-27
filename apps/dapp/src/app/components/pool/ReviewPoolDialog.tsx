import { type ReactNode, type FC, useEffect, useRef, useState } from 'react';
import {
	Button,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@goldstandard/ui';
import { DialogConfirm, DialogProvider, DialogReview } from '../Dialog';
import type { ConfirmationStatus, PoolActionType, WriteFn } from '@goldstandard/hooks';
import { parseUnits } from 'viem';
import { canonicalAmount } from '@goldstandard/utils';
import { formatEnteredAmount } from '../../lib/format';
import { describeTxError } from '../../lib/txError';

interface ReviewPoolDialogProps {
	action: PoolActionType;
	/** The exact decimal this action will move, as text (canonicalAmount): for a withdrawal, the amount the pool will return. */
	amount: string;
	unit: string;
	write: WriteFn | undefined;
	/** Forgets the last write: its hash, its error and its pending flag. */
	reset: () => void;
	/** True from the click until the wallet returns a hash or a refusal. */
	isWritePending?: boolean;
	confirmationStatus: ConfirmationStatus;
	isSimulationSuccess: boolean;
	isSimulationError: boolean;
	simulationError: Error | null;
	/** The wallet's or node's rejection of the write itself, shown inside the review. */
	writeError?: Error | null;
	txHash: `0x${string}` | undefined;
	children(props: { error: Error | null; isSuccess: boolean }): ReactNode;
	/** Called when the user closes a successful receipt, so the host can clear the form. */
	onClosed?: () => void;
	/** Withdraw only: the GSUSD the pool actually returned, from the confirmed receipt. */
	withdrawnAmount?: bigint;
	/** Claim only: the gold the pool actually paid, from the confirmed receipt, in the token's own units. */
	claimedAmount?: bigint;
	/** Claim only: the decimals of the gold token being claimed (XAUT has 6). */
	claimDecimals?: number;
}

const DECIMAL_TEXT = /^\d+(\.\d+)?$/;

interface ClaimOutcome {
	/** What the pool paid, as exact decimal text. */
	paid: string;
	/** The part of the reviewed gain the pool could not pay, or undefined when it paid all of it. */
	remainder: string | undefined;
}

/**
 * The pool pays the smaller of the gain and the gold it holds and leaves the rest
 * claimable, so the receipt names the event's amount and, when that is below the gain that
 * was reviewed, what is still owed. Undefined when the receipt could not be decoded.
 */
export function claimOutcome(
	reviewed: string,
	claimedAmount: bigint | undefined,
	decimals: number | undefined
): ClaimOutcome | undefined {
	if (claimedAmount === undefined || decimals === undefined) return undefined;
	const paid = canonicalAmount(claimedAmount, decimals);
	if (!DECIMAL_TEXT.test(reviewed)) return { paid, remainder: undefined };
	const shortfall = parseUnits(reviewed, decimals) - claimedAmount;
	return { paid, remainder: shortfall > 0n ? canonicalAmount(shortfall, decimals) : undefined };
}

const actionLabels: Record<PoolActionType, { verb: string; noun: string; done: string }> = {
	deposit: { verb: 'Depositing', noun: 'deposit', done: 'Deposited' },
	withdraw: { verb: 'Withdrawing', noun: 'withdraw', done: 'Withdrew' },
	claim: { verb: 'Claiming', noun: 'claim', done: 'Claimed' },
};

export const ReviewPoolDialog: FC<ReviewPoolDialogProps> = ({
	action,
	amount,
	unit,
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
	withdrawnAmount,
	claimedAmount,
	claimDecimals,
}) => {
	const labels = actionLabels[action];
	// Frozen at the confirm click (the host clears the amount when the receipt closes) and
	// forgotten when the attempt ends or the inputs change, so the next review on this page
	// never restates an earlier amount.
	const [submitted, setSubmitted] = useState<string>();
	// Not while a write is live: the page restates the amount it reviews as the pool and wallet change.
	useEffect(() => {
		if (!isWritePending && !txHash) setSubmitted(undefined);
	}, [amount, unit, action, isWritePending, txHash]);
	const shownAmount = submitted ?? amount;
	// The pool caps a withdrawal rather than reverting, so the receipt names what the event says it paid.
	// A claim is capped the same way, at the gold the pool holds, in the token's own decimals.
	const claim = action === 'claim' ? claimOutcome(shownAmount, claimedAmount, claimDecimals) : undefined;
	const receiptAmount =
		action === 'withdraw' && withdrawnAmount !== undefined
			? canonicalAmount(withdrawnAmount, 18)
			: claim?.paid ?? shownAmount;
	// Only the simulation error reaches the trigger: a rejected signature belongs to this
	// attempt and must not disable the Deposit button until a reload.
	const errorAction = { deposit: 'pool-deposit', withdraw: 'pool-withdraw', claim: undefined } as const;
	const reason = describeTxError(simulationError ?? writeError, { action: errorAction[action], tokenSymbol: unit });
	const isChecking = !write && !isSimulationError && !isWritePending;
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
		setSubmitted(amount);
		write({ onSuccess, onSettled: () => (sending.current = false) });
	};

	return (
		<DialogProvider>
			<DialogReview dismissable={!isWritePending} onDismiss={forget}>
				{({ showConfirmDialog }) => (
					<>
						{children({ error: simulationError, isSuccess: isSimulationSuccess })}
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Review {labels.noun}</DialogTitle>
								<DialogDescription>
									Check these figures, then confirm in your wallet.
								</DialogDescription>
							</DialogHeader>

							<div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-muted/40 py-6">
								<span className="label-mono text-xs text-primary">
									{labels.verb}
								</span>
								<span className="nums font-serif text-4xl font-semibold text-foreground">
									{formatEnteredAmount(shownAmount)}{' '}
									<span className="text-2xl text-muted-foreground">{unit}</span>
								</span>
							</div>

							{reason && (
								<p
									role="alert"
									className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm leading-relaxed text-destructive"
								>
									{reason}
								</p>
							)}

							<DialogFooter>
								<Button
									disabled={isSimulationError || !write || isWritePending}
									loading={isWritePending}
									aria-busy={isChecking || isWritePending}
									size="lg"
									fullWidth
									onClick={() => confirm(showConfirmDialog)}
								>
									{isWritePending ? 'Waiting for your wallet' : isChecking ? 'Checking' : `Confirm ${labels.noun}`}
								</Button>
							</DialogFooter>
							{isWritePending && (
								<p className="text-xs leading-relaxed text-muted-foreground" aria-live="polite">
									Waiting for your wallet. Reject in your wallet to cancel.
								</p>
							)}
						</DialogContent>
					</>
				)}
			</DialogReview>
			<DialogConfirm
				closeButtonText="Close"
				status={confirmationStatus}
				txHash={txHash}
				errorMessage={reason}
				onClosed={onClosed}
				onDismissed={forget}
				successMessage={
					<>
						{labels.done} {formatEnteredAmount(receiptAmount)} {unit}.{' '}
						{claim?.remainder !== undefined && (
							<>
								The pool held less than your gain, so the remaining {formatEnteredAmount(claim.remainder)} {unit} stays
								claimable and is paid once the pool holds it again.{' '}
							</>
						)}
						The figures on this page refresh over the next few seconds.
					</>
				}
			/>
		</DialogProvider>
	);
};
