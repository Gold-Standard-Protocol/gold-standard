import { type FC } from 'react';
import { isAddress, type Address } from 'viem';
import { Button, DialogTrigger } from '@goldstandard/ui';
import { Token } from '@goldstandard/models';
import { canonicalAmount, tryParseCurrencyAmount } from '@goldstandard/utils';
import { useDexSwap } from '@goldstandard/hooks';
import { getDexConfig, type GoldVaultChainId } from '@goldstandard/constants';
import * as Guard from '../Guard';
import { ReviewSwapDialog, type ReviewRow } from './ReviewSwapDialog';

interface MarketSwapButtonProps {
	/** Called when the user closes a successful receipt, so the host can clear the typed amount. */
	onClosed?: () => void;
	chainId: GoldVaultChainId;
	sellToken: Token | undefined;
	buyToken: Token | undefined;
	typedAmount: string;
	amountIn: bigint | undefined;
	minAmountOut: bigint | undefined;
	/** True when form validation failed upstream (bad input, balance, no liquidity). */
	blocked: boolean;
	/** A severe price gap is unacknowledged, so the review shows why it cannot proceed. */
	needsReacknowledgement?: boolean;
	rows: ReviewRow[];
	minReceiveLabel: string;
}

const toAddress = (token: Token | undefined): Address | undefined =>
	token && isAddress(token.address) ? token.address : undefined;

/**
 * Connect → chain → approval of the sold token for the Uniswap router → review →
 * confirm. The router is a third-party spender, so the approval is for the exact
 * amount rather than the protocol-wide unlimited approval.
 */
export const MarketSwapButton: FC<MarketSwapButtonProps> = ({
	onClosed,
	chainId,
	sellToken,
	buyToken,
	typedAmount,
	amountIn,
	minAmountOut,
	blocked,
	needsReacknowledgement = false,
	rows,
	minReceiveLabel,
}) => {
	const dex = getDexConfig(chainId);
	const routerAddress = dex?.router.address;
	const approvalAmount = tryParseCurrencyAmount(typedAmount, sellToken);

	const swap = useDexSwap(
		chainId,
		toAddress(sellToken),
		toAddress(buyToken),
		blocked ? undefined : amountIn,
		blocked ? undefined : minAmountOut,
		dex?.poolFee
	);

	// The review prints the exact decimal the wallet signs, not the typed string.
	const amount = amountIn !== undefined && sellToken ? canonicalAmount(amountIn, sellToken.decimals) : typedAmount;
	const sellSymbol = sellToken?.symbol ?? 'tokens';
	const receiveSymbol = buyToken?.symbol ?? 'tokens';

	return (
		<ReviewSwapDialog
			venue="market"
			amount={amount}
			sellSymbol={sellSymbol}
			receiveSymbol={receiveSymbol}
			rows={rows}
			minReceiveLabel={minReceiveLabel}
			minReceive={blocked ? undefined : minAmountOut}
			receivedAmount={swap.receivedAmount}
			receiveDecimals={buyToken?.decimals}
			needsReacknowledgement={needsReacknowledgement}
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
							spender={routerAddress}
							approveMax={false}
							enabled={!blocked && !!approvalAmount && !!routerAddress}
						>
							<Guard.Ready>
								<DialogTrigger asChild>
									<Button
										size="lg"
										fullWidth
										disabled={blocked || !approvalAmount || minAmountOut === undefined || Boolean(error)}
									>
										Swap {sellSymbol} for {receiveSymbol}
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
