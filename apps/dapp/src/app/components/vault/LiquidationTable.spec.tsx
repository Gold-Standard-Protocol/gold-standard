import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { LiquidationTable } from './LiquidationTable';

const state = vi.hoisted(() => ({
	judgedAtStoredPrice: false,
	undercollateralised: [] as { owner: `0x${string}` }[],
	account: '0x00000000000000000000000000000000000000aa' as `0x${string}` | undefined,
}));

vi.mock('wagmi', () => ({ useAccount: () => ({ address: state.account }) }));

vi.mock('@goldstandard/hooks', () => ({
	useUndercollateralisedVaults: () => ({
		undercollateralised: state.undercollateralised,
		judgedAtStoredPrice: state.judgedAtStoredPrice,
		isLoading: false,
		isError: false,
	}),
}));
// A stand-in row: one button per route that reports a confirmed liquidation.
vi.mock('./LiquidationRow', () => ({
	LiquidationRow: ({ vault, onConfirmed }: { vault: { owner: `0x${string}` }; onConfirmed?: (owner: `0x${string}`, route: 'direct' | 'pool') => void }) => (
		<li>
			<button type="button" onClick={() => onConfirmed?.(vault.owner, 'direct')}>confirm direct</button>
			<button type="button" onClick={() => onConfirmed?.(vault.owner, 'pool')}>confirm pool</button>
		</li>
	),
}));

describe('LiquidationTable empty state', () => {
	// The protocol is live; the old copy told liquidators the opposite.
	it('explains when a position appears without claiming the protocol is not live', () => {
		render(<LiquidationTable knownVaultOwners={[]} />);
		expect(screen.getByRole('heading', { name: 'No vaults are currently eligible for liquidation' })).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/once the protocol is live/i);
		expect(document.body.textContent).toMatch(/liquidation ratio for its gold token/i);
		expect(screen.queryByText(/Live gold price unavailable/)).toBeNull();
	});

	// A list judged at the stored price must say so, even when it is empty.
	it('says when eligibility fell back to the stored price', () => {
		state.judgedAtStoredPrice = true;
		render(<LiquidationTable knownVaultOwners={[]} />);
		expect(screen.getByText(/Live gold price unavailable\. Some positions are judged at the last price the oracle/)).toBeTruthy();
		state.judgedAtStoredPrice = false;
	});
});

describe('LiquidationTable after a confirmed liquidation', () => {
	const owner = '0x1234000000000000000000000000000000005678' as const;
	afterEach(() => {
		state.undercollateralised = [];
		state.account = '0x00000000000000000000000000000000000000aa';
	});

	// The confirmation re-reads the list, so the liquidated vault leaves it at once. Its row,
	// and the row's success line, go with it; the table must still say what happened.
	it('keeps the outcome on screen once the liquidated vault has left the list', () => {
		state.undercollateralised = [{ owner }];
		const view = render(<LiquidationTable knownVaultOwners={[owner]} />);
		fireEvent.click(screen.getByRole('button', { name: 'confirm direct' }));
		state.undercollateralised = [];
		view.rerender(<LiquidationTable knownVaultOwners={[owner]} />);
		expect(screen.getByRole('heading', { name: 'No vaults are currently eligible for liquidation' })).toBeTruthy();
		expect(screen.getByRole('status').textContent).toBe('Vault 0x1234…5678 liquidated; the seized gold is in your wallet.');
		view.unmount();
	});

	it('names the pool route and the bounty when the pool paid', () => {
		state.undercollateralised = [{ owner }, { owner: '0x0000000000000000000000000000000000000009' }];
		const view = render(<LiquidationTable knownVaultOwners={[owner]} />);
		fireEvent.click(screen.getAllByRole('button', { name: 'confirm pool' })[0]);
		expect(screen.getByRole('status').textContent).toMatch(/liquidated from the pool; your bounty is in your wallet\.$/);
		view.unmount();
	});

	// The line told another account, or no account at all, that the seized gold was in its
	// wallet: the rows' own success lines cleared on the switch, the table's did not.
	it('says the proceeds are in your wallet only to the account that liquidated', () => {
		state.undercollateralised = [{ owner }];
		const view = render(<LiquidationTable knownVaultOwners={[owner]} />);
		fireEvent.click(screen.getByRole('button', { name: 'confirm direct' }));
		expect(screen.getByRole('status')).toBeTruthy();
		state.account = '0x00000000000000000000000000000000000000bb';
		view.rerender(<LiquidationTable knownVaultOwners={[owner]} />);
		expect(screen.queryByRole('status')).toBeNull();
		state.account = undefined;
		view.rerender(<LiquidationTable knownVaultOwners={[owner]} />);
		expect(screen.queryByRole('status')).toBeNull();
		view.unmount();
	});
});

describe('LiquidationTable structure', () => {
	afterEach(() => {
		state.undercollateralised = [];
	});

	// A list of disclosure rows, not an ARIA table: the old table owned its rows through a
	// ul and its rows held a button instead of cells, so header association never worked.
	it('is a labelled list of vaults with no broken table roles', () => {
		state.undercollateralised = [{ owner: '0x1234000000000000000000000000000000005678' }, { owner: '0x0000000000000000000000000000000000000009' }];
		const view = render(<LiquidationTable knownVaultOwners={[]} />);
		expect(screen.queryByRole('table')).toBeNull();
		expect(screen.queryByRole('row')).toBeNull();
		expect(screen.queryByRole('columnheader')).toBeNull();
		const list = screen.getByRole('list', { name: 'Vaults eligible for liquidation' });
		expect(list.querySelectorAll(':scope > li')).toHaveLength(2);
		view.unmount();
	});
});
