import { useCallback, useMemo } from 'react';
import { formatUnits } from 'viem';
import { withinDecimals } from '@goldstandard/utils';
import { Button, Input } from '@goldstandard/ui';
import {
	useCollateralParams,
	useGsusdToken,
	useOriginationFee,
	useTokenBalance,
	useVaultContext,
	useVaultStateActions,
	useVaultSimulation,
	useVaultMinDebt,
} from '@goldstandard/hooks';
import { PositionSummary } from './PositionSummary';
import { formatPercent, formatTokenAmount } from '../../lib/format';
import { closesWithMargin, planRepayment } from '../../lib/repayPlan';
import { riskRatios } from '../../lib/riskDefaults';
import { AmountReason } from './AmountReason';
import { useVaultAmount } from './useVaultAmount';
import { TokenPill } from '../TokenPill';

/**
 * Truncates a wei amount to a typeable number of decimals, always rounding DOWN.
 *
 * formatUnits(x, 18) yields things like 39040.539673484096736935, which overflowed the
 * review dialog and is not a number anyone would type. Rounding down matters: the value
 * becomes the transaction amount, and rounding up could push it past the balance the
 * caller just capped it to.
 */
function truncateDown(value: bigint, decimals: number): string {
	const scale = 10n ** BigInt(18 - decimals);
	return formatUnits((value / scale) * scale, 18);
}

export function VaultRepayForm() {
	const { state, position, fees, goldPrice, chainId, collateralDecimals } = useVaultContext();
	const minDebt = useVaultMinDebt(chainId as never);
	const params = useCollateralParams(
		chainId as never,
		position.position?.collateralToken as `0x${string}` | undefined
	);
	const { setTypedAmount } = useVaultStateActions();
	const gsusdToken = useGsusdToken(chainId as never);
	const { data: gsusdBalanceAmount } = useTokenBalance(gsusdToken);
	// CurrencyAmount.quotient is a JSBI, not a native bigint; go via its decimal string.
	const gsusdBalance = useMemo(
		() =>
			gsusdBalanceAmount
				? BigInt(gsusdBalanceAmount.quotient.toString())
				: undefined,
		[gsusdBalanceAmount]
	);

	const { reason, check } = useVaultAmount();
	const originationFee = useOriginationFee(chainId as never);

	// GSUSD carries 18 decimals; a nineteenth is refused at the keystroke rather than rounded.
	const handleAmountChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		if (!withinDecimals(e.target.value, 18)) return;
		setTypedAmount(e.target.value);
	}, [setTypedAmount]);

	// The exact ceiling is subtle enough that it lives in a tested pure function.
	const repayPlan = useMemo(() => {
		const principal = position.position?.debtAmount;
		const debt = fees.currentDebt;
		if (principal === undefined || debt === undefined || gsusdBalance === undefined) {
			return undefined;
		}
		return planRepayment(principal, debt, gsusdBalance, minDebt);
	}, [position.position?.debtAmount, fees.currentDebt, gsusdBalance, minDebt]);

	const handleMaxClick = useCallback(() => {
		if (repayPlan) setTypedAmount(truncateDown(repayPlan.amount, 6));
	}, [repayPlan, setTypedAmount]);

	const hasDebt = position.position && position.position.debtAmount > 0n;

	// What the borrower must source elsewhere to close: the origination fee charged on each
	// mint, the stability fee accrued since and the margin a close needs for the fees that
	// accrue before it confirms. Minting more does NOT help: each
	// mint adds its fee to the debt, so the gap only widens.
	const shortfall = repayPlan?.shortToClose ?? 0n;
	// The origination fee is governed (5 bps at launch) and some accounts are exempt.
	const debtFees =
		originationFee.exempt === true || originationFee.bps === 0n
			? 'a stability fee that accrues every second'
			: `the ${
					originationFee.bps !== undefined ? `${formatPercent(Number(originationFee.bps) / 100, 2)} ` : ''
				}origination fee charged on each mint and a stability fee that accrues every second`;

	// True when what has been typed clears the whole debt with the accrual margin: the figure
	// in the box is then a ceiling, and the hint below shows what is actually owed. An amount
	// that only matches the debt this second is not a close.
	const closingNow = useMemo(() => {
		if (!repayPlan?.closes || fees.currentDebt === undefined || check.value === undefined) return false;
		return closesWithMargin(check.value, fees.currentDebt);
	}, [repayPlan?.closes, fees.currentDebt, check.value]);

	const simulation = useVaultSimulation(
		position.position && check.value !== undefined && goldPrice && collateralDecimals !== undefined
			? {
					action: 'repay',
					amount: state.typedAmount,
					currentCollateralAmount: position.position.collateralAmount,
					collateralDecimals,
					// Fee-inclusive debt: the contracts judge health with getCurrentDebt(), so
					// simulating against principal showed a healthier ratio and a safer
					// liquidation price than the protocol actually believes.
					currentDebt: fees.currentDebt ?? position.position.debtAmount,
					// The contract's minDebt floor applies to the pro-rata remaining principal.
					principalDebt: position.position.debtAmount,
					collateralPrice: goldPrice,
					minDebt,
					...riskRatios(params),
				}
			: undefined
	);

	return (
		<div className="flex flex-col gap-3">
			<div className="rounded-lg border border-border bg-muted/40 p-3.5 transition-colors focus-within:border-ring/60">
				<div className="mb-2 flex items-center justify-between">
					<label htmlFor="repay-amount" className="label-mono text-xs text-muted-foreground">Repay GSUSD</label>
					{hasDebt && (
						<Button
							variant="link"
							size="xs"
							className="-my-3 -mr-2 min-h-11 justify-end px-2"
							disabled={repayPlan?.blocked}
							onClick={handleMaxClick}
						>
							{repayPlan
								? repayPlan.closes
									? 'Close position'
									: `Max: ${formatTokenAmount(repayPlan.amount, 18, 2)} GSUSD`
								: `Max: ${fees.currentDebtFormatted} GSUSD`}
						</Button>
					)}
				</div>
				<div className="flex items-center gap-2">
					<Input
						id="repay-amount"
						inputMode="decimal"
						aria-invalid={reason ? true : undefined}
						aria-describedby={reason ? 'repay-amount-reason' : undefined}
						disabled={!hasDebt}
						className="nums h-auto border-0 bg-transparent p-0 text-2xl font-medium shadow-none focus-visible:ring-0 disabled:opacity-100"
						placeholder="0"
						onChange={handleAmountChange}
						value={state.typedAmount}
					/>
					<TokenPill symbol="GSUSD" />
				</div>
				{!hasDebt && (
					<span className="mt-2 block text-xs text-muted-foreground">
						No outstanding debt
					</span>
				)}
				<AmountReason id="repay-amount-reason" reason={reason} />
				{hasDebt && closingNow && fees.currentDebt !== undefined && (
					<span className="mt-2 block text-xs leading-relaxed text-muted-foreground">
						Closes the position. Owed right now:{' '}
						<span className="nums text-foreground">
							{formatTokenAmount(fees.currentDebt, 18, 6)} GSUSD
						</span>
						, accruing by the second. The amount above that is a margin so the close
						cannot fall short before it confirms; only what is owed at that moment is
						taken, and the rest never leaves your wallet.
					</span>
				)}
				{hasDebt && shortfall > 0n && repayPlan && (
					<span className="mt-2 block text-xs leading-relaxed text-muted-foreground">
						To close this vault you need{' '}
						<span className="nums text-foreground">
							{formatTokenAmount(shortfall, 18, 6)} GSUSD
						</span>{' '}
						more than you hold, including a small margin for the fees that accrue before
						the transaction confirms. Your debt carries {debtFees}, while the GSUSD you
						received does not grow.{' '}
						<span className="text-foreground">
							Minting more will not close the gap
						</span>
						, because each mint adds at least as much to your debt as to your wallet, so
						you would need to acquire that GSUSD elsewhere to close the position
						completely.
						{repayPlan.blocked ? (
							' This position is too small to repay in part, so it can only be closed in full.'
						) : (
							<>
								{' '}
								Until then the most you can repay is{' '}
								<span className="nums text-foreground">
									{formatTokenAmount(repayPlan.amount, 18, 2)} GSUSD
								</span>
								, which leaves the {formatTokenAmount(minDebt, 18, 0)} GSUSD minimum the
								protocol requires a vault to keep.
							</>
						)}
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
					note={simulation.note}
				/>
			)}
		</div>
	);
}
