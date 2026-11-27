import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DialogTrigger } from '@goldstandard/ui';
import type { WriteCallbacks } from '@goldstandard/hooks';
import { claimOutcome, ReviewPoolDialog } from './ReviewPoolDialog';

function renderReview(write: ((callbacks?: WriteCallbacks) => void) | undefined, extra: Partial<Parameters<typeof ReviewPoolDialog>[0]> = {}) {
	const reset = vi.fn();
	render(
		<ReviewPoolDialog
			action="deposit"
			amount="10"
			unit="GSUSD"
			write={write}
			reset={reset}
			confirmationStatus="pending"
			isSimulationSuccess={Boolean(write)}
			isSimulationError={false}
			simulationError={null}
			txHash={undefined}
			{...extra}
		>
			{() => (
				<DialogTrigger asChild>
					<button type="button">Open</button>
				</DialogTrigger>
			)}
		</ReviewPoolDialog>
	);
	fireEvent.click(screen.getByRole('button', { name: 'Open' }));
	return { reset };
}

describe('ReviewPoolDialog', () => {
	it('sends one request for two Confirm clicks inside the same frame', () => {
		const write = vi.fn();
		renderReview(write);
		const confirm = screen.getByRole('button', { name: 'Confirm deposit' });
		fireEvent.click(confirm);
		fireEvent.click(confirm);
		expect(write).toHaveBeenCalledTimes(1);
	});

	it('accepts a second attempt once the wallet has answered the first', () => {
		const write = vi.fn((callbacks?: WriteCallbacks) => callbacks?.onSettled?.());
		renderReview(write);
		const confirm = screen.getByRole('button', { name: 'Confirm deposit' });
		fireEvent.click(confirm);
		fireEvent.click(confirm);
		expect(write).toHaveBeenCalledTimes(2);
	});

	it('shows Checking, busy and disabled, while there is no request and no error', () => {
		renderReview(undefined);
		const button = screen.getByRole('button', { name: 'Checking' });
		expect(button.getAttribute('aria-busy')).toBe('true');
		expect((button as HTMLButtonElement).disabled).toBe(true);
	});

	it('renders the write error inside the review rather than disabling the trigger', () => {
		renderReview(vi.fn(), { writeError: Object.assign(new Error('User rejected the request.'), { shortMessage: 'User rejected the request.' }) });
		expect(screen.getByRole('alert').textContent).toMatch(/rejected/);
	});

	it('resets the write when the review is dismissed', () => {
		const { reset } = renderReview(vi.fn());
		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
		expect(reset).toHaveBeenCalledTimes(1);
	});

	it('keeps the review open while the wallet holds the request', () => {
		const { reset } = renderReview(vi.fn(), { isWritePending: true });
		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
		expect(screen.getByRole('dialog')).toBeTruthy();
		expect(screen.getByText('Waiting for your wallet. Reject in your wallet to cancel.')).toBeTruthy();
		expect(reset).not.toHaveBeenCalled();
	});
});

const E18 = 10n ** 18n;
const TX_HASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

function withdrawDialog(
	status: 'pending' | 'success',
	write: (callbacks?: WriteCallbacks) => void,
	withdrawnAmount?: bigint,
	amount = '300'
) {
	return (
		<ReviewPoolDialog
			action="withdraw"
			amount={amount}
			unit="GSUSD"
			write={write}
			reset={() => undefined}
			confirmationStatus={status}
			isSimulationSuccess
			isSimulationError={false}
			simulationError={null}
			txHash={status === 'success' ? TX_HASH : undefined}
			withdrawnAmount={withdrawnAmount}
		>
			{() => (
				<DialogTrigger asChild>
					<button type="button">Open</button>
				</DialogTrigger>
			)}
		</ReviewPoolDialog>
	);
}

/** Confirms a withdrawal reviewed at 300 GSUSD, then lands the receipt with what the pool returned. */
async function withdrawReceipt(withdrawnAmount: bigint | undefined, amountAfter = '300'): Promise<string> {
	let onSuccess: (() => void) | undefined;
	const write = vi.fn((callbacks?: WriteCallbacks) => {
		onSuccess = callbacks?.onSuccess;
	});
	const { rerender } = render(withdrawDialog('pending', write));
	fireEvent.click(screen.getByText('Open'));
	fireEvent.click(await screen.findByText('Confirm withdraw'));
	act(() => onSuccess?.());
	rerender(withdrawDialog('success', write, withdrawnAmount, amountAfter));
	return document.body.textContent ?? '';
}

describe('ReviewPoolDialog withdraw receipt', () => {
	it('states the amount the pool returned when that is below the amount reviewed', async () => {
		const text = await withdrawReceipt(299n * E18 + E18 / 2n);
		expect(text).toContain('Withdrew 299.5 GSUSD.');
		expect(text).not.toContain('Withdrew 300 GSUSD');
	});

	it('states the amount exactly, without rounding it to the display precision', async () => {
		const text = await withdrawReceipt(300n * E18 - 1n);
		expect(text).toContain('Withdrew 299.999999999999999999 GSUSD.');
	});

	it('falls back to the reviewed amount when the receipt cannot be decoded', async () => {
		const text = await withdrawReceipt(undefined);
		expect(text).toContain('Withdrew 300 GSUSD.');
	});

	it('keeps the reviewed amount in that fallback after the position refresh lowers the amount the page reviews', async () => {
		const text = await withdrawReceipt(undefined, '0');
		expect(text).toContain('Withdrew 300 GSUSD.');
	});

	it('keeps naming the amount of a deposit when the form empties because the wallet gave it all', async () => {
		let onSuccess: (() => void) | undefined;
		const write = vi.fn((callbacks?: WriteCallbacks) => {
			onSuccess = callbacks?.onSuccess;
		});
		const deposit = (status: 'pending' | 'success', amount: string) => (
			<ReviewPoolDialog
				action="deposit"
				amount={amount}
				unit="GSUSD"
				write={write}
				reset={() => undefined}
				confirmationStatus={status}
				isSimulationSuccess
				isSimulationError={false}
				simulationError={null}
				txHash={status === 'success' ? TX_HASH : undefined}
			>
				{() => (
					<DialogTrigger asChild>
						<button type="button">Open</button>
					</DialogTrigger>
				)}
			</ReviewPoolDialog>
		);
		const { rerender } = render(deposit('pending', '10'));
		fireEvent.click(screen.getByText('Open'));
		fireEvent.click(await screen.findByText('Confirm deposit'));
		act(() => onSuccess?.());
		rerender(deposit('success', ''));
		expect(document.body.textContent).toContain('Deposited 10 GSUSD.');
	});
});

function claimDialog(status: 'pending' | 'success', write: (callbacks?: WriteCallbacks) => void, claimedAmount?: bigint, amount = '1.5') {
	return (
		<ReviewPoolDialog
			action="claim"
			amount={amount}
			unit="XAUT"
			write={write}
			reset={() => undefined}
			confirmationStatus={status}
			isSimulationSuccess
			isSimulationError={false}
			simulationError={null}
			txHash={status === 'success' ? TX_HASH : undefined}
			claimedAmount={claimedAmount}
			claimDecimals={6}
		>
			{() => (
				<DialogTrigger asChild>
					<button type="button">Open</button>
				</DialogTrigger>
			)}
		</ReviewPoolDialog>
	);
}

/** Confirms a claim reviewed at 1.5 XAUT (6 decimals), then lands the receipt with what the pool paid. */
async function claimReceipt(claimedAmount: bigint | undefined, amountAfter = '1.5'): Promise<string> {
	let onSuccess: (() => void) | undefined;
	const write = vi.fn((callbacks?: WriteCallbacks) => {
		onSuccess = callbacks?.onSuccess;
	});
	const { rerender } = render(claimDialog('pending', write));
	fireEvent.click(screen.getByText('Open'));
	fireEvent.click(await screen.findByText('Confirm claim'));
	act(() => onSuccess?.());
	rerender(claimDialog('success', write, claimedAmount, amountAfter));
	return document.body.textContent ?? '';
}

describe('ReviewPoolDialog claim receipt', () => {
	it('names the gold the pool paid and the remainder when the pool held less than the gain', async () => {
		const text = await claimReceipt(400_000n);
		expect(text).toContain('Claimed 0.4 XAUT.');
		expect(text).not.toContain('Claimed 1.5 XAUT');
		expect(text).toContain('the remaining 1.1 XAUT stays claimable and is paid once the pool holds it again.');
	});

	it('still compares against the gain that was reviewed after the position refresh shows the remainder', async () => {
		const text = await claimReceipt(400_000n, '1.1');
		expect(text).toContain('Claimed 0.4 XAUT.');
		expect(text).toContain('the remaining 1.1 XAUT stays claimable');
	});

	it('has no remainder sentence when the pool paid the whole gain', async () => {
		const text = await claimReceipt(1_500_000n);
		expect(text).toContain('Claimed 1.5 XAUT.');
		expect(text).not.toContain('stays claimable');
	});

	it('falls back to the reviewed gain when the receipt cannot be decoded', async () => {
		const text = await claimReceipt(undefined);
		expect(text).toContain('Claimed 1.5 XAUT.');
		expect(text).not.toContain('stays claimable');
	});
});

describe('claimOutcome', () => {
	it('reads the paid amount in the token decimals, never assuming 18', () => {
		expect(claimOutcome('2', 2_000_000n, 6)).toEqual({ paid: '2', remainder: undefined });
		expect(claimOutcome('2', 5n * 10n ** 17n, 18)).toEqual({ paid: '0.5', remainder: '1.5' });
	});

	it('is undefined without a decoded amount or the token decimals', () => {
		expect(claimOutcome('2', undefined, 6)).toBeUndefined();
		expect(claimOutcome('2', 1n, undefined)).toBeUndefined();
	});

	it('reports no remainder when the reviewed text is not a number or the pool paid more than was reviewed', () => {
		expect(claimOutcome('', 1_000_000n, 6)).toEqual({ paid: '1', remainder: undefined });
		expect(claimOutcome('1', 1_200_000n, 6)).toEqual({ paid: '1.2', remainder: undefined });
	});
});
