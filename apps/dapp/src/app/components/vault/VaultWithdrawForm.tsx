import { useCallback, useMemo } from 'react';
import { Button, Input } from '@goldstandard/ui';
import {
	useCollateralParams,
	useOraclePrice,
	useVaultContext,
	useVaultStateActions,
	useVaultSimulation,
} from '@goldstandard/hooks';
import { withinDecimals } from '@goldstandard/utils';
import { PositionSummary } from './PositionSummary';
import { AmountReason } from './AmountReason';
import { useVaultAmount } from './useVaultAmount';
import { formatTokenAmount, toInputAmount } from '../../lib/format';
import { maxWithdrawable } from '../../lib/withdrawPlan';
import { riskRatios } from '../../lib/riskDefaults';
import { TokenPill } from '../TokenPill';

export function VaultWithdrawForm() {
	const { state, position, fees, goldPrice, chainId, collateralDecimals, collateralSymbol } =
		useVaultContext();
	const params = useCollateralParams(
		chainId as never,
		position.position?.collateralToken as `0x${string}` | undefined
	);
	const { setTypedAmount } = useVaultStateActions();

	const { reason, check } = useVaultAmount();

	// A digit beyond the collateral's decimals is refused at the keystroke rather than rounded.
	const handleAmountChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		if (collateralDecimals !== undefined && !withinDecimals(e.target.value, collateralDecimals)) return;
		setTypedAmount(e.target.value);
	}, [setTypedAmount, collateralDecimals]);

	const hasCollateral = position.position && position.position.collateralAmount > 0n;
	// The collateral's decimals and symbol come from the vault context, resolved from the
	// position's token address, so PAXG and XAUT are never confused with each other. With
	// no vault there is no token to name, so the unit pill is simply not shown: a generic
	// "gold" in a unit pill read as a third asset.

	// Max is what can leave WITHOUT breaching the minimum ratio at the oracle price
	// the contract will use, not the whole balance.
	// Indebted withdrawals are valued at the borrowing price.
	const oracle = useOraclePrice(chainId, position.position?.collateralToken, 'borrow');
	const maxOut = useMemo(() => {
		if (!position.position) return undefined;
		const debt = fees.currentDebt ?? position.position.debtAmount;
		if (debt === 0n) return position.position.collateralAmount;
		if (
			oracle.price8 === undefined ||
			params.minRatioPercent === undefined ||
			collateralDecimals === undefined
		) {
			return undefined;
		}
		return maxWithdrawable(
			position.position.collateralAmount,
			debt,
			oracle.price8,
			BigInt(Math.round(params.minRatioPercent * 10_000)),
			collateralDecimals
		);
	}, [position.position, fees.currentDebt, oracle.price8, params.minRatioPercent, collateralDecimals]);
	const isCappedByRatio =
		maxOut !== undefined && position.position !== undefined && maxOut < position.position.collateralAmount;

	const handleMaxClick = useCallback(() => {
		if (maxOut !== undefined && collateralDecimals !== undefined) {
			setTypedAmount(toInputAmount(maxOut, collateralDecimals));
		}
	}, [maxOut, collateralDecimals, setTypedAmount]);

	const simulation = useVaultSimulation(
		position.position && check.value !== undefined && goldPrice && collateralDecimals !== undefined
			? {
					action: 'withdraw',
					amount: state.typedAmount,
					currentCollateralAmount: position.position.collateralAmount,
					collateralDecimals,
					// Fee-inclusive debt: the contracts judge health with getCurrentDebt(), so
					// simulating against principal showed a healthier ratio and a safer
					// liquidation price than the protocol actually believes.
					currentDebt: fees.currentDebt ?? position.position.debtAmount,
					collateralPrice: goldPrice,
					...riskRatios(params),
				}
			: undefined
	);

	return (
		<div className="flex flex-col gap-3">
			<div className="rounded-lg border border-border bg-muted/40 p-3.5 transition-colors focus-within:border-ring/60">
				<div className="mb-2 flex items-center justify-between">
					<label htmlFor="withdraw-amount" className="label-mono text-xs text-muted-foreground">Withdraw collateral</label>
					{hasCollateral && maxOut !== undefined && collateralDecimals !== undefined && collateralSymbol && (
						<Button variant="link" size="xs" className="-my-3 -mr-2 min-h-11 justify-end px-2" onClick={handleMaxClick}>
							Max: {formatTokenAmount(maxOut, collateralDecimals, 4)} {collateralSymbol}
						</Button>
					)}
				</div>
				<div className="flex items-center gap-2">
					<Input
						id="withdraw-amount"
						inputMode="decimal"
						aria-invalid={reason ? true : undefined}
						aria-describedby={reason ? 'withdraw-amount-reason' : undefined}
						disabled={!hasCollateral}
						className="nums h-auto border-0 bg-transparent p-0 text-2xl font-medium shadow-none focus-visible:ring-0 disabled:opacity-100"
						placeholder="0"
						onChange={handleAmountChange}
						value={state.typedAmount}
					/>
					{hasCollateral && collateralSymbol && (
						<TokenPill symbol={collateralSymbol} />
					)}
				</div>
				{!hasCollateral && (
					<span className="mt-2 block text-xs text-muted-foreground">
						No collateral deposited
					</span>
				)}
				<AmountReason id="withdraw-amount-reason" reason={reason} />
				{hasCollateral && isCappedByRatio && (
					<span className="mt-2 block text-xs leading-relaxed text-muted-foreground">
						Your debt keeps the rest locked: the vault must hold {riskRatios(params).minRatio}% of
						its debt in gold at the oracle price. Max also leaves a small cushion for fees that
						accrue before your transaction lands. Repay some GSUSD to free more.
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
