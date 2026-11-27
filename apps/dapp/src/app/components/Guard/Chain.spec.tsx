import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Chain } from './Chain';

const wagmi = vi.hoisted(() => ({ switchChainAsync: vi.fn(), chain: { id: 1 } as { id: number } | undefined }));

vi.mock('wagmi', () => ({
	useAccount: () => ({ chain: wagmi.chain }),
	useSwitchChain: () => ({ switchChainAsync: wagmi.switchChainAsync }),
}));

const rejection = Object.assign(new Error('User rejected the request.'), { name: 'UserRejectedRequestError' });

describe('Guard.Chain', () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	beforeEach(() => {
		unhandled.length = 0;
		process.on('unhandledRejection', onUnhandled);
	});
	afterEach(() => {
		process.off('unhandledRejection', onUnhandled);
		wagmi.switchChainAsync.mockReset();
		wagmi.chain = { id: 1 };
	});

	// With only the target chain configured, a wallet on any other
	// network has no configured chain at all; that must still read as the wrong network.
	it('asks a wallet on an unconfigured network to switch', () => {
		wagmi.chain = undefined;
		render(<Chain chainId={11155111 as never}><span>child</span></Chain>);
		expect(screen.getByRole('button', { name: 'Switch Chain' })).toBeTruthy();
		expect(screen.queryByText('child')).toBeNull();
	});

	it('shows the guarded action on the target chain', () => {
		wagmi.chain = { id: 11155111 };
		render(<Chain chainId={11155111 as never}><span>child</span></Chain>);
		expect(screen.getByText('child')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Switch Chain' })).toBeNull();
	});

	const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

	it('swallows a declined switch prompt without an unhandled rejection or a message', async () => {
		wagmi.switchChainAsync.mockRejectedValue(rejection);
		render(<Chain chainId={11155111 as never}><span>child</span></Chain>);
		fireEvent.click(screen.getByRole('button', { name: 'Switch Chain' }));
		await flush();
		expect(unhandled).toEqual([]);
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.getByRole('button', { name: 'Switch Chain' })).toBeTruthy();
	});

	it('shows one short line when the switch fails for another reason', async () => {
		wagmi.switchChainAsync.mockRejectedValue(new Error('Unrecognized chain'));
		render(<Chain chainId={11155111 as never}><span>child</span></Chain>);
		fireEvent.click(screen.getByRole('button', { name: 'Switch Chain' }));
		await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not switch network/));
		expect(unhandled).toEqual([]);
	});
});
