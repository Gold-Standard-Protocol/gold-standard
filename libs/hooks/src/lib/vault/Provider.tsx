import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { type Address } from 'viem';
import { type GoldVaultChainId } from '@goldstandard/constants';
import { useVaultPosition } from './useVaultPosition';
import { useCollateralRatio } from './useCollateralRatio';
import { useLiquidationPrice } from './useLiquidationPrice';
import { useStabilityFees } from './useStabilityFees';
import { useGoldPrice } from './useGoldPrice';
import { useOraclePrice } from '../stability/useOraclePrice';
import { useCollateralToken } from './useCollateralToken';
import type { VaultActionType } from './useVaultActions';

interface VaultState {
	activeTab: VaultActionType;
	typedAmount: string;
	selectedToken: Address | undefined;
}

interface VaultContextValue {
	state: VaultState;
	position: ReturnType<typeof useVaultPosition>;
	ratio: ReturnType<typeof useCollateralRatio>;
	liquidationPrice: ReturnType<typeof useLiquidationPrice>;
	fees: ReturnType<typeof useStabilityFees>;
	/** USD per unit of the vault's collateral, from the protocol oracle when it has one. */
	goldPrice: number | undefined;
	/** Where goldPrice came from. Simulations against the market price can disagree with the contract. */
	goldPriceSource: 'oracle' | 'market' | undefined;
	chainId: GoldVaultChainId | undefined;
	userAddress: Address | undefined;
	/**
	 * Native decimals of the vault's collateral token (PAXG 18, XAUT 6), resolved from its
	 * address. Undefined until known or while the vault is empty; never a guess of 18.
	 */
	collateralDecimals: number | undefined;
	collateralSymbol: string | undefined;
	/**
	 * Decimals of the token a deposit will move. `state.selectedToken` is the vault's own
	 * collateral whenever it holds any, since the contract accepts nothing else, and the
	 * picked token only for an empty vault.
	 */
	depositDecimals: number | undefined;
}

interface VaultActionsContextValue {
	setActiveTab: (tab: VaultActionType) => void;
	setTypedAmount: (amount: string) => void;
	setSelectedToken: (token: Address) => void;
}

const VaultContext = createContext<VaultContextValue | undefined>(undefined);
const VaultActionsContext = createContext<VaultActionsContextValue | undefined>(undefined);

export function VaultProvider({ children }: { children: ReactNode }) {
	const { address: userAddress } = useAccount();
	const rawChainId = useChainId();
	const chainId = rawChainId as GoldVaultChainId | undefined;

	const [state, setState] = useState<VaultState>({
		activeTab: 'deposit',
		typedAmount: '',
		selectedToken: undefined,
	});

	// A typed amount and a chosen tab belong to the account that typed them. Keeping them
	// across a wallet switch offered the next account a review for the previous one's figure.
	const previousScope = useRef(`${chainId}:${userAddress ?? ''}`);
	useEffect(() => {
		const scope = `${chainId}:${userAddress ?? ''}`;
		if (previousScope.current === scope) return;
		previousScope.current = scope;
		setState({ activeTab: 'deposit', typedAmount: '', selectedToken: undefined });
	}, [chainId, userAddress]);

	const position = useVaultPosition(chainId, userAddress);
	// Priced at the live liquidation quote of the vault's own collateral.
	const ratio = useCollateralRatio(chainId, userAddress, position.position?.collateralToken);
	const liquidationPrice = useLiquidationPrice(chainId, userAddress);
	const fees = useStabilityFees(
		chainId,
		userAddress,
		position.position?.collateralToken,
		position.position?.debtAmount
	);
	const { goldPrice: marketPrice } = useGoldPrice();
	// The contract values collateral at ITS oracle, not at the market. Simulating a
	// withdrawal at a market price of $4,462 while the oracle said $4,000 showed 133.9%
	// for a position the vault priced at 120%, so the form said "fine" and the
	// contract said "Below min ratio". The oracle read is the one every form uses;
	// the market price only fills in before the oracle is deployed.
	// The vault simulation mirrors mint and withdraw, valued at the borrowing price.
	const oracle = useOraclePrice(chainId, position.position?.collateralToken, 'borrow');
	const goldPrice = oracle.price8 !== undefined ? Number(oracle.price8) / 1e8 : marketPrice;
	const goldPriceSource: 'oracle' | 'market' | undefined =
		oracle.price8 !== undefined ? 'oracle' : marketPrice !== undefined ? 'market' : undefined;

	// GoldVault accepts further deposits only in the collateral a vault already holds, so
	// that token is the deposit token unless the vault is empty and one has been picked.
	const heldToken =
		position.position && position.position.collateralAmount > 0n
			? position.position.collateralToken
			: undefined;
	const effectiveState = useMemo(
		() => ({ ...state, selectedToken: heldToken ?? state.selectedToken }),
		[state, heldToken]
	);

	// Every amount the forms parse, preview or display scales by the collateral's
	// decimals. Resolve them once here so no form guesses 18 for a 6-decimal XAUT vault.
	const collateral = useCollateralToken(chainId, position.position?.collateralToken);
	const depositToken = useCollateralToken(chainId, effectiveState.selectedToken);
	const depositDecimals = depositToken.decimals;

	const setActiveTab = useCallback((tab: VaultActionType) => {
		setState(prev => ({ ...prev, activeTab: tab, typedAmount: '' }));
	}, []);

	const setTypedAmount = useCallback((amount: string) => {
		setState(prev => ({ ...prev, typedAmount: amount }));
	}, []);

	const setSelectedToken = useCallback((token: Address) => {
		setState(prev => ({ ...prev, selectedToken: token }));
	}, []);

	const contextValue = useMemo(
		() => ({
			state: effectiveState,
			position,
			ratio,
			liquidationPrice,
			fees,
			goldPrice,
			goldPriceSource,
			chainId,
			userAddress,
			collateralDecimals: collateral.decimals,
			collateralSymbol: collateral.symbol,
			depositDecimals,
		}),
		[
			effectiveState,
			position,
			ratio,
			liquidationPrice,
			fees,
			goldPrice,
			goldPriceSource,
			chainId,
			userAddress,
			collateral.decimals,
			collateral.symbol,
			depositDecimals,
		]
	);

	const actionsValue = useMemo(
		() => ({ setActiveTab, setTypedAmount, setSelectedToken }),
		[setActiveTab, setTypedAmount, setSelectedToken]
	);

	return (
		<VaultContext.Provider value={contextValue}>
			<VaultActionsContext.Provider value={actionsValue}>
				{children}
			</VaultActionsContext.Provider>
		</VaultContext.Provider>
	);
}

export function useVaultContext() {
	const ctx = useContext(VaultContext);
	if (!ctx) throw new Error('useVaultContext must be used within VaultProvider');
	return ctx;
}

export function useVaultStateActions() {
	const ctx = useContext(VaultActionsContext);
	if (!ctx) throw new Error('useVaultStateActions must be used within VaultProvider');
	return ctx;
}
