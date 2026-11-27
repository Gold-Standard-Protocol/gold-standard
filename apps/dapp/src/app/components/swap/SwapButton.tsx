import { type FC } from 'react';
import { isAddress, type Address } from 'viem';
import { Button, DialogTrigger } from '@goldstandard/ui';
import { Token } from '@goldstandard/models';
import { canonicalAmount, parseAmount, tryParseCurrencyAmount } from '@goldstandard/utils';
import { useGsusdToken, useStabilitySwap } from '@goldstandard/hooks';
import { getStabilityReserveContractConfig, type GoldVaultChainId } from '@goldstandard/constants';
import * as Guard from '../Guard';
import { ReviewSwapDialog } from './ReviewSwapDialog';

interface SwapButtonProps {
	/** Called when the user closes a successful receipt, so the host can clear the typed amount. */
	onClosed?: () => void;
	chainId: GoldVaultChainId;
	selectedToken: Token | undefined;
	typedAmount: string;
	minGoldOut: bigint | undefined;
	/** True when form validation failed upstream (paused, too small, capacity). */
	blocked: boolean;
	spreadLabel: string;
	receiveLabel: string;
	minReceiveLabel: string;
	reserveLabel: string;
}

/**
 * Connect → chain → GSUSD approval for the reserve → review → confirm. The approval
 * guard is keyed on the reserve's own address, so an allowance granted to any retired
 * contract is never mistaken for a live one.
 */
export const SwapButton: FC<SwapButtonProps> = ({
	onClosed,
	chainId,
	selectedToken,
	typedAmount,
	minGoldOut,
	blocked,
	spreadLabel,
	receiveLabel,
	minReceiveLabel,
	reserveLabel,
}) => {
	const reserveAddress = getStabilityReserveContractConfig(chainId)?.address;
	const gsusdToken = useGsusdToken(chainId);
	const approvalAmount = tryParseCurrencyAmount(typedAmount, gsusdToken);

	// The Token model stores the address as a plain string; isAddress narrows
	// it without an unchecked assertion.
	const tokenAddress: Address | undefined =
		selectedToken && isAddress(selectedToken.address) ? selectedToken.address : undefined;

	const swap = useStabilitySwap(chainId, tokenAddress, typedAmount, blocked ? undefined : minGoldOut);
	// The review prints the exact decimal the wallet signs, not the typed string.
	const parsed = parseAmount(typedAmount, 18);
	const amount = parsed !== undefined ? canonicalAmount(parsed, 18) : typedAmount;

	return (
		<ReviewSwapDialog
			venue="reserve"
			amount={amount}
			sellSymbol="GSUSD"
			receiveSymbol={selectedToken?.symbol ?? 'gold'}
			rows={[
				{ label: 'Spread', value: spreadLabel },
				{ label: 'You receive', value: receiveLabel },
				{ label: 'Drawn from', value: reserveLabel },
			]}
			minReceiveLabel={minReceiveLabel}
			minReceive={blocked ? undefined : minGoldOut}
			receivedAmount={swap.receivedAmount}
			receiveDecimals={selectedToken?.decimals}
			write={swap.write}
			reset={swap.reset}
			isWritePending={swap.isWritePending}
			confirmationStatus={swap.confirmationStatus}
			isSimulationSuccess={swap.isSimulationSuccess}
			isSimulationError={swap.isSimulationError}
			simulationError={swap.simulationError ?? null}
			writeError={swap.writeError ?? null}
			txHash={swap.txHash}
			onClosed={onClosed}
		>
			{({ error }) => (
				<Guard.Connection>
					<Guard.Chain chainId={chainId}>
						<Guard.TokenApproval
							amount={approvalAmount}
							spender={reserveAddress}
							enabled={!blocked && !!approvalAmount && !!reserveAddress}
						>
							<Guard.Ready>
								<DialogTrigger asChild>
									<Button
										size="lg"
										fullWidth
										disabled={blocked || !approvalAmount || minGoldOut === undefined || Boolean(error)}
									>
										Swap GSUSD for {selectedToken?.symbol ?? 'gold'}
									</Button>
								</DialogTrigger>
							</Guard.Ready>
						</Guard.TokenApproval>
					</Guard.Chain>
				</Guard.Connection>
			)}
		</ReviewSwapDialog>
	);
};
