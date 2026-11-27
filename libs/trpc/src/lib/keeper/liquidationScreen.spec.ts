import { getAddress } from 'viem';
import type { Address } from 'viem';
import type { KeeperConfig } from './config';
import { rankCandidates, readVaultScreens, SCREEN_CHUNK } from './liquidationScreen';
import type { KeeperBatchResult, KeeperContractCall, KeeperJobDeps } from './ports';

const VAULT = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
const PAXG = getAddress('0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9');
const config = { goldVaultAddress: VAULT } as KeeperConfig;

const owner = (index: number): Address =>
  getAddress(`0x${(0x7000 + index).toString(16).padStart(40, '0')}`);

const answer = (call: KeeperContractCall): KeeperBatchResult =>
  call.functionName === 'vaults'
    ? { status: 'success', result: [PAXG, 5n, 9n] }
    : { status: 'success', result: 1_000n };

const depsWith = (readContracts: (calls: readonly KeeperContractCall[]) => Promise<KeeperBatchResult[]>) =>
  ({
    read: { readContract: async () => 0n, readContracts },
    tx: undefined,
    owners: { getOwners: async () => [] },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  }) satisfies KeeperJobDeps;

describe('readVaultScreens', () => {
  it('reads both figures for every owner, one batch per chunk', async () => {
    const batches: number[] = [];
    const owners = Array.from({ length: SCREEN_CHUNK + 1 }, (_, index) => owner(index));

    const screens = await readVaultScreens(
      depsWith(async (calls) => {
        batches.push(calls.length);
        return calls.map(answer);
      }),
      config,
      owners
    );

    expect(batches).toEqual([2 * SCREEN_CHUNK, 2]);
    expect(screens.get(owner(0))).toEqual({ collateralToken: PAXG, collateralAmount: 5n, liquidationPrice: 1_000n });
    expect(screens.size).toBe(SCREEN_CHUNK + 1);
  });

  it('leaves out an owner whose entry failed or did not decode, so the walk reads it singly', async () => {
    const screens = await readVaultScreens(
      depsWith(async (calls) =>
        calls.map((call, index): KeeperBatchResult => {
          if (index === 1) return { status: 'failure', error: new Error('fetch failed') };
          if (index === 2) return { status: 'success', result: 'garbage' };
          return answer(call);
        })
      ),
      config,
      [owner(0), owner(1), owner(2)]
    );

    expect([...screens.keys()]).toEqual([owner(2)]);
  });

  it('never throws when a whole batch throws: its owners simply have no screen', async () => {
    const screens = await readVaultScreens(
      depsWith(async () => {
        throw new Error('HTTP 429');
      }),
      config,
      [owner(0)]
    );

    expect(screens.size).toBe(0);
  });
});

describe('rankCandidates', () => {
  it('puts underwater vaults first, then the largest debt, and keeps the listing order on ties', () => {
    expect(
      rankCandidates([
        { owner: owner(0), debt: 10n, underwater: false },
        { owner: owner(1), debt: 50n, underwater: false },
        { owner: owner(2), debt: 5n, underwater: true },
        { owner: owner(3), debt: 50n, underwater: false },
        { owner: owner(4), debt: 7n, underwater: true },
      ])
    ).toEqual([owner(4), owner(2), owner(1), owner(3), owner(0)]);
  });
});
