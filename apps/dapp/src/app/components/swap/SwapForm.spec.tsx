import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SwapForm, type SwapFormProps } from './SwapForm';

/**
 * The reserve swap used to show an ellipsis for every figure it
 * could not read and "Loading spread" for ever once the reserve read had failed.
 */
const baseProps: SwapFormProps = {
	typedAmount: '',
	onAmountChange: () => undefined,
	tokens: [],
	selectedToken: undefined,
	onSelectToken: () => undefined,
	slippageBps: 50n,
	onSlippageChange: () => undefined,
	preview: undefined,
	minGoldOut: undefined,
	spreadPercent: undefined,
	redeemable: undefined,
	remainingToday: undefined,
	reserveLoading: false,
	oraclePrice: undefined,
	oracleIsStale: false,
	validationMessage: undefined,
};

afterEach(cleanup);

describe('SwapForm missing reserve and oracle values', () => {
	it('says the reserve read failed instead of an ellipsis or a spread that never loads', () => {
		const { container } = render(<SwapForm {...baseProps} reserveError />);
		const text = container.textContent ?? '';
		expect(text).toContain('Spread unavailable, retrying');
		expect(text).toContain('Reserve read failed, retrying');
		expect(text).not.toContain('Loading spread');
		expect(text).not.toContain('…');
	});

	it('says Loading while the reserve and the oracle are still being read', () => {
		const { container } = render(<SwapForm {...baseProps} reserveLoading oracleLoading />);
		const text = container.textContent ?? '';
		expect(text).toContain('Loading spread');
		expect(text).toContain('Loading');
	});

	it('says the oracle gave no price once its read has finished', () => {
		const { container } = render(<SwapForm {...baseProps} />);
		expect(container.textContent).toContain('No oracle price');
	});

	it('shows the spread once the reserve answers, whatever the loading flag says', () => {
		const { container } = render(<SwapForm {...baseProps} reserveLoading spreadPercent={0.5} />);
		expect(container.textContent).toMatch(/Current spread 0\.50%/);
	});
});

describe('SwapForm while the amount is being quoted', () => {
	// The amount-specific quote decides the tier; until it lands nothing is priced, rather
	// than a marginal-tier figure that drops when the quote arrives.
	it('says Quoting for the spread, the output and the minimum', () => {
		const { container } = render(<SwapForm {...baseProps} typedAmount="250000" quoting />);
		const text = container.textContent ?? '';
		expect(text.match(/Quoting…/g)).toHaveLength(3);
		expect(text).not.toContain('Enter an amount');
	});
});
