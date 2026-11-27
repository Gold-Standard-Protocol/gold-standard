import type { createPublicClient, ReadContractParameters } from 'viem';

import type { KeeperBatchResult, KeeperReadClient } from '@goldstandard/trpc/keeper';

type KeeperPublicClient = ReturnType<typeof createPublicClient>;

/**
 * Calldata bytes per aggregate3 eth_call. viem splits a multicall at 1,024 bytes by default,
 * which cut a 200-owner debt chunk (36 bytes a call) into eight eth_calls and a 200-owner
 * screen chunk into about sixteen. The keeper
 * library already sizes its chunks, at most 400 calls of 36 bytes, so this limit sits above
 * the largest of them and only guards against an outsized call list: each chunk is one
 * eth_call of about 80 KB, well inside providers' request limits.
 */
export const MULTICALL_BATCH_BYTES = 32_768;

/** The keeper's read seam over a viem public client. */
export const createReadClient = (client: KeeperPublicClient): KeeperReadClient => ({
  // The DI seam deliberately erases viem's ABI generics so jobs stay testable
  // with stub clients; the cast restores the broad parameter shape viem
  // accepts for a generic Abi.
  readContract: (args) => client.readContract(args as ReadContractParameters),
  // The oracle health watch judges each source's age against the block, as GoldOracle does.
  getBlockTimestamp: async () => (await client.getBlock({ blockTag: 'latest' })).timestamp,
  // The keeper.heartbeat line carries the head the keeper reads and how old it is.
  getHeadBlock: async () => {
    const block = await client.getBlock({ blockTag: 'latest' });
    return { number: block.number, timestamp: block.timestamp };
  },
  // The signer balance watch warns before the keeper wallet cannot pay for a liquidation.
  getBalance: (address) => client.getBalance({ address }),
  // Multicall3 is deployed on mainnet and Sepolia and viem's chain objects carry its
  // address. With MULTICALL_BATCH_BYTES each chunk the library hands over is one eth_call;
  // allowFailure keeps one bad owner from failing the whole chunk, and a failed eth_call
  // comes back as a failure entry for each of its calls, never as a throw.
  readContracts: async (calls) => {
    type Contracts = Parameters<KeeperPublicClient['multicall']>[0]['contracts'];
    const results = await client.multicall({
      contracts: calls.map((call) => ({
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
      })) as unknown as Contracts,
      allowFailure: true,
      batchSize: MULTICALL_BATCH_BYTES,
    });
    return results.map((entry): KeeperBatchResult =>
      entry.status === 'success'
        ? { status: 'success', result: entry.result }
        : { status: 'failure', error: entry.error }
    );
  },
});
