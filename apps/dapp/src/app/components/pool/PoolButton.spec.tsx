import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { PoolButton } from './PoolButton';

const sim = vi.hoisted(() => ({ error: null as Error | null, simulated: [] as Array<{ hook: string; input: unknown }> }));

vi.mock('wagmi', () => ({ useChainId: () => 11155111 }));

vi.mock('@goldstandard/constants', async (importOriginal) => ({
	...(await importOriginal<typeof import('@goldstandard/constants')>()),
	getStabilityPoolContractConfig: () => ({ address: '0x00000000000000000000000000000000000000ee', abi: [] }),
}));

vi.mock('@goldstandard/hooks', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@goldstandard/hooks')>();
	const write = () => ({
		write: undefined,
		reset: () => undefined,
		isWritePending: false,
		confirmationStatus: 'pending' as const,
		isSimulationSuccess: false,
		isSimulationError: sim.error !== null,
		simulationError: sim.error,
		writeError: null,
		txHash: undefined,
	});
	return {
		...actual,
		useGsusdToken: () => actual.buildGsusdToken(11155111, '0x00000000000000000000000000000000000000bb'),
		useStabilityPoolDeposit: (_chain: unknown, amount: unknown) => {
			sim.simulated.push({ hook: 'deposit', input: amount });
			return write();
		},
		useStabilityPoolWithdraw: (_chain: unknown, amount: unknown) => {
			sim.simulated.push({ hook: 'withdraw', input: amount });
			return { ...write(), withdrawnAmount: undefined };
		},
		useStabilityPoolClaim: (_chain: unknown, _token: unknown, hasGain: unknown) => {
			sim.simulated.push({ hook: 'claim', input: hasGain });
			return { ...write(), claimedAmount: undefined };
		},
	};
});

// The guards need a wallet; what matters here is the button and the sentence beneath it.
vi.mock('../Guard', () => {
	const Pass = ({ children }: { children: ReactNode }) => children;
	return { Connection: Pass, Chain: Pass, TokenApproval: Pass, Ready: Pass };
});

vi.mock('./ReviewPoolDialog', () => ({
	ReviewPoolDialog: ({
		children,
		simulationError,
	}: {
		children: (props: { error: Error | null; isSuccess: boolean }) => ReactNode;
		simulationError: Error | null;
	}) => children({ error: simulationError, isSuccess: false }),
}));

vi.mock('@goldstandard/ui', async (importOriginal) => ({
	...(await importOriginal<typeof import('@goldstandard/ui')>()),
	DialogTrigger: ({ children }: { children: ReactNode }) => children,
}));

describe('PoolButton', () => {
	beforeEach(() => {
		sim.error = null;
		sim.simulated = [];
	});

	// The hooks for the other tabs used to run their simulations too.
	it('simulates only the active tab', () => {
		const gain = { token: '0x00000000000000000000000000000000000000a1', amount: 5n, symbol: 'PAXG', decimals: 18 } as never;
		// Every render asks each hook the same; what each was asked is the set of its inputs.
		const inputs = (hook: string) => [...new Set(sim.simulated.filter((call) => call.hook === hook).map((call) => call.input))];
		render(<PoolButton activeTab="deposit" amount="5" reviewAmount="5" selectedGain={gain} />);
		expect([inputs('deposit'), inputs('withdraw'), inputs('claim')]).toEqual([['5'], [undefined], [false]]);
		sim.simulated = [];
		render(<PoolButton activeTab="withdraw" amount="5" reviewAmount="5" selectedGain={gain} />);
		expect([inputs('deposit'), inputs('withdraw'), inputs('claim')]).toEqual([[undefined], ['5'], [false]]);
		sim.simulated = [];
		render(<PoolButton activeTab="claim" amount="" reviewAmount="" selectedGain={gain} />);
		expect([inputs('deposit'), inputs('withdraw'), inputs('claim')]).toEqual([[undefined], [undefined], [true]]);
	});

	it('says why the button is disabled when the simulation fails', () => {
		sim.error = new Error('Pool insufficient');
		render(<PoolButton activeTab="withdraw" amount="5" reviewAmount="5" selectedGain={undefined} />);
		expect((screen.getByRole('button', { name: 'Withdraw' }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole('alert').textContent).toBe('Pool insufficient');
	});

	it('shows nothing beneath the button while no amount is typed', () => {
		sim.error = new Error('Zero amount');
		render(<PoolButton activeTab="deposit" amount="" reviewAmount="" selectedGain={undefined} />);
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('shows nothing beneath an enabled button', () => {
		render(<PoolButton activeTab="deposit" amount="5" reviewAmount="5" selectedGain={undefined} />);
		expect(screen.queryByRole('alert')).toBeNull();
	});
});
