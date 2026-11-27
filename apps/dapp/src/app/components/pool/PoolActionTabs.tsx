import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { formatUnits, type Address } from 'viem';
import { Card, CardContent, Tabs, TabsList, TabsTrigger, TabsContent } from '@goldstandard/ui';
import {
	clampWithdrawAmount,
	parseGsusdAmount,
	useGsusdToken,
	useStabilityPoolPosition,
	useTokenBalance,
	type PoolActionType,
} from '@goldstandard/hooks';
import { getStabilityPoolContractConfig, type GoldVaultChainId } from '@goldstandard/constants';
import { canonicalAmount, checkAmount, describeAmountProblem } from '@goldstandard/utils';
import { TokenInput } from '../TokenInput';
import { formatTokenAmount, toInputAmount } from '../../lib/format';
import { PoolButton } from './PoolButton';
import { TokenPill } from '../TokenPill';

interface PoolActionState {
	activeTab: PoolActionType;
	typedAmount: string;
	selectedClaimToken: Address | undefined;
}

const tabs: { value: PoolActionType; label: string; hint: string }[] = [
	{
		value: 'deposit',
		label: 'Deposit',
		hint: 'Deposit GSUSD so the pool can absorb liquidated debt. Your deposit is at risk and can shrink.',
	},
	{
		value: 'withdraw',
		label: 'Withdraw',
		hint: 'Withdraw your remaining GSUSD deposit. The pool caps withdrawals at your effective deposit.',
	},
	{
		value: 'claim',
		label: 'Claim',
		hint: 'Claim the gold collateral credited to you when the pool absorbed liquidations.',
	},
];

export function PoolActionTabs() {
	const chainId = useChainId() as GoldVaultChainId;
	const { address } = useAccount();
	const config = getStabilityPoolContractConfig(chainId);
	const gsusdToken = useGsusdToken(chainId);
	const position = useStabilityPoolPosition(chainId, address);
	const { data: gsusdBalance } = useTokenBalance(gsusdToken);

	const [state, setState] = useState<PoolActionState>({
		activeTab: 'deposit',
		typedAmount: '',
		selectedClaimToken: undefined,
	});

	// A typed amount belongs to the account that typed it: a wallet switch starts afresh.
	const previousScope = useRef(`${chainId}:${address ?? ''}`);
	useEffect(() => {
		const scope = `${chainId}:${address ?? ''}`;
		if (previousScope.current === scope) return;
		previousScope.current = scope;
		setState({ activeTab: 'deposit', typedAmount: '', selectedClaimToken: undefined });
	}, [chainId, address]);

	const setActiveTab = useCallback((value: string) => {
		setState((prev) => ({ ...prev, activeTab: value as PoolActionType, typedAmount: '' }));
	}, []);

	const setTypedAmount = useCallback((value: string) => {
		setState((prev) => ({ ...prev, typedAmount: value }));
	}, []);

	const setSelectedClaimToken = useCallback((token: Address) => {
		setState((prev) => ({ ...prev, selectedClaimToken: token }));
	}, []);

	if (!config) {
		return (
			<Card>
				<CardContent className="p-5 sm:p-6">
					<p className="text-sm leading-relaxed text-muted-foreground">
						The stability pool opens with the protocol launch. Deposits,
						withdrawals and collateral claims will be available here once the
						pool contract is deployed.
					</p>
				</CardContent>
			</Card>
		);
	}

	const effectiveDeposit = position.effectiveDeposit ?? 0n;
	// A deposit still being read, or whose read failed, is unknown, not zero: the form says
	// which rather than falling silent with a disabled button and a 0.00 balance.
	const depositKnown = position.effectiveDeposit !== undefined;
	// One reading of the typed amount for the form's reason and the button's gate. The
	// pool caps an over-large withdrawal itself, so only the deposit checks the balance.
	const walletGsusd = gsusdBalance ? BigInt(gsusdBalance.quotient.toString()) : undefined;
	const check = checkAmount(state.typedAmount, 18, state.activeTab === 'deposit' ? walletGsusd : undefined);
	// With no effective deposit (never deposited, or absorbed by liquidations) a withdrawal can
	// only fail, so there is nothing to sign until the deposit is known and above zero.
	const nothingToWithdraw = state.activeTab === 'withdraw' && effectiveDeposit === 0n;
	const amount = check.value !== undefined && !nothingToWithdraw ? canonicalAmount(check.value, 18) : '';
	const reason =
		state.typedAmount === ''
			? undefined
			: state.activeTab === 'withdraw' && !depositKnown
				? position.isLoading
					? 'Reading your pool deposit.'
					: 'Your pool deposit could not be read. Check your connection and try again.'
				: nothingToWithdraw && position.effectiveDeposit === 0n
					? 'You have no GSUSD deposited in the pool to withdraw.'
					: check.problem !== undefined
						? describeAmountProblem(check.problem, 'GSUSD')
						: undefined;
	const parsedWithdraw = parseGsusdAmount(state.typedAmount);
	const exceedsDeposit =
		state.activeTab === 'withdraw' &&
		!nothingToWithdraw &&
		parsedWithdraw !== undefined &&
		parsedWithdraw > effectiveDeposit;
	const withdrawCap =
		parsedWithdraw !== undefined
			? clampWithdrawAmount(parsedWithdraw, effectiveDeposit)
			: undefined;
	// The pool pays at most the effective deposit, so the review dialog states that, not the typed amount.
	const reviewAmount =
		state.activeTab === 'withdraw' && amount !== '' && check.value !== undefined
			? canonicalAmount(clampWithdrawAmount(check.value, effectiveDeposit), 18)
			: amount;

	const claimableGains = (position.gains ?? []).filter((gain) => gain.amount > 0n);
	const selectedGain = claimableGains.find(
		(gain) => gain.token === state.selectedClaimToken
	);

	const activeHint = tabs.find((tab) => tab.value === state.activeTab)?.hint;

	return (
		<Card className="p-4 sm:p-5">
			<Tabs value={state.activeTab} onValueChange={setActiveTab} className="w-full">
				<TabsList className="grid w-full grid-cols-3">
					{tabs.map((tab) => (
						<TabsTrigger key={tab.value} value={tab.value}>
							{tab.label}
						</TabsTrigger>
					))}
				</TabsList>

				{activeHint && (
					<p
						className="mt-4 text-center text-xs leading-relaxed text-muted-foreground text-pretty"
						aria-live="polite"
					>
						{activeHint}
					</p>
				)}

				<TabsContent value="deposit" className="mt-5">
					<TokenInput
						id="pool-deposit-amount"
						label="You deposit"
						amount={state.typedAmount}
						onChangeAmount={setTypedAmount}
						onMax={() => {
							if (gsusdBalance)
								setTypedAmount(
									toInputAmount(
										BigInt(gsusdBalance.quotient.toString()),
										gsusdBalance.currency.decimals
									)
								);
						}}
						selectedToken={gsusdToken}
						disableTokenSelection
						showMax
						reason={reason}
					/>
				</TabsContent>

				<TabsContent value="withdraw" className="mt-5">
					<div className="flex flex-col gap-3">
						<TokenInput
							id="pool-withdraw-amount"
							label="You withdraw"
							amount={state.typedAmount}
							onChangeAmount={setTypedAmount}
							onMax={() => setTypedAmount(toInputAmount(effectiveDeposit, 18))}
							selectedToken={gsusdToken}
							disableTokenSelection
							showMax={depositKnown}
							availableLabel="Pool deposit"
							availableAmount={depositKnown ? formatTokenAmount(effectiveDeposit, 18, 2) : undefined}
							reason={reason}
						/>
						{exceedsDeposit && withdrawCap !== undefined && (
							<p className="rounded-lg border border-warning/20 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning">
								You can withdraw at most {formatTokenAmount(withdrawCap, 18, 2)} GSUSD.
								The pool caps the withdrawal at your effective deposit instead
								of rejecting it.
							</p>
						)}
					</div>
				</TabsContent>

				<TabsContent value="claim" className="mt-5">
					{claimableGains.length === 0 ? (
						<p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
							No liquidation collateral gains to claim yet. Gains appear after
							the pool absorbs a liquidation.
						</p>
					) : (
						<ul className="space-y-2" role="radiogroup" aria-label="Collateral to claim">
							{claimableGains.map((gain) => {
								const isSelected = gain.token === state.selectedClaimToken;
								return (
									<li key={gain.token}>
										<button
											type="button"
											role="radio"
											aria-checked={isSelected}
											onClick={() => setSelectedClaimToken(gain.token)}
											className={`flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors ${
												isSelected
													? 'border-primary bg-muted/60'
													: 'border-border bg-muted/40 hover:bg-muted/60'
											}`}
										>
											<TokenPill symbol={gain.symbol} />
											<span className="nums text-sm font-medium text-foreground">
												{formatUnits(gain.amount, gain.decimals)}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					)}
				</TabsContent>
			</Tabs>

			<div className="mt-5">
				<PoolButton
					activeTab={state.activeTab}
					amount={amount}
					reviewAmount={reviewAmount}
					selectedGain={selectedGain}
					onClosed={() => setTypedAmount('')}
				/>
			</div>
		</Card>
	);
}
