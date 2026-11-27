import { Queue, Worker } from 'bullmq';
import { QUEUE_PREFIX, redisConfig } from '../config/redisConfig';
import { reportErrorsOnce } from '../config/redisErrors';
import IORedis from 'ioredis';
import { fetchAndUpdatePrices } from '../jobs/fetchPrices';
import { resetSchedule } from './schedule';

export const PRICE_UPDATE_JOB = 'fetch-and-update-prices';
const PRICE_UPDATE_EVERY_MS = 30_000;

const connection = new IORedis({
  ...redisConfig,
});
reportErrorsOnce(connection, 'Price queue Redis', { rearmOn: connection });

const PRICE_UPDATE_QUEUE = 'price-update';

// Namespaced like the indexer's queue. The schedule reset
// obliterates the queue on every start, and under BullMQ's bare default prefix that
// reached any other deployment's price queue on the same Redis. The queue an older build
// left under the bare prefix holds one idle schedule and is not removed here, since
// another deployment on the same Redis may still own it.
export const priceUpdateQueue = new Queue(PRICE_UPDATE_QUEUE, {
  connection,
  prefix: QUEUE_PREFIX,
});
reportErrorsOnce(priceUpdateQueue, 'Price queue');

export const initPriceUpdateWorker = () => {
  const worker = new Worker(
    PRICE_UPDATE_QUEUE,
    async () => {
      await fetchAndUpdatePrices();
    },
    {
      connection,
      prefix: QUEUE_PREFIX,
    }
  );
  // Without a listener a Redis hiccup surfaces as an unhandled 'error' event.
  worker.on('error', (error) => {
    console.error('Price worker error:', error.message);
  });
  return worker;
};

/**
 * Installs the 30-second price refresh. Never throws: the API must still serve its
 * cached prices and every other route when Redis is briefly unavailable at boot.
 */
export const schedulePriceUpdate = () =>
  resetSchedule(priceUpdateQueue, { schedulerId: PRICE_UPDATE_JOB, everyMs: PRICE_UPDATE_EVERY_MS }).catch((error: unknown) => {
    console.error('Price schedule not installed:', error instanceof Error ? error.message : String(error));
  });
