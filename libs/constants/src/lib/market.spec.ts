import { gsusdBuyUrl } from './market';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const GSUSD = '0x24C3597eF975bdB565fd146f61438Ef14e15601D';
const ZERO = '0x0000000000000000000000000000000000000000';

describe('gsusdBuyUrl', () => {
	it('opens the Uniswap swap of the paired token for GSUSD on mainnet', () => {
		expect(gsusdBuyUrl({ chainId: 1, marketToken: USDC, gsusd: GSUSD })).toBe(
			`https://app.uniswap.org/swap?chain=mainnet&inputCurrency=${USDC}&outputCurrency=${GSUSD}`
		);
	});

	it.each([
		['the build is not for mainnet', { chainId: 11155111, marketToken: USDC, gsusd: GSUSD }],
		['no paired token is set', { chainId: 1, marketToken: undefined, gsusd: GSUSD }],
		['the paired token is the unset address', { chainId: 1, marketToken: ZERO, gsusd: GSUSD }],
		['the paired token is not an address', { chainId: 1, marketToken: '0x1234', gsusd: GSUSD }],
		['GSUSD is not deployed', { chainId: 1, marketToken: USDC, gsusd: ZERO }],
		['the paired token is GSUSD itself', { chainId: 1, marketToken: GSUSD, gsusd: GSUSD.toLowerCase() }],
	])('offers no link when %s', (_case, market) => {
		expect(gsusdBuyUrl(market)).toBeUndefined();
	});
});
