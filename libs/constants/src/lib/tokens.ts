import { ChainId, Token } from '@goldstandard/models';

import { Address, isAddress } from 'viem';

import { MAINNET_PAXG_ADDRESS, MAINNET_XAUT_ADDRESS } from './mainnetTokens';
import { TARGET_CHAIN_ID } from './targetChain';

// Vite injects `import.meta.env` at build time; read it through a locally-typed
// accessor exactly as goldVault.ts does, so this file type-checks in consumers
// that lack vite/client ambient types.
const viteEnv =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

// Collateral token addresses were previously HARDCODED while every protocol
// contract address came from VITE_* env. That inconsistency meant a testnet
// deployment wired its contracts correctly but still pointed at a stale PAXG,
// had no XAUT entry at all, and left GSUSD at the zero address — so balances
// silently read 0 and the token picker looked broken. They are env-driven now,
// falling back to the real mainnet addresses.
// IMPORTANT: this list is consumed on BOTH sides. The dapp builds its token
// list from it directly (it no longer waits on the
// API), and the API still serves it over `trpc.tokensRouter.getAll`.
// `import.meta.env` only exists under Vite, so a browser-only lookup silently
// fell back to the stale hardcoded address on the server and the dapp showed a
// zero balance for a token it had never actually queried. Read both.
// A value that is not an address (a truncated paste, a mixed-case typo that
// breaks the EIP-55 checksum) is refused and reported once, so the token is
// left out instead of every balance read and approval targeting a contract
// that is not there.
const reportedInvalidEnv = new Set<string>();
const envAddress = (key: string): Address | undefined => {
  const fromVite = viteEnv[key];
  const fromNode =
    typeof process !== 'undefined' ? process.env?.[key] : undefined;
  const value = (fromVite ?? fromNode)?.trim();
  if (!value) return undefined;
  if (isAddress(value)) return value;
  if (!reportedInvalidEnv.has(key)) {
    reportedInvalidEnv.add(key);
    console.error(`${key} is not a valid address ("${value}"); the token is left out of the list.`);
  }
  return undefined;
};

// Define Token Information Type
export interface TokenInfo {
  name: string;
  image: string;
  symbol: string;
  addresses: Partial<Record<ChainId, Address>>;
  decimals: number;
  gold: boolean;
  priceApiId: string;
}

const SEPOLIA_PAXG = envAddress('VITE_PAXG_ADDRESS');

export const TOKEN_LIST: TokenInfo[] = [
  {
    name: 'Paxos Gold',
    image: '/images/paxg.png',
    symbol: 'PAXG',
    addresses: {
      [ChainId.MAINNET]: MAINNET_PAXG_ADDRESS,
      // Sepolia PAXG is a mock that changes with every deployment, so there is
      // no fallback: a hard-coded one went stale and pointed the picker, the
      // balance and the approval at a token the current vault does not list.
      // Without the variable PAXG is not listed on
      // Sepolia. scripts/print-service-env.ts prints it from the snapshot.
      ...(SEPOLIA_PAXG ? { [ChainId.SEPOLIA]: SEPOLIA_PAXG } : {}),
    },
    decimals: 18,
    gold: true,
    priceApiId: 'pax-gold',
  },
  {
    name: 'Tether Gold',
    image: '/images/xaut.png',
    symbol: 'XAUT',
    addresses: {
      [ChainId.MAINNET]: MAINNET_XAUT_ADDRESS,
      // Sepolia has no real XAUT; a dry-run deployment supplies its own mock.
      ...(envAddress('VITE_XAUT_ADDRESS')
        ? { [ChainId.SEPOLIA]: envAddress('VITE_XAUT_ADDRESS') as Address }
        : {}),
    },
    decimals: 6,
    gold: true,
    priceApiId: 'tether-gold',
  },
  {
    name: 'Gold Standard Dollar',
    image: '/images/gsusd.svg',
    symbol: 'GSUSD',
    addresses: {
      // Same GSUSD address the vault hooks use, so balances resolve instead of
      // reading the zero address and always reporting 0.
      [TARGET_CHAIN_ID]:
        envAddress('VITE_GUSD_ADDRESS') ??
        '0x0000000000000000000000000000000000000000',
    },
    decimals: 18,
    gold: false,
    priceApiId: 'gold-standard-usd',
  },
];

/**
 * Per-symbol address overrides for the CURRENT target chain, read from env at
 * call time.
 *
 * These are applied here rather than baked into TOKEN_LIST because the list is
 * a module-level constant served by the API (`trpc.tokensRouter.getAll`) and
 * evaluated at import — before dotenv has populated `process.env` — so a
 * constant-time lookup silently kept the stale hardcoded address. Resolving
 * lazily on the client, which is the side that actually knows its target
 * chain and has the VITE_* values, is both correct and order-independent.
 */
function addressOverride(symbol: string, chainId: ChainId): Address | undefined {
  if (chainId !== TARGET_CHAIN_ID) return undefined;
  switch (symbol) {
    case 'PAXG':
      return envAddress('VITE_PAXG_ADDRESS');
    case 'XAUT':
      return envAddress('VITE_XAUT_ADDRESS');
    case 'GSUSD':
      return envAddress('VITE_GUSD_ADDRESS');
    default:
      return undefined;
  }
}

/**
 * The token-list entry whose address on `chainId` is `address`, if any.
 *
 * Vault positions, liquidation rows and the activity feed all carry a raw collateral
 * address and need its decimals and symbol. PAXG carries 18 decimals and XAUT 6, so a
 * guess puts every parsed, previewed or displayed amount out by a factor of 1e12.
 * Callers that get `undefined` back must treat the decimals as unknown, not as 18.
 *
 * The zero address is never a token: an empty vault reports it as its collateral, and
 * GSUSD falls back to it before VITE_GUSD_ADDRESS is set, so without this guard an empty
 * vault would resolve to "GSUSD".
 */
export function findTokenInfoByAddress(
  address: string | undefined,
  chainId: ChainId = TARGET_CHAIN_ID
): TokenInfo | undefined {
  if (!address) return undefined;
  const wanted = address.toLowerCase();
  if (wanted === '0x0000000000000000000000000000000000000000') return undefined;
  return TOKEN_LIST.find(
    (t) =>
      (addressOverride(t.symbol, chainId) ?? t.addresses[chainId])?.toLowerCase() ===
      wanted
  );
}

export function createTokenInstances(
  chainId: ChainId,
  tokens: TokenInfo[] = []
): Record<string, Token> {
  return tokens
    .map((t) => {
      const address = addressOverride(t.symbol, chainId) ?? t.addresses[chainId];
      if (!address) {
        // Token is not supported on this chain
        return null;
      }
      return new Token({
        chainId: chainId,
        address: address,
        decimals: t.decimals,
        image: t.image,
        gold: t.gold,
        priceApiId: t.priceApiId,
        symbol: t.symbol,
        name: t.name,
      });
    })
    .filter((token): token is Token => token !== null)
    .reduce((acc, token) => {
      acc[token.address] = token;
      return acc;
    }, {} as Record<string, Token>);
}
