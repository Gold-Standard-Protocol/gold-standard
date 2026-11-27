// The vault index queue's shutdown and its worker's job, with BullMQ, IORedis, the viem
// client, the indexer and its config replaced so no connection is opened.
const closes: string[] = [];
let processor: (() => Promise<void>) | undefined;
let servedChainId = 11155111;
const indexVaultOwners = jest.fn(async () => undefined);

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn(async () => {
      closes.push('queue');
    }),
  })),
  Worker: jest.fn().mockImplementation((_name: string, run: () => Promise<void>) => {
    processor = run;
    return {
      on: jest.fn(),
      close: jest.fn(async () => {
        closes.push('worker');
      }),
    };
  }),
}));
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
}));
jest.mock('viem', () => ({
  ...jest.requireActual('viem'),
  createPublicClient: () => ({
    getChainId: async () => servedChainId,
    getBlockNumber: async () => 0n,
    getLogs: async () => [],
  }),
}));
jest.mock('./vaultOwnerIndexer', () => ({
  ...jest.requireActual('./vaultOwnerIndexer'),
  indexVaultOwners: () => indexVaultOwners(),
}));
jest.mock('./config', () => ({
  getIndexerConfig: () => ({
    rpcUrl: 'https://sepolia.example.org/rpc',
    goldVaultAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    deployBlock: 100n,
    chainId: 11155111,
    confirmations: 6,
  }),
}));

import { runShutdownTasks } from '../shutdown';
import { initVaultIndexWorker } from './queue';

describe('vault index queue shutdown', () => {
  it('installs no signal handler and never exits the process itself', async () => {
    const sigterm = process.listenerCount('SIGTERM');
    const sigint = process.listenerCount('SIGINT');
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    initVaultIndexWorker();

    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
    expect(process.listenerCount('SIGINT')).toBe(sigint);
    await runShutdownTasks();
    expect(closes).toEqual(['worker']);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});

// An endpoint serving another chain than
// INDEXER_CHAIN_ID was indexed under the configured chain's keys.
describe('vault index worker chain check', () => {
  it('indexes nothing while the RPC endpoint serves another chain, then indexes once it matches', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    initVaultIndexWorker();
    expect(processor).toBeDefined();

    servedChainId = 1;
    await processor?.();
    expect(indexVaultOwners).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('serves chain 1'));

    servedChainId = 11155111;
    await processor?.();
    expect(indexVaultOwners).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
