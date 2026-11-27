import { type Address, isAddress } from 'viem';
import { contractAddressFromEnv, UNSET_ADDRESS } from './contractAddressEnv';
import { GUSD_ADDRESSES } from './goldVault';
import { TARGET_CHAIN_ID } from './targetChain';

const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

// The outside market for GSUSD: a Uniswap pool that pairs it with another token (USDC at
// launch). The dapp does not trade through that pool; it only links to it. A build names the
// paired token once such a pool exists:
//   VITE_GSUSD_MARKET_TOKEN=0x...   the token GSUSD is paired with (mainnet USDC
//                                   0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48)
// Without the variable the build shows no link, so a page never points at a market that is
// not there.
export const GSUSD_MARKET_TOKEN_VARIABLE = 'VITE_GSUSD_MARKET_TOKEN';

const MAINNET_CHAIN_ID = 1;
const UNISWAP_SWAP_URL = 'https://app.uniswap.org/swap';

const isSet = (address: string | undefined): address is Address =>
	address !== undefined && isAddress(address) && address.toLowerCase() !== UNSET_ADDRESS;

export interface GsusdMarket {
	chainId: number;
	/** The token paid in. */
	marketToken: string | undefined;
	gsusd: string | undefined;
}

/**
 * The Uniswap page that swaps the paired token for GSUSD, or undefined when the build has no
 * such market: off mainnet (the address names a chain in words Uniswap knows only for
 * mainnet here), or with either address missing or the two equal. Pure and exported for tests.
 */
export function gsusdBuyUrl({ chainId, marketToken, gsusd }: GsusdMarket): string | undefined {
	if (chainId !== MAINNET_CHAIN_ID || !isSet(marketToken) || !isSet(gsusd)) return undefined;
	if (marketToken.toLowerCase() === gsusd.toLowerCase()) return undefined;
	const query = new URLSearchParams({ chain: 'mainnet', inputCurrency: marketToken, outputCurrency: gsusd });
	return `${UNISWAP_SWAP_URL}?${query.toString()}`;
}

/** The link this build shows for buying GSUSD on the outside market, when it has one. */
export const GSUSD_BUY_URL: string | undefined = gsusdBuyUrl({
	chainId: TARGET_CHAIN_ID,
	marketToken: contractAddressFromEnv(viteEnv, GSUSD_MARKET_TOKEN_VARIABLE),
	gsusd: GUSD_ADDRESSES[TARGET_CHAIN_ID],
});
