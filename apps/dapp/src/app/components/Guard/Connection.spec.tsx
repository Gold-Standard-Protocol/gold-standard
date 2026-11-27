import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Connection } from './Connection';

const state = vi.hoisted(() => ({
	account: { isConnecting: false, isReconnecting: false, isDisconnected: true },
	pending: false,
}));

vi.mock('wagmi', () => ({ useAccount: () => state.account }));
vi.mock('@goldstandard/hooks', () => ({ useIsMounted: () => true }));
vi.mock('../../wallet/WalletUi', () => ({ useWalletUi: () => ({ pending: state.pending, open: vi.fn() }) }));
vi.mock('../ConnectButton', () => ({ ConnectButton: () => <button type="button">Connect Wallet</button> }));

afterEach(() => {
	cleanup();
	state.account = { isConnecting: false, isReconnecting: false, isDisconnected: true };
	state.pending = false;
});

const mount = () => render(<Connection><span>protected action</span></Connection>);

describe('Guard.Connection', () => {
	it('offers Connect, not a stuck check, while an abandoned wallet prompt keeps Wagmi connecting', () => {
		state.account = { isConnecting: true, isReconnecting: false, isDisconnected: false };
		mount();
		expect(screen.getByRole('button', { name: 'Connect Wallet' })).toBeTruthy();
		expect(screen.queryByText('protected action')).toBeNull();
		expect(screen.queryByText('Checking Wallet')).toBeNull();
	});

	it('keeps the Connect button that opened the dialog while a request is open, so focus can return to it', () => {
		state.account = { isConnecting: true, isReconnecting: false, isDisconnected: false };
		state.pending = true;
		mount();
		expect(screen.getByRole('button', { name: 'Connect Wallet' })).toBeTruthy();
		expect(screen.queryByText('Checking Wallet')).toBeNull();
		expect(screen.queryByText('protected action')).toBeNull();
	});

	it('shows the check while a returning wallet reconnects on page load', () => {
		state.account = { isConnecting: false, isReconnecting: true, isDisconnected: false };
		mount();
		expect(screen.getByText('Checking Wallet')).toBeTruthy();
	});

	it('renders the protected action once connected', () => {
		state.account = { isConnecting: false, isReconnecting: false, isDisconnected: false };
		mount();
		expect(screen.getByText('protected action')).toBeTruthy();
	});
});
