import { useCallback, useMemo, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { Card, CardContent, Tabs, TabsContent, TabsList, TabsTrigger } from '@goldstandard/ui';
import { Token } from '@goldstandard/models';
import {
	parseGsusdAmount,
	previewSwap,
	useDexQuote,
	useOraclePrice,
	useReserveAssetTokens,
	useReserveSwapSpread,
	useStabilityReserve,
	type ReserveSwapSpread,
} from '@goldstandard/hooks';
import {
	TOKEN_LIST,
	createTokenInstances,
	getDexConfig,
	getGusdAddress,
	getStabilityReserveContractConfig,
	type GoldVaultChainId,
} from '@goldstandard/constants';
import { MarketSwapPanel } from './MarketSwapPanel';
import { type SwapDirection } from './MarketSwapForm';
import { ReserveSwapPanel } from './ReserveSwapPanel';
import { VenueComparison } from './VenueComparison';

/** Market first and by default: the reserve is the floor, not the everyday exit. */
type SwapMode = 'market' | 'reserve';

interface SwapState {
	mode: SwapMode;
	direction: SwapDirection;
	typedAmount: string;
	selectedTokenAddress: string | undefined;
	slippageBps: bigint;
}

interface SwapPanelProps {
	chainId: GoldVaultChainId;
}

const MODES: { value: SwapMode; label: string; hint: string }[] = [
	{
		value: 'market',
		label: 'Market swap',
		hint: 'Trade GSUSD against tokenised gold on Uniswap v3, at the price the pool quotes. The pool fee is included in that quote.',
	},
	{
		value: 'reserve',
		label: 'Reserve swap (arbitrage)',
		hint: "The reserve is the protocol's price floor. It pays gold at the oracle price minus the current spread and is meant for arbitrage when GSUSD trades below par; when GSUSD is at par the market will usually pay more.",
	},
];

/**
 * The reserve's payout for the comparison line, or undefined when the reserve is not a real
 * option for this swap right now: the "better" mark steered
 * people to the reserve while its oracle quote was refused, its asset paused or the payout
 * beyond what it may pay out today, where its own button then stayed disabled. Pure and
 * exported for tests.
 */
export function comparableReserveOut(input: {
	goldOut: bigint | undefined;
	tooSmall: boolean;
	quoted: boolean;
	paused: boolean | undefined;
	remainingToday: bigint | undefined;
}): bigint | undefined {
	const { goldOut, tooSmall, quoted, paused, remainingToday } = input;
	if (goldOut === undefined || goldOut === 0n || tooSmall) return undefined;
	if (!quoted || paused !== false || remainingToday === undefined || goldOut > remainingToday) return undefined;
	return goldOut;
}

/**
 * The spread to preview a reserve swap at. The amount-specific quote wins; while it is in
 * flight nothing is previewed, because the marginal tier is cheaper than the one a large
 * swap pays and showed a higher output and minimum that then dropped.
 * When the quote will not come, the marginal tier is the best estimate left:
 * the minimum rides in the simulation, so an overstated preview is refused there, never paid.
 * Pure and exported for tests.
 */
export function previewSpreadPpm(quote: ReserveSwapSpread, marginalPpm: bigint | undefined): bigint | undefined {
	if (quote.status === 'quoting') return undefined;
	return quote.spreadPpm ?? marginalPpm;
}

/**
 * Hosts both swap venues behind one segmented control and owns the state they share
 * (amount, gold token, tolerance), so a figure typed on one tab carries to the other
 * and the comparison line can price the same GSUSD at both venues at once.
 */
export function SwapPanel({ chainId }: SwapPanelProps) {
	const dexConfig = getDexConfig(chainId);
	const reserveConfig = getStabilityReserveContractConfig(chainId);
	const gsusdAddress = getGusdAddress(chainId);

	const [state, setState] = useState<SwapState>({
		mode: dexConfig ? 'market' : 'reserve',
		direction: 'gsusd-to-gold',
		typedAmount: '',
		selectedTokenAddress: undefined,
		slippageBps: 50n,
	});

	const tokens = useMemo(() => {
		const instances = createTokenInstances(
			chainId,
			TOKEN_LIST.filter(token => token.gold)
		);
		return Object.values(instances);
	}, [chainId]);

	// The market may trade any gold token on Uniswap; the reserve pays out only the assets
	// it supports. On a PAXG-first deployment XAUT is not one, so it stays off the reserve
	// tab, and appears there with no dapp release once governance lists it.
	const reserveTokens = useReserveAssetTokens(chainId, tokens);
	const pick = (list: readonly Token[] | undefined): Token | undefined =>
		list?.find(token => token.address === state.selectedTokenAddress) ?? list?.[0];
	const selectedToken: Token | undefined = state.mode === 'reserve' ? pick(reserveTokens) : pick(tokens);

	// The Token model stores the address as a plain string; isAddress narrows
	// it without an unchecked assertion.
	const tokenAddress: Address | undefined =
		selectedToken && isAddress(selectedToken.address) ? selectedToken.address : undefined;
	// Reserve reads only for a token the reserve holds: a market selection it does not
	// support has no reserve price to compare against.
	const reserveTokenAddress: Address | undefined = reserveTokens?.some(token => token.address === tokenAddress)
		? tokenAddress
		: undefined;

	const reserve = useStabilityReserve(chainId, reserveTokenAddress);
	// The reserve prices a swap at getReservePrice: max(C, G) while PAXG sits inside the gold
	// band, refused outside it. Never the liquidation price.
	const oracle = useOraclePrice(chainId, reserveTokenAddress, 'reserve');

	// The comparison only makes sense for GSUSD in, gold out: that is the one trade
	// both venues can price. The reserve never buys GSUSD back.
	const gsusdIn = state.direction === 'gsusd-to-gold' ? parseGsusdAmount(state.typedAmount) : undefined;

	// A swap pays the tier of the coverage it leaves behind, so a large one can pay more
	// than the marginal spread; the amount-specific quote is the one to preview with.
	const swapQuote = useReserveSwapSpread(chainId, reserveTokenAddress, gsusdIn);
	const swapSpreadPpm = previewSpreadPpm(swapQuote, reserve.spreadPpm);
	const reservePreview =
		gsusdIn !== undefined &&
		swapSpreadPpm !== undefined &&
		oracle.price8 !== undefined &&
		selectedToken
			? previewSwap(gsusdIn, swapSpreadPpm, oracle.price8, selectedToken.decimals)
			: undefined;

	const marketQuote = useDexQuote(chainId, gsusdAddress, tokenAddress, gsusdIn, dexConfig?.poolFee);

	const handleModeChange = useCallback((value: string) => {
		const mode = value as SwapMode;
		setState(prev => {
			// A gold amount typed for a gold-to-GSUSD market swap is not a GSUSD amount;
			// reset rather than hand it to the reserve as if it were.
			if (mode === 'reserve' && prev.direction === 'gold-to-gsusd') {
				return { ...prev, mode, direction: 'gsusd-to-gold', typedAmount: '' };
			}
			return { ...prev, mode };
		});
	}, []);

	const handleDirectionChange = useCallback((direction: SwapDirection) => {
		setState(prev => (prev.direction === direction ? prev : { ...prev, direction, typedAmount: '' }));
	}, []);

	const handleAmountChange = useCallback((value: string) => {
		setState(prev => ({ ...prev, typedAmount: value }));
	}, []);

	const handleSelectToken = useCallback((token: Token) => {
		setState(prev => ({ ...prev, selectedTokenAddress: token.address }));
	}, []);

	const handleSlippageChange = useCallback((bps: bigint) => {
		setState(prev => ({ ...prev, slippageBps: bps }));
	}, []);

	const goldDecimals = selectedToken?.decimals ?? 18;
	const goldSymbol = selectedToken?.symbol ?? 'gold';
	const activeHint = MODES.find(mode => mode.value === state.mode)?.hint;

	const comparison =
		dexConfig && reserveConfig ? (
			<VenueComparison
				marketOut={marketQuote.amountOut}
				reserveOut={comparableReserveOut({
					goldOut: reservePreview?.goldOut,
					tooSmall: reservePreview?.tooSmall ?? false,
					quoted: oracle.quoted,
					paused: reserve.paused,
					remainingToday: reserve.remainingToday,
				})}
				decimals={goldDecimals}
				symbol={goldSymbol}
			/>
		) : null;

	const marketPanel = dexConfig ? (
		<MarketSwapPanel
			chainId={chainId}
			direction={state.direction}
			onDirectionChange={handleDirectionChange}
			typedAmount={state.typedAmount}
			onAmountChange={handleAmountChange}
			tokens={tokens}
			selectedToken={selectedToken}
			onSelectToken={handleSelectToken}
			slippageBps={state.slippageBps}
			onSlippageChange={handleSlippageChange}
		/>
	) : null;

	const reservePanel = reserveConfig ? (
		<ReserveSwapPanel
			chainId={chainId}
			typedAmount={state.typedAmount}
			onAmountChange={handleAmountChange}
			tokens={reserveTokens ?? []}
			selectedToken={selectedToken}
			onSelectToken={handleSelectToken}
			slippageBps={state.slippageBps}
			onSlippageChange={handleSlippageChange}
			reserve={reserve}
			oracle={oracle}
			preview={reservePreview}
			quoting={swapQuote.status === 'quoting'}
		/>
	) : null;

	// Only one venue deployed: no segmented control, just that venue and its note.
	if (!dexConfig || !reserveConfig) {
		const only = MODES.find(mode => mode.value === (dexConfig ? 'market' : 'reserve'));
		return (
			<Card>
				<CardContent className="flex flex-col gap-4 p-5 sm:p-6">
					{only ? (
						<p className="text-center text-xs leading-relaxed text-muted-foreground text-pretty">{only.hint}</p>
					) : null}
					{marketPanel ?? reservePanel}
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardContent className="flex flex-col gap-4 p-5 sm:p-6">
				<Tabs value={state.mode} onValueChange={handleModeChange} className="w-full">
					<TabsList className="grid w-full grid-cols-2" aria-label="Swap venue">
						{MODES.map(mode => (
							<TabsTrigger key={mode.value} value={mode.value}>
								{mode.label}
							</TabsTrigger>
						))}
					</TabsList>

					{activeHint ? (
						<p
							className="mt-4 text-center text-xs leading-relaxed text-muted-foreground text-pretty"
							aria-live="polite"
						>
							{activeHint}
						</p>
					) : null}

					{comparison ? <div className="mt-4">{comparison}</div> : null}

					<TabsContent value="market" className="mt-4">
						{marketPanel}
					</TabsContent>
					<TabsContent value="reserve" className="mt-4">
						{reservePanel}
					</TabsContent>
				</Tabs>
			</CardContent>
		</Card>
	);
}
