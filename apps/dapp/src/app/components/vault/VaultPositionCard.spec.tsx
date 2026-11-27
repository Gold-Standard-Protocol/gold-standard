import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';
import type { Token } from '@goldstandard/models';
import { VaultPositionCard } from './VaultPositionCard';

const active = vi.hoisted(() => ({ tokens: undefined as Record<string, Token> | undefined }));
const read = vi.hoisted(() => ({
	position: { isLoading: false, isError: false, isFetching: false, hasFailed: false, hasPosition: false, position: undefined, refetch: vi.fn() },
}));

vi.mock('@goldstandard/hooks', () => ({
	useVaultContext: () => ({
		chainId: 1,
		position: read.position,
		ratio: undefined,
		liquidationPrice: undefined,
		fees: {},
		collateralDecimals: undefined,
		collateralSymbol: undefined,
	}),
	useRefreshWindow: () => ({ active: false, startedAt: null }),
	useActiveCollateralTokens: () => active.tokens,
}));

const token = (symbol: string) => ({ address: `0x${symbol}`, symbol }) as unknown as Token;

beforeEach(() => {
	read.position = { isLoading: false, isError: false, isFetching: false, hasFailed: false, hasPosition: false, position: undefined, refetch: vi.fn() };
});

describe('VaultPositionCard empty state', () => {
	// On a PAXG-first deployment XAUT is not a collateral; the card must not invite it.
	it('names only the active collateral', () => {
		active.tokens = { PAXG: token('PAXG') };
		render(<VaultPositionCard />);
		expect(screen.getByText(/Deposit gold collateral \(PAXG\) below/)).toBeTruthy();
		expect(screen.queryByText(/XAUT/)).toBeNull();
	});

	it('names every active collateral once governance activates another', () => {
		active.tokens = { PAXG: token('PAXG'), XAUT: token('XAUT') };
		render(<VaultPositionCard />);
		expect(screen.getByText(/Deposit gold collateral \(PAXG or XAUT\) below/)).toBeTruthy();
	});

	it('names no token while the list is loading', () => {
		active.tokens = undefined;
		render(<VaultPositionCard />);
		expect(screen.getByText(/^Deposit gold collateral below/)).toBeTruthy();
	});
});

// A read that failed says nothing about the vault. "No active vault" told a holder with
// collateral and debt that the position was gone whenever the RPC was down.
describe('VaultPositionCard when the position cannot be read', () => {
	beforeEach(() => {
		active.tokens = { PAXG: token('PAXG') };
		read.position = { ...read.position, isError: true, hasFailed: true };
	});

	it('says the read failed, never that there is no vault', () => {
		render(<VaultPositionCard />);
		expect(screen.getByRole('status').textContent).toContain('Chain read failed, retrying');
		expect(screen.queryByText('No active vault')).toBeNull();
		expect(screen.queryByText(/Deposit gold collateral/)).toBeNull();
	});

	it('offers a retry that reads the position again', () => {
		render(<VaultPositionCard />);
		fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
		expect(read.position.refetch).toHaveBeenCalledTimes(1);
	});

	// React Query puts a read with no data back to loading at the start of every retry. The
	// notice and its button used to give way to the skeleton each time, for the whole outage.
	it('keeps the notice and its button while a retry is in flight', () => {
		read.position = { ...read.position, isError: false, isLoading: true, isFetching: true };
		render(<VaultPositionCard />);
		expect(screen.getByRole('status').textContent).toContain('Your position could not be read');
		const retry = screen.getByRole('button', { name: 'Retrying' });
		// Still focusable, and a second press does not start a second read.
		expect((retry as HTMLButtonElement).disabled).toBe(false);
		expect(retry.getAttribute('aria-disabled')).toBe('true');
		fireEvent.click(retry);
		expect(read.position.refetch).not.toHaveBeenCalled();
	});

	it('shows the skeleton for a first read that has not failed', () => {
		read.position = { ...read.position, isError: false, hasFailed: false, isLoading: true, isFetching: true };
		render(<VaultPositionCard />);
		expect(screen.queryByText(/Your position could not be read/)).toBeNull();
		expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
		expect(screen.queryByText('No active vault')).toBeNull();
	});
});
