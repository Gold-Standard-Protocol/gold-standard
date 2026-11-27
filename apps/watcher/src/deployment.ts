import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';

import { CONTRACT_KEYS } from './rules';
import type { ContractKey } from './rules';

export interface Deployment {
  chainId: number;
  addresses: Readonly<Record<ContractKey, Address>>;
}

/**
 * Reads the addresses from a deployment snapshot (contracts/deployments/<network>.json), so
 * none is retyped. Throws when the snapshot lacks a chain id or any contract the rules name.
 */
export const parseDeployment = (json: string): Deployment => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('the deployment snapshot is not JSON');
  }
  const snapshot = parsed as { chainId?: unknown; addresses?: Record<string, unknown> };
  const chainId = Number(snapshot.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('the deployment snapshot has no chainId');
  const source = snapshot.addresses;
  if (typeof source !== 'object' || source === null) throw new Error('the deployment snapshot has no addresses');

  const missing = CONTRACT_KEYS.filter((key) => typeof source[key] !== 'string' || !isAddress(source[key] as string));
  if (missing.length > 0) throw new Error(`the deployment snapshot lacks an address for: ${missing.join(', ')}`);

  const addresses = Object.fromEntries(
    CONTRACT_KEYS.map((key) => [key, getAddress(source[key] as string)])
  ) as Record<ContractKey, Address>;
  return { chainId, addresses };
};

/** The contract a log came from, or undefined for an address the rules do not name. */
export const contractKeyOf = (deployment: Deployment, address: string): ContractKey | undefined =>
  CONTRACT_KEYS.find((key) => deployment.addresses[key].toLowerCase() === address.toLowerCase());
