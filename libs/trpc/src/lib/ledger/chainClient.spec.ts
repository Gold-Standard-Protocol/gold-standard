const POOL_OF_VAULT = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';
const GSUSD = '0xdc64a140aa3e981100a9beca4e685f962f0cf6c9';
const DOLLAR = '0x5fc8d32690cc91d4c39d9d3abcbd16989f875707';
const FACTORY = '0x00000000000000000000000000000000000000fa';
const HOLDER = '0x00000000000000000000000000000000000000a1';
let failPositionsWith: unknown;

/** The Uniswap pool, the position manager, the factory and the two tokens, as the liquidity reads see them. */
const liquidityRead = (args: { functionName: string; address?: string }): unknown => {
  switch (args.functionName) {
    case 'token0':
      return GSUSD;
    case 'token1':
      return DOLLAR;
    case 'fee':
      return 500;
    case 'factory':
      return FACTORY;
    case 'stablecoin':
      return GSUSD;
    case 'decimals':
      return args.address === GSUSD ? 18 : 6;
    case 'getPool':
      return '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0';
    case 'slot0':
      return [2n ** 96n, -276_325, 0, 1, 1, 0, true];
    case 'ownerOf':
      return HOLDER;
    case 'positions':
      if (failPositionsWith !== undefined) throw failPositionsWith;
      return [0n, HOLDER, GSUSD, DOLLAR, 500, -276_330, -276_320, 77n, 0n, 0n, 0n, 0n];
    default:
      return POOL_OF_VAULT;
  }
};

const viemClient = {
  getChainId: jest.fn(async () => 11155111),
  getBlockNumber: jest.fn(async () => 123n),
  getLogs: jest.fn(async (_args: unknown) => [] as unknown[]),
  getBlock: jest.fn(async (_args: unknown) => ({ timestamp: 1_800_000_123n })),
  readContract: jest.fn(async (args: { functionName: string }): Promise<unknown> => {
    switch (args.functionName) {
      case 'totalDeposits':
        return 700n;
      case 'P':
        return 10n ** 18n;
      case 'currentScale':
        return 1n;
      case 'currentEpoch':
        return 2n;
      default:
        return liquidityRead(args);
    }
  }),
  getTransactionReceipt: jest.fn(async (_args: unknown): Promise<{ logs: unknown[] }> => ({ logs: [] })),
};
const createPublicClient = jest.fn((_options: { chain: { id: number } }) => viemClient);
const http = jest.fn((url: string) => ({ url }));

jest.mock('viem', () => ({
  ...jest.requireActual('viem'),
  createPublicClient: (options: { chain: { id: number } }) => createPublicClient(options),
  http: (url: string) => http(url),
}));

import { createLedgerChainClient } from './chainClient';
import { BaseError, ContractFunctionRevertedError, encodeEventTopics, getAddress } from 'viem';
import { LIQUIDITY_POOL_EVENTS, LEDGER_EVENTS, POSITION_LIQUIDITY_EVENTS, POSITION_TRANSFER_EVENT } from './events';
import { TEST_LIQUIDITY, TEST_LIQUIDITY_POOL, TEST_POOL, TEST_POSITION_MANAGER, TEST_VAULT, testConfig } from './testSupport';

describe('createLedgerChainClient', () => {
  const config = testConfig();
  const client = createLedgerChainClient(config);

  it('labels the client with the configured chain and uses the configured endpoint', () => {
    expect(createPublicClient.mock.calls[0][0].chain.id).toBe(11155111);
    expect(http).toHaveBeenCalledWith(config.rpcUrl);
    createLedgerChainClient(testConfig({ chainId: 1 }));
    expect(createPublicClient.mock.calls[1][0].chain.id).toBe(1);
  });

  it('asks for the nine events from the vault and the pool in one call', async () => {
    await client.getLogs(5n, 9n);
    expect(viemClient.getLogs).toHaveBeenCalledTimes(1);
    expect(viemClient.getLogs).toHaveBeenCalledWith({
      address: [TEST_VAULT, TEST_POOL],
      events: LEDGER_EVENTS,
      fromBlock: 5n,
      toBlock: 9n,
    });
  });

  it('reads the head, the chain id and a block timestamp as a number', async () => {
    expect(await client.getBlockNumber()).toBe(123n);
    expect(await client.getChainId()).toBe(11155111);
    expect(await client.getBlockTimestamp(77n)).toBe(1_800_000_123);
    expect(viemClient.getBlock).toHaveBeenCalledWith({ blockNumber: 77n });
  });

  it('reads the four pool globals and the vault pool at the given block', async () => {
    expect(await client.readPoolState(456n)).toEqual({ total: 700n, P: 10n ** 18n, scale: 1n, epoch: 2n, vaultPool: TEST_POOL });
    expect(viemClient.readContract).toHaveBeenCalledTimes(5);
    for (const [args] of viemClient.readContract.mock.calls) {
      expect(args).toMatchObject({ blockNumber: 456n });
    }
    expect(viemClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: TEST_VAULT, functionName: 'stabilityPool' })
    );
    expect(viemClient.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: TEST_POOL, functionName: 'totalDeposits' }));
  });
});

describe('createLedgerChainClient with the liquidity dimension', () => {
  const config = testConfig({ liquidity: TEST_LIQUIDITY });
  let client: ReturnType<typeof createLedgerChainClient>;

  beforeAll(() => {
    client = createLedgerChainClient(config);
  });

  beforeEach(() => {
    viemClient.getLogs.mockClear();
    viemClient.readContract.mockClear();
    failPositionsWith = undefined;
  });

  it('asks the vault, the pool and the liquidity pool for a window of logs, and never the position manager', async () => {
    await client.getLogs(5n, 9n);
    expect(viemClient.getLogs).toHaveBeenCalledTimes(1);
    expect(viemClient.getLogs).toHaveBeenCalledWith({
      address: [TEST_VAULT, TEST_POOL, TEST_LIQUIDITY_POOL],
      events: [...LEDGER_EVENTS, ...LIQUIDITY_POOL_EVENTS],
      fromBlock: 5n,
      toBlock: 9n,
    });
  });

  it('asks the position manager for transfers with the token id topic set to the ids it is given', async () => {
    await client.getPositionTransferLogs(5n, 9n, [7n, 8n]);
    expect(viemClient.getLogs).toHaveBeenCalledTimes(1);
    expect(viemClient.getLogs).toHaveBeenCalledWith({
      address: TEST_POSITION_MANAGER,
      event: POSITION_TRANSFER_EVENT,
      args: { tokenId: [7n, 8n] },
      fromBlock: 5n,
      toBlock: 9n,
    });
  });

  it("reads the position manager's liquidity logs from one transaction's receipt, leaving every other log of it out", async () => {
    const hash = `0x${'ab'.repeat(32)}` as const;
    const tokenIdTopic = `0x${(7n).toString(16).padStart(64, '0')}` as const;
    const word = (value: bigint): string => value.toString(16).padStart(64, '0');
    const base = { blockNumber: 12n, transactionHash: hash, blockHash: hash, transactionIndex: 0, removed: false };
    viemClient.getTransactionReceipt.mockResolvedValueOnce({
      logs: [
        // A token transfer and the pool's own log: not the position manager's.
        { ...base, address: GSUSD, logIndex: 3, topics: [encodeEventTopics({ abi: [POSITION_TRANSFER_EVENT], eventName: 'Transfer' })[0], tokenIdTopic, tokenIdTopic, tokenIdTopic], data: '0x' },
        // The NFT transfer: the position manager's, but not a liquidity log.
        { ...base, address: TEST_POSITION_MANAGER.toLowerCase(), logIndex: 4, topics: [encodeEventTopics({ abi: [POSITION_TRANSFER_EVENT], eventName: 'Transfer' })[0], tokenIdTopic, tokenIdTopic, tokenIdTopic], data: '0x' },
        { ...base, address: TEST_POSITION_MANAGER.toLowerCase(), logIndex: 5, topics: [encodeEventTopics({ abi: POSITION_LIQUIDITY_EVENTS, eventName: 'IncreaseLiquidity' })[0], tokenIdTopic], data: `0x${word(9n)}${word(1n)}${word(2n)}` },
      ],
    });
    const logs = await client.getPositionLiquidityLogs(hash);
    expect(viemClient.getTransactionReceipt).toHaveBeenCalledWith({ hash });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ eventName: 'IncreaseLiquidity', args: { tokenId: 7n, liquidity: 9n }, blockNumber: 12n, logIndex: 5, transactionHash: hash });
  });

  it('reads the pool, its tokens, the deployment GSUSD and the pool the factory holds for the pair', async () => {
    expect(await client.readLiquidityFacts(TEST_LIQUIDITY)).toEqual({
      token0: getAddress(GSUSD),
      token1: getAddress(DOLLAR),
      fee: 500,
      decimals0: 18,
      decimals1: 6,
      stablecoin: getAddress(GSUSD),
      factoryPool: TEST_LIQUIDITY_POOL,
    });
    expect(viemClient.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: TEST_VAULT, functionName: 'stablecoin' }));
    expect(viemClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: FACTORY, functionName: 'getPool', args: [GSUSD, DOLLAR, 500] })
    );
    expect(viemClient.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: TEST_POSITION_MANAGER, functionName: 'factory' }));
  });

  it('reads positions and their owners at the given block', async () => {
    expect(await client.readPositions(456n, [7n, 8n])).toEqual([
      { token0: getAddress(GSUSD), token1: getAddress(DOLLAR), fee: 500, tickLower: -276_330, tickUpper: -276_320, liquidity: 77n, owner: getAddress(HOLDER) },
      { token0: getAddress(GSUSD), token1: getAddress(DOLLAR), fee: 500, tickLower: -276_330, tickUpper: -276_320, liquidity: 77n, owner: getAddress(HOLDER) },
    ]);
    expect(viemClient.readContract).toHaveBeenCalledTimes(4);
    for (const [args] of viemClient.readContract.mock.calls) {
      expect(args).toMatchObject({ address: TEST_POSITION_MANAGER, blockNumber: 456n });
    }
  });

  it('answers undefined for a token id the position manager refuses, and fails on any other error', async () => {
    failPositionsWith = new BaseError('execution reverted', {
      cause: new ContractFunctionRevertedError({ abi: [], functionName: 'positions', message: 'Invalid token ID' }),
    });
    expect(await client.readPositions(456n, [7n])).toEqual([undefined]);
    failPositionsWith = new Error('request timed out');
    await expect(client.readPositions(456n, [7n])).rejects.toThrow('request timed out');
  });

  it('reads the pool tick, and null for a pool that is not initialized', async () => {
    expect(await client.readPoolTick(456n)).toBe(-276_325);
    expect(viemClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: TEST_LIQUIDITY_POOL, functionName: 'slot0', blockNumber: 456n })
    );
    viemClient.readContract.mockImplementationOnce(async () => [0n, 0, 0, 0, 0, 0, false]);
    expect(await client.readPoolTick(456n)).toBeNull();
  });

  it('refuses the liquidity reads while the source is off', async () => {
    const off = createLedgerChainClient(testConfig());
    await expect(off.readPositions(1n, [7n])).rejects.toThrow('the liquidity dimension is not configured');
    await expect(off.readPoolTick(1n)).rejects.toThrow('the liquidity dimension is not configured');
    await expect(off.getPositionLiquidityLogs(`0x${'ab'.repeat(32)}`)).rejects.toThrow('the liquidity dimension is not configured');
    expect(() => off.getPositionTransferLogs(1n, 2n, [7n])).toThrow('the liquidity dimension is not configured');
  });
});
