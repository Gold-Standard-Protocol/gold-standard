import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Token } from '@goldstandard/models';
import { MarketSwapPanel } from './MarketSwapPanel';

const ORACLE_8 = 4005n * 10n ** 8n;
const PAXG_ADDRESS = '0x5ccd1c3Cf37261EbA2f681b2848271C9e1De4c6e';
const GSUSD_ADDRESS = '0x2000000000000000000000000000000000000002';

const state = vi.hoisted(() => ({
	amountOut: undefined as bigint | undefined,
	oracle: { price8: 4005n * 10n ** 8n as bigint | undefined, isLive: true, isLoading: false },
	lastButtonProps: undefined as undefined | { blocked: boolean; rows: { label: string; value: string }[] },
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
		useOraclePrice: () => ({ isDeployed: true, ...state.oracle, isError: false }),
		useDexQuote: () => ({ amountOut: state.amountOut, isLoading: false, isError: false, noLiquidity: false }),
	};
});

vi.mock('./MarketSwapButton', () => ({
	MarketSwapButton: (props: { blocked: boolean; rows: { label: string; value: string }[] }) => {
		state.lastButtonProps = props;
		return <button type="button" disabled={props.blocked}>Swap</button>;
	},
}));

const paxg = { address: PAXG_ADDRESS, symbol: 'PAXG', decimals: 18, name: 'Paxos Gold', image: '' } as unknown as Token;

const renderPanel = (direction: 'gsusd-to-gold' | 'gold-to-gsusd', typedAmount: string, onAmountChange = vi.fn()) =>
	render(
		<MarketSwapPanel
			chainId={11155111}
			direction={direction}
			onDirectionChange={vi.fn()}
			typedAmount={typedAmount}
			onAmountChange={onAmountChange}
			tokens={[paxg]}
			selectedToken={paxg}
			onSelectToken={vi.fn()}
			slippageBps={50n}
			onSlippageChange={vi.fn()}
		/>
	);

describe('MarketSwapPanel price impact', () => {
	beforeEach(() => {
		state.amountOut = undefined;
		state.lastButtonProps = undefined;
		state.oracle = { price8: ORACLE_8, isLive: true, isLoading: false };
	});

	it('demands an acknowledgement when a sale fills far below the oracle', () => {
		// 7 PAXG for 12,022.04 GSUSD is $1,717.43 an ounce against a $4,005 oracle.
		state.amountOut = 1_202_204n * 10n ** 16n;
		renderPanel('gold-to-gsusd', '7');
		expect(screen.getByRole('alert').textContent).toContain('You would receive 57.1% less than the oracle price.');
		expect(state.lastButtonProps?.blocked).toBe(true);
		expect(state.lastButtonProps?.rows).toContainEqual({ label: 'Against oracle', value: '57.1% less' });

		fireEvent.click(screen.getByRole('checkbox'));
		expect(state.lastButtonProps?.blocked).toBe(false);
	});

	it('forgets the acknowledgement when the amount changes', () => {
		state.amountOut = 1_202_204n * 10n ** 16n;
		const view = renderPanel('gold-to-gsusd', '7');
		fireEvent.click(screen.getByRole('checkbox'));
		expect(state.lastButtonProps?.blocked).toBe(false);
		view.rerender(
			<MarketSwapPanel
				chainId={11155111}
				direction="gold-to-gsusd"
				onDirectionChange={vi.fn()}
				typedAmount="6"
				onAmountChange={vi.fn()}
				tokens={[paxg]}
				selectedToken={paxg}
				onSelectToken={vi.fn()}
				slippageBps={50n}
				onSlippageChange={vi.fn()}
			/>
		);
		expect(state.lastButtonProps?.blocked).toBe(true);
		expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
	});

	it('only warns, without blocking, between 2% and 5% worse than the oracle', () => {
		// 1 PAXG for $3,884.85 is exactly 3.0% below $4,005.
		state.amountOut = 388485n * 10n ** 16n;
		renderPanel('gold-to-gsusd', '1');
		expect(screen.queryByRole('checkbox')).toBeNull();
		expect(screen.getByRole('status').textContent).toContain('You would receive 3.0% less than the oracle price.');
		expect(state.lastButtonProps?.blocked).toBe(false);
	});

	it('says nothing when the fill is within the pool fee of the oracle', () => {
		state.amountOut = 3990n * 10n ** 18n;
		renderPanel('gold-to-gsusd', '1');
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.queryByRole('checkbox')).toBeNull();
		expect(state.lastButtonProps?.blocked).toBe(false);
		expect(state.lastButtonProps?.rows.map(r => r.label)).not.toContain('Against oracle');
	});

	it('measures a buyer against a fill dearer than the oracle', () => {
		// 4,005 GSUSD buys 0.5 PAXG: $8,010 an ounce, 100% above the oracle.
		state.amountOut = 5n * 10n ** 17n;
		renderPanel('gsusd-to-gold', '4005');
		expect(screen.getByRole('alert').textContent).toContain('You would pay 100.0% more than the oracle price.');
		expect(state.lastButtonProps?.blocked).toBe(true);
	});

	it('asks again when a refreshed quote moves the gap, even at the same amount', () => {
		state.amountOut = 1_202_204n * 10n ** 16n;
		const view = renderPanel('gold-to-gsusd', '7');
		fireEvent.click(screen.getByRole('checkbox'));
		expect(state.lastButtonProps?.blocked).toBe(false);
		// The next quote is worse: 7 PAXG for 10,000 GSUSD is 64.3% under the oracle.
		state.amountOut = 10_000n * 10n ** 18n;
		view.rerender(
			<MarketSwapPanel
				chainId={11155111}
				direction="gold-to-gsusd"
				onDirectionChange={vi.fn()}
				typedAmount="7"
				onAmountChange={vi.fn()}
				tokens={[paxg]}
				selectedToken={paxg}
				onSelectToken={vi.fn()}
				slippageBps={50n}
				onSlippageChange={vi.fn()}
			/>
		);
		expect(state.lastButtonProps?.blocked).toBe(true);
		expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
	});

	it('blocks a quote of nothing and says so', () => {
		state.amountOut = 0n;
		renderPanel('gold-to-gsusd', '0.000000000001');
		expect(screen.getByRole('alert').textContent).toContain('The pool would return nothing for this amount.');
		expect(state.lastButtonProps?.blocked).toBe(true);
	});

	it('says the fill cannot be checked when the oracle gives no price, and still lets a normal swap through', () => {
		state.oracle = { price8: undefined, isLive: false, isLoading: false };
		state.amountOut = 3990n * 10n ** 18n;
		renderPanel('gold-to-gsusd', '1');
		expect(screen.getByRole('status').textContent).toContain('cannot be compared');
		expect(state.lastButtonProps?.blocked).toBe(false);
	});

	it('stays quiet about the oracle while it is still loading', () => {
		state.oracle = { price8: undefined, isLive: false, isLoading: true };
		state.amountOut = 3990n * 10n ** 18n;
		renderPanel('gold-to-gsusd', '1');
		expect(screen.queryByRole('status')).toBeNull();
	});

	// The severe gate cannot judge a fill before the oracle answers, so it holds the swap
	// shut until then instead of reading the unknown gap as fine.
	it('holds a swap until the oracle has answered', () => {
		state.oracle = { price8: undefined, isLive: false, isLoading: true };
		// The 57.1% short sale: severe once the oracle arrives.
		state.amountOut = 1_202_204n * 10n ** 16n;
		const view = renderPanel('gold-to-gsusd', '7');
		expect(state.lastButtonProps?.blocked).toBe(true);
		state.oracle = { price8: ORACLE_8, isLive: true, isLoading: false };
		view.rerender(
			<MarketSwapPanel
				chainId={11155111}
				direction="gold-to-gsusd"
				onDirectionChange={vi.fn()}
				typedAmount="7"
				onAmountChange={vi.fn()}
				tokens={[paxg]}
				selectedToken={paxg}
				onSelectToken={vi.fn()}
				slippageBps={50n}
				onSlippageChange={vi.fn()}
			/>
		);
		expect(state.lastButtonProps?.blocked).toBe(true);
		expect(screen.getByRole('checkbox')).toBeTruthy();
	});

	it('labels a stale oracle price as the last known one', () => {
		state.oracle = { price8: ORACLE_8, isLive: false, isLoading: false };
		state.amountOut = 3990n * 10n ** 18n;
		renderPanel('gold-to-gsusd', '1');
		expect(screen.getByText('$4,005.00 / oz (last known)')).toBeTruthy();
	});
});
