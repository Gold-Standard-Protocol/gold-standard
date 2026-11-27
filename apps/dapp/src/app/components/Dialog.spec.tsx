import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useRef, type FC } from 'react';
import { DialogConfirm, DialogProvider, DialogType, useDialog } from './Dialog';

/** Opens the receipt on mount, as a Confirm click would. */
const OpenReceipt: FC = () => {
	const { setOpen } = useDialog(DialogType.Confirm);
	// setOpen takes a new identity on every dialog state change, so open exactly once.
	const opened = useRef(false);
	useEffect(() => {
		if (opened.current) return;
		opened.current = true;
		setOpen(true);
	}, [setOpen]);
	return null;
};

const HASH = '0x1111111111111111111111111111111111111111111111111111111111111111';
const CHAIN_HASH = '0x2222222222222222222222222222222222222222222222222222222222222222';

function renderReceipt(status: 'pending' | 'success') {
	return render(
		<DialogProvider>
			<OpenReceipt />
			<DialogConfirm closeButtonText="Close" status={status} txHash={HASH} successMessage="Deposited 1 PAXG." />
		</DialogProvider>
	);
}

describe('DialogConfirm while the receipt is pending', () => {
	it('announces one status named by the heading, with the spinner hidden from the name', () => {
		renderReceipt('pending');
		const status = screen.getByRole('status', { name: 'Waiting for confirmation' });
		expect(status.getAttribute('aria-live')).toBe('polite');
		const icon = status.querySelector('svg');
		expect(icon?.getAttribute('aria-hidden')).toBe('true');
		expect(icon?.className.baseVal).toContain('motion-safe:animate-spin');
		// The hash link is still there beside the wait.
		expect(screen.getByRole('link', { name: /View on Etherscan/ })).toBeTruthy();
	});

	it('drops the spinner and shows the confirmed state once the receipt lands', () => {
		const view = renderReceipt('pending');
		view.rerender(
			<DialogProvider>
				<OpenReceipt />
				<DialogConfirm closeButtonText="Close" status="success" txHash={HASH} successMessage="Deposited 1 PAXG." />
			</DialogProvider>
		);
		// The live region stays mounted so the change is announced; only the spinner goes.
		expect(screen.getByRole('status', { name: 'Confirmed' })).toBeTruthy();
		expect(screen.getByRole('heading', { name: 'Confirmed' })).toBeTruthy();
		expect(document.querySelector('[role="dialog"] svg.motion-safe\\:animate-spin')).toBeNull();
	});
});

// An RPC outage during the wait is not a revert: nothing is known about the transaction.
describe('DialogConfirm while the chain cannot be read', () => {
	const renderUnconfirmed = () =>
		render(
			<DialogProvider>
				<OpenReceipt />
				<DialogConfirm
					closeButtonText="Close"
					status="unconfirmed"
					txHash={HASH}
					successMessage="Deposited 1 PAXG."
					errorMessage="Ratio would drop below 130%"
				/>
			</DialogProvider>
		);

	it('says the transaction is not confirmed and may still succeed, never that it failed', () => {
		renderUnconfirmed();
		const status = screen.getByRole('status', { name: 'Not confirmed yet' });
		expect(status.textContent).toContain('may still succeed');
		expect(status.textContent).not.toMatch(/reverted|Transaction failed/);
		// A reason left over from the simulation is not the cause of an unread chain.
		expect(status.textContent).not.toContain('Ratio would drop');
	});

	it('keeps waiting and keeps the explorer link, the one place the result can be checked', () => {
		renderUnconfirmed();
		expect(document.querySelector('[role="dialog"] svg.motion-safe\\:animate-spin')).not.toBeNull();
		const link = screen.getByRole('link', { name: /View on Etherscan/ });
		expect(link.getAttribute('href')).toContain(`/tx/${HASH}`);
	});
});

// Inside Safe{Wallet} a write is a proposal: nothing is on-chain until the owners sign, and
// the hash beside it is the proposal's own, which no explorer knows.
describe('DialogConfirm for a proposal to a Safe', () => {
	const receipt = (status: 'proposed' | 'success', txHash: string, onClosed?: () => void) => (
		<DialogProvider>
			<OpenReceipt />
			<DialogConfirm
				closeButtonText="Done"
				status={status}
				txHash={txHash}
				successMessage="Deposited 1 PAXG."
				errorMessage="Ratio would drop below 130%"
				onClosed={onClosed}
			/>
		</DialogProvider>
	);

	it('says the transaction is proposed and that nothing has changed on-chain yet', () => {
		render(receipt('proposed', HASH));
		const status = screen.getByRole('status', { name: 'Proposed to your Safe' });
		expect(status.textContent).toContain('Nothing has changed on-chain yet');
		expect(status.textContent).toContain('once the owners have signed');
		expect(status.textContent).not.toMatch(/Confirmed|Deposited|failed|Ratio would drop/);
	});

	it('links nothing on Etherscan while the hash is a proposal', () => {
		render(receipt('proposed', HASH));
		expect(screen.queryByRole('link', { name: /Etherscan/ })).toBeNull();
		expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(HASH.slice(0, 10));
	});

	// The wait is the owners', and it can last days.
	it('shows no spinner', () => {
		render(receipt('proposed', HASH));
		expect(document.querySelector('[role="dialog"] svg.motion-safe\\:animate-spin')).toBeNull();
	});

	it('confirms, and links the executing transaction, once the Safe has executed the proposal', () => {
		const view = render(receipt('proposed', HASH));
		view.rerender(receipt('success', CHAIN_HASH));
		expect(screen.getByRole('status', { name: 'Confirmed' }).textContent).toContain('Deposited 1 PAXG.');
		expect(screen.getByRole('link', { name: /View on Etherscan/ }).getAttribute('href')).toContain(`/tx/${CHAIN_HASH}`);
	});

	// The amount is with the Safe now: a form left filled invites a second proposal.
	it('clears the form when the proposal is closed, as a confirmed receipt does', () => {
		const onClosed = vi.fn();
		render(receipt('proposed', HASH, onClosed));
		fireEvent.click(screen.getByRole('button', { name: 'Done' }));
		expect(onClosed).toHaveBeenCalledTimes(1);
	});
});

// A cancel in the wallet is a mined zero-value self-send, and the
// receipt said "Confirmed" with the deposit sentence for a deposit that never happened.
describe('DialogConfirm for a transaction cancelled or replaced in the wallet', () => {
	const receipt = (onClosed?: () => void, onDismissed?: () => void) => (
		<DialogProvider>
			<OpenReceipt />
			<DialogConfirm
				closeButtonText="Done"
				status="replaced"
				txHash={CHAIN_HASH}
				successMessage="Deposited 1 PAXG."
				errorMessage="Ratio would drop below 130%"
				onClosed={onClosed}
				onDismissed={onDismissed}
			/>
		</DialogProvider>
	);

	it('says the transaction was not carried out, never that it was confirmed or reverted', () => {
		render(receipt());
		const status = screen.getByRole('status', { name: 'Cancelled or replaced' });
		expect(status.textContent).toContain('was not carried out');
		expect(status.textContent).not.toMatch(/Confirmed|Deposited|reverted|Ratio would drop/);
		expect(document.querySelector('[role="dialog"] svg.motion-safe\\:animate-spin')).toBeNull();
	});

	it('links the transaction mined in its place', () => {
		render(receipt());
		expect(screen.getByRole('link', { name: /View on Etherscan/ }).getAttribute('href')).toContain(`/tx/${CHAIN_HASH}`);
	});

	// Nothing was done, so the amount stays for the user to send again.
	it('keeps the form when closed, and still resets the write', () => {
		const onClosed = vi.fn();
		const onDismissed = vi.fn();
		render(receipt(onClosed, onDismissed));
		fireEvent.click(screen.getByRole('button', { name: 'Done' }));
		expect(onClosed).not.toHaveBeenCalled();
		expect(onDismissed).toHaveBeenCalledTimes(1);
	});
});
