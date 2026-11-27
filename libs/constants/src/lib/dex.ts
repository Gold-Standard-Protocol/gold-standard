import { type Address } from 'viem';
import { ChainId } from '@goldstandard/models';
import { uniswapQuoterV2Abi } from './abis/UniswapQuoterV2';
import { uniswapSwapRouter02Abi } from './abis/UniswapSwapRouter02';
import { contractAddressFromEnv } from './contractAddressEnv';
import { TARGET_CHAIN_ID, type TargetChainId } from './targetChain';

// Vite injects `import.meta.env` at build time. Read it through a locally-typed accessor so that
// consumers which compile this file type-check without needing vite/client ambient types in their
// own tsconfig (and without a triple-slash reference, which the lint config disallows).
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

// The DEX leg of the swap page: GSUSD against tokenised gold on Uniswap v3. The protocol
// earns fees through its own liquidity positions on these pools, so the market swap is
// the everyday route and the stability reserve stays the arbitrage floor.
//
// Dapp env (apps/dapp/.env.local), per target chain. Mainnet addresses differ from Sepolia:
//   VITE_UNISWAP_QUOTER=0x...            QuoterV2          (Sepolia 0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3)
//   VITE_UNISWAP_ROUTER=0x...            SwapRouter02      (Sepolia 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E)
//   VITE_DEX_POOL_FEE=3000               fee tier in hundredths of a bip: 100, 500, 3000 or 10000
//
// Script-only env (contracts/scripts/seed-testnet-dex.ts), not read by the dapp:
//   UNISWAP_FACTORY, UNISWAP_POSITION_MANAGER, UNISWAP_QUOTER, LP_PRIVATE_KEY, PAXG_LP
export const UNISWAP_QUOTER_ADDRESSES: Partial<Record<ChainId, Address>> = {
	[TARGET_CHAIN_ID]: contractAddressFromEnv(viteEnv, 'VITE_UNISWAP_QUOTER'),
} as const;

export const UNISWAP_ROUTER_ADDRESSES: Partial<Record<ChainId, Address>> = {
	[TARGET_CHAIN_ID]: contractAddressFromEnv(viteEnv, 'VITE_UNISWAP_ROUTER'),
} as const;

/** The 0.30% tier: the default for a stable-to-gold pair with modest volume. */
export const DEFAULT_DEX_POOL_FEE = 3000;

/** The fee tiers Uniswap v3 factories enable out of the box. */
const KNOWN_POOL_FEES = [100, 500, 3000, 10000] as const;

/**
 * Parses VITE_DEX_POOL_FEE into a fee tier. Anything that is not one of the standard
 * tiers falls back to 0.30% with a warning rather than quoting against a pool that
 * cannot exist. Pure and exported for tests.
 */
export function parseDexPoolFee(raw: string | undefined): number {
	const trimmed = raw?.trim() ?? '';
	if (trimmed === '') return DEFAULT_DEX_POOL_FEE;
	const parsed = Number(trimmed);
	if ((KNOWN_POOL_FEES as readonly number[]).includes(parsed)) return parsed;
	console.warn(
		`Unrecognised VITE_DEX_POOL_FEE "${raw}"; defaulting to ${DEFAULT_DEX_POOL_FEE} (0.30%).`
	);
	return DEFAULT_DEX_POOL_FEE;
}

/** The pool fee tier this build quotes and swaps through, baked in at build time. */
export const DEX_POOL_FEE: number = parseDexPoolFee(viteEnv['VITE_DEX_POOL_FEE']);

export interface DexConfig {
	quoter: { readonly address: Address; readonly abi: typeof uniswapQuoterV2Abi };
	router: { readonly address: Address; readonly abi: typeof uniswapSwapRouter02Abi };
	/** Fee tier in hundredths of a bip (3000 = 0.30%). */
	poolFee: number;
}

// Treats the zero-address env fallback as "not configured", exactly as goldVault.ts does.
const configuredAddress = (address: Address | undefined): Address | undefined =>
	!address || address === '0x0000000000000000000000000000000000000000' ? undefined : address;

/**
 * The Uniswap v3 quoter and router for a chain. Returns undefined until BOTH
 * VITE_UNISWAP_QUOTER and VITE_UNISWAP_ROUTER are real deployments, which is the
 * app-wide switch for the DEX leg: with no config the swap page shows the reserve alone.
 */
export const getDexConfig = (chainId: TargetChainId | undefined): DexConfig | undefined => {
	if (!chainId) return;
	const quoter = configuredAddress(UNISWAP_QUOTER_ADDRESSES[chainId]);
	const router = configuredAddress(UNISWAP_ROUTER_ADDRESSES[chainId]);
	if (!quoter || !router) return;
	return {
		quoter: { address: quoter, abi: uniswapQuoterV2Abi },
		router: { address: router, abi: uniswapSwapRouter02Abi },
		poolFee: DEX_POOL_FEE,
	};
};
