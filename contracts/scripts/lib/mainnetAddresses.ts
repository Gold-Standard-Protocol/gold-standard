/**
 * The Ethereum mainnet inventory the launch tooling checks against and prints: the two
 * collateral tokens, the two Chainlink feeds (docs/ORACLES.md section 1, RPC-confirmed) and
 * Uniswap v3's router and quoter for the dapp's market swap. docs/LAUNCH.md step 3.2 carries
 * the same values with the reasoning; this file is what the scripts read.
 */
export const MAINNET_CHAIN_ID = 1;
export const SEPOLIA_CHAIN_ID = 11155111;

export interface KnownAddresses {
  paxgToken: string;
  xautToken: string;
  /**
   * Chainlink PAXG/USD, PAXG_FEED in the launch environment (source C). Wherever the preflight meets it, it must still describe
   * itself as "PAXG / USD".
   */
  paxgUsdFeed: string;
  /**
   * XAU/USD spot, the oracle's cross-feed anchor and the gold reference. Mandatory on mainnet,
   * and never a token's market price: XAUT_FEED and both confirmation feeds must differ
   * from it.
   */
  anchorFeed: string;
}

export const MAINNET: KnownAddresses = {
  paxgToken: "0x45804880De22913dAFE09f4980848ECE6EcbAf78",
  xautToken: "0x68749665FF8D2d112Fa859AA293F07A622782F38",
  paxgUsdFeed: "0x9944D86CEB9160aF5C5feB251FD671923323f8C3",
  anchorFeed: "0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6",
};

export interface UniswapAddresses {
  /** SwapRouter02 */
  router: string;
  /** QuoterV2 */
  quoter: string;
  /** The NonfungiblePositionManager, which holds the pool positions the Usage Ledger records. */
  positionManager: string;
}

/**
 * Uniswap v3 per chain, as the dapp's VITE_UNISWAP_ROUTER and VITE_UNISWAP_QUOTER and the
 * API's LEDGER_LIQUIDITY_POSITION_MANAGER. From Uniswap's published v3 deployment addresses.
 */
export const UNISWAP: Record<number, UniswapAddresses> = {
  [MAINNET_CHAIN_ID]: {
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  },
  [SEPOLIA_CHAIN_ID]: {
    router: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    quoter: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
    positionManager: "0x1238536071E1c677A632429e3655c799b22cDA52",
  },
};

export const CHAIN_NAMES: Record<number, string> = {
  [MAINNET_CHAIN_ID]: "mainnet",
  [SEPOLIA_CHAIN_ID]: "sepolia",
};
