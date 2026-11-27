import { useMemo } from 'react';
import { createTokenInstances, TOKEN_LIST } from '@goldstandard/constants';
import { ChainId, Token } from '@goldstandard/models';

export type Maybe<T> = T | null | undefined;

/**
 * The tokens the dapp knows on a chain, keyed by address, built from the TOKEN_LIST
 * bundled with the dapp.
 *
 * The list used to come from the API over tRPC. In production the dapp is a static build
 * on IPFS and a mirror while the API is a separate server, so with the API down or blocked
 * every balance read as 0.00, the deposit picker was empty and Max did nothing. Addresses
 * and decimals are pinned in the bundle, which is the same list the API serves. The
 * `{ data }` shape is kept so callers read it as before, and the record is
 * stable per chain so effects keyed on it do not re-run every render.
 */
export function useAllTokens(chainId: ChainId): { data: Record<string, Token> } {
  const data = useMemo(() => createTokenInstances(chainId, TOKEN_LIST), [chainId]);
  return { data };
}

/** The gold tokens from the bundled list on a chain, keyed by address. */
export function useAllGoldTokens(chainId: ChainId): { data: Record<string, Token> } {
  const { data: all } = useAllTokens(chainId);
  const data = useMemo(
    () => Object.fromEntries(Object.entries(all).filter(([, token]) => token.gold)),
    [all]
  );
  return { data };
}

export function useToken(
  chainId: ChainId,
  tokenId: Maybe<string>
): Token | undefined {
  const { data } = useAllTokens(chainId);
  return tokenId ? data[tokenId] : undefined;
}
