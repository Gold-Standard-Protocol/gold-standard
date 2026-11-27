import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { CurrencyAmount, Token } from '@goldstandard/models';
import { TokenInput, walletBalanceLine } from './TokenInput';

const PAXG = new Token({
	chainId: 11155111,
	address: '0x00000000000000000000000000000000000000a1',
	decimals: 18,
	symbol: 'PAXG',
	name: 'Paxos Gold',
	image: '/images/paxg.png',
	gold: true,
	priceApiId: 'pax-gold',
});

const state = vi.hoisted(() => ({
	connected: true,
	balance: { data: undefined as unknown, isLoading: false },
}));

vi.mock('wagmi', () => ({
	useAccount: () => ({ isConnected: state.connected }),
}));

vi.mock('@goldstandard/hooks', () => ({
	useTokenBalance: () => state.balance,
}));

const amount = (raw: bigint) => CurrencyAmount.fromRawAmount(PAXG, raw.toString());

describe('walletBalanceLine', () => {
	it('shows a read balance, and a read zero as 0.00', () => {
		expect(walletBalanceLine(amount(15n * 10n ** 17n), { connected: true, loading: false }, 'PAXG')).toBe('Balance: 1.5 PAXG');
		expect(walletBalanceLine(amount(0n), { connected: true, loading: false }, 'PAXG')).toBe('Balance: 0.00 PAXG');
	});

	it('never shows a balance it could not read as 0.00', () => {
		expect(walletBalanceLine(undefined, { connected: true, loading: false }, 'PAXG')).toBe('Balance unavailable');
		expect(walletBalanceLine(undefined, { connected: true, loading: true }, 'PAXG')).toBe('Balance: …');
	});

	it('has nothing to say without a wallet', () => {
		expect(walletBalanceLine(undefined, { connected: false, loading: false }, 'PAXG')).toBeUndefined();
	});
});

describe('TokenInput balance line', () => {
	beforeEach(() => {
		state.connected = true;
		state.balance = { data: undefined, isLoading: false };
	});

	it('says the balance is unavailable and offers no Max when the read failed', () => {
		render(<TokenInput amount="" onChangeAmount={() => undefined} selectedToken={PAXG} showMax onMax={() => undefined} />);
		expect(screen.getByText('Balance unavailable')).toBeTruthy();
		expect(screen.queryByText(/0\.00/)).toBeNull();
		expect(screen.queryByRole('button', { name: /^Max/ })).toBeNull();
	});

	it('offers the balance as the Max, beside the label like the other vault fields', () => {
		state.balance = { data: amount(2n * 10n ** 18n), isLoading: false };
		const onMax = vi.fn();
		render(<TokenInput id="deposit" label="You deposit" amount="" onChangeAmount={() => undefined} selectedToken={PAXG} showMax onMax={onMax} />);
		const max = screen.getByRole('button', { name: 'Max: 2 PAXG' });
		// One figure, said once: the balance is the Max.
		expect(screen.queryByText('Balance: 2 PAXG')).toBeNull();
		expect(max.parentElement).toBe(screen.getByText('You deposit').parentElement);
		max.click();
		expect(onMax).toHaveBeenCalledTimes(1);
	});

	it('shows the balance as plain text when no Max is asked for', () => {
		state.balance = { data: amount(2n * 10n ** 18n), isLoading: false };
		render(<TokenInput amount="" onChangeAmount={() => undefined} selectedToken={PAXG} />);
		expect(screen.getByText('Balance: 2 PAXG')).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Max/ })).toBeNull();
	});

	it('offers no Max of nothing: an empty balance is stated, not offered', () => {
		state.balance = { data: amount(0n), isLoading: false };
		render(<TokenInput amount="" onChangeAmount={() => undefined} selectedToken={PAXG} showMax onMax={() => undefined} />);
		expect(screen.getByText('Balance: 0.00 PAXG')).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Max/ })).toBeNull();
	});

	it('offers what caps the input as the Max when the caller supplies it', () => {
		const cap = { amount: '', onChangeAmount: () => undefined, selectedToken: PAXG, showMax: true, onMax: () => undefined, availableLabel: 'Pool deposit' };
		const { unmount } = render(<TokenInput {...cap} availableAmount="1,300.00" />);
		expect(screen.getByRole('button', { name: 'Max: 1,300.00 PAXG' })).toBeTruthy();
		unmount();
		render(<TokenInput {...cap} availableAmount="0.00" />);
		expect(screen.getByText('Pool deposit: 0.00 PAXG')).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Max/ })).toBeNull();
	});

	it('keeps the field as short as the other vault fields: no row under the amount without a dollar value', () => {
		state.balance = { data: amount(2n * 10n ** 18n), isLoading: false };
		const { container } = render(<TokenInput amount="" onChangeAmount={() => undefined} selectedToken={PAXG} showMax onMax={() => undefined} />);
		expect(container.querySelector('[data-token-input-value]')).toBeNull();
	});

	it('shows no balance line before a wallet is connected', () => {
		state.connected = false;
		render(<TokenInput amount="" onChangeAmount={() => undefined} selectedToken={PAXG} showMax onMax={() => undefined} />);
		expect(screen.queryByText(/Balance/)).toBeNull();
	});
});

describe('TokenInput token pill', () => {
	it('names a fixed token with the same pill as every other amount field, not a disabled button', () => {
		const { container } = render(<TokenInput amount="" onChangeAmount={() => undefined} selectedToken={PAXG} disableTokenSelection />);
		expect(screen.queryByRole('button', { name: /PAXG/ })).toBeNull();
		const pill = container.querySelector('[data-token-pill]');
		expect(pill?.textContent).toBe('PAXG');
		expect(pill?.querySelector('img')?.getAttribute('src')).toBe('/images/paxg.png');
	});

	it('keeps a token that can be changed a button with a full size tap target around the same pill', () => {
		const onChooseToken = vi.fn();
		render(<TokenInput amount="" onChangeAmount={() => undefined} selectedToken={PAXG} onChooseToken={onChooseToken} />);
		const button = screen.getByRole('button', { name: /PAXG/ });
		expect(button.className).toContain('min-h-11');
		expect(button.querySelector('[data-token-pill]')).not.toBeNull();
		button.click();
		expect(onChooseToken).toHaveBeenCalledTimes(1);
	});
});

describe('TokenInput note', () => {
	it('holds its note inside the field, under the amount and after any reason, like the mint and withdraw fields', () => {
		const { container } = render(
			<TokenInput id="deposit" amount="" onChangeAmount={() => undefined} selectedToken={PAXG} disableTokenSelection reason="Enter an amount." note="This vault holds PAXG." />
		);
		const field = container.firstElementChild;
		const note = screen.getByText('This vault holds PAXG.');
		expect(field?.contains(note)).toBe(true);
		expect(field?.lastElementChild).toBe(note);
		expect(note.previousElementSibling?.textContent).toBe('Enter an amount.');
	});

	it('adds nothing when there is no note', () => {
		const { container } = render(<TokenInput amount="" onChangeAmount={() => undefined} selectedToken={PAXG} disableTokenSelection />);
		expect(container.querySelector('[data-token-input-note]')).toBeNull();
	});
});
