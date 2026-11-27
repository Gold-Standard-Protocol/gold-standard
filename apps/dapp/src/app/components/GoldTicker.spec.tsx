import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoldTicker } from './GoldTicker';

vi.mock('@goldstandard/hooks', async (importOriginal) => ({
	...(await importOriginal<typeof import('@goldstandard/hooks')>()),
	useGoldPrices: () => ({ paxg: 4000, xaut: 3990, isLoading: false, isError: false }),
	useCollateralParams: () => ({ minRatioPercent: 130, liquidationRatioPercent: 110 }),
}));

afterEach(cleanup);

/**
 * WCAG 2.2.2: the tape paused only on hover and focus, so a
 * touch reader had no way to stop it.
 */
describe('GoldTicker pause control', () => {
	it('pauses and resumes the tape from a button, naming the action each time', () => {
		const { container } = render(<GoldTicker />);
		const tape = container.querySelector('.ticker');
		expect(tape?.hasAttribute('data-paused')).toBe(false);

		fireEvent.click(screen.getByRole('button', { name: 'Pause the price tape' }));
		expect(tape?.hasAttribute('data-paused')).toBe(true);

		fireEvent.click(screen.getByRole('button', { name: 'Play the price tape' }));
		expect(tape?.hasAttribute('data-paused')).toBe(false);
	});
});
