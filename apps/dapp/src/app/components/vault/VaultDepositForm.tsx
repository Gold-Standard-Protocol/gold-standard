import { useCallback, useMemo, useState } from 'react';
import { useChainId } from 'wagmi';
import {
	useActiveCollateralTokens,
	useAllGoldTokens,
	useCollateralParams,
	useTokenBalance,
	useVaultContext,
	useVaultSimulation,
	useVaultStateActions,
	useVaultMinDebt,
} from '@goldstandard/hooks';
import { Token } from '@goldstandard/models';
import { TokenSelectionDialog } from '../TokenSelectionDialog';
import { TokenInput } from '../TokenInput';
import { PositionSummary } from './PositionSummary';
import { toInputAmount } from '../../lib/format';
import { riskRatios } from '../../lib/riskDefaults';
import { useVaultAmount } from './useVaultAmount';

export function VaultDepositForm() {
	const { state, position, fees, goldPrice, depositDecimals, collateralSymbol } = useVaultContext();
	const { setTypedAmount, setSelectedToken } = useVaultStateActions();
	const chainId = useChainId();
	const minDebt = useVaultMinDebt(chainId as never);
	// Risk parameters come from the vault, never hardcoded: they are governance-settable
	// per collateral, so a hardcoded 150/110 would quote limits the contract does not
	// enforce the moment they change.
	const params = useCollateralParams(
		chainId as never,
		position.position?.collateralToken as `0x${string}` | undefined
	);
	const { data: goldTokens } = useAllGoldTokens(chainId);

	const [tokenSelectionOpen, setTokenSelectionOpen] = useState(false);

	// The token being deposited lives in the vault context: the vault's own collateral
	// whenever it holds any (GoldVault reverts "Collateral token mismatch" on anything
	// else), otherwise whatever was picked. Resolving the Token instance from that one
	// address keeps the picker, the balance line and the transaction in agreement.
	const hasCollateral = Boolean(position.position && position.position.collateralAmount > 0n);
	const selectedGoldToken = useMemo(
		() =>
			Object.values(goldTokens ?? {}).find(
				(t): t is Token => t !== undefined && t.address.toLowerCase() === state.selectedToken?.toLowerCase()
			),
		[goldTokens, state.selectedToken]
	);
	// With collateral held, the picker offers only that token. Otherwise only the tokens the
	// vault lists as active: a dormant collateral (XAUT on a PAXG-first deployment) stays out
	// of the picker until governance activates it.
	const activeTokens = useActiveCollateralTokens(chainId);
	const selectableTokens = useMemo(
		() =>
			hasCollateral && selectedGoldToken
				? { [selectedGoldToken.address]: selectedGoldToken }
				: activeTokens,
		[hasCollateral, selectedGoldToken, activeTokens]
	);

	const { data: balance } = useTokenBalance(selectedGoldToken);
	const { reason, check } = useVaultAmount();

	const handleTokenSelected = useCallback((token: Token) => {
		setSelectedToken(token.address as `0x${string}`);
		setTokenSelectionOpen(false);
	}, [setSelectedToken]);

	const handleAmountChange = useCallback((value: string) => {
		setTypedAmount(value);
	}, [setTypedAmount]);

	const handleMax = useCallback(() => {
		if (!balance) {
			return;
		}
		// toExact() formats at the token's full decimals, same overflow as formatUnits.
		setTypedAmount(toInputAmount(BigInt(balance.quotient.toString()), balance.currency.decimals));
	}, [balance, setTypedAmount]);

	// Simulation preview
	const simulation = useVaultSimulation(
		position.position && check.value !== undefined && goldPrice && depositDecimals !== undefined
			? {
					action: 'deposit',
					amount: state.typedAmount,
					currentCollateralAmount: position.position.collateralAmount,
					// The deposit token's decimals, which are the vault's own whenever it holds
					// collateral: a 6-decimal XAUT deposit parsed at 18 previewed a million
					// million times the gold actually arriving.
					collateralDecimals: depositDecimals,
					// Fee-inclusive debt: the contracts judge health with getCurrentDebt(), so
					// simulating against principal showed a healthier ratio and a safer
					// liquidation price than the protocol actually believes.
					currentDebt: fees.currentDebt ?? position.position.debtAmount,
					collateralPrice: goldPrice,
					minDebt,
					...riskRatios(params),
				}
			: undefined
	);

	return (
		<div className="flex flex-col gap-3">
			<TokenSelectionDialog
				open={tokenSelectionOpen}
				description="Select a gold token to deposit as collateral"
				setOpen={setTokenSelectionOpen}
				onTokenSelected={handleTokenSelected}
				title="Select Collateral"
				tokens={selectableTokens}
			/>
			<TokenInput
				id="deposit-amount"
				label="You deposit"
				amount={state.typedAmount}
				onChooseToken={() => setTokenSelectionOpen(true)}
				onChangeAmount={handleAmountChange}
				onMax={handleMax}
				selectedToken={selectedGoldToken}
				disableTokenSelection={hasCollateral}
				showMax={true}
				reason={reason}
				note={
					hasCollateral && collateralSymbol
						? `This vault holds ${collateralSymbol}, so further deposits must be ${collateralSymbol}.`
						: undefined
				}
			/>

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
