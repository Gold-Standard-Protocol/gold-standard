import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OUTSIDE_MARKET_COPY } from '../../content/swap';
import { OutsideMarketLink } from './OutsideMarketLink';

vi.mock('@goldstandard/constants', () => ({ GSUSD_BUY_URL: undefined }));
vi.mock('@goldstandard/ui', () => ({
  Card: ({ children, ...props }: { children: React.ReactNode }) => <div {...props}>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const URL = 'https://app.uniswap.org/swap?chain=mainnet&inputCurrency=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&outputCurrency=0x24C3597eF975bdB565fd146f61438Ef14e15601D';

afterEach(cleanup);

describe('OutsideMarketLink', () => {
  it('links to the market in a new tab, with no opener and no referrer', () => {
    render(<OutsideMarketLink href={URL} />);
    const link = screen.getByRole('link', { name: 'Buy GSUSD on Uniswap (opens in a new tab)' });
    expect(link.getAttribute('href')).toBe(URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.className).toContain('min-h-11');
  });

  it('renders nothing in a build that names no market', () => {
    const { container } = render(<OutsideMarketLink />);
    expect(container.innerHTML).toBe('');
  });

  it('promises no price, peg, yield or liquidity reward', () => {
    const words = Object.values(OUTSIDE_MARKET_COPY).join(' ');
    expect(words).not.toMatch(/\$1|peg|par\b|guarante|yield|earn|reward|APR|APY|provide liquidity|best price/i);
    expect(words).not.toMatch(/[—–]/);
  });
});
