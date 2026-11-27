// The price queue's wiring, with BullMQ, IORedis and the price job replaced so no
// connection is opened and no request is made.
const queues: { name: string; options: { prefix?: string } }[] = [];
const workers: { name: string; options: { prefix?: string } }[] = [];

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((name: string, options: { prefix?: string }) => {
    queues.push({ name, options });
    return { on: jest.fn() };
  }),
  Worker: jest.fn().mockImplementation((name: string, _processor: unknown, options: { prefix?: string }) => {
    workers.push({ name, options });
    return { on: jest.fn() };
  }),
}));
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
}));
jest.mock('../jobs/fetchPrices', () => ({ fetchAndUpdatePrices: jest.fn() }));

import { KEY_NAMESPACE } from '../config/redisConfig';
import { initPriceUpdateWorker } from './queue';

describe('price update queue', () => {
  it("lives under the deployment's key namespace, so its start-up wipe cannot reach another deployment's queue", () => {
    expect(queues).toEqual([
      { name: 'price-update', options: expect.objectContaining({ prefix: `bull:${KEY_NAMESPACE}` }) },
    ]);
  });

  it('runs its worker under the same prefix as the queue', () => {
    initPriceUpdateWorker();
    expect(workers).toEqual([
      { name: 'price-update', options: expect.objectContaining({ prefix: `bull:${KEY_NAMESPACE}` }) },
    ]);
  });
});
