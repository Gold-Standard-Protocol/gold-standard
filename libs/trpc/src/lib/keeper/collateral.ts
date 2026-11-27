import { encodePacked, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';
import { goldVaultKeeperAbi } from './abis';
import type { KeeperConfig } from './config';
import { expectBoolean, expectTuple } from './decode';
import type { KeeperReadClient } from './ports';

/**
 * Collateral id for a token, matching GoldVault._collateralId
 * (keccak256(abi.encodePacked(token))) and the dapp-side derivation in
 * libs/hooks useProtocolStats.
 */
export const collateralIdForToken = (token: Address): Hex =>
  keccak256(encodePacked(['address'], [token]));

/**
 * True when the token is an active GoldVault collateral type. XAUT on a PAXG-first
 * deployment is registered at the oracle on a dormant feed but is no collateral type,
 * so no vault can hold it and nothing about its price is worth an alert or a poke.
 * The vault never deactivates a type once added. A failed read throws, so the caller's
 * per-token error report says so rather than the token vanishing from view.
 */
export const isActiveCollateral = async (
  read: KeeperReadClient,
  config: Pick<KeeperConfig, 'goldVaultAddress'>,
  token: Address
): Promise<boolean> => {
  const tuple = expectTuple(
    await read.readContract({
      address: config.goldVaultAddress,
      abi: goldVaultKeeperAbi,
      functionName: 'collateralTypes',
      args: [collateralIdForToken(token)],
    }),
    7,
    'collateralTypes'
  );
  return expectBoolean(tuple[6], 'collateralTypes.active');
};

/** The configured collateral tokens: PAXG, and XAUT once XAUT_TOKEN is set. */
export const configuredTokens = (config: Pick<KeeperConfig, 'paxgToken' | 'xautToken'>): Address[] => [
  config.paxgToken,
  ...(config.xautToken !== undefined ? [config.xautToken] : []),
];
