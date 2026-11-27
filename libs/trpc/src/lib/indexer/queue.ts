import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { createPublicClient, http } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { getCacheHandle } from '../config/cacheManager';
import { QUEUE_PREFIX, redisConfig } from '../config/redisConfig';
import { reportErrorsOnce } from '../config/redisErrors';
import { resetSchedule } from '../bullmq/schedule';
import { onShutdown } from '../shutdown';
import { createIndexerCacheStore } from './cacheStore';
import { createChainCheck } from './chainCheck';
import { getIndexerConfig } from './config';
import { DEFAULT_NAMESPACE, indexVaultOwners, KEY_NAMESPACE } from './vaultOwnerIndexer';
import type { IndexerCacheStore, VaultLogClient } from './vaultOwnerIndexer';

const VAULT_INDEX_QUEUE = 'vault-owner-index';
/** Where the queue lived before it was namespaced: BullMQ's default prefix. */
const LEGACY_PREFIX = 'bull';
export const VAULT_INDEX_JOB = 'index-vault-owners';
const VAULT_INDEX_EVERY_MS = 1000 * 60;

// Reads reject on a Redis failure, so a blip aborts the run.
const cacheStore: IndexerCacheStore = createIndexerCacheStore(getCacheHandle);

/** A BullMQ connection with its own error report. */
const createConnection = (label: string): IORedis => {
  const connection = new IORedis({ ...redisConfig });
  reportErrorsOnce(connection, label, { rearmOn: connection });
  return connection;
};

interface IndexerRpc {
  logClient: VaultLogClient;
  /** True once the endpoint has said it serves the configured chain. */
  servesConfiguredChain: () => Promise<boolean>;
}

const buildIndexerRpc = (rpcUrl: string, chainId: number): IndexerRpc => {
  const client = createPublicClient({
    chain: chainId === 1 ? mainnet : sepolia,
    transport: http(rpcUrl),
  });
  return {
    logClient: {
      getBlockNumber: () => client.getBlockNumber(),
      getLogs: (args) => client.getLogs(args),
    },
    servesConfiguredChain: createChainCheck(() => client.getChainId(), chainId),
  };
};

// Module-scope instances so repeated calls (dev-server reloads, multiple
// importers) reuse one worker and one queue instead of leaking an IORedis
// connection per call.
let activeWorker: Worker | undefined;
let activeQueue: Queue | undefined;
let shutdownRegistered = false;

/**
 * Closes the worker and the queue when the process shuts down.
 * This used to be a SIGTERM handler of its own that called process.exit as soon as they
 * closed, ending the API before its HTTP server had answered the requests in flight. The
 * API's entry now owns the signals and runs this after the drain.
 */
const registerShutdown = (): void => {
  if (shutdownRegistered) {
    return;
  }
  shutdownRegistered = true;
  onShutdown(() => Promise.allSettled([activeWorker?.close(), activeQueue?.close()]));
};

/**
 * Starts the vault owner indexing worker. Mirrors initPriceUpdateWorker in
 * lib/bullmq/queue.ts, but stays dormant (no Redis connection, no worker)
 * when the indexer environment is not configured. Idempotent: subsequent
 * calls return the existing worker.
 */
export const initVaultIndexWorker = (): Worker | undefined => {
  const config = getIndexerConfig();
  if (!config) {
    return undefined;
  }
  if (activeWorker) {
    return activeWorker;
  }
  const rpc = buildIndexerRpc(config.rpcUrl, config.chainId);
  activeWorker = new Worker(
    VAULT_INDEX_QUEUE,
    async () => {
      if (!(await rpc.servesConfiguredChain())) {
        return;
      }
      await indexVaultOwners(rpc.logClient, cacheStore, config);
    },
    {
      connection: createConnection('Vault index worker Redis'),
      // Namespaced like every other key: two APIs on one Redis (a dev instance and the
      // end-to-end one, or two deployments) must not take turns on a single repeat job,
      // each indexing with its own configuration into the other's owner set.
      prefix: QUEUE_PREFIX,
    }
  );
  // Without a listener a Redis hiccup surfaces as an unhandled 'error' event.
  activeWorker.on('error', (error) => {
    console.error('Vault index worker error:', error.message);
  });
  registerShutdown();
  return activeWorker;
};

/**
 * Schedules the indexing job every 60 seconds. No-op when the indexer
 * environment is not configured. One queue instance is reused, and the
 * reset clears the iterations earlier runs left queued: upsertJobScheduler
 * alone did not, so after six restarts the RPC was walked six times a minute.
 */
export const scheduleVaultIndex = async (): Promise<void> => {
  const config = getIndexerConfig();
  if (!config) {
    return;
  }
  if (!activeQueue) {
    activeQueue = new Queue(VAULT_INDEX_QUEUE, {
      connection: createConnection('Vault index queue Redis'),
      // Namespaced like every other key: two APIs on one Redis (a dev instance and the
      // end-to-end one, or two deployments) must not take turns on a single repeat job,
      // each indexing with its own configuration into the other's owner set.
      prefix: QUEUE_PREFIX,
    });
    reportErrorsOnce(activeQueue, 'Vault index queue');
    registerShutdown();
    await retireLegacyQueue();
  }
  await resetSchedule(activeQueue, { schedulerId: VAULT_INDEX_JOB, everyMs: VAULT_INDEX_EVERY_MS });
};

/**
 * Until 2026-09-30 the queue sat under BullMQ's default prefix, unnamespaced, and an
 * existing deployment still holds its schedule there. The default namespace is the
 * deployment that owned it, so that instance removes the old schedule once on start.
 * A custom namespace (a second deployment, the end-to-end suite) leaves it alone: it
 * may be another instance's live queue. Best effort; a failure is logged, not fatal.
 */
async function retireLegacyQueue(): Promise<void> {
  if (KEY_NAMESPACE !== DEFAULT_NAMESPACE) return;
  const legacy = new Queue(VAULT_INDEX_QUEUE, {
    connection: createConnection('Legacy vault index queue Redis'),
    prefix: LEGACY_PREFIX,
  });
  reportErrorsOnce(legacy, 'Legacy vault index queue');
  try {
    await legacy.obliterate({ force: true });
  } catch (error) {
    console.error('Legacy vault index queue cleanup failed:', (error as Error).message);
  } finally {
    await legacy.close();
  }
}
