import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_PREFIX, redisConfig } from '../config/redisConfig';
import { reportErrorsOnce } from '../config/redisErrors';
import { resetSchedule } from '../bullmq/schedule';
import { createChainCheck } from '../indexer/chainCheck';
import { onShutdown } from '../shutdown';
import { createLedgerChainClient } from './chainClient';
import { getLedgerConfig } from './env';
import { createIndexerMemory, indexLedger } from './indexer';
import { ledgerKeys } from './keys';
import { LEDGER_INDEX_EVERY_MS } from './limits';
import { createLedgerRedis } from './redis';
import { createLedgerStore } from './store';

const LEDGER_INDEX_QUEUE = 'ledger-index';
export const LEDGER_INDEX_JOB = 'index-ledger';

/** A BullMQ connection with its own error report, as the vault index queue has. */
const createConnection = (label: string): IORedis => {
  const connection = new IORedis({ ...redisConfig });
  reportErrorsOnce(connection, label, { rearmOn: connection });
  return connection;
};

// Module-scope instances so repeated calls reuse one worker and one queue.
let activeWorker: Worker | undefined;
let activeQueue: Queue | undefined;
let workerStoreClient: ReturnType<typeof createLedgerRedis> | undefined;
let shutdownRegistered = false;

const registerShutdown = (): void => {
  if (shutdownRegistered) {
    return;
  }
  shutdownRegistered = true;
  onShutdown(async () => {
    await Promise.allSettled([activeWorker?.close(), activeQueue?.close()]);
    workerStoreClient?.disconnect();
  });
};

/**
 * Starts the ledger indexing worker. A no-op that constructs nothing (no worker, no queue,
 * no Redis client, no RPC client) while the ledger is off. Idempotent.
 */
export const initLedgerIndexWorker = (): Worker | undefined => {
  const config = getLedgerConfig();
  if (!config) {
    return undefined;
  }
  if (activeWorker) {
    return activeWorker;
  }
  const client = createLedgerChainClient(config);
  const servesConfiguredChain = createChainCheck(() => client.getChainId(), config.chainId, 'Usage ledger indexing');
  // The worker's own Redis client: its commits use WATCH, which is per connection.
  workerStoreClient = createLedgerRedis('Usage ledger index store Redis');
  const store = createLedgerStore(workerStoreClient, ledgerKeys(config.chainId, config.vault));
  const memory = createIndexerMemory();
  activeWorker = new Worker(
    LEDGER_INDEX_QUEUE,
    async () => {
      if (!(await servesConfiguredChain())) {
        return;
      }
      await indexLedger(client, store, config, memory);
    },
    {
      connection: createConnection('Usage ledger index worker Redis'),
      prefix: QUEUE_PREFIX,
      // One run at a time: the in-memory state belongs to a single run.
      concurrency: 1,
    }
  );
  // Without a listener a Redis hiccup surfaces as an unhandled 'error' event.
  activeWorker.on('error', (error) => {
    console.error('Usage ledger index worker error:', error.message);
  });
  registerShutdown();
  return activeWorker;
};

/** Schedules the indexing job every minute. A no-op that constructs nothing while the ledger is off. */
export const scheduleLedgerIndex = async (): Promise<void> => {
  const config = getLedgerConfig();
  if (!config) {
    return;
  }
  if (!activeQueue) {
    activeQueue = new Queue(LEDGER_INDEX_QUEUE, {
      connection: createConnection('Usage ledger index queue Redis'),
      prefix: QUEUE_PREFIX,
    });
    reportErrorsOnce(activeQueue, 'Usage ledger index queue');
    registerShutdown();
  }
  await resetSchedule(activeQueue, { schedulerId: LEDGER_INDEX_JOB, everyMs: LEDGER_INDEX_EVERY_MS });
};
