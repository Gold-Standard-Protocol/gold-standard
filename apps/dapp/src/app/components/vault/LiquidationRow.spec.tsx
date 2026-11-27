import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiquidationRow } from './LiquidationRow';

const mocks = vi.hoisted(() => ({
	direct: vi.fn(),
	pool: vi.fn(),
	directState: {} as Record<string, unknown>,
	poolState: {} as Record<string, unknown>,
	isFullArgs: [] as boolean[],
	connected: true,
	onTarget: true,
}));

vi.mock('wagmi', () => ({
	useReadContract: ({ functionName }: { functionName: string }) => ({ data: functionName === 'underwaterDiscountPpm' ? 20_000n : 600_000n }),
}));
vi.mock('@goldstandard/hooks', () => ({
	useLiquidate: (_chain: unknown, _owner: unknown, _amount: unknown, isFull: boolean) => {
		mocks.isFullArgs.push(isFull);
		return mocks.directState;
	},
	useLiquidateViaPool: () => mocks.poolState,
	useGsusdToken: () => undefined,
	useCollateralToken: () => ({ decimals: 18, symbol: 'PAXG' }),
	useOraclePrice: () => ({ price8: 1_000n * 10n ** 8n, isLive: true }),
	useCollateralParams: () => ({ liquidationPenaltyPercent: 5 }),
}));
vi.mock('../Guard', () => ({
	TokenApproval: ({ children }: { children: React.ReactNode }) => children,
	Connection: ({ children }: { children: React.ReactNode }) => (mocks.connected ? children : <button type="button">Connect Wallet</button>),
	Chain: ({ children, chainId }: { children: React.ReactNode; chainId: number }) =>
		mocks.onTarget ? children : <button type="button" data-chain={chainId}>Switch Chain</button>,
}));

const vault = {
	owner: '0x0000000000000000000000000000000000000001' as const,
	collateralToken: '0x0000000000000000000000000000000000000002' as const,
	collateralAmount: 10n ** 18n,
	currentDebt: 1_000n * 10n ** 18n,
	debtAmount: 1_000n * 10n ** 18n,
	ratio: 1_000_000n,
	ratioPercent: 100,
	priceSource: 'live' as const,
};

function open() {
	render(<LiquidationRow vault={vault} chainId={11155111} />);
	fireEvent.click(screen.getAllByRole('button')[0]);
	fireEvent.change(screen.getByLabelText('GSUSD to repay'), { target: { value: '1000' } });
	return {
		direct: screen.getByRole('button', { name: /^Liquidat(e position|ing)$/ }),
		pool: screen.getByRole('button', { name: /^(Liquidate from the Stability Pool|Liquidating via pool)$/ }),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isFullArgs = [];
	mocks.connected = true;
	mocks.onTarget = true;
	mocks.directState = { write: mocks.direct, isSimulationSuccess: true, isWritePending: false, confirmationStatus: 'pending' };
	mocks.poolState = { write: mocks.pool, isSimulationSuccess: true, isWritePending: false, confirmationStatus: 'pending' };
});
afterEach(cleanup);

describe('liquidation request lifecycle', () => {
	for (const route of ['directState', 'poolState'] as const) {
		it(`disables both routes while ${route} awaits a mined receipt`, () => {
			mocks[route].txHash = `0x${'1'.repeat(64)}`;
			const buttons = open();
			expect((buttons.direct as HTMLButtonElement).disabled).toBe(true);
			expect((buttons.pool as HTMLButtonElement).disabled).toBe(true);
		});
	}

	// The wait goes on while the chain cannot be read, so a second send stays locked out.
	for (const route of ['directState', 'poolState'] as const) {
		it(`holds both routes while ${route} cannot confirm a sent liquidation`, () => {
			mocks[route].txHash = `0x${'1'.repeat(64)}`;
			mocks[route].confirmationStatus = 'unconfirmed';
			const buttons = open();
			expect((buttons.direct as HTMLButtonElement).disabled).toBe(true);
			expect((buttons.pool as HTMLButtonElement).disabled).toBe(true);
		});
	}

	it('disables the alternate route while a wallet request is outstanding', () => {
		mocks.directState.isWritePending = true;
		const buttons = open();
		expect((buttons.pool as HTMLButtonElement).disabled).toBe(true);
	});

	it('sends only once for two clicks before React can show the wallet wait', () => {
		const buttons = open();
		fireEvent.click(buttons.direct);
		fireEvent.click(buttons.direct);
		fireEvent.click(buttons.pool);
		expect(mocks.direct).toHaveBeenCalledTimes(1);
		expect(mocks.pool).not.toHaveBeenCalled();
	});
});

describe('liquidation row safety', () => {
	const expand = () => {
		render(<LiquidationRow vault={vault} chainId={11155111} />);
		fireEvent.click(screen.getAllByRole('button')[0]);
	};

	it('keeps Max a full liquidation after fees carry the debt past the filled figure', () => {
		const { rerender } = render(<LiquidationRow vault={vault} chainId={11155111} />);
		fireEvent.click(screen.getAllByRole('button')[0]);
		fireEvent.click(screen.getByRole('button', { name: 'Max' }));
		expect((screen.getByLabelText('GSUSD to repay') as HTMLInputElement).value).toBe('1000');
		// A second of fees: the debt is now a hair over the 1,000 Max filled.
		rerender(<LiquidationRow vault={{ ...vault, currentDebt: vault.currentDebt + 1n }} chainId={11155111} />);
		expect(mocks.isFullArgs.at(-1)).toBe(true);
	});

	it('treats an amount typed by hand after Max as typed', () => {
		expand();
		fireEvent.click(screen.getByRole('button', { name: 'Max' }));
		fireEvent.change(screen.getByLabelText('GSUSD to repay'), { target: { value: '400' } });
		expect(mocks.isFullArgs.at(-1)).toBe(false);
	});

	it('asks for a wallet, then for the deployment chain, before either route', () => {
		mocks.connected = false;
		expand();
		expect(screen.getByRole('button', { name: 'Connect Wallet' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Liquidate/ })).toBeNull();
		cleanup();
		mocks.connected = true;
		mocks.onTarget = false;
		expand();
		const switchButton = screen.getByRole('button', { name: 'Switch Chain' });
		expect(switchButton.getAttribute('data-chain')).toBe('11155111');
		expect(screen.queryByRole('button', { name: /^Liquidate/ })).toBeNull();
	});

	it('says when the wallet refused the liquidation', () => {
		mocks.directState.writeError = Object.assign(new Error('rejected'), { shortMessage: 'User rejected the request.' });
		expand();
		expect(screen.getByRole('alert').textContent).toMatch(/did not send|rejected/i);
	});

	it('says when a sent liquidation reverted', () => {
		mocks.poolState.txHash = `0x${'2'.repeat(64)}`;
		mocks.poolState.confirmationStatus = 'error';
		expand();
		expect(screen.getByRole('alert').textContent).toBe('The liquidation was sent but reverted on-chain.');
	});

	// An RPC outage during the receipt wait used to be reported as a revert.
	it('says when a sent liquidation could not be confirmed, never that it reverted', () => {
		mocks.poolState.txHash = `0x${'2'.repeat(64)}`;
		mocks.poolState.confirmationStatus = 'unconfirmed';
		expand();
		const alert = screen.getByRole('alert').textContent;
		expect(alert).toContain('may still succeed');
		expect(alert).not.toContain('reverted');
	});

	// A cancel in the wallet is a mined self-send: the liquidation itself never ran.
	it('says when the wallet cancelled or replaced a sent liquidation', () => {
		mocks.directState.txHash = `0x${'2'.repeat(64)}`;
		mocks.directState.confirmationStatus = 'replaced';
		expand();
		const alert = screen.getByRole('alert').textContent;
		expect(alert).toContain('cancelled or replaced');
		expect(alert).not.toContain('reverted');
	});

	// Inside Safe{Wallet} a liquidation is a proposal to the owners of the Safe, not a transaction.
	it('says a liquidation is proposed to the Safe, as a notice and never as a failure', () => {
		mocks.poolState.txHash = `0x${'2'.repeat(64)}`;
		mocks.poolState.confirmationStatus = 'proposed';
		expand();
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.getByRole('status').textContent).toBe(
			'Proposed to your Safe. The liquidation executes once the owners have signed.'
		);
	});

	// Owners can take days, and the vault may be liquidated by someone else meanwhile.
	it('leaves both routes live while a proposal is outstanding', () => {
		mocks.directState.txHash = `0x${'2'.repeat(64)}`;
		mocks.directState.confirmationStatus = 'proposed';
		const { direct, pool } = open();
		expect((direct as HTMLButtonElement).disabled).toBe(false);
		expect((pool as HTMLButtonElement).disabled).toBe(false);
	});
});

describe('liquidation row confirmation', () => {
	// The list re-reads on confirmation and a closed vault leaves it with this row, so the
	// row hands the outcome to the table before it goes.
	for (const [route, state] of [['direct', 'directState'], ['pool', 'poolState']] as const) {
		it(`reports a confirmed ${route} liquidation to the table`, () => {
			mocks[state].txHash = `0x${'3'.repeat(64)}`;
			mocks[state].confirmationStatus = 'success';
			const onConfirmed = vi.fn();
			render(<LiquidationRow vault={vault} chainId={11155111} onConfirmed={onConfirmed} />);
			expect(onConfirmed).toHaveBeenCalledWith(vault.owner, route);
		});
	}

	it('reports nothing while a liquidation is still waiting for its receipt', () => {
		mocks.directState.txHash = `0x${'3'.repeat(64)}`;
		const onConfirmed = vi.fn();
		render(<LiquidationRow vault={vault} chainId={11155111} onConfirmed={onConfirmed} />);
		expect(onConfirmed).not.toHaveBeenCalled();
	});
});

describe('liquidation row structure', () => {
	// A row is a list item whose disclosure button names every value with its label, so
	// a screen reader hears owner, collateral, debt and ratio without a table to navigate.
	it('is a list item whose summary button names each value with its label', () => {
		render(
			<ul>
				<LiquidationRow vault={vault} chainId={11155111} />
			</ul>
		);
		expect(screen.queryByRole('row')).toBeNull();
		expect(screen.queryByRole('cell')).toBeNull();
		expect(screen.getAllByRole('listitem')).toHaveLength(1);
		const summary = screen.getByRole('button', {
			name: 'Vault owner 0x0000…0001, collateral 1.00 PAXG, debt 1,000 GSUSD, Ratio 100.0%',
		});
		expect(summary.getAttribute('aria-expanded')).toBe('false');
	});
});
