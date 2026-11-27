import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  getAddress,
  multicall3Abi,
} from 'viem';
import type { Address, Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { goldVaultKeeperAbi } from '@goldstandard/trpc/keeper';
import type { KeeperContractCall } from '@goldstandard/trpc/keeper';
import { createReadClient } from './readClient';

const VAULT = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');

const owner = (index: number): Address =>
  getAddress(`0x${(0x5000 + index).toString(16).padStart(40, '0')}`);

/**
 * A node that answers every Multicall3 aggregate3 eth_call with one uint256 per sub-call,
 * and counts the eth_calls it is sent, as a provider's rate limit does.
 */
const createCountingClient = (): { client: ReturnType<typeof createPublicClient>; ethCalls: number[] } => {
  const ethCalls: number[] = [];
  const client = createPublicClient({
    chain: sepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        if (method !== 'eth_call') throw new Error(`Unexpected ${method}`);
        const [call] = params as [{ data: Hex }];
        const { args } = decodeFunctionData({ abi: multicall3Abi, data: call.data });
        const calls = (args?.[0] ?? []) as readonly unknown[];
        ethCalls.push(calls.length);
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          result: calls.map(() => ({
            success: true,
            returnData: encodeAbiParameters([{ type: 'uint256' }], [7n]),
          })),
        });
      },
    }),
  });
  return { client, ethCalls };
};

const debtCall = (index: number): KeeperContractCall => ({
  address: VAULT,
  abi: goldVaultKeeperAbi,
  functionName: 'getVaultCurrentDebt',
  args: [owner(index)],
});

describe('createReadClient multicall batching', () => {
  it('sends a 200-owner debt chunk as one eth_call, not eight', async () => {
    const { client, ethCalls } = createCountingClient();
    const read = createReadClient(client);

    const results = await read.readContracts?.(Array.from({ length: 200 }, (_, index) => debtCall(index)));

    expect(ethCalls).toEqual([200]);
    expect(results).toHaveLength(200);
    expect(results?.every((entry) => entry.status === 'success' && entry.result === 7n)).toBe(true);
  });

  it('sends a screen chunk of two reads for each of 200 owners as one eth_call', async () => {
    const { client, ethCalls } = createCountingClient();
    const read = createReadClient(client);
    const calls = Array.from({ length: 200 }, (_, index): KeeperContractCall[] => [
      { address: VAULT, abi: goldVaultKeeperAbi, functionName: 'getLiquidationPrice', args: [owner(index)] },
      { address: VAULT, abi: goldVaultKeeperAbi, functionName: 'getVaultCurrentDebt', args: [owner(index)] },
    ]).flat();

    await read.readContracts?.(calls);

    expect(ethCalls).toEqual([400]);
  });
});

describe('createReadClient head block', () => {
  it('reads the latest block number and timestamp for the heartbeat line', async () => {
    const asked: unknown[] = [];
    const client = createPublicClient({
      chain: sepolia,
      transport: custom({
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          if (method !== 'eth_getBlockByNumber') throw new Error(`Unexpected ${method}`);
          asked.push(params);
          return { number: '0x1406f40', timestamp: '0x6b49d200', transactions: [] };
        },
      }),
    });

    const head = await createReadClient(client).getHeadBlock?.();

    expect(head).toEqual({ number: 21_000_000n, timestamp: 1_800_000_000n });
    expect(asked).toEqual([['latest', false]]);
  });
});
