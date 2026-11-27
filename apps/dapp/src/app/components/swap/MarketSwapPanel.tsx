import { useEffect, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { Token } from '@goldstandard/models';
import {
	adverseDeviationBps,
	computeMinAmountOut,
	formatDeviationBps,
	impliedGoldPrice8,
	parseTokenAmount,
	poolFeeLabel,
	priceImpactLevel,
	useDexQuote,
	useGsusdToken,
	useOraclePrice,
	useTokenBalance,
} from '@goldstandard/hooks';
import { getDexConfig, type GoldVaultChainId } from '@goldstandard/constants';
import { formatTokenAmount, toInputAmount } from '../../lib/format';
import { MarketSwapForm, type PriceImpactView, type SwapDirection } from './MarketSwapForm';
import { MarketSwapButton } from './MarketSwapButton';

interface MarketSwapPanelProps {
	chainId: GoldVaultChainId;
	direction: SwapDirection;
	onDirectionChange: (direction: SwapDirection) => void;
	typedAmount: string;
	onAmountChange: (value: string) => void;
	tokens: Token[];
	selectedToken: Token | undefined;
	onSelectToken: (token: Token) => void;
	slippageBps: bigint;
	onSlippageChange: (bps: bigint) => void;
}

const toAddress = (token: Token | undefined): Address | undefined =>
	token && isAddress(token.address) ? token.address : undefined;

interface ValidationInput {
	hasTyped: boolean;
	amountIn: bigint | undefined;
	balance: bigint | undefined;
	sellSymbol: string;
	quoteFailed: boolean;
	quoteEmpty: boolean;
}

/** Input the user can fix first; a failed RPC last, since that one is not theirs. */
function resolveValidationMessage(input: ValidationInput): string | undefined {
	if (input.hasTyped && input.amountIn === undefined) {
		return 'Enter a valid amount.';
	}
	if (input.amountIn !== undefined && input.balance !== undefined && input.amountIn > input.balance) {
		return `You do not hold that much ${input.sellSymbol}.`;
	}
	if (input.quoteFailed) {
		return 'The market quote could not be fetched. Check your connection and try again.';
	}
	if (input.quoteEmpty) {
		return 'The pool would return nothing for this amount. Try a larger amount.';
	}
	return undefined;
}

/**
 * The market leg: GSUSD against tokenised gold on Uniswap v3, either direction. The
 * quote is a QuoterV2 simulation refreshed every ten seconds; the write goes through
 * SwapRouter02 with the connected wallet as recipient.
 */
export function MarketSwapPanel({
	chainId,
	direction,
	onDirectionChange,
	typedAmount,
	onAmountChange,
	tokens,
	selectedToken,
	onSelectToken,
	slippageBps,
	onSlippageChange,
}: MarketSwapPanelProps) {
	const dex = getDexConfig(chainId);
	const gsusdToken = useGsusdToken(chainId);

	const sellToken = direction === 'gsusd-to-gold' ? gsusdToken : selectedToken;
	const buyToken = direction === 'gsusd-to-gold' ? selectedToken : gsusdToken;
	const sellSymbol = sellToken?.symbol ?? (direction === 'gsusd-to-gold' ? 'GSUSD' : 'gold');
	const receiveSymbol = buyToken?.symbol ?? (direction === 'gsusd-to-gold' ? 'gold' : 'GSUSD');

	const amountIn = sellToken ? parseTokenAmount(typedAmount, sellToken.decimals) : undefined;
	const hasTyped = typedAmount.trim() !== '';

	const quote = useDexQuote(chainId, toAddress(sellToken), toAddress(buyToken), amountIn, dex?.poolFee);
	const { data: sellBalance, isError: sellBalanceFailed } = useTokenBalance(sellToken);
	const balanceRaw = sellBalance ? BigInt(sellBalance.quotient.toString()) : undefined;

	const minAmountOut =
		quote.amountOut !== undefined ? computeMinAmountOut(quote.amountOut, slippageBps) : undefined;

	// The implied price always reads as GSUSD per gold token, whichever way the swap runs.
	const goldDecimals = selectedToken?.decimals ?? 18;
	const impliedPrice8 =
		amountIn !== undefined && quote.amountOut !== undefined && quote.amountOut > 0n
			? direction === 'gsusd-to-gold'
				? impliedGoldPrice8(amountIn, quote.amountOut, goldDecimals)
				: impliedGoldPrice8(quote.amountOut, amountIn, goldDecimals)
			: undefined;

	// The pool is judged against the oracle the vault itself uses. A thin pool fills far from
	// it; slippage tolerance only guards the move between quote and execution, so without
	// this a 7 PAXG sale that fetched $1,717 an ounce against a $4,005 oracle looked routine.
	const oracle = useOraclePrice(chainId, toAddress(selectedToken));
	const sellingGold = direction === 'gold-to-gsusd';
	const deviationBps = adverseDeviationBps(impliedPrice8, oracle.price8, sellingGold);
	const impactLevel = priceImpactLevel(deviationBps);
	const impactText = deviationBps !== undefined ? formatDeviationBps(deviationBps) : undefined;
	// The acknowledgement is for this figure at this size: a refreshed quote that moves the gap, or
	// any change of amount, token or direction, asks again, and returning to an old scope does not
	// bring an old tick back.
	const impactScope = `${direction}|${selectedToken?.address ?? ''}|${typedAmount}|${impactText ?? ''}`;
	const [acknowledgedScope, setAcknowledgedScope] = useState<string | undefined>(undefined);
	useEffect(() => {
		setAcknowledgedScope(current => (current === impactScope ? current : undefined));
	}, [impactScope]);
	const impactAcknowledged = acknowledgedScope === impactScope;

	const priceImpact: PriceImpactView | undefined =
		oracle.price8 !== undefined
			? {
					oracleLabel: `$${formatTokenAmount(oracle.price8, 8, 2)} / oz${oracle.isLive ? '' : ' (last known)'}`,
					level: impactLevel,
					message:
						impactLevel === 'ok' || impactText === undefined
							? undefined
							: sellingGold
							? `You would receive ${impactText} less than the oracle price.`
							: `You would pay ${impactText} more than the oracle price.`,
					reserveHint: !sellingGold,
					acknowledged: impactAcknowledged,
					onAcknowledgedChange: checked => setAcknowledgedScope(checked ? impactScope : undefined),
			  }
			: undefined;

	const validationMessage = resolveValidationMessage({
		hasTyped,
		amountIn,
		balance: balanceRaw,
		sellSymbol,
		quoteFailed: quote.isError && !quote.noLiquidity,
		quoteEmpty: amountIn !== undefined && quote.amountOut === 0n,
	});

	const oracleUnavailable =
		!oracle.isLoading && oracle.price8 === undefined && quote.amountOut !== undefined && !quote.noLiquidity;

	// A review only opens unblocked, so this being true there means the gap moved under it.
	const needsReacknowledgement = impactLevel === 'severe' && !impactAcknowledged;
	// Until the first oracle read answers, the gap is unknown, not fine: the severe gate would
	// read 'ok' and let a far-off fill through to the review. An oracle that answered without a
	// price is a different case, reported above, and does not hold the swap.
	const oraclePending = oracle.isLoading && oracle.price8 === undefined;

	const blocked =
		!!validationMessage ||
		quote.noLiquidity ||
		amountIn === undefined ||
		amountIn === 0n ||
		minAmountOut === undefined ||
		!sellToken ||
		!buyToken ||
		oraclePending ||
		needsReacknowledgement;

	const receiveDecimals = buyToken?.decimals ?? 18;
	const routeLabel = dex ? `Uniswap v3 · ${poolFeeLabel(dex.poolFee)} pool` : 'No pool on this network';
	const quoteLabel =
		quote.amountOut !== undefined
			? `≈ ${formatTokenAmount(quote.amountOut, receiveDecimals, 6)} ${receiveSymbol}`
			: 'Enter an amount';
	const impliedPriceLabel =
		impliedPrice8 !== undefined
			? `$${formatTokenAmount(impliedPrice8, 8, 2)} / oz`
			: quote.amountOut === 0n
			? 'No fill'
			: 'Enter an amount';
	const minReceiveLabel =
		minAmountOut !== undefined ? `${formatTokenAmount(minAmountOut, receiveDecimals, 6)} ${receiveSymbol}` : 'Enter an amount';
	const balanceLabel =
		balanceRaw !== undefined && sellToken
			? `${formatTokenAmount(balanceRaw, sellToken.decimals, 4)} ${sellSymbol}`
			: undefined;

	const onMax =
		balanceRaw !== undefined && sellToken
			? () => onAmountChange(toInputAmount(balanceRaw, sellToken.decimals))
			: undefined;

	return (
		<div className="flex flex-col gap-4">
			<MarketSwapForm
				direction={direction}
				onDirectionChange={onDirectionChange}
				typedAmount={typedAmount}
				onAmountChange={onAmountChange}
				onMax={onMax}
				balanceLabel={balanceLabel}
				balanceNote={sellBalanceFailed ? 'Balance unavailable, retrying' : undefined}
				tokens={tokens}
				selectedToken={selectedToken}
				onSelectToken={onSelectToken}
				slippageBps={slippageBps}
				onSlippageChange={onSlippageChange}
				sellSymbol={sellSymbol}
				receiveSymbol={receiveSymbol}
				routeLabel={routeLabel}
				quoteLabel={quoteLabel}
				impliedPriceLabel={impliedPriceLabel}
				minReceiveLabel={minReceiveLabel}
				quoteLoading={quote.isLoading}
				noLiquidity={quote.noLiquidity}
				validationMessage={validationMessage}
				priceImpact={priceImpact}
				oracleUnavailable={oracleUnavailable}
			/>
			<MarketSwapButton
				chainId={chainId}
				onClosed={() => onAmountChange('')}
				sellToken={sellToken}
				buyToken={buyToken}
				typedAmount={typedAmount}
				amountIn={amountIn}
				minAmountOut={minAmountOut}
				blocked={blocked}
				needsReacknowledgement={needsReacknowledgement}
				rows={[
					{ label: 'Route', value: routeLabel },
					{ label: 'You receive', value: quoteLabel },
					{ label: 'Implied price', value: impliedPriceLabel },
					...(priceImpact?.message && impactText
						? [{ label: 'Against oracle', value: `${impactText} ${sellingGold ? 'less' : 'more'}` }]
						: []),
				]}
				minReceiveLabel={minReceiveLabel}
			/>
		</div>
	);
}
