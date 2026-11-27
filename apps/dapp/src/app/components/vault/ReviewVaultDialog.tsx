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
import type { ConfirmationStatus, VaultActionType, WriteFn } from '@goldstandard/hooks';
import { formatFeeBps, type MintFeeSplit } from '@goldstandard/utils';
import { EXPLORER_BASE_URL, TARGET_CHAIN_ID } from '@goldstandard/constants';
import { describeTxError, type TxErrorContext } from '../../lib/txError';
import { formatEnteredAmount, formatTokenAmount } from '../../lib/format';

/**
 * A full repayment is submitted with a margin above the quoted debt, because fees
 * accrue every second and the quote is stale by the time the transaction lands. The
 * contract takes only what is owed at inclusion. Both figures are shown so the number
 * on the review screen is the debt, not the ceiling.
 */
export interface RepaySettlement {
	/** Fee-inclusive debt at the moment of review. */
	owedNow: bigint;
	/** The submitted amount: the most the contract may take. */
	authorised: bigint;
	/** True when the submitted amount clears the whole debt. */
	closes: boolean;
}

/** The position the simulation expects after this action lands, restated on the review and the receipt. */
export interface VaultOutcome {
	debt: bigint;
	ratioPercent: number;
	liquidationPrice: number;
}

interface ReviewVaultDialogProps {
	action: VaultActionType;
	/** The exact decimal the wallet will be asked to sign, as text (canonicalAmount). */
	amount: string;
	write: WriteFn | undefined;
	/** Forgets the last write: its hash, its error and its pending flag. */
	reset: () => void;
	/** True from the click until the wallet returns a hash or a refusal. */
	isWritePending?: boolean;
	confirmationStatus: ConfirmationStatus;
	/** What the vault will look like afterwards, when the simulation can say. */
	outcome?: VaultOutcome;
	isSimulationSuccess: boolean;
	isSimulationError: boolean;
	simulationError: Error | null;
	/** The wallet's or node's rejection of the write itself, shown where a simulation error would be. */
	writeError?: Error | null;
	txHash: `0x${string}` | undefined;
	/** Called when the user closes a successful receipt, so the host can clear the form. */
	onClosed?: () => void;
	/** Symbol of the collateral in play, for deposit and withdraw. */
	collateralSymbol?: string | undefined;
	/** What the user is doing, so a revert reads as advice rather than a raw constraint. */
	errorContext?: TxErrorContext;
	/** Repay only: what is owed versus what is authorised. */
	settlement?: RepaySettlement;
	/** Repay only: the amount the contract actually took, from the confirmed receipt. */
	repaidAmount?: bigint;
	/** Mint only: the origination fee and what reaches the wallet; undefined until the fee is read. */
	mintFee?: MintFeeSplit;
	children(props: { error: Error | null; isSuccess: boolean }): ReactNode;
}

const actionLabels: Record<VaultActionType, { verb: string; noun: string; done: string }> = {
	deposit: { verb: 'Depositing', noun: 'deposit', done: 'Deposited' },
	mint: { verb: 'Minting', noun: 'mint', done: 'Minted' },
	repay: { verb: 'Repaying', noun: 'repay', done: 'Repaid' },
	withdraw: { verb: 'Withdrawing', noun: 'withdraw', done: 'Withdrew' },
};

/** "at a 200.0% collateral ratio", or "at a collateral ratio above 1,000%" once the gauge caps. */
const ratioClause = (ratioPercent: number): string =>
	ratioPercent >= 1000 ? 'at a collateral ratio above 1,000%' : `at a ${ratioPercent.toFixed(1)}% collateral ratio`;

const usd = (value: number): string =>
	new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

/** One sentence a reader can check against the position card: debt, ratio and the price that would liquidate. */
export function outcomeSentence(outcome: VaultOutcome): string {
	const debt = `${formatTokenAmount(outcome.debt, 18, 2)} GSUSD`;
	if (outcome.debt === 0n) return 'Your vault will owe nothing, so it cannot be liquidated.';
	return `Your vault will owe ${debt} ${ratioClause(outcome.ratioPercent)}, liquidatable below ${usd(outcome.liquidationPrice)} per ounce.`;
}

/**
 * Only the debt legs have a fixed unit. Collateral is whichever gold token is in play,
 * and hardcoding PAXG meant an XAUT depositor read "Depositing 5 PAXG" on the last
 * screen before signing, and "Successfully depositing 5 PAXG" afterwards, on the one
 * surface whose entire job is to restate exactly what is about to happen.
 */
const FIXED_UNITS: Partial<Record<VaultActionType, string>> = {
	mint: 'GSUSD',
	repay: 'GSUSD',
};

export const ReviewVaultDialog: FC<ReviewVaultDialogProps> = ({
	action,
	amount,
	write,
	reset,
	isWritePending = false,
	confirmationStatus,
	outcome,
	isSimulationSuccess,
	isSimulationError,
	simulationError,
	writeError = null,
	txHash,
	collateralSymbol,
	onClosed,
	errorContext,
	settlement,
	repaidAmount,
	mintFee,
	children,
}) => {
	const labels = actionLabels[action];
	const unit = FIXED_UNITS[action] ?? collateralSymbol ?? 'gold';
	// What was submitted, frozen at the confirm click, because the form clears its amount
	// when the receipt closes and the receipt must still name what was done. Forgotten
	// whenever the attempt ends (review dismissed, receipt closed) or the inputs change,
	// so a later review on the same page never restates an earlier amount. Whether the repay
	// closes the position is frozen with it: the live settlement falls once the repay lands.
	const [submitted, setSubmitted] = useState<{
		amount: string;
		outcome: VaultOutcome | undefined;
		closes: boolean;
		mintFee: MintFeeSplit | undefined;
	}>();
	// Not while a write is live: the form empties its amount once the wallet no longer covers it.
	useEffect(() => {
		if (!isWritePending && !txHash) setSubmitted(undefined);
	}, [amount, action, collateralSymbol, isWritePending, txHash]);
	const shown = submitted ?? { amount, outcome, mintFee };
	const isClose = action === 'repay' && settlement?.closes === true;
	const receiptCloses = submitted?.closes ?? isClose;
	const gsusd = (value: bigint) => `${formatTokenAmount(value, 18, 6)} GSUSD`;
	// The simulation knows precisely why this would revert. Show it, in both the review
	// dialog and the confirmation dialog, instead of only using it to grey out a button.
	const reason = describeTxError(simulationError ?? writeError, errorContext);
	// A mint is not confirmable until the fee is known: the review must state what arrives.
	const isFeeUnknown = action === 'mint' && mintFee === undefined;
	const chargedFee = shown.mintFee && shown.mintFee.fee > 0n ? shown.mintFee : undefined;
	// No request yet and no error: the simulation for these inputs is still running.
	const isChecking = (!write || isFeeUnknown) && !isSimulationError && !isWritePending;
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
		if (sending.current || !write || isFeeUnknown) return;
		sending.current = true;
		setSubmitted({ amount, outcome, closes: isClose, mintFee });
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
									{isClose ? 'Closing position · owed now' : labels.verb}
								</span>
								<span className="nums font-serif text-4xl font-semibold text-foreground">
									{isClose && settlement ? formatTokenAmount(settlement.owedNow, 18, 6) : formatEnteredAmount(shown.amount)}{' '}
									<span className="text-2xl text-muted-foreground">{unit}</span>
								</span>
							</div>

							{isClose && settlement && (
								<p className="text-xs leading-relaxed text-muted-foreground">
									Fees accrue by the second, so you authorise up to{' '}
									<span className="nums text-foreground">{gsusd(settlement.authorised)}</span> to
									cover what accrues before confirmation. Only the amount owed at that moment is
									taken; the rest never leaves your wallet.
								</p>
							)}

							{chargedFee && (
								<p className="text-sm leading-relaxed text-muted-foreground">
									<span className="font-medium text-foreground">You receive </span>
									<span className="nums font-medium text-foreground">{gsusd(chargedFee.received)}</span>{' '}
									after the {formatFeeBps(chargedFee.bps)} mint fee of{' '}
									<span className="nums">{gsusd(chargedFee.fee)}</span>, which goes to the protocol. Your
									vault owes the full {formatEnteredAmount(shown.amount)} GSUSD.
								</p>
							)}

							{shown.outcome && !reason && (
								<p className="text-sm leading-relaxed text-muted-foreground">
									<span className="font-medium text-foreground">Afterwards. </span>
									{outcomeSentence(shown.outcome)}
								</p>
							)}

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
									disabled={isSimulationError || !write || isFeeUnknown || isWritePending}
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
				explorerUrl={EXPLORER_BASE_URL[TARGET_CHAIN_ID]}
				errorMessage={reason}
				onClosed={onClosed}
				onDismissed={forget}
				successMessage={
					action === 'repay' && repaidAmount !== undefined ? (
						<>
							Repaid {gsusd(repaidAmount)}
							{receiptCloses
								? ', the exact amount owed at confirmation. Your position is closed.'
								: '.'}
							{!receiptCloses && shown.outcome ? ` ${outcomeSentence(shown.outcome)}` : ''} The figures on this page refresh over the next few seconds.
						</>
					) : action === 'mint' && chargedFee ? (
						<>
							Minted {formatEnteredAmount(shown.amount)} GSUSD: {gsusd(chargedFee.received)} reached your
							wallet and {gsusd(chargedFee.fee)} went to the protocol as the mint fee.
							{shown.outcome ? ` ${outcomeSentence(shown.outcome)}` : ''} The figures on this page refresh over the next few seconds.
						</>
					) : (
						<>
							{labels.done} {formatEnteredAmount(shown.amount)} {unit}.{shown.outcome ? ` ${outcomeSentence(shown.outcome)}` : ''} The figures on this page refresh over the next few seconds.
						</>
					)
				}
			/>
		</DialogProvider>
	);
};
