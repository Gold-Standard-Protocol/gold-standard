import { useMemo } from 'react';
import { type Address } from 'viem';
import { getGusdAddress, type GoldVaultChainId } from '@goldstandard/constants';
import { Token } from '@goldstandard/models';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Builds the GSUSD Token instance for a chain. Returns undefined when the
 * address is unset or still the zero-address env fallback, so consumers can
 * gate approval flows on a real deployment. Pure function, exported for tests.
 */
export function buildGsusdToken(
  chainId: GoldVaultChainId | undefined,
  address: Address | undefined
): Token | undefined {
  if (!chainId || !address || address === ZERO_ADDRESS) return undefined;
  return new Token({
    chainId,
    address,
    decimals: 18,
    image: '/images/gsusd.svg',
    gold: false,
    priceApiId: 'gold-standard-usd',
    symbol: 'GSUSD',
    name: 'Gold Standard Dollar',
  });
}

/**
 * Shared GSUSD Token for approval flows (stability pool deposits and
 * redemptions both spend GSUSD). Undefined until the token is deployed.
 */
export function useGsusdToken(
  chainId: GoldVaultChainId | undefined
): Token | undefined {
  return useMemo(
    () => buildGsusdToken(chainId, getGusdAddress(chainId)),
    [chainId]
  );
}
