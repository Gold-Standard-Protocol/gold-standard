// The ledger queue with BullMQ, IORedis, the chain client, the indexer and the configuration
// replaced, so the specs can count what is constructed and no connection is opened.
import type { LedgerConfig } from './env';

const queueConstructor = jest.fn();
const workerConstructor = jest.fn();
const redisConstructor = jest.fn();
const closes: string[] = [];
let processor: (() => Promise<void>) | undefined;
let servedChainId = 11155111;
let config: LedgerConfig | undefined;
const indexLedger = jest.fn(async (..._args: unknown[]) => undefined);
const getChainId = jest.fn(async () => servedChainId);
const createLedgerChainClient = jest.fn(() => ({ getChainId }));
const resetSchedule = jest.fn(async (..._args: unknown[]) => undefined);

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((...args: unknown[]) => {
    queueConstructor(...args);
    return { on: jest.fn(), close: jest.fn(async () => closes.push('queue')) };
  }),
  Worker: jest.fn().mockImplementation((name: string, run: () => Promise<void>, options: unknown) => {
    workerConstructor(name, options);
    processor = run;
    return { on: jest.fn(), close: jest.fn(async () => closes.push('worker')) };
  }),
}));
jest.mock('ioredis', () => {
  const Redis = jest.fn().mockImplementation((...args: unknown[]) => {
    redisConstructor(...args);
    return { on: jest.fn(), disconnect: jest.fn(() => closes.push('store')) };
  });
  return { __esModule: true, default: Redis, Redis };
});
jest.mock('../bullmq/schedule', () => ({ resetSchedule: (...args: unknown[]) => resetSchedule(...args) }));
jest.mock('./chainClient', () => ({ createLedgerChainClient: () => createLedgerChainClient() }));
jest.mock('./indexer', () => ({
  ...jest.requireActual('./indexer'),
  indexLedger: (...args: unknown[]) => indexLedger(...args),
}));
jest.mock('./env', () => ({ getLedgerConfig: () => config }));

import { QUEUE_PREFIX } from '../config/redisConfig';
import { runShutdownTasks } from '../shutdown';
import { LEDGER_INDEX_EVERY_MS } from './limits';
import { initLedgerIndexWorker, LEDGER_INDEX_JOB, scheduleLedgerIndex } from './queue';
import { testConfig } from './testSupport';

describe('ledger index queue', () => {
  describe('while the ledger is off', () => {
    it('constructs no queue, no worker, no Redis client and no RPC client, and schedules nothing', async () => {
      config = undefined;
      await scheduleLedgerIndex();
      expect(initLedgerIndexWorker()).toBeUndefined();
      expect(queueConstructor).not.toHaveBeenCalled();
      expect(workerConstructor).not.toHaveBeenCalled();
      expect(redisConstructor).not.toHaveBeenCalled();
      expect(createLedgerChainClient).not.toHaveBeenCalled();
      expect(resetSchedule).not.toHaveBeenCalled();
    });
  });

  describe('while the ledger is on', () => {
    let consoleError: jest.SpyInstance;

    beforeAll(() => {
      config = testConfig();
    });
    beforeEach(() => {
      consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => consoleError.mockRestore());

    it('installs the one minute schedule on a namespaced queue, once per call and one queue for all', async () => {
      await scheduleLedgerIndex();
      await scheduleLedgerIndex();
      expect(queueConstructor).toHaveBeenCalledTimes(1);
      expect(queueConstructor).toHaveBeenCalledWith('ledger-index', expect.objectContaining({ prefix: QUEUE_PREFIX }));
      expect(resetSchedule).toHaveBeenCalledTimes(2);
      expect(resetSchedule).toHaveBeenLastCalledWith(expect.anything(), { schedulerId: LEDGER_INDEX_JOB, everyMs: LEDGER_INDEX_EVERY_MS });
      expect(LEDGER_INDEX_JOB).toBe('index-ledger');
      expect(LEDGER_INDEX_EVERY_MS).toBe(60_000);
    });

    it('starts one worker with concurrency 1 and reuses it', () => {
      const worker = initLedgerIndexWorker();
      expect(initLedgerIndexWorker()).toBe(worker);
      expect(workerConstructor).toHaveBeenCalledTimes(1);
      expect(workerConstructor).toHaveBeenCalledWith('ledger-index', expect.objectContaining({ prefix: QUEUE_PREFIX, concurrency: 1 }));
    });

    it('indexes nothing while the RPC endpoint serves another chain, then indexes once it matches', async () => {
      initLedgerIndexWorker();
      servedChainId = 1;
      await processor?.();
      expect(indexLedger).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Usage ledger indexing refused'));
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('serves chain 1'));

      servedChainId = 11155111;
      await processor?.();
      await processor?.();
      expect(indexLedger).toHaveBeenCalledTimes(2);
      // The same process memory is handed to every run.
      expect(indexLedger.mock.calls[0][3]).toBe(indexLedger.mock.calls[1][3]);
      expect(indexLedger.mock.calls[0][2]).toBe(config);
    });

    it('installs no signal handler and closes the worker, the queue and the store client on shutdown', async () => {
      const sigterm = process.listenerCount('SIGTERM');
      const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      initLedgerIndexWorker();
      expect(process.listenerCount('SIGTERM')).toBe(sigterm);
      await runShutdownTasks();
      expect(closes.sort()).toEqual(['queue', 'store', 'worker']);
      expect(exit).not.toHaveBeenCalled();
      exit.mockRestore();
    });
  });
});
