import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { Token } from '@goldstandard/models';
import { CollateralStrip } from './CollateralStrip';

const active = vi.hoisted(() => ({ tokens: undefined as Record<string, Token> | undefined }));

vi.mock('@goldstandard/hooks', () => ({
	useGoldPrices: () => ({ paxg: 4000, xaut: 3990, isLoading: false, isError: false }),
	useActiveCollateralTokens: () => active.tokens,
}));

vi.mock('../components/Reveal', () => ({
	Reveal: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div>,
}));

const token = (symbol: string) => ({ address: `0x${symbol}`, symbol }) as unknown as Token;

describe('CollateralStrip', () => {
	// A PAXG-first deployment registers XAUT in the oracle only: it is not accepted.
	it('shows only the collateral the vault accepts once the vault has answered', () => {
		active.tokens = { PAXG: token('PAXG') };
		render(<CollateralStrip />);
		expect(screen.getByRole('heading', { name: 'Paxos Gold' })).toBeTruthy();
		expect(screen.queryByRole('heading', { name: 'Tether Gold' })).toBeNull();
	});

	it('shows Tether Gold once governance activates it', () => {
		active.tokens = { PAXG: token('PAXG'), XAUT: token('XAUT') };
		render(<CollateralStrip />);
		expect(screen.getByRole('heading', { name: 'Tether Gold' })).toBeTruthy();
	});
});
