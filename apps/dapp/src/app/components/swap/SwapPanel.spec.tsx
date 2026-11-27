import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { Token } from '@goldstandard/models';
import { SwapPanel, comparableReserveOut, previewSpreadPpm } from './SwapPanel';

const PAXG = '0x45804880De22913dAFE09f4980848ECE6EcbAf78';
const XAUT = '0x68749665FF8D2d112Fa859AA293F07A622782F38';

const reserveAssets = vi.hoisted(() => ({ addresses: [] as string[] | undefined }));

vi.mock('@goldstandard/constants', async (importOriginal) => ({
	...(await importOriginal<typeof import('@goldstandard/constants')>()),
	getDexConfig: () => ({ poolFee: 3000 }),
	getStabilityReserveContractConfig: () => ({ address: '0x00000000000000000000000000000000000000ff', abi: [] }),
	getGusdAddress: () => '0x00000000000000000000000000000000000000bb',
}));

vi.mock('@goldstandard/hooks', async (importOriginal) => ({
	...(await importOriginal<typeof import('@goldstandard/hooks')>()),
	useReserveAssetTokens: (_chainId: number, tokens: readonly Token[]) =>
		reserveAssets.addresses === undefined
			? undefined
			: tokens.filter((token) => reserveAssets.addresses?.includes(token.address)),
	useStabilityReserve: () => ({ isDeployed: true, isLoading: false, isError: false }),
	useOraclePrice: () => ({ isDeployed: true, price8: undefined, isLive: false, isLoading: false, isError: false }),
	useReserveSwapSpread: () => ({ spreadPpm: undefined, status: 'idle' }),
	useDexQuote: () => ({ amountOut: undefined }),
}));

interface VenueProps {
	tokens: Token[];
	selectedToken: Token | undefined;
	onSelectToken: (token: Token) => void;
}

/** A stand-in venue that shows the tokens it was handed and lets the test pick one. */
function Venue({ testId, tokens, selectedToken, onSelectToken }: VenueProps & { testId: string }) {
	return (
		<div data-testid={testId} data-tokens={tokens.map((t) => t.symbol).join(',')} data-selected={selectedToken?.symbol ?? ''}>
			{tokens.map((token) => (
				<button key={token.address} type="button" onClick={() => onSelectToken(token)}>
					{`${testId} ${token.symbol}`}
				</button>
			))}
		</div>
	);
}

vi.mock('./MarketSwapPanel', () => ({ MarketSwapPanel: (props: VenueProps) => <Venue testId="market" {...props} /> }));
vi.mock('./ReserveSwapPanel', () => ({ ReserveSwapPanel: (props: VenueProps) => <Venue testId="reserve" {...props} /> }));
vi.mock('./VenueComparison', () => ({ VenueComparison: () => null }));

const openReserveTab = () => fireEvent.mouseDown(screen.getByRole('tab', { name: /Reserve swap/ }), { button: 0 });

describe('SwapPanel token lists', () => {
	beforeEach(() => {
		reserveAssets.addresses = [PAXG];
	});

	// A dormant XAUT is not a reserve asset; the market may still trade it on Uniswap.
	it('offers the market every gold token and the reserve only the assets it supports', () => {
		render(<SwapPanel chainId={1} />);
		expect(screen.getByTestId('market').dataset['tokens']).toBe('PAXG,XAUT');
		openReserveTab();
		expect(screen.getByTestId('reserve').dataset['tokens']).toBe('PAXG');
	});

	it('falls back to a reserve asset when the market selection is not one', () => {
		render(<SwapPanel chainId={1} />);
		fireEvent.click(screen.getByRole('button', { name: 'market XAUT' }));
		expect(screen.getByTestId('market').dataset['selected']).toBe('XAUT');
		openReserveTab();
		expect(screen.getByTestId('reserve').dataset['selected']).toBe('PAXG');
	});

	it('shows both once governance lists XAUT on the reserve', () => {
		reserveAssets.addresses = [PAXG, XAUT];
		render(<SwapPanel chainId={1} />);
		openReserveTab();
		expect(screen.getByTestId('reserve').dataset['tokens']).toBe('PAXG,XAUT');
	});
});

describe('comparableReserveOut', () => {
	const live = { goldOut: 2_500n, tooSmall: false, quoted: true, paused: false, remainingToday: 10_000n };

	it('offers the reserve when its quote is live, its asset open and the payout within today', () => {
		expect(comparableReserveOut(live)).toBe(2_500n);
		expect(comparableReserveOut({ ...live, remainingToday: 2_500n })).toBe(2_500n);
	});

	it('leaves the reserve out while its oracle quote is refused or only a fallback price', () => {
		expect(comparableReserveOut({ ...live, quoted: false })).toBeUndefined();
	});

	it('leaves the reserve out while the asset is paused, or before that is known', () => {
		expect(comparableReserveOut({ ...live, paused: true })).toBeUndefined();
		expect(comparableReserveOut({ ...live, paused: undefined })).toBeUndefined();
	});

	it('leaves the reserve out when the payout exceeds what it may pay today', () => {
		expect(comparableReserveOut({ ...live, remainingToday: 2_499n })).toBeUndefined();
		expect(comparableReserveOut({ ...live, remainingToday: undefined })).toBeUndefined();
	});

	it('leaves out an amount too small to pay any gold', () => {
		expect(comparableReserveOut({ ...live, goldOut: 0n, tooSmall: true })).toBeUndefined();
	});
});

describe('previewSpreadPpm', () => {
	const MARGINAL = 5_000n;

	it('previews at the spread quoted for this amount', () => {
		expect(previewSpreadPpm({ spreadPpm: 12_500n, status: 'quoted' }, MARGINAL)).toBe(12_500n);
	});

	// A swap that crosses a tier pays the dearer one: the marginal tier would show a higher
	// output and minimum that drop once the quote lands.
	it('previews nothing while the quote for this amount is in flight', () => {
		expect(previewSpreadPpm({ spreadPpm: undefined, status: 'quoting' }, MARGINAL)).toBeUndefined();
	});

	// The minimum then rides in the simulation, so an overstated preview is refused there.
	it('falls back to the marginal tier when the quote will not come', () => {
		expect(previewSpreadPpm({ spreadPpm: undefined, status: 'unavailable' }, MARGINAL)).toBe(MARGINAL);
	});
});
