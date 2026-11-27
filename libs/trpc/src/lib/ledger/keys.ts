import { KEY_NAMESPACE } from '../config/redisConfig';

export interface LedgerKeys {
  /** String: the JSON meta record. */
  meta: string;
  /** Hash: lowercase address to its compact account record. */
  accounts: string;
  /** Hash: token id to its liquidity position record. */
  positions: string;
}

/**
 * Keys scoped by namespace, chain and vault, like the owner index: deployments that share a
 * Redis, and a redeploy on the same chain, never read each other's state. Everything under
 * them is recomputable from the chain.
 */
export const ledgerKeys = (chainId: number, vault: string): LedgerKeys => {
  const scope = `${KEY_NAMESPACE}:ledger:v1:${chainId}:${vault.toLowerCase()}`;
  return {
    meta: `${scope}:meta`,
    accounts: `${scope}:accounts`,
    positions: `${scope}:positions`,
  };
};
