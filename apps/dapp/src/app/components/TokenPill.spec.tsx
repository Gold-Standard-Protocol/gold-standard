import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN_LIST } from '@goldstandard/constants';
import { TokenPill } from './TokenPill';

afterEach(cleanup);

describe('TokenPill', () => {
	it.each(TOKEN_LIST.map((token) => [token.symbol, token.image] as const))('shows the mark of %s beside its symbol', (symbol, image) => {
		const { container } = render(<TokenPill symbol={symbol} />);
		expect(screen.getByText(symbol)).toBeTruthy();
		expect(container.querySelector('img')?.getAttribute('src')).toBe(image);
	});

	it('matches the symbol whatever its case, since the chain reports XAUt', () => {
		const { container } = render(<TokenPill symbol="xaut" />);
		expect(container.querySelector('img')).not.toBeNull();
	});

	it('keeps the mark out of the accessible name, which the symbol already gives', () => {
		const { container } = render(<TokenPill symbol="GSUSD" />);
		expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
		expect(container.textContent).toBe('GSUSD');
	});

	it('shows the symbol alone for a token it has no mark for', () => {
		const { container } = render(<TokenPill symbol="WETH" />);
		expect(container.querySelector('img')).toBeNull();
		expect(container.textContent).toBe('WETH');
	});
});
