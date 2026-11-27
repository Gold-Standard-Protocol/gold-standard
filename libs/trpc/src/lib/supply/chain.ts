import { createPublicClient, http, parseAbi } from 'viem';
import type { Address } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { parseIndexerConfig } from '../indexer/config';
import type { SupplyReader } from './http';

const VAULT_ABI = parseAbi(['function stablecoin() view returns (address)']);
const TOKEN_ABI = parseAbi(['function totalSupply() view returns (uint256)']);

/**
 * A reader built from the indexer's own settings (endpoint, chain and vault), so the supply
 * paths need no variable of their own. The token address is asked of the vault once and
 * kept: the vault names its stablecoin at construction and cannot change it. Undefined when
 * those settings are incomplete, as on a machine that runs no indexer.
 */
export const createSupplyReader = (env: Record<string, string | undefined>): SupplyReader | undefined => {
  const parsed = parseIndexerConfig(env);
  if (!parsed.ok) return undefined;
  const { rpcUrl, chainId, goldVaultAddress } = parsed.config;
  const client = createPublicClient({ chain: chainId === 1 ? mainnet : sepolia, transport: http(rpcUrl) });
  let token: Address | undefined;
  return async () => {
    token ??= await client.readContract({ address: goldVaultAddress, abi: VAULT_ABI, functionName: 'stablecoin' });
    return client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'totalSupply' });
  };
};
