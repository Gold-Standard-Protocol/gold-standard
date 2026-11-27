import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { Button, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@goldstandard/ui';
import { DialogConfirm, DialogProvider, DialogReview, DialogType, useDialog } from './Dialog';

const HASH = '0x1111111111111111111111111111111111111111111111111111111111111111';

const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});

interface FormProps {
	/** The amount field the form offers, if any. */
	withInput?: boolean;
	/** A successful receipt closing clears the amount, which disables the trigger as the real forms do. */
	clearOnClose?: boolean;
}

const Form: FC<FormProps> = ({ withInput = true, clearOnClose = false }) => {
	const [amount, setAmount] = useState('5');
	return (
		<main id="main">
			<button type="button">Before</button>
			<section aria-label="Deposit form">
				{withInput && <input inputMode="decimal" aria-label="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />}
				<DialogProvider>
					<DialogReview>
						{({ showConfirmDialog }) => (
							<>
								<DialogTrigger asChild>
									<Button disabled={amount === ''}>Deposit</Button>
								</DialogTrigger>
								<DialogContent>
									<DialogHeader>
										<DialogTitle>Review deposit</DialogTitle>
										<DialogDescription>Check the details.</DialogDescription>
									</DialogHeader>
									<Button onClick={showConfirmDialog}>Confirm deposit</Button>
								</DialogContent>
							</>
						)}
					</DialogReview>
					<DialogConfirm
						closeButtonText="Close"
						status="success"
						txHash={HASH}
						successMessage="Deposited 5 GSUSD."
						onClosed={clearOnClose ? () => setAmount('') : undefined}
					/>
				</DialogProvider>
			</section>
		</main>
	);
};

/** Two panels, each with its own field; only the second holds the trigger. */
const Panels: FC = () => {
	const [amount, setAmount] = useState('5');
	return (
		<main id="main">
			<div role="tabpanel" aria-label="First panel">
				<input inputMode="decimal" aria-label="First amount" defaultValue="1" />
			</div>
			<div role="tabpanel" aria-label="Second panel">
				<input inputMode="decimal" aria-label="Second amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
				<DialogProvider>
					<DialogReview>
						{({ showConfirmDialog }) => (
							<>
								<DialogTrigger asChild>
									<Button disabled={amount === ''}>Deposit</Button>
								</DialogTrigger>
								<DialogContent>
									<DialogHeader>
										<DialogTitle>Review deposit</DialogTitle>
										<DialogDescription>Check the details.</DialogDescription>
									</DialogHeader>
									<Button onClick={showConfirmDialog}>Confirm deposit</Button>
								</DialogContent>
							</>
						)}
					</DialogReview>
					<DialogConfirm
						closeButtonText="Close"
						status="success"
						txHash={HASH}
						successMessage="Deposited 5 GSUSD."
						onClosed={() => setAmount('')}
					/>
				</DialogProvider>
			</div>
		</main>
	);
};

type Closer = 'button' | 'escape' | 'outside';

/** Opens the review from the trigger, confirms into the receipt and closes the receipt. */
async function runReceipt(closer: Closer, { focusTrigger = true }: { focusTrigger?: boolean } = {}) {
	const trigger = screen.getByRole('button', { name: 'Deposit' });
	if (focusTrigger) trigger.focus();
	fireEvent.click(trigger);
	await screen.findByRole('dialog', { name: 'Review deposit' });
	fireEvent.click(screen.getByRole('button', { name: 'Confirm deposit' }));
	await screen.findByRole('dialog', { name: 'Confirmed' });
	await settle();
	if (closer === 'button') fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
	if (closer === 'escape') fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
	if (closer === 'outside') fireEvent.pointerDown(document.body);
	await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	await settle();
	return trigger;
}

describe('the receipt returns focus when it closes', () => {
	it.each<Closer>(['button', 'escape', 'outside'])('to the control that opened the review (%s)', async (closer) => {
		render(<Form />);
		const trigger = await runReceipt(closer);
		expect(document.activeElement).toBe(trigger);
	});

	it('to the amount field when the form cleared and the trigger is disabled', async () => {
		render(<Form clearOnClose />);
		const trigger = await runReceipt('button');
		expect((trigger as HTMLButtonElement).disabled).toBe(true);
		expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Amount' }));
	});

	it('to the amount field when the browser did not focus the trigger on click', async () => {
		render(<Form />);
		await runReceipt('button', { focusTrigger: false });
		expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Amount' }));
	});

	it('to the field of the panel that held the trigger, not another panel', async () => {
		render(<Panels />);
		await runReceipt('button');
		expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Second amount' }));
	});

	it('to the main region when there is no amount field and the trigger is disabled', async () => {
		render(<Form withInput={false} clearOnClose />);
		await runReceipt('escape');
		const main = document.getElementById('main');
		expect(document.activeElement).toBe(main);
		expect(main?.getAttribute('tabindex')).toBe('-1');
	});

	it('never leaves focus on the page body', async () => {
		render(<Form clearOnClose />);
		await runReceipt('outside');
		expect(document.activeElement).not.toBe(document.body);
	});
});

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

interface ReceiptProps {
	status: 'error' | 'pending' | 'success';
	txHash?: string | undefined;
	errorMessage?: string | undefined;
	successMessage?: ReactNode;
}

const Receipt: FC<ReceiptProps> = ({ status, txHash, errorMessage, successMessage = 'Deposited 1 PAXG.' }) => (
	<DialogProvider>
		<OpenReceipt />
		<DialogConfirm closeButtonText="Close" status={status} txHash={txHash} errorMessage={errorMessage} successMessage={successMessage} />
	</DialogProvider>
);

describe('the receipt status region', () => {
	it('is one live region with the same DOM node through pending, success and error', () => {
		const view = render(<Receipt status="pending" txHash={HASH} />);
		const region = screen.getByRole('status');
		expect(region.getAttribute('aria-live')).toBe('polite');
		expect(region.getAttribute('aria-atomic')).toBe('true');
		expect(region.textContent).toContain('Waiting for confirmation');

		view.rerender(<Receipt status="success" txHash={HASH} />);
		expect(screen.getByRole('status')).toBe(region);
		expect(region.textContent).toContain('Confirmed');
		expect(region.textContent).toContain('Deposited 1 PAXG.');
		expect(region.textContent).not.toContain('Waiting for confirmation');

		view.rerender(<Receipt status="error" txHash={HASH} errorMessage="The pool is paused." />);
		expect(screen.getByRole('status')).toBe(region);
		expect(region.textContent).toContain('Transaction failed');
		expect(region.textContent).toContain('The pool is paused.');
	});

	it('keeps the node when the wallet never sent anything and a hash then arrives', () => {
		const view = render(<Receipt status="pending" txHash={undefined} />);
		const region = screen.getByRole('status');
		expect(region.textContent).toContain('Not submitted');
		view.rerender(<Receipt status="pending" txHash={HASH} />);
		expect(screen.getByRole('status')).toBe(region);
		expect(region.textContent).toContain('Waiting for confirmation');
	});

	it('is named by the current heading in every state', () => {
		const view = render(<Receipt status="pending" txHash={HASH} />);
		expect(screen.getByRole('status', { name: 'Waiting for confirmation' })).toBeTruthy();
		view.rerender(<Receipt status="success" txHash={HASH} />);
		expect(screen.getByRole('status', { name: 'Confirmed' })).toBeTruthy();
		view.rerender(<Receipt status="error" txHash={HASH} errorMessage="Reverted." />);
		expect(screen.getByRole('status', { name: 'Transaction failed' })).toBeTruthy();
	});

	it('shows the spinner only while pending, inside the region', () => {
		const view = render(<Receipt status="pending" txHash={HASH} />);
		const region = screen.getByRole('status');
		expect(region.querySelectorAll('svg')).toHaveLength(1);
		view.rerender(<Receipt status="success" txHash={HASH} />);
		expect(region.querySelectorAll('svg')).toHaveLength(0);
		view.rerender(<Receipt status="error" txHash={HASH} errorMessage="Reverted." />);
		expect(region.querySelectorAll('svg')).toHaveLength(0);
	});

	it('keeps the dialog named by its heading', () => {
		render(<Receipt status="success" txHash={HASH} />);
		expect(screen.getByRole('dialog', { name: 'Confirmed' })).toBeTruthy();
	});

	it('does not mutate when a caller passes a fresh element with the same success text', async () => {
		const view = render(<Receipt status="success" txHash={HASH} successMessage={<>Deposited 1 PAXG.</>} />);
		const region = screen.getByRole('status');
		const seen: MutationRecord[] = [];
		const observer = new MutationObserver((records) => seen.push(...records));
		observer.observe(region, { childList: true, subtree: true, characterData: true, attributes: true });
		view.rerender(<Receipt status="success" txHash={HASH} successMessage={<>Deposited 1 PAXG.</>} />);
		await settle();
		observer.disconnect();
		expect(seen).toHaveLength(0);
	});
});
