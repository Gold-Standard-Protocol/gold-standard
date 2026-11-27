import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { VaultRepayForm } from './VaultRepayForm';

const E18 = 10n ** 18n;
const DEBT = 1_000n * E18;

const state = vi.hoisted(() => ({
	balance: undefined as bigint | undefined,
	originationFee: { bps: 5n as bigint | undefined, exempt: false as boolean | undefined },
}));

vi.mock('./useVaultAmount', () => ({
	useVaultAmount: () => ({ reason: undefined, check: { value: undefined } }),
}));

vi.mock('@goldstandard/hooks', () => ({
	useGsusdToken: () => undefined,
	useTokenBalance: () => ({
		data: state.balance === undefined ? undefined : { quotient: { toString: () => String(state.balance) } },
	}),
	useVaultContext: () => ({
		state: { activeTab: 'repay', typedAmount: '', selectedToken: undefined },
		position: { position: { collateralAmount: E18, debtAmount: 995n * E18, collateralToken: '0x00000000000000000000000000000000000000a1' } },
		fees: { currentDebt: DEBT, currentDebtFormatted: '1000' },
		chainId: 11155111,
		goldPrice: 4000,
		collateralDecimals: 18,
	}),
	useVaultStateActions: () => ({ setTypedAmount: vi.fn() }),
	useVaultSimulation: () => undefined,
	useVaultMinDebt: () => 100n * E18,
	useOriginationFee: () => state.originationFee,
	useCollateralParams: () => ({ minRatioPercent: 130, liquidationRatioPercent: 110, isLoading: false }),
}));

describe('VaultRepayForm close and shortfall', () => {
	beforeEach(() => {
		state.balance = undefined;
		state.originationFee = { bps: 5n, exempt: false };
	});

	it('does not offer Close position when the balance only just covers the debt', () => {
		state.balance = DEBT;
		render(<VaultRepayForm />);
		expect(screen.queryByRole('button', { name: 'Close position' })).toBeNull();
		expect(screen.getByRole('button', { name: /^Max: .* GSUSD$/ })).toBeTruthy();
		expect(screen.getByText(/To close this vault you need/)).toBeTruthy();
		expect(screen.getByText(/including a small margin for the fees that accrue before the transaction confirms/)).toBeTruthy();
	});

	it('offers Close position once the balance covers the debt and the margin', () => {
		state.balance = 1_001n * E18;
		render(<VaultRepayForm />);
		expect(screen.getByRole('button', { name: 'Close position' })).toBeTruthy();
		expect(screen.queryByText(/To close this vault you need/)).toBeNull();
	});

	it('names the origination fee as well as the stability fee', () => {
		state.balance = 990n * E18;
		render(<VaultRepayForm />);
		expect(
			screen.getByText(/Your debt carries the 0\.05% origination fee charged on each mint and a stability fee that accrues every second/)
		).toBeTruthy();
	});

	it('leaves the origination fee out for an exempt account', () => {
		state.balance = 990n * E18;
		state.originationFee = { bps: 5n, exempt: true };
		render(<VaultRepayForm />);
		expect(screen.queryByText(/origination fee/)).toBeNull();
		expect(screen.getByText(/Your debt carries a stability fee that accrues every second/)).toBeTruthy();
	});
});
