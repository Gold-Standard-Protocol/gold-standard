import type { Address } from 'viem';
import { goldVaultKeeperAbi } from './abis';
import type { KeeperConfig } from './config';
import { expectAddress, expectBigInt, expectTuple } from './decode';
import type { KeeperBatchResult, KeeperContractCall, KeeperJobDeps } from './ports';

// The screen that keeps a healthy vault off the sequential path. Every indebted vault used to cost
// two eth_calls one after the
// other, vaults(owner) and getLiquidationPrice(owner), so a tick grew with the vault count
// and outgrew its interval. Both reads are now batched for the owners with debt, the walk
// decides in memory which vaults are candidates, and only those take the single reads that
// run immediately before a send.

/** Owners per screen multicall: two calls each, one eth_call per chunk. */
export const SCREEN_CHUNK = 200;

/** What the walk needs to tell a healthy vault from a candidate without a single read. */
export interface VaultScreen {
  collateralToken: Address;
  collateralAmount: bigint;
  /** GoldVault.getLiquidationPrice: oracle free, the price at which the vault crosses its line. */
  liquidationPrice: bigint;
}

const vaultCall = (config: KeeperConfig, functionName: string, owner: Address): KeeperContractCall => ({
  address: config.goldVaultAddress,
  abi: goldVaultKeeperAbi,
  functionName,
  args: [owner],
});

const decodeScreen = (
  vault: KeeperBatchResult | undefined,
  liquidationPrice: KeeperBatchResult | undefined
): VaultScreen | undefined => {
  if (vault?.status !== 'success' || liquidationPrice?.status !== 'success') return undefined;
  try {
    const tuple = expectTuple(vault.result, 3, 'vaults');
    return {
      collateralToken: expectAddress(tuple[0], 'vaults.collateralToken'),
      collateralAmount: expectBigInt(tuple[1], 'vaults.collateralAmount'),
      liquidationPrice: expectBigInt(liquidationPrice.result, 'getLiquidationPrice'),
    };
  } catch {
    return undefined;
  }
};

/**
 * Screens for `owners` in batches. An owner whose entries failed, did not decode or sat in a
 * batch that threw has no screen, and the walk then takes the sequential reads for it, as it
 * did for every vault before; a screen read never throws and never hides a vault.
 */
export const readVaultScreens = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  owners: readonly Address[]
): Promise<Map<Address, VaultScreen>> => {
  const screens = new Map<Address, VaultScreen>();
  const batch = deps.read.readContracts;
  if (batch === undefined) return screens;
  for (let start = 0; start < owners.length; start += SCREEN_CHUNK) {
    const chunk = owners.slice(start, start + SCREEN_CHUNK);
    let results: KeeperBatchResult[];
    try {
      results = await batch.call(
        deps.read,
        chunk.flatMap((owner) => [
          vaultCall(config, 'vaults', owner),
          vaultCall(config, 'getLiquidationPrice', owner),
        ])
      );
    } catch {
      continue;
    }
    chunk.forEach((owner, index) => {
      const screen = decodeScreen(results[2 * index], results[2 * index + 1]);
      if (screen !== undefined) screens.set(owner, screen);
    });
  }
  return screens;
};

/** A vault the screen could not call healthy, with what ranks it. */
export interface Candidate {
  owner: Address;
  debt: bigint;
  /** Gold worth less than the debt at the screen price; false when unknown. */
  underwater: boolean;
}

/**
 * The order the walk visits candidates in:
 * underwater vaults first, since every block they wait adds bad debt, then the largest debt
 * first, so the pool's deposits and the keeper's float go to the largest exposure. Ties keep
 * the owner source's order.
 */
export const rankCandidates = (candidates: readonly Candidate[]): Address[] =>
  [...candidates]
    .sort((left, right) => {
      if (left.underwater !== right.underwater) return left.underwater ? -1 : 1;
      if (left.debt === right.debt) return 0;
      return left.debt > right.debt ? -1 : 1;
    })
    .map((candidate) => candidate.owner);
