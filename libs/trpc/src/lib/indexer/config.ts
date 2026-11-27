import { z } from 'zod';
import { getAddress, zeroAddress } from 'viem';
import type { Address } from 'viem';
import { loadLocalEnv } from '../config/loadEnv';

// Mirrors lib/config/env.ts, but every variable here is OPTIONAL: when the
// indexer environment is incomplete the worker stays dormant and the API
// honestly serves an empty owner list instead of crashing at startup.
// A missing .env file is fine (production injects real env vars); any other
// load failure is reported so a dormant indexer is diagnosable.
// SEPOLIA_RPC_URL keeps its historical name by canonical decision: it is the
// indexer RPC endpoint for whichever chain INDEXER_CHAIN_ID selects, and a
// mainnet deployment points it at a mainnet RPC.
loadLocalEnv();

/** The default chain when INDEXER_CHAIN_ID is unset; preserves the original Sepolia behaviour. */
export const SEPOLIA_CHAIN_ID = 11155111;

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** The widest eth_getLogs window the scans ever ask for; INDEXER_MAX_BLOCK_RANGE may only lower it. */
export const MAX_INDEXER_BLOCK_RANGE = 10_000;

const indexerEnvSchema = z.object({
  SEPOLIA_RPC_URL: z.string().url().optional(),
  GOLD_VAULT_ADDRESS: z.string().regex(EVM_ADDRESS_PATTERN).optional(),
  GOLD_VAULT_DEPLOY_BLOCK: z.coerce.bigint().nonnegative().optional(),
  INDEXER_CHAIN_ID: z.coerce
    .number()
    .pipe(z.union([z.literal(1), z.literal(11155111)]))
    .optional(),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).max(1000).optional(),
  INDEXER_MAX_BLOCK_RANGE: z.coerce
    .number()
    .int({ message: 'must be a whole number of blocks' })
    .min(1, { message: 'must be at least 1 block' })
    .max(MAX_INDEXER_BLOCK_RANGE, { message: `must be at most ${MAX_INDEXER_BLOCK_RANGE} blocks` })
    .optional(),
});

/**
 * Blocks behind the head the scan stops at. The cursor used to be stored at the head
 * getBlockNumber reported, so a log node lagging the block-number node, or a same-height
 * reorg of the head block, left an owner's first deposit in a gap the indexer never
 * revisited. Six blocks covers every reorg seen on mainnet in years and any ordinary
 * provider lag; the scan also re-reads this many blocks behind the cursor each run.
 */
export const DEFAULT_INDEXER_CONFIRMATIONS = 6;

export interface IndexerConfig {
  rpcUrl: string;
  goldVaultAddress: Address;
  deployBlock: bigint;
  /** Chain the RPC URL and vault address belong to; scopes the cache keys. */
  chainId: number;
  /** Blocks behind the head the scan stops at, and re-reads behind the cursor. */
  confirmations: number;
  /**
   * INDEXER_MAX_BLOCK_RANGE: the widest eth_getLogs window the scans ask for, the vault owner
   * index and the usage ledger index alike. Absent, the scans start at 10,000 blocks and halve a
   * window a provider refuses. Set it to a provider's own cap (10 on a plan that allows ten
   * blocks a query) so no request is ever refused: a refused request still counts against
   * the plan, and below 100 blocks the scans do not narrow a refused window any further.
   */
  maxBlockRange?: bigint;
}

export type IndexerConfigResult =
  | { ok: true; config: IndexerConfig }
  | { ok: false; reason: string };

const emptyToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;

/**
 * Pure parser so tests can pass explicit environment objects without
 * touching process.env. Returns a reason string instead of logging so the
 * caller decides how loudly to report a dormant indexer.
 */
export const parseIndexerConfig = (
  env: Record<string, string | undefined>
): IndexerConfigResult => {
  const candidate = {
    SEPOLIA_RPC_URL: emptyToUndefined(env['SEPOLIA_RPC_URL']),
    GOLD_VAULT_ADDRESS: emptyToUndefined(env['GOLD_VAULT_ADDRESS']),
    GOLD_VAULT_DEPLOY_BLOCK: emptyToUndefined(env['GOLD_VAULT_DEPLOY_BLOCK']),
    INDEXER_CHAIN_ID: emptyToUndefined(env['INDEXER_CHAIN_ID']),
    INDEXER_CONFIRMATIONS: emptyToUndefined(env['INDEXER_CONFIRMATIONS']),
    INDEXER_MAX_BLOCK_RANGE: emptyToUndefined(env['INDEXER_MAX_BLOCK_RANGE']),
  };

  const parsed = indexerEnvSchema.safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason: `Invalid indexer environment: ${detail}` };
  }

  const {
    SEPOLIA_RPC_URL,
    GOLD_VAULT_ADDRESS,
    GOLD_VAULT_DEPLOY_BLOCK,
    INDEXER_CHAIN_ID,
    INDEXER_CONFIRMATIONS,
    INDEXER_MAX_BLOCK_RANGE,
  } = parsed.data;

  if (
    SEPOLIA_RPC_URL === undefined ||
    GOLD_VAULT_ADDRESS === undefined ||
    GOLD_VAULT_DEPLOY_BLOCK === undefined
  ) {
    return {
      ok: false,
      reason:
        'Indexer environment incomplete: SEPOLIA_RPC_URL, GOLD_VAULT_ADDRESS and GOLD_VAULT_DEPLOY_BLOCK are all required.',
    };
  }

  // The regex above guarantees getAddress cannot throw here; it only
  // normalises the address to its checksummed form.
  const goldVaultAddress = getAddress(GOLD_VAULT_ADDRESS);
  if (goldVaultAddress === zeroAddress) {
    return {
      ok: false,
      reason: 'GOLD_VAULT_ADDRESS is the zero address; no contract deployed.',
    };
  }

  return {
    ok: true,
    config: {
      rpcUrl: SEPOLIA_RPC_URL,
      goldVaultAddress,
      deployBlock: GOLD_VAULT_DEPLOY_BLOCK,
      chainId: INDEXER_CHAIN_ID ?? SEPOLIA_CHAIN_ID,
      confirmations: INDEXER_CONFIRMATIONS ?? DEFAULT_INDEXER_CONFIRMATIONS,
      // Absent, not undefined, when unset: the configuration is then exactly what it was.
      ...(INDEXER_MAX_BLOCK_RANGE === undefined ? {} : { maxBlockRange: BigInt(INDEXER_MAX_BLOCK_RANGE) }),
    },
  };
};

let cachedResult: IndexerConfigResult | undefined;

/**
 * Parses process.env once and memoises the result. Returns undefined when
 * the indexer is not configured, logging the reason a single time so the
 * worker and scheduler can both call this without spamming the logs.
 */
export const getIndexerConfig = (): IndexerConfig | undefined => {
  if (cachedResult === undefined) {
    cachedResult = parseIndexerConfig(process.env);
    if (!cachedResult.ok) {
      console.error(`Vault owner indexer dormant: ${cachedResult.reason}`);
    }
  }
  return cachedResult.ok ? cachedResult.config : undefined;
};
