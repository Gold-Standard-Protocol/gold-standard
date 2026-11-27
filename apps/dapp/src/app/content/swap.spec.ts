import { describe, expect, it } from 'vitest';
import { swapPageCopy } from './swap';

const everyWord = (copy: ReturnType<typeof swapPageCopy>): string => [copy.title, copy.lead, ...copy.points.flatMap((point) => [point.title, point.detail])].join(' ');

describe('swap page copy', () => {
	describe('with the reserve alone (no market venue in the build)', () => {
		const copy = swapPageCopy(false);

		it('describes one swap, GSUSD for gold through the reserve', () => {
			expect(copy.title).toBe('Swap GSUSD for gold');
			expect(copy.lead).toContain('Gold Stability Reserve');
			expect(copy.points.map((point) => point.title)).toEqual(['The reserve pays gold for GSUSD', 'A floor, not an exit', 'No vault is ever touched']);
		});

		it('names no market route, venue or second direction the page does not offer', () => {
			expect(everyWord(copy)).not.toMatch(/uniswap|market swap|open market|either direction|pooled liquidity|gold to GSUSD|gold for GSUSD and/i);
		});

		it('keeps the figures of the reserve: a spread from 0.5% to 5% and a daily capacity', () => {
			expect(everyWord(copy)).toContain('starts at 0.5%');
			expect(everyWord(copy)).toContain('never above 5%');
			expect(everyWord(copy)).toContain('capacity for the day');
		});
	});

	describe('with a market venue in the build', () => {
		const copy = swapPageCopy(true);

		it('describes both routes, the market first', () => {
			expect(copy.title).toBe('Swap GSUSD and gold');
			expect(copy.lead).toContain('Uniswap v3');
			expect(copy.points.map((point) => point.title)).toEqual(['Market swap: the everyday route', 'The reserve holds the floor', 'No vault is ever touched']);
		});
	});

	it('numbers its points in order and uses no contraction, dash or exclamation mark', () => {
		for (const hasMarket of [true, false]) {
			const copy = swapPageCopy(hasMarket);
			expect(copy.points.map((point) => point.numeral)).toEqual(['01', '02', '03']);
			expect(everyWord(copy)).not.toMatch(/n['’]t\b|[—–]|\s-\s|!/);
		}
	});
});
