import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import LiquidationPage from './LiquidationPage';

interface OwnersQuery {
	data?: { status: 'ok' | 'unavailable'; owners: string[]; lastIndexedBlock: string | null };
	isLoading: boolean;
	isError: boolean;
}

const api = vi.hoisted(() => ({
	query: { isLoading: false, isError: false } as OwnersQuery,
	registry: { isDeployed: true, owners: undefined as string[] | undefined, isLoading: false, isError: false },
	registryEnabled: [] as boolean[],
}));

vi.mock('../trpc', () => ({
	trpc: { vaultsRouter: { owners: { useQuery: () => api.query } } },
}));

vi.mock('@goldstandard/hooks', () => ({
	useRegistryVaultOwners: (_chainId: number, enabled: boolean) => {
		api.registryEnabled.push(enabled);
		return enabled ? api.registry : { ...api.registry, owners: undefined };
	},
}));

vi.mock('./components/Reveal', () => ({
	Reveal: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./components/vault/LiquidationTable', () => ({
	LiquidationTable: ({ knownVaultOwners }: { knownVaultOwners: string[] }) => (
		<output data-testid="liquidation-table" data-owners={knownVaultOwners.length} />
	),
}));

const OWNER = '0x00000000000000000000000000000000000000aa';

describe('LiquidationPage', () => {
	beforeEach(() => {
		api.query = { isLoading: false, isError: false };
		api.registry = { isDeployed: false, owners: undefined, isLoading: false, isError: false };
		api.registryEnabled = [];
	});

	// A cache outage used to arrive as an empty success, and the table under it said no
	// vaults were eligible: a verdict where there was only missing data.
	it('says the owner index is not available instead of rendering an empty table', () => {
		api.query = {
			isLoading: false,
			isError: false,
			data: { status: 'unavailable', owners: [], lastIndexedBlock: null },
		};
		render(<LiquidationPage />);
		expect(screen.getByText(/owner index is not available/i)).toBeTruthy();
		expect(screen.queryByTestId('liquidation-table')).toBeNull();
	});

	it('renders the table for an indexed chain, even one with no owners yet', () => {
		api.query = {
			isLoading: false,
			isError: false,
			data: { status: 'ok', owners: [], lastIndexedBlock: '100' },
		};
		render(<LiquidationPage />);
		expect(screen.getByTestId('liquidation-table').dataset['owners']).toBe('0');
		expect(screen.queryByText(/owner index is not available/i)).toBeNull();
	});

	it('passes the indexed owners to the table', () => {
		api.query = {
			isLoading: false,
			isError: false,
			data: { status: 'ok', owners: [OWNER], lastIndexedBlock: '100' },
		};
		render(<LiquidationPage />);
		expect(screen.getByTestId('liquidation-table').dataset['owners']).toBe('1');
	});

	// The page keeps working from the chain when the API cannot help.
	describe('on-chain VaultRegistry fallback', () => {
		it('lists open vaults from the registry when the owner index is unavailable', () => {
			api.query = { isLoading: false, isError: false, data: { status: 'unavailable', owners: [], lastIndexedBlock: null } };
			api.registry = { isDeployed: true, owners: [OWNER, OWNER.replace('aa', 'bb')], isLoading: false, isError: false };
			render(<LiquidationPage />);
			expect(screen.getByTestId('liquidation-table').dataset['owners']).toBe('2');
			expect(screen.getByText('Reading open vaults from the chain')).toBeTruthy();
			expect(screen.queryByText(/owner index is not available/i)).toBeNull();
		});

		it('lists open vaults from the registry when the API cannot be reached', () => {
			api.query = { isLoading: false, isError: true };
			api.registry = { isDeployed: true, owners: [OWNER], isLoading: false, isError: false };
			render(<LiquidationPage />);
			expect(screen.getByTestId('liquidation-table').dataset['owners']).toBe('1');
			expect(screen.queryByText(/Vault discovery is temporarily unavailable/)).toBeNull();
		});

		it('does not read the registry while the API answers', () => {
			api.query = { isLoading: false, isError: false, data: { status: 'ok', owners: [OWNER], lastIndexedBlock: '100' } };
			api.registry = { isDeployed: true, owners: undefined, isLoading: false, isError: false };
			render(<LiquidationPage />);
			expect(api.registryEnabled.every((enabled) => !enabled)).toBe(true);
			expect(screen.queryByText('Reading open vaults from the chain')).toBeNull();
		});

		it('says eligible positions cannot be shown when the registry fails too', () => {
			api.query = { isLoading: false, isError: false, data: { status: 'unavailable', owners: [], lastIndexedBlock: null } };
			api.registry = { isDeployed: true, owners: undefined, isLoading: false, isError: true };
			render(<LiquidationPage />);
			expect(screen.getByText(/owner index is not available/i)).toBeTruthy();
			expect(screen.queryByTestId('liquidation-table')).toBeNull();
		});
	});

	// Each collateral liquidates at its own governance-set ratio, so the lead must not
	// promise one number for all of them.
	it('does not quote a fixed liquidation ratio in the lead', () => {
		render(<LiquidationPage />);
		expect(document.body.textContent).not.toMatch(/\d+% liquidation ratio/);
	});
});
