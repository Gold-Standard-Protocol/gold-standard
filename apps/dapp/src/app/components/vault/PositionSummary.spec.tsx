import { render, screen } from '@testing-library/react';
import { PositionSummary } from './PositionSummary';

const RATIOS = { minRatio: 130, liquidationRatio: 110 };
const GSUSD = 10n ** 18n;

const summary = (overrides: { isValid: boolean; errorMessage?: string; note?: string }) => (
	<PositionSummary
		ratios={RATIOS}
		currentRatioPercent={117.6}
		newRatioPercent={123.5}
		currentLiquidationPrice={3740}
		newLiquidationPrice={3561.9}
		currentDebt={3400n * GSUSD}
		newDebt={3400n * GSUSD}
		{...overrides}
	/>
);

describe('PositionSummary', () => {
	it('shows the reason an action would fail', () => {
		render(summary({ isValid: false, errorMessage: 'Ratio would drop below 130%' }));
		expect(screen.getByText('Ratio would drop below 130%').className).toContain('text-danger');
	});

	// A deposit into an unhealthy vault is allowed; the remark is information, not a refusal.
	it('shows a remark on an action that will go through, and not as an error', () => {
		const note = 'Still below the 130% minimum. Minting and withdrawing stay locked.';
		render(summary({ isValid: true, note }));
		expect(screen.getByText(note).className).not.toContain('text-danger');
	});

	it('shows neither line for a plain valid action', () => {
		const { container } = render(summary({ isValid: true }));
		expect(container.textContent).not.toMatch(/Ratio would drop|Still below/);
	});
});
