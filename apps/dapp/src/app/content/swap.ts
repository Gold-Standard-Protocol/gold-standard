/**
 * The words above the swap panel. They follow what the build offers: a build with a market
 * venue (a Uniswap router and quoter in its environment) has two routes, and a build
 * without one, the mainnet launch build among them, has the reserve swap alone. The page
 * must not describe a route its visitor cannot take.
 */

export interface SwapPoint {
	numeral: string;
	title: string;
	detail: string;
}

export interface SwapPageCopy {
	title: string;
	lead: string;
	points: SwapPoint[];
}

const RESERVE_PRICE =
	'The Gold Stability Reserve pays gold at the oracle price minus a spread that starts at 0.5% and rises as coverage falls, never above 5%. It exists so that anyone can buy GSUSD below par and swap it for gold here, which pulls the market back to par.';

const NOT_AN_EXIT =
	'not to be the exit for freshly minted GSUSD: minting against gold and draining the reserve with it would leave nothing for the arbitrage that keeps the peg.';

const VAULTS_UNTOUCHED = 'Borrowers keep every gram of their collateral: the only thing that can move a vault is its owner, or a liquidation below the threshold.';

const WITH_MARKET: SwapPageCopy = {
	title: 'Swap GSUSD and gold',
	lead: 'Trade GSUSD against tokenised gold on the open market through Uniswap v3. The Gold Stability Reserve sits alongside as the arbitrage floor that holds the peg.',
	points: [
		{
			numeral: '01',
			title: 'Market swap: the everyday route',
			detail:
				'GSUSD trades against PAXG on Uniswap v3, in either direction, at whatever the pool will pay. XAUT joins once governance activates it and a pool exists. The pool fee goes to whoever provides liquidity at the traded price, and the protocol earns a share only through liquidity positions it owns.',
		},
		{
			numeral: '02',
			title: 'The reserve holds the floor',
			detail: `${RESERVE_PRICE} At par the market will usually pay more. The reserve is sized to hold that floor, ${NOT_AN_EXIT}`,
		},
		{
			numeral: '03',
			title: 'No vault is ever touched',
			detail: `A market swap trades against pooled liquidity. A reserve swap draws only on protocol-owned gold, up to its available capacity for the day. ${VAULTS_UNTOUCHED}`,
		},
	],
};

const RESERVE_ONLY: SwapPageCopy = {
	title: 'Swap GSUSD for gold',
	lead: 'Swap GSUSD for protocol-owned gold through the Gold Stability Reserve, at the oracle price minus a spread. The reserve is the floor that holds the peg.',
	points: [
		{
			numeral: '01',
			title: 'The reserve pays gold for GSUSD',
			detail: RESERVE_PRICE,
		},
		{
			numeral: '02',
			title: 'A floor, not an exit',
			detail: `The reserve is sized to hold that floor, ${NOT_AN_EXIT} A swap draws only on protocol-owned gold, up to the reserve's available capacity for the day.`,
		},
		{
			numeral: '03',
			title: 'No vault is ever touched',
			detail: `A reserve swap never draws on a borrower's collateral. ${VAULTS_UNTOUCHED}`,
		},
	],
};

/** The page's words for a build with a market venue, or with the reserve alone. */
export const swapPageCopy = (hasMarket: boolean): SwapPageCopy => (hasMarket ? WITH_MARKET : RESERVE_ONLY);

/**
 * The words beside the link to the outside market, shown only in a build that names one
 * (VITE_GSUSD_MARKET_TOKEN). They say where the link goes and that the price there is the
 * market's own; they promise no price.
 */
export const OUTSIDE_MARKET_COPY = {
	title: 'Buying GSUSD',
	detail:
		'GSUSD also trades on Uniswap v3, outside this site. The price there is set by that market and its liquidity, not by the protocol. Check the token address on the Uniswap page against the one this site lists before you swap.',
	link: 'Buy GSUSD on Uniswap',
	newTab: '(opens in a new tab)',
} as const;
