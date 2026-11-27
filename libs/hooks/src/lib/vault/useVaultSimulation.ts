import { useMemo } from 'react';
import { GOLD_VAULT_MIN_DEBT } from '@goldstandard/constants';
import type { VaultActionType } from './useVaultActions';
import { parseVaultAmount } from './vaultAmount';

export interface SimulationInput {
	action: VaultActionType;
	amount: string;
	currentCollateralAmount: bigint;
	/** Fee-inclusive debt, 18 decimals; health is judged against this. */
	currentDebt: bigint;
	/**
	 * Principal only (the vault's debtAmount). GoldVault applies MIN_DEBT to principal,
	 * so with it the preview can name the exact revert; without it the check is made
	 * against the fee-inclusive figure, which never flags a valid action.
	 */
	principalDebt?: bigint;
	/** GoldVault.minDebt as read from the chain; the deploy default when absent. */
	minDebt?: bigint;
	collateralPrice: number; // USD price of collateral token
	/** Collateral token decimals (PAXG 18, XAUT 6). Amounts and values scale by this. */
	collateralDecimals: number;
	minRatio: number; // e.g. 120 for 120%
	liquidationRatio: number; // e.g. 110 for 110%
}

export interface SimulationResult {
	newCollateralAmount: bigint;
	newDebt: bigint;
	newRatioPercent: number;
	newLiquidationPrice: number;
	currentRatioPercent: number;
	currentLiquidationPrice: number;
	isValid: boolean;
	errorMessage: string | undefined;
	/** A remark on an action that will go through; never set beside an error. */
	note: string | undefined;
}

/** GSUSD carries 18 decimals whatever the collateral. */
const GSUSD_DECIMALS = 18;

/**
 * Previews a vault action: the position after it, its ratio and liquidation price.
 *
 * Pure so it can be tested against known figures. Deposit and withdraw amounts are in
 * the COLLATERAL token's native units; mint and repay are GSUSD. Parsing XAUT at 18
 * decimals made every preview wrong by a factor of 1e12.
 */
export function simulateVault(input: SimulationInput): SimulationResult | undefined {
	const { action, amount, currentCollateralAmount, currentDebt, principalDebt, collateralPrice, collateralDecimals, minRatio, liquidationRatio } = input;

	if (!amount || amount === '0') return undefined;

	const parsedAmount = parseVaultAmount(
		amount,
		action === 'deposit' || action === 'withdraw' ? collateralDecimals : GSUSD_DECIMALS
	);
	if (parsedAmount === undefined) return undefined;

	let newCollateralAmount = currentCollateralAmount;
	let newDebt = currentDebt;

	switch (action) {
		case 'deposit':
			newCollateralAmount = currentCollateralAmount + parsedAmount;
			break;
		case 'withdraw':
			if (parsedAmount > currentCollateralAmount) {
				return {
					newCollateralAmount: 0n,
					newDebt: currentDebt,
					newRatioPercent: 0,
					newLiquidationPrice: 0,
					currentRatioPercent: calcRatioPercent(currentCollateralAmount, currentDebt, collateralPrice, collateralDecimals),
					currentLiquidationPrice: calcLiqPrice(currentDebt, currentCollateralAmount, liquidationRatio, collateralDecimals),
					isValid: false,
					errorMessage: 'Insufficient collateral',
					note: undefined,
				};
			}
			newCollateralAmount = currentCollateralAmount - parsedAmount;
			break;
		case 'mint':
			newDebt = currentDebt + parsedAmount;
			break;
		case 'repay':
			// Overshooting is legitimate and expected: GoldVault.repay caps `amount` at the
			// true currentDebt, and quoting high is the ONLY way to fully close a position
			// whose debt accrues every second. Clamp to zero rather than raising an error —
			// flagging it as invalid steered users away from the one action that works.
			newDebt = parsedAmount >= currentDebt ? 0n : currentDebt - parsedAmount;
			break;
	}

	const currentRatioPercent = calcRatioPercent(currentCollateralAmount, currentDebt, collateralPrice, collateralDecimals);
	const newRatioPercent = calcRatioPercent(newCollateralAmount, newDebt, collateralPrice, collateralDecimals);
	const currentLiquidationPrice = calcLiqPrice(currentDebt, currentCollateralAmount, liquidationRatio, collateralDecimals);
	const newLiquidationPrice = calcLiqPrice(newDebt, newCollateralAmount, liquidationRatio, collateralDecimals);

	const floorMessage = minimumDebtBreach(action, parsedAmount, currentDebt, newDebt, principalDebt, input.minDebt ?? GOLD_VAULT_MIN_DEBT);
	const belowMinimum = newDebt > 0n && newRatioPercent < minRatio;
	// GoldVault checks the minimum ratio on mint and withdraw only. A deposit or a repayment
	// can only raise the ratio, and the contract takes both from a vault at any ratio:
	// refusing them here turned away the two actions that repair an unhealthy vault.
	const ratioChecked = action === 'mint' || action === 'withdraw';
	const ratioOk = !ratioChecked || !belowMinimum;
	const isValid = ratioOk && floorMessage === undefined;
	const errorMessage = !ratioOk ? `Ratio would drop below ${minRatio}%` : floorMessage;
	const note =
		isValid && belowMinimum ? `Still below the ${minRatio}% minimum. Minting and withdrawing stay locked.` : undefined;

	return {
		newCollateralAmount,
		newDebt,
		newRatioPercent,
		newLiquidationPrice,
		currentRatioPercent,
		currentLiquidationPrice,
		isValid,
		errorMessage,
		note,
	};
}

export function useVaultSimulation(input: SimulationInput | undefined): SimulationResult | undefined {
	return useMemo(() => (input ? simulateVault(input) : undefined), [input]);
}

/**
 * GoldVault's MIN_DEBT floor, mirrored on the principal exactly as the contract applies
 * it: a mint must leave principal + amount at or above the floor, and a partial repayment
 * must leave the pro-rata remaining principal at zero or at or above it.
 */
function minimumDebtBreach(
	action: VaultActionType,
	amount: bigint,
	currentDebt: bigint,
	newDebt: bigint,
	principalDebt: bigint | undefined,
	minDebt: bigint
): string | undefined {
	const minDebtWhole = minDebt / 10n ** BigInt(GSUSD_DECIMALS);
	// Principal is never above the fee-inclusive debt, so the fee-inclusive figure is a
	// safe stand-in: it can miss a revert, never invent one.
	const principal = principalDebt ?? currentDebt;
	if (action === 'mint' && principal + amount < minDebt) {
		return `A vault must owe at least ${minDebtWhole} GSUSD`;
	}
	if (action === 'repay' && newDebt > 0n) {
		const remainingPrincipal = currentDebt > 0n ? (principal * newDebt) / currentDebt : 0n;
		if (remainingPrincipal > 0n && remainingPrincipal < minDebt) {
			return `Repay in full or leave at least ${minDebtWhole} GSUSD owing`;
		}
	}
	return undefined;
}

function calcRatioPercent(collateralAmount: bigint, debt: bigint, price: number, decimals: number): number {
	if (debt === 0n) return Infinity;
	const collateralValue = (Number(collateralAmount) / 10 ** decimals) * price;
	const debtValue = Number(debt) / 10 ** GSUSD_DECIMALS; // GSUSD is 1:1 USD
	return (collateralValue / debtValue) * 100;
}

function calcLiqPrice(debt: bigint, collateralAmount: bigint, liquidationRatio: number, decimals: number): number {
	if (collateralAmount === 0n) return 0;
	const debtValue = Number(debt) / 10 ** GSUSD_DECIMALS;
	const collateral = Number(collateralAmount) / 10 ** decimals;
	return (debtValue * liquidationRatio) / (collateral * 100);
}
