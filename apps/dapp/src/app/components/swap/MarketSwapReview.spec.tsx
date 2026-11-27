import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Token } from '@goldstandard/models';
import { MarketSwapPanel } from './MarketSwapPanel';

const PAXG_ADDRESS = '0x5ccd1c3Cf37261EbA2f681b2848271C9e1De4c6e';
const GSUSD_ADDRESS = '0x2000000000000000000000000000000000000002';

const state = vi.hoisted(() => ({
	amountOut: undefined as bigint | undefined,
	writePending: false,
}));

vi.mock('@goldstandard/constants', async () => {
	const actual = await vi.importActual<typeof import('@goldstandard/constants')>('@goldstandard/constants');
	return {
		...actual,
		getDexConfig: () => ({ poolFee: 3000, router: { address: '0x00000000000000000000000000000000000000aa' } }),
	};
});

vi.mock('@goldstandard/hooks', async () => {
	const actual = await vi.importActual<typeof import('@goldstandard/hooks')>('@goldstandard/hooks');
	return {
		...actual,
		useGsusdToken: () => ({ address: GSUSD_ADDRESS, symbol: 'GSUSD', decimals: 18, name: 'GSUSD', image: '' }),
		useTokenBalance: () => ({ data: undefined }),
		useOraclePrice: () => ({ isDeployed: true, price8: 4005n * 10n ** 8n, isLive: true, isLoading: false, isError: false }),
		useDexQuote: () => ({ amountOut: state.amountOut, isLoading: false, isError: false, noLiquidity: false }),
		// Like the real hook, a swap with no amount or no floor has nothing to send.
		useDexSwap: (_chain: unknown, _sell: unknown, _buy: unknown, amountIn: bigint | undefined, minOut: bigint | undefined) => ({
			write: amountIn !== undefined && minOut !== undefined ? vi.fn() : undefined,
			reset: vi.fn(),
			isWritePending: state.writePending,
			confirmationStatus: 'pending' as const,
			isSimulationSuccess: amountIn !== undefined && minOut !== undefined,
			isSimulationError: false,
			simulationError: undefined,
			writeError: undefined,
			txHash: undefined,
		}),
	};
});

vi.mock('../Guard', () => {
	const passthrough = ({ children }: { children?: unknown }) => children;
	return { Connection: passthrough, Chain: passthrough, TokenApproval: passthrough, Ready: passthrough };
});

const paxg = { address: PAXG_ADDRESS, symbol: 'PAXG', decimals: 18, name: 'Paxos Gold', image: '' } as unknown as Token;

const panel = (typedAmount: string) => (
	<MarketSwapPanel
		chainId={11155111}
		direction="gold-to-gsusd"
		onDirectionChange={vi.fn()}
		typedAmount={typedAmount}
		onAmountChange={vi.fn()}
		tokens={[paxg]}
		selectedToken={paxg}
		onSelectToken={vi.fn()}
		slippageBps={50n}
		onSlippageChange={vi.fn()}
	/>
);

const MOVED_MESSAGE =
	'The price moved while you were reviewing. Close this review and tick the acknowledgement again.';

describe('MarketSwapPanel review dialog when the quote moves', () => {
	beforeEach(() => {
		state.amountOut = undefined;
		state.writePending = false;
	});

	it('names the moved price instead of a bare Checking when an acknowledged gap changes', () => {
		// 7 PAXG for 12,022.04 GSUSD is 57.1% under the oracle; the next quote is 64.3% under.
		state.amountOut = 1_202_204n * 10n ** 16n;
		const view = render(panel('7'));
		fireEvent.click(screen.getByRole('checkbox'));
		fireEvent.click(screen.getByRole('button', { name: 'Swap PAXG for GSUSD' }));

		const review = screen.getByRole('dialog');
		expect(within(review).getByRole('button', { name: 'Confirm swap' }).hasAttribute('disabled')).toBe(false);

		state.amountOut = 10_000n * 10n ** 18n;
		view.rerender(panel('7'));

		const open = screen.getByRole('dialog');
		expect(within(open).getByRole('status').textContent).toBe(MOVED_MESSAGE);
		const button = within(open).getByRole('button', { name: 'Price moved' });
		expect(button.hasAttribute('disabled')).toBe(true);
		expect(within(open).queryByRole('button', { name: 'Checking' })).toBeNull();
	});

	it('does not close the review or acknowledge on the user behalf', () => {
		state.amountOut = 1_202_204n * 10n ** 16n;
		const view = render(panel('7'));
		fireEvent.click(screen.getByRole('checkbox'));
		fireEvent.click(screen.getByRole('button', { name: 'Swap PAXG for GSUSD' }));
		state.amountOut = 10_000n * 10n ** 18n;
		view.rerender(panel('7'));

		expect(screen.getByRole('dialog')).toBeTruthy();
		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
		expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
	});

	it('lets the user acknowledge the new figure and review again', () => {
		state.amountOut = 1_202_204n * 10n ** 16n;
		const view = render(panel('7'));
		fireEvent.click(screen.getByRole('checkbox'));
		fireEvent.click(screen.getByRole('button', { name: 'Swap PAXG for GSUSD' }));
		state.amountOut = 10_000n * 10n ** 18n;
		view.rerender(panel('7'));
		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

		fireEvent.click(screen.getByRole('checkbox'));
		fireEvent.click(screen.getByRole('button', { name: 'Swap PAXG for GSUSD' }));
		const review = screen.getByRole('dialog');
		expect(within(review).queryByRole('status')).toBeNull();
		expect(within(review).getByRole('button', { name: 'Confirm swap' }).hasAttribute('disabled')).toBe(false);
	});

	it('says the same when the price turns severe during a review that needed no acknowledgement', () => {
		// 3.0% under the oracle needs no tick; the next quote is 64.3% under.
		state.amountOut = 388485n * 10n ** 16n;
		const view = render(panel('1'));
		fireEvent.click(screen.getByRole('button', { name: 'Swap PAXG for GSUSD' }));
		state.amountOut = 1_428n * 10n ** 18n;
		view.rerender(panel('1'));

		const open = screen.getByRole('dialog');
		expect(within(open).getByRole('status').textContent).toBe(MOVED_MESSAGE);
		expect(within(open).getByRole('button', { name: 'Price moved' }).hasAttribute('disabled')).toBe(true);
	});

	it('does not tell the user to close a review that cannot be closed while the wallet holds the request', () => {
		state.amountOut = 1_202_204n * 10n ** 16n;
		const view = render(panel('7'));
		fireEvent.click(screen.getByRole('checkbox'));
		fireEvent.click(screen.getByRole('button', { name: 'Swap PAXG for GSUSD' }));
		state.writePending = true;
		state.amountOut = 10_000n * 10n ** 18n;
		view.rerender(panel('7'));

		const open = screen.getByRole('dialog');
		expect(within(open).queryByRole('status')).toBeNull();
		expect(within(open).getByRole('button', { name: 'Waiting for your wallet' }).hasAttribute('disabled')).toBe(true);

		state.writePending = false;
		view.rerender(panel('7'));
		expect(within(screen.getByRole('dialog')).getByRole('status').textContent).toBe(MOVED_MESSAGE);
	});

	it('keeps Checking for a quote that is still loading', () => {
		state.amountOut = 3990n * 10n ** 18n;
		const view = render(panel('1'));
		fireEvent.click(screen.getByRole('button', { name: 'Swap PAXG for GSUSD' }));
		state.amountOut = undefined;
		view.rerender(panel('1'));

		const open = screen.getByRole('dialog');
		expect(within(open).getByRole('button', { name: 'Checking' }).hasAttribute('disabled')).toBe(true);
		expect(within(open).queryByRole('status')).toBeNull();
		expect(within(open).queryByRole('button', { name: 'Price moved' })).toBeNull();
	});

	it('shows Confirm swap, with no moved notice, while nothing has moved', () => {
		state.amountOut = 3990n * 10n ** 18n;
		render(panel('1'));
		fireEvent.click(screen.getByRole('button', { name: 'Swap PAXG for GSUSD' }));
		const open = screen.getByRole('dialog');
		expect(within(open).getByRole('button', { name: 'Confirm swap' }).hasAttribute('disabled')).toBe(false);
		expect(within(open).queryByRole('status')).toBeNull();
	});
});
