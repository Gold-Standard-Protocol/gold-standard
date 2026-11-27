import { type FC, useEffect, useState } from 'react';
import { useChainId } from 'wagmi';
import { formatUnits } from 'viem';
import { Button, DialogTrigger } from '@goldstandard/ui';
import { tryParseCurrencyAmount } from '@goldstandard/utils';
import * as Guard from '../Guard';
import { ReviewPoolDialog } from './ReviewPoolDialog';
import {
	useGsusdToken,
	useStabilityPoolClaim,
	useStabilityPoolDeposit,
	useStabilityPoolWithdraw,
	type PoolActionType,
	type PoolCollateralGain,
} from '@goldstandard/hooks';
import { getStabilityPoolContractConfig, type GoldVaultChainId } from '@goldstandard/constants';
import { describeTxError, type TxErrorContext } from '../../lib/txError';

const actionButtonLabels: Record<PoolActionType, string> = {
	deposit: 'Deposit',
	withdraw: 'Withdraw',
	claim: 'Claim collateral',
};

/** Matches the review dialog, so the sentence under the button and the one inside it agree. */
const errorActions: Record<PoolActionType, TxErrorContext['action']> = {
	deposit: 'pool-deposit',
	withdraw: 'pool-withdraw',
	claim: undefined,
};

interface PoolButtonProps {
	activeTab: PoolActionType;
	/** The exact decimal the wallet will sign (canonicalAmount), or an empty string while the field is not usable. */
	amount: string;
	/** What the review and receipt state. Equals `amount` except on a withdrawal the pool caps at the deposit. */
	reviewAmount: string;
	selectedGain: PoolCollateralGain | undefined;
	/** Called when the user closes a successful receipt, so the host can clear the typed amount. */
	onClosed?: () => void;
}

export const PoolButton: FC<PoolButtonProps> = ({ activeTab, amount, reviewAmount, selectedGain, onClosed }) => {
	const chainId = useChainId() as GoldVaultChainId;
	const gsusdToken = useGsusdToken(chainId);
	const poolAddress = getStabilityPoolContractConfig(chainId)?.address;

	// Each action has its own write hook
	const hasGain = !!selectedGain && selectedGain.amount > 0n;
	// The confirmation dialog names what was claimed. Once the claim lands the gain is gone
	// from the position, so `selectedGain` empties and the dialog read "Successfully
	// claiming  ." Keep the last claimable gain for the dialog's amount and unit.
	const [lastGain, setLastGain] = useState<PoolCollateralGain | undefined>(undefined);
	useEffect(() => {
		if (hasGain) setLastGain(selectedGain);
	}, [hasGain, selectedGain]);
	const gainForDialog = hasGain ? selectedGain : lastGain;
	// Only the active tab simulates: the other hooks get nothing to
	// simulate, so a withdrawal is never checked while depositing, nor a claim on another tab.
	const deposit = useStabilityPoolDeposit(chainId, activeTab === 'deposit' ? amount : undefined);
	const withdraw = useStabilityPoolWithdraw(chainId, activeTab === 'withdraw' ? amount : undefined);
	const claim = useStabilityPoolClaim(chainId, selectedGain?.token, activeTab === 'claim' && hasGain);

	// Select the appropriate hook result based on active tab
	const activeHook = {
		deposit,
		withdraw,
		claim,
	}[activeTab];

	const hasAmount = amount !== '';
	const isReady = activeTab === 'claim' ? hasGain : hasAmount;
	const buttonLabel = actionButtonLabels[activeTab];

	const dialogAmount =
		activeTab === 'claim'
			? gainForDialog
				? formatUnits(gainForDialog.amount, gainForDialog.decimals)
				: ''
			: reviewAmount;
	const dialogUnit = activeTab === 'claim' ? gainForDialog?.symbol ?? '' : 'GSUSD';

	// Deposits pull GSUSD via safeTransferFrom, so the pool must be approved first
	const approvalAmount =
		activeTab === 'deposit' ? tryParseCurrencyAmount(amount, gsusdToken) : undefined;

	return (
		<ReviewPoolDialog
			action={activeTab}
			amount={dialogAmount}
			unit={dialogUnit}
			write={activeHook.write}
			reset={activeHook.reset}
			isWritePending={activeHook.isWritePending}
			confirmationStatus={activeHook.confirmationStatus}
			isSimulationSuccess={activeHook.isSimulationSuccess}
			isSimulationError={activeHook.isSimulationError}
			simulationError={activeHook.simulationError ?? null}
			writeError={activeHook.writeError ?? null}
			txHash={activeHook.txHash}
			onClosed={onClosed}
			withdrawnAmount={activeTab === 'withdraw' ? withdraw.withdrawnAmount : undefined}
			claimedAmount={activeTab === 'claim' ? claim.claimedAmount : undefined}
			claimDecimals={activeTab === 'claim' ? gainForDialog?.decimals : undefined}
		>
			{({ error }) => (
				<Guard.Connection>
					<Guard.Chain chainId={chainId}>
						<Guard.TokenApproval
							amount={approvalAmount}
							spender={poolAddress}
							enabled={activeTab === 'deposit' && !!approvalAmount && !!poolAddress}
						>
							<Guard.Ready>
								<div className="flex flex-col gap-2">
									<DialogTrigger asChild>
										<Button
											size="lg"
											disabled={!isReady || Boolean(error)}
											fullWidth
										>
											{buttonLabel}
										</Button>
									</DialogTrigger>
									{/* A disabled button with no explanation reads as a broken app, and
									    during a guardian pause the only other cue was a small label on
									    the position card. Say why, as the vault forms do. */}
									{isReady && error && (
										<p role="alert" className="text-sm leading-relaxed text-destructive">
											{describeTxError(error, { action: errorActions[activeTab], tokenSymbol: dialogUnit })}
										</p>
									)}
								</div>
							</Guard.Ready>
						</Guard.TokenApproval>
					</Guard.Chain>
				</Guard.Connection>
			)}
		</ReviewPoolDialog>
	);
};
