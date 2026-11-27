import { useCallback } from 'react';
import { parseUnits } from 'viem';
import { Button, Input } from '@goldstandard/ui';
import {
	useCollateralParams,
	useMintCapacity,
	useOraclePrice,
	useVaultContext,
	useVaultStateActions,
	useVaultSimulation,
	useVaultMinDebt,
	useOriginationFee,
} from '@goldstandard/hooks';
import { formatFeeBps, originationFeeSplit, withinDecimals } from '@goldstandard/utils';
import { formatTokenAmount } from '../../lib/format';
import { riskRatios } from '../../lib/riskDefaults';
import { PositionSummary } from './PositionSummary';
import { AmountReason } from './AmountReason';
import { useVaultAmount } from './useVaultAmount';
import { TokenPill } from '../TokenPill';

/** Explains which limit is binding, so the number is not just an unexplained ceiling. */
const limitExplanation = (limit: string, minDebtLabel: string): string => {
	switch (limit) {
		case 'ratio':
			return 'set by your collateral ratio';
		case 'per-block cap':
			return 'set by the protocol per-block mint cap';
		case 'debt ceiling':
			return 'set by this collateral debt ceiling';
		case 'minimum debt':
			return `nothing, because a vault must owe at least ${minDebtLabel}`;
		default:
			return 'set by protocol rules';
	}
};

export function VaultMintForm() {
	const { state, position, fees, goldPrice, chainId, collateralDecimals } = useVaultContext();
	const minDebt = useVaultMinDebt(chainId as never);
	const minDebtLabel = `${formatTokenAmount(minDebt, 18, 0)} GSUSD`;
	const params = useCollateralParams(
		chainId as never,
		position.position?.collateralToken as `0x${string}` | undefined
	);
	const { setTypedAmount } = useVaultStateActions();

	const { reason, check, canonical } = useVaultAmount();
	// The vault takes its origination fee from what it sends, so say what arrives before review.
	// `check.value` is in whole GSUSD (the form takes whole dollars); the fee is on wei.
	const originationFee = useOriginationFee(chainId as never);
	const mintFee =
		canonical !== '' && originationFee.bps !== undefined
			? originationFeeSplit(parseUnits(canonical, 18), originationFee.bps, originationFee.exempt === true)
			: undefined;

	// Whole dollars only: a fractional digit is refused at the keystroke rather than
	// silently floored, and anything else typed is kept and explained under the field.
	const handleAmountChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		if (!withinDecimals(e.target.value, 0)) return;
		setTypedAmount(e.target.value);
	}, [setTypedAmount]);

	const simulation = useVaultSimulation(
		position.position && check.value !== undefined && goldPrice && collateralDecimals !== undefined
			? {
					action: 'mint',
					amount: state.typedAmount,
					currentCollateralAmount: position.position.collateralAmount,
					collateralDecimals,
					// Fee-inclusive debt: the contracts judge health with getCurrentDebt(), so
					// simulating against principal showed a healthier ratio and a safer
					// liquidation price than the protocol actually believes.
					currentDebt: fees.currentDebt ?? position.position.debtAmount,
					// GoldVault applies its minDebt floor to principal + amount.
					principalDebt: position.position.debtAmount,
					collateralPrice: goldPrice,
					minDebt,
					...riskRatios(params),
				}
			: undefined
	);

	const hasCollateral = position.position && position.position.collateralAmount > 0n;

	// Capacity must be computed from the ORACLE price, not the market price feed the
	// ratio preview uses: the vault enforces its limits against the oracle, and the two
	// can diverge sharply (on testnet the mock oracle sits at $4,000 while the price API
	// reports the real ~$4,590). Quoting a Max from the market price would hand the user
	// a number the contract then rejects, which is the bug this is fixing.
	// Minting is valued at the oracle's borrowing price, the lowest of both market sources
	// and gold, so Max quotes what the contract will accept.
	const oracle = useOraclePrice(
		chainId as never,
		position.position?.collateralToken as `0x${string}` | undefined,
		'borrow'
	);
	const capacity = useMintCapacity(
		chainId as never,
		position.position?.collateralToken as `0x${string}` | undefined,
		position.position?.collateralAmount,
		fees.currentDebt ?? position.position?.debtAmount,
		oracle.price8,
		collateralDecimals,
		position.position?.debtAmount
	);

	// Whole dollars only, and always round DOWN so Max is never itself over the limit.
	// The DISPLAYED figure must floor too: 0.61 GSUSD of headroom rendered as "Max: 1"
	// at exactly 130%, and a mint of 1 would have reverted. Max also leaves the small
	// reserve that fee accrual and a moving oracle need, so the mint it offers still
	// passes in the block that includes it.
	const wholeAvailable = capacity.recommended !== undefined ? capacity.recommended / 10n ** 18n : undefined;
	const handleMaxClick = useCallback(() => {
		if (wholeAvailable === undefined) return;
		setTypedAmount(wholeAvailable.toString());
	}, [wholeAvailable, setTypedAmount]);

	return (
		<div className="flex flex-col gap-3">
			<div className="rounded-lg border border-border bg-muted/40 p-3.5 transition-colors focus-within:border-ring/60">
				<div className="mb-2 flex items-center justify-between">
					<label htmlFor="mint-amount" className="label-mono text-xs text-muted-foreground">Mint GSUSD</label>
					{hasCollateral && wholeAvailable !== undefined && wholeAvailable > 0n ? (
						<Button variant="link" size="xs" className="-my-3 -mr-2 min-h-11 justify-end px-2" onClick={handleMaxClick}>
							Max: {wholeAvailable.toLocaleString('en-US')} GSUSD
						</Button>
					) : hasCollateral && wholeAvailable === 0n ? (
						<span className="text-xs text-muted-foreground">
							{capacity.limitedBy === 'minimum debt'
								? `Not enough headroom for the ${minDebtLabel} minimum`
								: 'No headroom at the current ratio'}
						</span>
					) : (
						<span className="text-xs text-muted-foreground">
							{hasCollateral ? 'Whole dollars only' : 'Deposit collateral first'}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					<Input
						id="mint-amount"
						inputMode="numeric"
						aria-invalid={reason ? true : undefined}
						aria-describedby={reason ? 'mint-amount-reason' : undefined}
						disabled={!hasCollateral}
						className="nums h-auto border-0 bg-transparent p-0 text-2xl font-medium shadow-none focus-visible:ring-0 disabled:opacity-100"
						placeholder="0"
						onChange={handleAmountChange}
						value={state.typedAmount}
					/>
					<TokenPill symbol="GSUSD" />
				</div>
				<AmountReason id="mint-amount-reason" reason={reason} />
				{!reason && mintFee && mintFee.fee > 0n && (
					<span className="mt-2 block text-xs text-muted-foreground">
						You receive <span className="nums text-foreground">{formatTokenAmount(mintFee.received, 18, 6)} GSUSD</span>{' '}
						after the {formatFeeBps(mintFee.bps)} mint fee. Your vault owes the full amount.
					</span>
				)}
				{hasCollateral && capacity.limitedBy && capacity.available !== undefined && (
					<span className="mt-2 block text-xs text-muted-foreground">
						Whole dollars only. The most you can mint now is{' '}
						{limitExplanation(capacity.limitedBy, minDebtLabel)}.
					</span>
				)}
			</div>

			{simulation && (
				<PositionSummary
					ratios={riskRatios(params)}
					currentRatioPercent={simulation.currentRatioPercent}
					newRatioPercent={simulation.newRatioPercent}
					currentLiquidationPrice={simulation.currentLiquidationPrice}
					newLiquidationPrice={simulation.newLiquidationPrice}
					currentDebt={fees.currentDebt ?? position.position?.debtAmount ?? 0n}
					newDebt={simulation.newDebt}
					isValid={simulation.isValid}
					errorMessage={simulation.errorMessage}
				/>
			)}
		</div>
	);
}
