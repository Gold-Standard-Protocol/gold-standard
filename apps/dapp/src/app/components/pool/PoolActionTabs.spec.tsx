import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { PoolActionTabs } from './PoolActionTabs';

const E18 = 10n ** 18n;

const pool = vi.hoisted(() => ({
	effectiveDeposit: 300n * 10n ** 18n as bigint | undefined,
	isLoading: false,
	isError: false,
}));

vi.mock('wagmi', () => ({
	useAccount: () => ({ address: '0x00000000000000000000000000000000000000aa' }),
	useChainId: () => 11155111,
}));

vi.mock('@goldstandard/constants', async (importOriginal) => ({
	...(await importOriginal<typeof import('@goldstandard/constants')>()),
	getStabilityPoolContractConfig: () => ({ address: '0x00000000000000000000000000000000000000ee', abi: [] }),
}));

vi.mock('@goldstandard/hooks', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@goldstandard/hooks')>();
	return {
		...actual,
		useGsusdToken: () => actual.buildGsusdToken(11155111, '0x00000000000000000000000000000000000000bb'),
		useStabilityPoolPosition: () => ({
			effectiveDeposit: pool.effectiveDeposit,
			gains: [],
			isLoading: pool.isLoading,
			isError: pool.isError,
		}),
		useTokenBalance: () => ({ data: undefined }),
	};
});

// The button's own hooks need a wallet; what matters here is what the form hands it.
vi.mock('./PoolButton', () => ({
	PoolButton: ({ amount, reviewAmount }: { amount: string; reviewAmount: string }) => (
		<output data-testid="pool-button" data-amount={amount} data-review={reviewAmount} />
	),
}));

function openWithdrawTab() {
	fireEvent.mouseDown(screen.getByRole('tab', { name: 'Withdraw' }), { button: 0 });
}

function type(id: string, value: string) {
	fireEvent.change(document.getElementById(id) as HTMLInputElement, { target: { value } });
}

const button = () => screen.getByTestId('pool-button');

describe('PoolActionTabs withdraw tab while the pool deposit is unknown', () => {
	afterEach(() => {
		pool.effectiveDeposit = 300n * E18;
		pool.isLoading = false;
		pool.isError = false;
	});

	it('says the deposit is still being read, offers no Max and no balance and hands the button nothing', () => {
		pool.effectiveDeposit = undefined;
		pool.isLoading = true;
		render(<PoolActionTabs />);
		openWithdrawTab();
		type('pool-withdraw-amount', '100');
		expect(screen.getByText('Reading your pool deposit.')).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Max/ })).toBeNull();
		expect(screen.queryByText(/Pool deposit: 0\.00 GSUSD/)).toBeNull();
		expect(button().dataset['amount']).toBe('');
		expect(button().dataset['review']).toBe('');
	});

	it('says the deposit could not be read when the read failed', () => {
		pool.effectiveDeposit = undefined;
		pool.isError = true;
		render(<PoolActionTabs />);
		openWithdrawTab();
		type('pool-withdraw-amount', '100');
		expect(screen.getByText('Your pool deposit could not be read. Check your connection and try again.')).toBeTruthy();
		expect(screen.queryByText('You have no GSUSD deposited in the pool to withdraw.')).toBeNull();
		expect(button().dataset['amount']).toBe('');
	});

	it('still names a known zero deposit as the reason', () => {
		pool.effectiveDeposit = 0n;
		render(<PoolActionTabs />);
		openWithdrawTab();
		type('pool-withdraw-amount', '100');
		expect(screen.getByText('You have no GSUSD deposited in the pool to withdraw.')).toBeTruthy();
		expect(screen.getByText(/Pool deposit: 0\.00 GSUSD/)).toBeTruthy();
	});
});

describe('PoolActionTabs withdrawal review', () => {
	beforeEach(() => {
		pool.effectiveDeposit = 300n * E18;
	});

	it('reviews the effective deposit when more is typed, while the transaction keeps the typed amount', () => {
		render(<PoolActionTabs />);
		openWithdrawTab();
		type('pool-withdraw-amount', '500');
		expect(button().dataset['amount']).toBe('500');
		expect(button().dataset['review']).toBe('300');
		expect(screen.getByText(/You can withdraw at most 300.00 GSUSD/)).toBeTruthy();
	});

	it('reviews exactly what was typed when it is within the deposit', () => {
		render(<PoolActionTabs />);
		openWithdrawTab();
		type('pool-withdraw-amount', '120.5');
		expect(button().dataset['review']).toBe('120.5');
		expect(screen.queryByText(/You can withdraw at most/)).toBeNull();
	});

	// With nothing in the pool there is no withdrawal to sign.
	it('offers no withdrawal and says why when the effective deposit is zero', () => {
		pool.effectiveDeposit = 0n;
		render(<PoolActionTabs />);
		openWithdrawTab();
		type('pool-withdraw-amount', '5');
		expect(button().dataset['amount']).toBe('');
		expect(button().dataset['review']).toBe('');
		expect(screen.getByText('You have no GSUSD deposited in the pool to withdraw.')).toBeTruthy();
		expect(screen.queryByText(/You can withdraw at most/)).toBeNull();
	});

	it('leaves a deposit review on the typed amount', () => {
		render(<PoolActionTabs />);
		type('pool-deposit-amount', '500');
		expect(button().dataset['review']).toBe('500');
	});
});
