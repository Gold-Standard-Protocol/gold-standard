import { fireEvent, render } from '@testing-library/react';
import { vi } from 'vitest';
import { VaultWithdrawForm } from './VaultWithdrawForm';

// One mutable context shared by the mock, so each test can describe a different vault.
const { ctx, oracle, setTypedAmount } = vi.hoisted(() => ({
	setTypedAmount: vi.fn(),
	oracle: { price8: undefined as bigint | undefined },
	ctx: {
		state: { activeTab: 'withdraw', typedAmount: '', selectedToken: undefined },
		position: { position: undefined as undefined | { collateralAmount: bigint; debtAmount: bigint; collateralToken: string } },
		fees: { currentDebt: 0n, currentDebtFormatted: '0' },
		chainId: 11155111,
		goldPrice: 2000,
		collateralDecimals: undefined as number | undefined,
		collateralSymbol: undefined as string | undefined,
		depositDecimals: 18,
	},
}));

// The amount hook reads the chain id from wagmi; there is no provider in these renders.
vi.mock('wagmi', () => ({ useChainId: () => 11155111 }));

vi.mock('@goldstandard/hooks', () => ({
	MAX_RATIO_RESERVE_PER_100K: 250n,
	useGsusdToken: () => undefined,
	useAllGoldTokens: () => ({ data: undefined }),
	useTokenBalance: () => ({ data: undefined }),
	useVaultContext: () => ctx,
	useVaultStateActions: () => ({ setTypedAmount }),
	useVaultSimulation: () => undefined,
	useCollateralParams: () => ({
		minRatioPercent: 130,
		liquidationRatioPercent: 110,
		liquidationPenaltyPercent: 5,
		debtCeiling: undefined,
		totalDebt: undefined,
		active: true,
		isLoading: false,
	}),
	useOraclePrice: () => ({ isDeployed: true, price8: oracle.price8, isLive: true, isLoading: false, isError: false }),
}));

describe('VaultWithdrawForm', () => {
	beforeEach(() => {
		setTypedAmount.mockClear();
	});

	it('shows no unit and a disabled input when there is no vault', () => {
		ctx.position = { position: undefined };
		ctx.collateralDecimals = undefined;
		ctx.collateralSymbol = undefined;
		const { getByLabelText, getByText, queryByText } = render(<VaultWithdrawForm />);
		expect((getByLabelText('Withdraw collateral') as HTMLInputElement).disabled).toBe(true);
		expect(getByText('No collateral deposited')).toBeTruthy();
		// The old fallback named a third asset; nothing should claim to be "gold" here.
		expect(queryByText('gold')).toBeNull();
		expect(queryByText(/^Max:/)).toBeNull();
	});

	it('says why an amount cannot be withdrawn, under the field', () => {
		ctx.position = {
			position: { collateralAmount: 10n ** 18n, debtAmount: 0n, collateralToken: '0x0000000000000000000000000000000000000001' },
		};
		ctx.collateralDecimals = 18;
		ctx.collateralSymbol = 'PAXG';
		ctx.state = { ...ctx.state, typedAmount: '2' };
		const { getByText } = render(<VaultWithdrawForm />);
		expect(getByText('More than your vault holds')).toBeTruthy();
		ctx.state = { ...ctx.state, typedAmount: '' };
	});

	it("names the vault's own token once collateral is held", () => {
		ctx.position = {
			position: { collateralAmount: 10n ** 18n, debtAmount: 0n, collateralToken: '0x0000000000000000000000000000000000000001' },
		};
		ctx.collateralDecimals = 18;
		ctx.collateralSymbol = 'PAXG';
		const { getByLabelText, getByText, queryByText } = render(<VaultWithdrawForm />);
		expect((getByLabelText('Withdraw collateral') as HTMLInputElement).disabled).toBe(false);
		expect(getByText('PAXG')).toBeTruthy();
		expect(getByText(/^Max: .* PAXG$/)).toBeTruthy();
		expect(queryByText('No collateral deposited')).toBeNull();
	});

	it('offers a Max that leaves the fee reserve behind when the vault carries debt', () => {
		// 100 PAXG against 50,000 GSUSD at $4,000 and 130%: 83.75 exactly, 83.709375 with the reserve.
		ctx.position = {
			position: { collateralAmount: 100n * 10n ** 18n, debtAmount: 50_000n * 10n ** 18n, collateralToken: '0x0000000000000000000000000000000000000001' },
		};
		ctx.fees = { currentDebt: 50_000n * 10n ** 18n, currentDebtFormatted: '50000' };
		ctx.collateralDecimals = 18;
		ctx.collateralSymbol = 'PAXG';
		oracle.price8 = 400_000_000_000n;
		const { getByText } = render(<VaultWithdrawForm />);
		const max = getByText(/^Max: .* PAXG$/);
		expect(max.textContent).toBe('Max: 83.7094 PAXG');
		fireEvent.click(max);
		expect(setTypedAmount).toHaveBeenCalledWith('83.709375');
		expect(getByText(/small cushion for fees/)).toBeTruthy();
		oracle.price8 = undefined;
		ctx.fees = { currentDebt: 0n, currentDebtFormatted: '0' };
	});
});
