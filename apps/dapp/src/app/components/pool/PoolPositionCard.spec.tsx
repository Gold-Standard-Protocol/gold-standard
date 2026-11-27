import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoolPositionCard } from './PoolPositionCard';

/**
 * A deposit or pool total the chain did not return used to read as
 * 0.00 GSUSD, the same as an empty deposit.
 */
const pool = vi.hoisted(() => ({
	position: {
		isDeployed: true,
		isLoading: false,
		isError: false,
		paused: false,
		effectiveDeposit: undefined as bigint | undefined,
		totalDeposits: undefined as bigint | undefined,
		gains: undefined as { token: string; symbol: string; amount: bigint; decimals: number }[] | undefined,
	},
}));

vi.mock('wagmi', () => ({
	useAccount: () => ({ address: '0x00000000000000000000000000000000000000aa' }),
	useChainId: () => 11155111,
}));

vi.mock('@goldstandard/hooks', async (importOriginal) => ({
	...(await importOriginal<typeof import('@goldstandard/hooks')>()),
	useStabilityPoolPosition: () => pool.position,
}));

afterEach(cleanup);

describe('PoolPositionCard unread values', () => {
	it('says the read failed instead of showing 0.00 for the deposit, the total and the share', () => {
		pool.position = { ...pool.position, effectiveDeposit: undefined, totalDeposits: undefined, gains: undefined };
		const { container } = render(<PoolPositionCard />);
		expect(screen.getAllByText('Read failed, retrying').length).toBe(3);
		expect(container.textContent).not.toContain('0.00');
		expect(container.textContent).toContain('Gains could not be read, retrying.');
		expect(container.textContent).not.toContain('No liquidation collateral gains yet');
	});

	it('shows the figures once they are read', () => {
		pool.position = { ...pool.position, effectiveDeposit: 250n * 10n ** 18n, totalDeposits: 1_000n * 10n ** 18n, gains: [] };
		const { container } = render(<PoolPositionCard />);
		expect(container.textContent).toContain('250.00');
		expect(container.textContent).toContain('25.00%');
		expect(screen.queryByText('Read failed, retrying')).toBeNull();
	});
});
