import { useMemo } from 'react';
import { useChainId } from 'wagmi';
import { useAllGoldTokens, useGsusdToken, useTokenBalance, useVaultContext } from '@goldstandard/hooks';
import { Token } from '@goldstandard/models';
import { canonicalAmount, checkAmount, describeAmountProblem, type AmountCheck } from '@goldstandard/utils';

/** The mint box takes whole dollars: GoldVault's floor and ceiling are quoted in them. */
const MINT_DECIMALS = 0;

export interface VaultAmount {
	check: AmountCheck;
	/** Decimals the active tab's amount is typed in; undefined until the token is known. */
	decimals: number | undefined;
	symbol: string;
	/** The exact decimal the wallet will be asked to sign, or an empty string while invalid. */
	canonical: string;
	/** The line under the field, once something has been typed. */
	reason: string | undefined;
}

/**
 * One reading of the typed amount for the active vault tab, shared by the form that shows
 * the reason and the button that enables the action, so the two can never disagree about
 * whether an amount is usable. Each tab has its own decimals and its own ceiling.
 */
export function useVaultAmount(): VaultAmount {
	const { state, position, depositDecimals, collateralDecimals, collateralSymbol } = useVaultContext();
	const chainId = useChainId();
	const gsusdToken = useGsusdToken(chainId);
	const { data: goldTokens } = useAllGoldTokens(chainId);
	const depositToken = useMemo(
		() =>
			Object.values(goldTokens ?? {}).find(
				(t): t is Token => t !== undefined && t.address.toLowerCase() === state.selectedToken?.toLowerCase()
			),
		[goldTokens, state.selectedToken]
	);
	const { data: depositBalance } = useTokenBalance(depositToken);
	const { data: gsusdBalance } = useTokenBalance(gsusdToken);

	return useMemo(() => {
		const raw = (amount: typeof depositBalance) => (amount ? BigInt(amount.quotient.toString()) : undefined);
		const tab = {
			deposit: { decimals: depositDecimals, symbol: depositToken?.symbol ?? 'gold', balance: raw(depositBalance), over: 'More than your balance' },
			mint: { decimals: MINT_DECIMALS, symbol: 'GSUSD', balance: undefined, over: undefined },
			repay: { decimals: 18, symbol: 'GSUSD', balance: raw(gsusdBalance), over: 'More than your balance' },
			withdraw: { decimals: collateralDecimals, symbol: collateralSymbol ?? 'gold', balance: position.position?.collateralAmount, over: 'More than your vault holds' },
		}[state.activeTab];
		const check: AmountCheck =
			tab.decimals === undefined ? { value: undefined, problem: 'empty' } : checkAmount(state.typedAmount, tab.decimals, tab.balance);
		const canonical = check.value !== undefined && tab.decimals !== undefined ? canonicalAmount(check.value, tab.decimals) : '';
		const reason =
			state.typedAmount === '' || check.problem === undefined
				? undefined
				: check.problem === 'too-many-decimals' && state.activeTab === 'mint'
				? 'Whole GSUSD only'
				: check.problem === 'over-balance' && tab.over
				? tab.over
				: describeAmountProblem(check.problem, tab.symbol);
		return { check, decimals: tab.decimals, symbol: tab.symbol, canonical, reason };
	}, [state.activeTab, state.typedAmount, depositDecimals, depositToken, depositBalance, gsusdBalance, collateralDecimals, collateralSymbol, position.position?.collateralAmount]);
}
