import { Token } from '@goldstandard/models';
import {
	computeMinGoldOut,
	parseGsusdAmount,
	type OraclePriceState,
	type StabilityReserveState,
	type SwapPreview,
} from '@goldstandard/hooks';
import { type GoldVaultChainId } from '@goldstandard/constants';
import { formatPercent, formatTokenAmount } from '../../lib/format';
import { SwapForm } from './SwapForm';
import { SwapButton } from './SwapButton';

interface ReserveSwapPanelProps {
	chainId: GoldVaultChainId;
	typedAmount: string;
	onAmountChange: (value: string) => void;
	tokens: Token[];
	selectedToken: Token | undefined;
	onSelectToken: (token: Token) => void;
	slippageBps: bigint;
	onSlippageChange: (bps: bigint) => void;
	reserve: StabilityReserveState;
	oracle: OraclePriceState;
	/** The contract-mirroring preview for the typed amount, computed once by the host. */
	preview: SwapPreview | undefined;
	/** The amount-specific quote is in flight, so there is no preview yet. */
	quoting?: boolean;
}

interface ValidationInput {
	paused: boolean | undefined;
	supported: boolean | undefined;
	hasTyped: boolean;
	parsedAmount: bigint | undefined;
	tooSmall: boolean;
	goldOut: bigint | undefined;
	remainingToday: bigint | undefined;
	hasPrice: boolean;
	hasPreview: boolean;
	/** True when the reserve lists another gold token the user could switch to. */
	hasOtherAsset: boolean;
}

/**
 * The ladder the contract enforces, in the order the user can act on it: an asset
 * that cannot be swapped at all comes first, malformed input next, then the two
 * capacity limits, and only then a missing price (the one they cannot fix).
 */
function resolveValidationMessage(input: ValidationInput): string | undefined {
	if (input.supported === false) {
		return 'The reserve does not hold this gold token yet.';
	}
	if (input.paused) {
		return input.hasOtherAsset
			? 'Swaps into this gold token are paused by the guardian. The other reserve asset may still be available.'
			: 'Swaps into this gold token are paused by the guardian. Return once the pause is lifted.';
	}
	if (input.hasTyped && input.parsedAmount === undefined) {
		return 'Enter a valid GSUSD amount.';
	}
	if (input.tooSmall) {
		return 'This amount is too small to swap: the gold output rounds to zero at the current price.';
	}
	if (input.remainingToday !== undefined && input.remainingToday === 0n && input.hasPreview) {
		return input.hasOtherAsset
			? 'The reserve has no capacity for this gold token today. Try the other asset, or return after the daily window resets.'
			: 'The reserve has no capacity for this gold token today. Return after the daily window resets.';
	}
	if (input.goldOut !== undefined && input.remainingToday !== undefined && input.goldOut > input.remainingToday) {
		return 'This amount exceeds what the reserve can pay out today. Reduce the amount, or return after the daily window resets.';
	}
	if (input.hasTyped && input.parsedAmount !== undefined && !input.hasPrice) {
		return 'No oracle price is available for this gold token right now.';
	}
	return undefined;
}

/**
 * The reserve leg: GSUSD for protocol-owned gold at the oracle price minus the spread.
 * Behaviour is unchanged from the original single-venue swap page; only the amount,
 * token and tolerance state now live in the host so both legs share them.
 */
export function ReserveSwapPanel({
	chainId,
	typedAmount,
	onAmountChange,
	tokens,
	selectedToken,
	onSelectToken,
	slippageBps,
	onSlippageChange,
	reserve,
	oracle,
	preview,
	quoting = false,
}: ReserveSwapPanelProps) {
	const parsedAmount = parseGsusdAmount(typedAmount);
	const hasTyped = typedAmount.trim() !== '';

	const minGoldOut = preview ? computeMinGoldOut(preview.goldOut, slippageBps) : undefined;

	const validationMessage = resolveValidationMessage({
		paused: reserve.paused,
		supported: reserve.supported,
		hasTyped,
		parsedAmount,
		tooSmall: preview?.tooSmall ?? false,
		goldOut: preview?.goldOut,
		remainingToday: reserve.remainingToday,
		hasPrice: oracle.price8 !== undefined,
		hasPreview: !!preview,
		hasOtherAsset: tokens.length > 1,
	});

	const blocked = !!validationMessage || !preview || minGoldOut === undefined || !oracle.isLive;

	const decimals = selectedToken?.decimals ?? 18;
	const symbol = selectedToken?.symbol ?? 'gold';

	const spreadLabel = preview
		? `${formatTokenAmount(preview.spreadAmount, 18)} GSUSD (${formatPercent(Number(preview.spreadPpm) / 10_000, 2)})`
		: formatPercent(reserve.spreadPercent, 2);
	const receiveLabel = preview ? `≈ ${formatTokenAmount(preview.goldOut, decimals, 6)} ${symbol}` : 'Enter an amount';
	const minReceiveLabel =
		minGoldOut !== undefined ? `${formatTokenAmount(minGoldOut, decimals, 6)} ${symbol}` : 'Enter an amount';
	const reserveLabel =
		reserve.redeemable !== undefined
			? `Protocol reserve (${formatTokenAmount(reserve.redeemable, decimals, 4)} ${symbol} available)`
			: 'Protocol reserve';

	return (
		<div className="flex flex-col gap-4">
			<SwapForm
				typedAmount={typedAmount}
				onAmountChange={onAmountChange}
				tokens={tokens}
				selectedToken={selectedToken}
				onSelectToken={onSelectToken}
				slippageBps={slippageBps}
				onSlippageChange={onSlippageChange}
				preview={preview}
				quoting={quoting}
				minGoldOut={minGoldOut}
				spreadPercent={reserve.spreadPercent}
				redeemable={reserve.redeemable}
				remainingToday={reserve.remainingToday}
				reserveLoading={reserve.isLoading}
				reserveError={reserve.isError}
				oraclePrice={oracle.price8}
				oracleLoading={oracle.isLoading}
				oracleIsStale={oracle.price8 !== undefined && !oracle.isLive}
				oracleRefusal={oracle.refusal}
				validationMessage={validationMessage}
			/>
			<SwapButton
				chainId={chainId}
				onClosed={() => onAmountChange('')}
				selectedToken={selectedToken}
				typedAmount={typedAmount}
				minGoldOut={minGoldOut}
				blocked={blocked}
				spreadLabel={spreadLabel}
				receiveLabel={receiveLabel}
				minReceiveLabel={minReceiveLabel}
				reserveLabel={reserveLabel}
			/>
		</div>
	);
}
