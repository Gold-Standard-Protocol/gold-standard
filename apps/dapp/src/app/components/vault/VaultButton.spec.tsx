import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { VaultActionType } from '@goldstandard/hooks';
import { VaultButton } from './VaultButton';

const vault = vi.hoisted(() => ({
	activeTab: 'deposit' as VaultActionType,
	simulated: [] as Array<{ hook: string; input: unknown }>,
}));

vi.mock('wagmi', () => ({ useChainId: () => 11155111 }));

vi.mock('./useVaultAmount', () => ({
	useVaultAmount: () => ({ canonical: '5', check: { value: 5n } }),
}));

vi.mock('@goldstandard/hooks', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@goldstandard/hooks')>();
	const write = () => ({
		write: undefined,
		reset: () => undefined,
		isWritePending: false,
		confirmationStatus: 'pending' as const,
		isSimulationSuccess: false,
		isSimulationError: false,
		simulationError: null,
		writeError: null,
		txHash: undefined,
	});
	const record = (hook: string, amount: unknown) => {
		vault.simulated.push({ hook, input: amount });
		return write();
	};
	return {
		...actual,
		useVaultContext: () => ({
			state: { activeTab: vault.activeTab, selectedToken: '0x00000000000000000000000000000000000000a1' },
			position: { position: undefined },
			fees: { currentDebt: undefined },
			goldPrice: undefined,
			collateralDecimals: 18,
			collateralSymbol: 'PAXG',
			depositDecimals: 18,
		}),
		useVaultStateActions: () => ({ setTypedAmount: () => undefined }),
		useVaultDeposit: (_chain: unknown, _token: unknown, amount: unknown) => record('deposit', amount),
		useVaultMint: (_chain: unknown, amount: unknown) => record('mint', amount),
		useVaultRepay: (_chain: unknown, amount: unknown) => ({ ...record('repay', amount), repaidAmount: undefined }),
		useVaultWithdraw: (_chain: unknown, amount: unknown) => record('withdraw', amount),
		useVaultMinDebt: () => undefined,
		useCollateralParams: () => undefined,
		useVaultSimulation: () => undefined,
		useGsusdToken: () => actual.buildGsusdToken(11155111, '0x00000000000000000000000000000000000000bb'),
		useAllGoldTokens: () => ({ data: {} }),
		useOriginationFee: () => ({ bps: undefined, exempt: undefined }),
	};
});

// The guards need a wallet; what matters here is which simulations the button starts.
vi.mock('../Guard', () => {
	const Pass = ({ children }: { children: ReactNode }) => children;
	return { Connection: Pass, Chain: Pass, TokenApproval: Pass, Ready: Pass };
});

vi.mock('./ReviewVaultDialog', () => ({
	ReviewVaultDialog: ({ children }: { children: (props: { error: Error | null; isSuccess: boolean }) => ReactNode }) =>
		children({ error: null, isSuccess: false }),
}));

vi.mock('@goldstandard/ui', async (importOriginal) => ({
	...(await importOriginal<typeof import('@goldstandard/ui')>()),
	DialogTrigger: ({ children }: { children: ReactNode }) => children,
}));

describe('VaultButton', () => {
	beforeEach(() => {
		vault.simulated = [];
	});

	// Every typed amount used to simulate all four actions, three of them for
	// forms not on screen and in the wrong unit (a GSUSD mint simulated as a PAXG deposit).
	it.each(['deposit', 'mint', 'repay', 'withdraw'] as const)('simulates only the %s tab', (tab) => {
		vault.activeTab = tab;
		render(<VaultButton />);
		// Every render asks each hook the same; what each was asked is the set of its inputs.
		const inputs = (hook: string) => [...new Set(vault.simulated.filter((call) => call.hook === hook).map((call) => call.input))];
		const expected = (hook: VaultActionType) => [hook === tab ? '5' : undefined];
		expect([inputs('deposit'), inputs('mint'), inputs('repay'), inputs('withdraw')]).toEqual([
			expected('deposit'),
			expected('mint'),
			expected('repay'),
			expected('withdraw'),
		]);
	});
});
