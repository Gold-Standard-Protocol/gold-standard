// The canonical mainnet gold tokens, in one place. This file imports nothing, so
// apps/dapp/vite.config.mts can load it by relative path (Vite's config loader does not apply
// the @goldstandard/* path aliases): the token list in tokens.ts and the build guard in
// buildEnv.ts read the same two addresses.

/** Paxos Gold (PAXG) on Ethereum mainnet. */
export const MAINNET_PAXG_ADDRESS = '0x45804880De22913dAFE09f4980848ECE6EcbAf78';

/** Tether Gold (XAUT) on Ethereum mainnet. */
export const MAINNET_XAUT_ADDRESS = '0x68749665FF8D2d112Fa859AA293F07A622782F38';
