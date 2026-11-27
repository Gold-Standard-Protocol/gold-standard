import {
  combineVaultOwnerSources,
  createRedisVaultOwnerSource,
  createRegistryVaultOwnerSource,
} from '@goldstandard/trpc/keeper';
import type {
  KeeperConfig,
  KeeperLogger,
  KeeperReadClient,
  VaultOwnerSource,
} from '@goldstandard/trpc/keeper';

/**
 * Owner discovery. The on-chain registry is the authoritative list; the
 * indexer's Redis set is the historical one. Both are read and unioned when
 * both are configured, so a stalled or re-pointed API cannot hide an open
 * vault. With no Redis configured the keeper never builds a Redis client at
 * all, which is the shape the runbook deploys: a keeper VPS with no Redis.
 * Even a single source is read through the union, which pages every tick on
 * which no full owner list was read: every source failing (the runbook keeper
 * whose registry read fails among them) or only a partial list left.
 */
export const createOwnerSource = (
  config: KeeperConfig,
  read: KeeperReadClient,
  log: KeeperLogger
): { owners: VaultOwnerSource; names: string[] } => {
  // Typed by inference, so each source keeps its readOwners type; the union asks any source
  // that has readOwners how its read went.
  const sources = [
    ...(config.vaultRegistryAddress === undefined
      ? []
      : [
          {
            name: 'registry',
            source: createRegistryVaultOwnerSource(config.vaultRegistryAddress, read, log),
          },
        ]),
    ...(config.redisConfigured
      ? [
          {
            name: 'redis',
            // A truncated indexer set warns here; the union pages the tick unless the
            // registry walk read a full list.
            source: createRedisVaultOwnerSource(config.chainId, log, undefined, {
              readThroughUnion: true,
            }),
          },
        ]
      : []),
  ];
  return {
    owners: combineVaultOwnerSources(
      sources.map((entry) => entry.source),
      log
    ),
    names: sources.map((entry) => entry.name),
  };
};
