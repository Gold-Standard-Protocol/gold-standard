import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button, DialogTrigger } from '@goldstandard/ui';
import type { WriteCallbacks } from '@goldstandard/hooks';
import { ReviewSwapDialog, type SwapVenue } from './ReviewSwapDialog';
import { formatTokenAmount } from '../../lib/format';

const write = (callbacks?: WriteCallbacks) => callbacks?.onSuccess?.();

const dialog = (venue: SwapVenue, confirmationStatus: 'pending' | 'success', receivedAmount?: bigint) => (
	<ReviewSwapDialog
		venue={venue}
		amount="1000"
		sellSymbol="GSUSD"
		receiveSymbol="XAUT"
		rows={[]}
		minReceiveLabel="0.24 XAUT"
		minReceive={240_000n}
		receivedAmount={receivedAmount}
		receiveDecimals={6}
		write={write}
		reset={vi.fn()}
		confirmationStatus={confirmationStatus}
		isSimulationSuccess
		isSimulationError={false}
		simulationError={null}
		txHash="0x01"
	>
		{() => (
			<DialogTrigger asChild>
				<Button>Swap GSUSD for XAUT</Button>
			</DialogTrigger>
		)}
	</ReviewSwapDialog>
);

async function swapAndConfirm(venue: SwapVenue, receivedAmount?: bigint) {
	const view = render(dialog(venue, 'pending'));
	fireEvent.click(screen.getByRole('button', { name: 'Swap GSUSD for XAUT' }));
	fireEvent.click(await screen.findByRole('button', { name: 'Confirm swap' }));
	view.rerender(dialog(venue, 'success', receivedAmount));
}

describe('ReviewSwapDialog receipt', () => {
	it('states the gold the reserve actually paid, in the token decimals', async () => {
		await swapAndConfirm('reserve', 250_123n);
		expect(await screen.findByText(/Swapped 1,000 GSUSD for 0\.250123 XAUT from the protocol reserve\./)).toBeTruthy();
	});

	it('states what the pool actually paid on a market swap', async () => {
		await swapAndConfirm('market', 249_000n);
		expect(await screen.findByText(/Swapped 1,000 GSUSD for 0\.249 XAUT on Uniswap v3\./)).toBeTruthy();
	});

	it('names only the token when the receipt amount cannot be read', async () => {
		await swapAndConfirm('reserve');
		expect(await screen.findByText(/Swapped 1,000 GSUSD for XAUT from the protocol reserve\./)).toBeTruthy();
	});
});

/** A market review whose quote refreshes underneath it: the minimum and its label come from the props. */
const quoted = (minReceive: bigint, write = vi.fn()) => (
	<ReviewSwapDialog
		venue="market"
		amount="1000"
		sellSymbol="GSUSD"
		receiveSymbol="XAUT"
		rows={[{ label: 'You receive', value: `≈ ${formatTokenAmount(minReceive + 1_000n, 6, 6)} XAUT` }]}
		minReceiveLabel={`${formatTokenAmount(minReceive, 6, 6)} XAUT`}
		minReceive={minReceive}
		write={write}
		reset={vi.fn()}
		confirmationStatus="pending"
		isSimulationSuccess
		isSimulationError={false}
		simulationError={null}
		txHash={undefined}
	>
		{() => (
			<DialogTrigger asChild>
				<Button>Swap GSUSD for XAUT</Button>
			</DialogTrigger>
		)}
	</ReviewSwapDialog>
);

describe('ReviewSwapDialog quote snapshot', () => {
	it('holds the reviewed minimum when a refresh lowers it, and signs only after Accept new price', async () => {
		const write = vi.fn();
		const view = render(quoted(240_000n, write));
		fireEvent.click(screen.getByRole('button', { name: 'Swap GSUSD for XAUT' }));
		await screen.findByRole('button', { name: 'Confirm swap' });

		view.rerender(quoted(230_000n, write));
		expect(screen.queryByRole('button', { name: 'Confirm swap' })).toBeNull();
		expect(screen.getByText('Reverts below 0.24 XAUT')).toBeTruthy();
		expect(screen.getByRole('status').textContent).toMatch(/would now revert below 0\.23 XAUT instead of 0\.24 XAUT/);
		expect(write).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Accept new price' }));
		expect(screen.getByText('Reverts below 0.23 XAUT')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Confirm swap' }));
		expect(write).toHaveBeenCalledTimes(1);
	});

	it('shows a refresh that keeps or raises the minimum as it comes, with no extra step', async () => {
		const view = render(quoted(240_000n));
		fireEvent.click(screen.getByRole('button', { name: 'Swap GSUSD for XAUT' }));
		await screen.findByRole('button', { name: 'Confirm swap' });
		view.rerender(quoted(250_000n));
		expect(screen.getByText('Reverts below 0.25 XAUT')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Confirm swap' })).toBeTruthy();
		// A later fall is judged against the higher minimum the review moved to.
		view.rerender(quoted(245_000n));
		expect(screen.getByRole('button', { name: 'Accept new price' })).toBeTruthy();
	});
});
