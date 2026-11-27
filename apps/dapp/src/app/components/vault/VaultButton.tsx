import { type FC, useMemo } from 'react';
import { useChainId } from 'wagmi';
import { parseUnits } from 'viem';
import { Button, DialogTrigger } from '@goldstandard/ui';
import { originationFeeSplit, tryParseCurrencyAmount } from '@goldstandard/utils';
import * as Guard from '../Guard';
import { ReviewVaultDialog, type RepaySettlement, type VaultOutcome } from './ReviewVaultDialog';
import { useVaultAmount } from './useVaultAmount';
import {
	useAllGoldTokens,
	useCollateralParams,
	useGsusdToken,
	useVaultContext,
	useVaultDeposit,
	useVaultMinDebt,
	useVaultMint,
	useOriginationFee,
	useVaultRepay,
	useVaultSimulation,
	useVaultStateActions,
	useVaultWithdraw,
	type VaultActionType,
} from '@goldstandard/hooks';
import { getGoldVaultContractConfig, type GoldVaultChainId } from '@goldstandard/constants';
import { describeTxError } from '../../lib/txError';
import { closesWithMargin } from '../../lib/repayPlan';
import { riskRatios } from '../../lib/riskDefaults';

const actionButtonLabels = {
	deposit: 'Deposit',
	mint: 'Mint GSUSD',
	repay: 'Repay',
	withdraw: 'Withdraw',
} as const;

export const VaultButton: FC = () => {
	const { state, position, fees, goldPrice, collateralDecimals, collateralSymbol, depositDecimals } =
		useVaultContext();
	const { setTypedAmount } = useVaultStateActions();
	const chainId = useChainId() as GoldVaultChainId;
	// The same reading of the typed amount the form shows its reason for: an empty string
	// until it is usable, then the exact decimal the wallet signs. The hooks simulate it.
	const { canonical: amount, check } = useVaultAmount();

	// Deposit and withdraw move the COLLATERAL token, whose decimals differ (PAXG 18,
	// XAUT 6); mint and repay move GSUSD (always 18). The decimals come from the vault
	// context, which resolves them from the token address rather than assuming 18.
	// Only the active tab simulates, as in the pool: the other three were checked on
	// every typed amount, in the wrong unit, and mostly reverted.
	const amountFor = (action: VaultActionType) => (state.activeTab === action ? amount : undefined);
	const deposit = useVaultDeposit(chainId, state.selectedToken, amountFor('deposit'), depositDecimals);
	const mint = useVaultMint(chainId, amountFor('mint'));
	const repay = useVaultRepay(chainId, amountFor('repay'));
	const withdraw = useVaultWithdraw(chainId, amountFor('withdraw'), collateralDecimals);

	// Select the appropriate hook result based on active tab
	const activeHook = {
		deposit,
		mint,
		repay,
		withdraw,
	}[state.activeTab];

	const hasAmount = check.value !== undefined;
	const buttonLabel = actionButtonLabels[state.activeTab];

	// The same preview the form shows, restated on the review and the receipt so the
	// user reads what their vault will owe without going back to a card that may still
	// be catching up with the chain.
	const minDebt = useVaultMinDebt(chainId as never);
	const params = useCollateralParams(chainId as never, position.position?.collateralToken);
	const simulationDecimals = state.activeTab === 'deposit' ? depositDecimals : collateralDecimals;
	const simulation = useVaultSimulation(
		hasAmount && goldPrice && simulationDecimals !== undefined
			? {
					action: state.activeTab,
					amount,
					currentCollateralAmount: position.position?.collateralAmount ?? 0n,
					collateralDecimals: simulationDecimals,
					currentDebt: fees.currentDebt ?? position.position?.debtAmount ?? 0n,
					principalDebt: position.position?.debtAmount ?? 0n,
					collateralPrice: goldPrice,
					minDebt,
					...riskRatios(params),
				}
			: undefined
	);
	const outcome: VaultOutcome | undefined =
		simulation && simulation.isValid
			? { debt: simulation.newDebt, ratioPercent: simulation.newRatioPercent, liquidationPrice: simulation.newLiquidationPrice }
			: undefined;

	// Both inbound actions pull tokens with safeTransferFrom, so the vault must hold an
	// allowance first. The pool and swap flows already guard this; the vault did not,
	// which meant repay could never complete from the UI at all: a correctly sized
	// repayment still reverted with ERC20InsufficientAllowance and there was no approve
	// step anywhere to clear it. Deposit had the same gap for the gold token.
	const gsusdToken = useGsusdToken(chainId);
	const { data: goldTokens } = useAllGoldTokens(chainId);
	const vaultAddress = getGoldVaultContractConfig(chainId)?.address;

	const approvalToken = useMemo(() => {
		if (state.activeTab === 'repay') return gsusdToken;
		if (state.activeTab === 'deposit') {
			// useAllGoldTokens returns a record keyed by address, not an array.
			return Object.values(goldTokens ?? {}).find(
				(t) => t.address.toLowerCase() === state.selectedToken?.toLowerCase()
			);
		}
		return undefined;
	}, [state.activeTab, state.selectedToken, gsusdToken, goldTokens]);

	// Mint and withdraw send tokens OUT of the vault and need no allowance.
	const needsApproval = state.activeTab === 'deposit' || state.activeTab === 'repay';
	// Whichever gold token this vault deals in: the one being deposited, or the one
	// already held as collateral when withdrawing.
	const goldSymbol = approvalToken?.symbol ?? collateralSymbol;

	// The token whose balance/allowance a revert would be about: gold on the way in,
	// gold on the way out, GSUSD for the debt legs.
	const errorContext = {
		action: state.activeTab,
		tokenSymbol:
			state.activeTab === 'repay' || state.activeTab === 'mint'
				? gsusdToken?.symbol ?? 'GSUSD'
				: goldSymbol,
	} as const;

	const approvalAmount = needsApproval
		? tryParseCurrencyAmount(amount, approvalToken)
		: undefined;

	// What a repayment is really settling: the fee-inclusive debt now, against the
	// ceiling being submitted. Lets the review screen show the debt rather than the pad.
	const settlement = useMemo((): RepaySettlement | undefined => {
		if (state.activeTab !== 'repay' || fees.currentDebt === undefined) return undefined;
		const authorised = parseUnits(amount || '0', 18);
		if (authorised <= 0n) return undefined;
		return { owedNow: fees.currentDebt, authorised, closes: closesWithMargin(authorised, fees.currentDebt) };
	}, [state.activeTab, amount, fees.currentDebt]);

	// What a mint actually delivers: the vault takes its origination fee from what it sends
	// to the wallet, while the debt rises by the full amount.
	const originationFee = useOriginationFee(chainId);
	const mintFee = useMemo(() => {
		if (state.activeTab !== 'mint' || originationFee.bps === undefined) return undefined;
		return originationFeeSplit(parseUnits(amount || '0', 18), originationFee.bps, originationFee.exempt === true);
	}, [state.activeTab, amount, originationFee.bps, originationFee.exempt]);

	return (
		<ReviewVaultDialog
			action={state.activeTab}
			amount={amount}
			write={activeHook.write}
			reset={activeHook.reset}
			isWritePending={activeHook.isWritePending}
			confirmationStatus={activeHook.confirmationStatus}
			outcome={outcome}
			isSimulationSuccess={activeHook.isSimulationSuccess}
			isSimulationError={activeHook.isSimulationError}
			simulationError={activeHook.simulationError ?? null}
			writeError={activeHook.writeError ?? null}
			txHash={activeHook.txHash}
			// Clear the amount when the receipt is closed. Left in place, it re-simulated
			// against the new position and painted the form red seconds after a success.
			onClosed={() => setTypedAmount('')}
			collateralSymbol={goldSymbol}
			errorContext={errorContext}
			settlement={settlement}
			repaidAmount={state.activeTab === 'repay' ? repay.repaidAmount : undefined}
			mintFee={mintFee}
		>
			{({ isSuccess, error }) => (
				<Guard.Connection>
					<Guard.Chain chainId={chainId}>
						<Guard.TokenApproval
							amount={approvalAmount}
							spender={vaultAddress}
							enabled={
								needsApproval && Boolean(approvalAmount) && Boolean(vaultAddress)
							}
							explanation={
								state.activeTab === 'repay'
									? 'Step 1 of 2: allow the vault to take GSUSD from your wallet for this repayment. Step 2 is the repayment itself.'
									: `Step 1 of 2: allow the vault to move your ${goldSymbol ?? 'gold'}. Step 2 is the deposit itself.`
							}
						>
							<Guard.Ready>
								<div className="flex flex-col gap-2">
								<DialogTrigger asChild>
									<Button
										size="lg"
										disabled={!hasAmount || Boolean(error)}
										fullWidth
									>
										{buttonLabel}
									</Button>
								</DialogTrigger>
								{/* A disabled button with no explanation reads as a broken app.
								    Say why the protocol will not accept this amount. */}
								{hasAmount && error && (
									<p
										role="alert"
										className="text-sm leading-relaxed text-destructive"
									>
										{describeTxError(error, errorContext)}
									</p>
								)}
								</div>
							</Guard.Ready>
						</Guard.TokenApproval>
					</Guard.Chain>
				</Guard.Connection>
			)}
		</ReviewVaultDialog>
	);
};
